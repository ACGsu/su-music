import {randomUUID} from 'node:crypto'
import type {MusicDatabase} from '../database.ts'
import type {CatalogChange} from '../database.ts'
import type {SourceCandidate} from '../../shared/music.ts'
import type {PlayerState,PlayerCommand,MediaEvent,QueueEntry,PlaybackTarget,HistoryEntry,PlaybackNow} from '../../shared/playback.ts'
import type {PlaybackAttempts} from '../music/gd.ts'
import type {PlaybackSources} from './source.ts'
import type {MediaRegistry} from './media.ts'
import {PlayerError,playerMessage} from './errors.ts'
import {SourceError} from '../music/errors.ts'

export function emptyPlayer():PlayerState{return{phase:'idle',queue:[],currentId:null,mode:'sequence',now:null,media:null,desiredPlaying:false,positionMs:0,durationMs:null,seekToMs:0,seekSerial:0,reason:null,retryAt:null,skipped:[],historyRevision:0}}
const sameReference=(a:PlaybackTarget,b:PlaybackTarget):boolean=>a.kind==='original'&&b.kind==='original'&&a.reference.collectionId===b.reference.collectionId&&a.reference.position===b.reference.position

export class PlayerController {
  private state=emptyPlayer()
  private generation=0
  private accountKey:string
  private attempts:PlaybackAttempts={used:0,limit:2}
  private rateWaits=0
  private automatic=false
  private pass=new Set<string>()
  private overrides=new Map<string,SourceCandidate>()
  private signatures=new Map<string,string|null>()
  private historyContext=new Map<string,PlaybackNow>()
  private shuffleVisited=new Set<string>()
  private navigation:string[]=[]
  private navigationIndex=-1
  private timer:ReturnType<typeof setTimeout>|null=null
  private history:HistoryEntry|null=null
  private historyStarted=false
  private lastPosition=0
  private lastProgressAt=0
  private lastHistorySave=0
  private coverage:{start:number;end:number}[]=[]
  private db:MusicDatabase
  private sources:PlaybackSources
  private media:MediaRegistry
  private changed:(state:PlayerState)=>void
  private options:{now?:()=>number;random?:()=>number;stallMs?:number}
  constructor(db:MusicDatabase,sources:PlaybackSources,media:MediaRegistry,changed:(state:PlayerState)=>void,
    options:{now?:()=>number;random?:()=>number;stallMs?:number}={}){
    this.db=db;this.sources=sources;this.media=media;this.changed=changed;this.options=options
    this.accountKey=db.currentAccountKey()
    const mode=db.getSetting<unknown>('playback-mode','sequence');if(['sequence','shuffle','repeat_one'].includes(String(mode)))this.state.mode=mode as PlayerState['mode']
  }
  private clock():number{return(this.options.now??Date.now)()}
  snapshot():PlayerState{return structuredClone(this.state)}
  private emit():void{this.changed(this.snapshot())}
  private clearTimer():void{if(this.timer)clearTimeout(this.timer);this.timer=null}
  private release():void{this.clearTimer();if(this.state.media)this.media.revoke(this.state.media.id);this.state.media=null}
  private current():QueueEntry|null{return this.state.queue.find(item=>item.id===this.state.currentId)??null}
  private makeEntry(target:PlaybackTarget):QueueEntry{
    const entry={id:randomUUID(),target:structuredClone(target),...this.sources.describe(target)}
    if(target.kind==='original')this.signatures.set(entry.id,this.db.originalSignature(target.reference))
    return entry
  }
  private revision():void{this.state.historyRevision++}
  private refreshQueueMetadata(target:PlaybackTarget):void{for(const entry of this.state.queue)if(sameReference(entry.target,target))Object.assign(entry,this.sources.describe(target))}
  catalogChanged(changes:CatalogChange[]):void{
    this.accountChanged()
    let currentMoved=false
    for(const entry of this.state.queue){
      if(entry.target.kind!=='original')continue
      const reference=entry.target.reference,change=changes.find(item=>item.collectionId===reference.collectionId)
      if(!change)continue
      const position=change.positions.get(reference.position)
      if(position===undefined){this.signatures.set(entry.id,null);continue}
      entry.target={kind:'original',reference:{collectionId:change.targetCollectionId??reference.collectionId,position}}
      this.signatures.set(entry.id,this.db.originalSignature(entry.target.reference))
      Object.assign(entry,this.sources.describe(entry.target))
      if(entry.id===this.state.currentId){currentMoved=true;if(this.state.now)this.state.now.reference=structuredClone(entry.target.reference)}
    }
    if(currentMoved&&this.state.phase==='resolving'&&!this.state.media){this.generation++;void this.resolveCurrent(false,false)}
    this.revision();this.emit()
  }
  accountChanged():void{
    const key=this.db.currentAccountKey();if(key===this.accountKey)return
    this.flushHistory();this.generation++;this.release();const mode=this.state.mode,revision=this.state.historyRevision+1
    this.state={...emptyPlayer(),mode,historyRevision:revision};this.accountKey=key
    this.overrides.clear();this.signatures.clear();this.historyContext.clear();this.shuffleVisited.clear();this.navigation=[];this.navigationIndex=-1;this.history=null;this.emit()
  }
  command(command:PlayerCommand):PlayerState{
    this.accountChanged()
    switch(command.type){
      case'play':this.replace([this.makeEntry(command.target)],0);break
      case'play_collection':{
        const detail=this.db.getCollection(command.collectionId);if(!detail)throw new PlayerError('TRACK_NOT_FOUND')
        if(detail.tracks.length>20000)throw new PlayerError('QUEUE_LIMIT')
        const index=detail.tracks.findIndex(track=>track.position===command.position);if(index<0)throw new PlayerError('TRACK_NOT_FOUND')
        this.replace(detail.tracks.map(track=>this.makeEntry({kind:'original',reference:{collectionId:command.collectionId,position:track.position}})),index,command.skipUnavailable===true);break
      }
      case'enqueue':{
        if(this.state.queue.length>=20000)throw new PlayerError('QUEUE_LIMIT')
        const entry=this.makeEntry(command.target),current=this.state.queue.findIndex(item=>item.id===this.state.currentId)
        this.state.queue.splice(command.placement==='next'?Math.max(0,current+1):this.state.queue.length,0,entry);this.emit();break
      }
      case'control':this.control(command.action);break
      case'seek':this.seek(command.positionMs);break
      case'mode':this.state.mode=command.mode;this.db.setSetting('playback-mode',command.mode);this.shuffleVisited.clear();this.emit();break
      case'queue_jump':{const entry=this.state.queue.find(item=>item.id===command.id);if(entry)this.begin(entry,false);break}
      case'queue_move':{
        const index=this.state.queue.findIndex(item=>item.id===command.id);if(index<0)break
        const item=this.state.queue.splice(index,1)[0]!;this.state.queue.splice(Math.min(command.index,this.state.queue.length),0,item);this.emit();break
      }
      case'queue_remove':{
        const index=this.state.queue.findIndex(item=>item.id===command.id);if(index<0)break
        const wasCurrent=this.state.currentId===command.id,wanted=this.state.desiredPlaying
        this.state.queue.splice(index,1);this.overrides.delete(command.id);this.signatures.delete(command.id)
        if(wasCurrent){this.flushHistory();this.generation++;this.release();const next=this.state.queue[index]??this.state.queue[0];if(next&&wanted)this.begin(next,true);else{this.state.currentId=null;this.state.now=null;this.state.positionMs=0;this.state.durationMs=null;this.state.desiredPlaying=false;this.state.phase='idle';this.emit()}}
        else this.emit();break
      }
      case'choose':{
        const candidate=this.sources.choose(command.reference,command.candidate,command.persistence),target:PlaybackTarget={kind:'original',reference:command.reference}
        if(command.persistence==='remember')this.refreshQueueMetadata(target)
        const current=this.current()
        if(current&&sameReference(current.target,target)){this.overrides.set(current.id,candidate);this.signatures.set(current.id,this.db.originalSignature(command.reference));Object.assign(current,this.sources.describe(target));this.revision();this.begin(current,false)}
        else{const entry=this.makeEntry(target);this.overrides.set(entry.id,candidate);this.revision();this.replace([entry],0)}break
      }
      case'link_local':{
        this.sources.linkLocal(command.reference,command.localId);this.revision()
        const current=this.current(),target:PlaybackTarget={kind:'original',reference:command.reference}
        this.refreshQueueMetadata(target)
        if(current&&sameReference(current.target,target)){this.overrides.delete(current.id);this.begin(current,false)}else this.replace([this.makeEntry(target)],0)
        break
      }
      case'restore_original':{
        this.sources.restore(command.reference);this.revision()
        const current=this.current(),target:PlaybackTarget={kind:'original',reference:command.reference}
        this.refreshQueueMetadata(target)
        for(const item of this.state.queue)if(sameReference(item.target,target))this.overrides.delete(item.id)
        if(current&&sameReference(current.target,target))this.begin(current,false);else this.emit();break
      }
      case'retry':{const current=this.current();if(current)this.begin(current,false,true);break}
    }return this.snapshot()
  }
  private replace(queue:QueueEntry[],index:number,automatic=false):void{
    this.flushHistory();this.generation++;this.release();this.state.queue=queue;this.navigation=[];this.navigationIndex=-1;this.shuffleVisited.clear();this.state.skipped=[];this.pass.clear()
    const keep=new Set(queue.map(item=>item.id));for(const id of this.overrides.keys())if(!keep.has(id))this.overrides.delete(id);for(const id of this.signatures.keys())if(!keep.has(id))this.signatures.delete(id)
    for(const id of this.historyContext.keys())if(!keep.has(id))this.historyContext.delete(id)
    const entry=queue[index];if(entry)this.begin(entry,automatic)
  }
  private control(action:'resume'|'pause'|'next'|'previous'|'stop'):void{
    if(action==='stop'){
      this.flushHistory();this.generation++;this.release();this.state.phase='idle';this.state.desiredPlaying=false;this.state.currentId=null;this.state.now=null;this.state.positionMs=0;this.state.durationMs=null;this.state.reason=null;this.state.retryAt=null;this.emit();return
    }
    if(action==='pause'){
      this.state.desiredPlaying=false;this.clearTimer();if(!['idle','needs_review','error','resolving'].includes(this.state.phase))this.state.phase='paused';this.flushHistory();this.emit();return
    }
    if(action==='resume'){
      const current=this.current()??this.state.queue[0];if(!current)return
      if(!this.state.media){if(this.state.phase==='resolving'){this.state.desiredPlaying=true;this.emit()}else this.begin(current,false);return}
      this.state.desiredPlaying=true;this.state.reason=null;this.state.phase='loading';this.watchdog();this.emit();return
    }
    if(action==='previous'&&this.state.positionMs>3000&&this.state.media){this.seek(0);return}
    const current=this.current(),index=this.state.queue.findIndex(item=>item.id===current?.id)
    let entry:QueueEntry|undefined
    if(action==='previous'&&this.state.mode==='shuffle'){
      while(this.navigationIndex>0&&!entry){this.navigationIndex--;entry=this.state.queue.find(item=>item.id===this.navigation[this.navigationIndex])}
      if(entry)this.begin(entry,false,false,false)
    }else if(action==='previous'){entry=this.state.queue[Math.max(0,index-1)];if(entry)this.begin(entry,false)}
    else{this.pass.clear();entry=this.nextEntry(false)??undefined;if(entry)this.begin(entry,true);else this.finishQueue(false)}
  }
  private seek(position:number):void{
    if(!this.state.media)return
    const target=Math.max(0,Math.min(position,this.state.durationMs??this.state.now?.expectedDurationMs??position))
    this.state.seekToMs=target;this.state.seekSerial++;this.state.positionMs=target;this.lastPosition=target;this.lastProgressAt=this.clock();this.emit()
  }
  private begin(entry:QueueEntry,automatic:boolean,force=false,recordNavigation=true):void{
    this.flushHistory();this.release();this.generation++;this.attempts={used:0,limit:2};this.rateWaits=0;this.automatic=automatic
    if(!automatic){this.pass.clear();this.state.skipped=[]}
    this.history=null;this.historyStarted=false;this.coverage=[];this.lastPosition=0;this.lastProgressAt=this.clock();this.lastHistorySave=0
    this.state.currentId=entry.id;this.state.now=null;this.state.phase='resolving';this.state.desiredPlaying=true;this.state.positionMs=0;this.state.durationMs=null;this.state.seekToMs=0;this.state.seekSerial++;this.state.reason=null;this.state.retryAt=null
    if(recordNavigation){this.navigation.splice(this.navigationIndex+1);this.navigation.push(entry.id);if(this.navigation.length>20000)this.navigation.shift();this.navigationIndex=this.navigation.length-1}
    this.emit();void this.resolveCurrent(force,false)
  }
  private async resolveCurrent(force:boolean,recovery:boolean):Promise<void>{
    const epoch=this.generation,entry=this.current();if(!entry)return
    try{
      if(entry.target.kind==='original'&&this.signatures.get(entry.id)!==this.db.originalSignature(entry.target.reference))throw new PlayerError('TRACK_CHANGED')
      const resolved=await this.sources.resolve(entry.target,{attempts:this.attempts,force,recovery,override:this.overrides.get(entry.id),isCurrent:()=>epoch===this.generation})
      if(epoch!==this.generation)return
      const context=this.historyContext.get(entry.id)
      if(context)resolved.now={...resolved.now,reference:context.reference,original:context.original,collectionName:context.collectionName,binding:context.binding,expectedDurationMs:resolved.now.expectedDurationMs??context.observedDurationMs??null}
      const media=this.media.register(resolved.stream)
      this.state.now=resolved.now;this.state.media=media;this.state.phase=this.state.desiredPlaying?'loading':'paused';this.state.reason=null;this.state.retryAt=null
      this.state.seekToMs=this.state.positionMs;this.state.seekSerial++;if(this.state.desiredPlaying)this.watchdog();this.emit()
    }catch(error){
      if(epoch!==this.generation)return
      if(error instanceof SourceError&&error.code==='SOURCE_RATE_LIMITED'&&this.rateWaits<1&&this.attempts.used<this.attempts.limit){
        const retryAt=Math.max(this.clock()+100,error.retryAt??this.clock()+60000)
        if(retryAt-this.clock()<=300000){
          this.rateWaits++;this.state.phase='waiting_retry';this.state.retryAt=retryAt;this.state.reason='音源请求较多，等待额度恢复。可暂停或切换歌曲。';this.emit()
          this.clearTimer();if(this.state.desiredPlaying)this.timer=setTimeout(()=>{this.timer=null;if(epoch!==this.generation)return;this.state.phase='resolving';this.emit();void this.resolveCurrent(force,recovery)},retryAt-this.clock()+30)
          return
        }
      }
      this.failed(error)
    }
  }
  private watchdog():void{
    this.clearTimer();const epoch=this.generation
    this.timer=setTimeout(()=>{this.timer=null;if(epoch===this.generation&&this.state.desiredPlaying)this.mediaFailed(new PlayerError('MEDIA_STALLED'))},this.options.stallMs??20000)
  }
  event(event:MediaEvent):void{
    this.accountChanged();if(event.id!==this.state.media?.id)return
    if(event.durationMs!==null){
      this.state.durationMs=event.durationMs
      if(this.state.now)this.state.now.observedDurationMs=event.durationMs
      const expected=this.state.now?.expectedDurationMs
      if(expected!=null&&Math.abs(event.durationMs-expected)>2000){const candidate=this.state.now?.candidate??null;this.release();this.sources.invalidate(candidate);this.failed(new PlayerError('MEDIA_DURATION_MISMATCH',true));return}
    }
    const quality=this.media.quality(event.id)
    if(quality&&this.state.now){this.state.now.format=quality.format;this.state.now.verifiedBitrateKbps=quality.bitrateKbps}
    switch(event.type){
      case'metadata':this.state.phase=this.state.desiredPlaying?'loading':'paused';break
      case'playing':{
        if(!this.state.desiredPlaying)return
        this.clearTimer();this.state.phase='playing';this.state.reason=null;this.pass.clear();this.shuffleVisited.add(this.state.currentId!)
        const current=this.current();if(current?.target.kind==='original')this.db.clearIssue(current.target.reference)
        if(!this.historyStarted&&this.state.now&&current){this.historyStarted=true;this.history={id:randomUUID(),at:new Date(this.clock()).toISOString(),target:structuredClone(current.target),now:structuredClone(this.state.now),playedMs:0,completed:false};this.revision();this.flushHistory()}
        this.lastPosition=event.positionMs;this.lastProgressAt=this.clock();break
      }
      case'paused':if(!this.state.desiredPlaying){this.state.phase='paused';this.clearTimer();this.flushHistory()}break
      case'seeking':this.lastPosition=event.positionMs;this.lastProgressAt=this.clock();break
      case'progress':{
        const now=this.clock(),difference=event.positionMs-this.lastPosition,elapsed=now-this.lastProgressAt
        if(this.history&&this.state.phase==='playing'&&this.state.desiredPlaying&&difference>0&&difference<=Math.max(1500,elapsed*1.5)){
          this.history.playedMs+=difference;this.coverage.push({start:this.lastPosition,end:event.positionMs})
          const merged:typeof this.coverage=[]
          for(const span of this.coverage.sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&span.start<=last.end+300)last.end=Math.max(last.end,span.end);else merged.push({...span})}this.coverage=merged
        }
        this.lastPosition=event.positionMs;this.lastProgressAt=now
        this.state.positionMs=event.positionMs
        if(now-this.lastHistorySave>5000)this.flushHistory()
        if(this.state.phase==='loading'&&this.state.desiredPlaying)this.watchdog()
        break
      }
      case'waiting':if(this.state.desiredPlaying){this.state.phase='loading';this.watchdog()}break
      case'error':this.mediaFailed(new PlayerError(event.code===5?'MEDIA_PLAY_BLOCKED':this.media.failure(event.id)??(event.code===3?'MEDIA_DECODE_ERROR':'MEDIA_UNAVAILABLE')));return
      case'ended':{
        if(!this.state.desiredPlaying)return
        this.state.positionMs=event.positionMs
        if(this.history){this.history.completed=this.state.durationMs!==null&&this.coverage.length===1&&this.coverage[0]!.start<500&&this.coverage[0]!.end>=this.state.durationMs-600;this.flushHistory()}
        const current=this.current();if(current)this.overrides.delete(current.id)
        const next=this.nextEntry(true);if(next)this.begin(next,true);else this.finishQueue(false);return
      }
    }this.emit()
  }
  private mediaFailed(error:PlayerError):void{
    if(error.code==='MEDIA_PLAY_BLOCKED'){this.state.desiredPlaying=false;this.state.phase='paused';this.state.reason=playerMessage(error);this.clearTimer();this.emit();return}
    if(this.state.now?.candidate&&this.attempts.used<this.attempts.limit){
      const candidate=this.state.now.candidate;this.release();this.sources.invalidate(candidate);this.generation++;this.state.phase='resolving';this.state.reason='正在重新获取播放资源…';this.emit();void this.resolveCurrent(true,true);return
    }
    this.failed(error)
  }
  private failed(error:unknown):void{
    const entry=this.current(),reason=playerMessage(error);this.flushHistory();this.release();this.generation++
    if(entry?.target.kind==='original'){this.db.setIssue(entry.target.reference,reason);this.revision()}
    if(entry){this.pass.add(entry.id);this.state.skipped.push({queueId:entry.id,title:entry.title,reason})}
    if(error instanceof SourceError&&error.code==='SOURCE_RATE_LIMITED'){
      this.state.phase='error';this.state.desiredPlaying=false;this.state.reason='音源请求暂不可用，队列已停止。可稍后重试。';this.state.retryAt=null;this.emit();return
    }
    if(this.automatic&&this.pass.size>=20&&this.pass.size<this.state.queue.length){
      this.state.phase='error';this.state.desiredPlaying=false;this.state.reason='连续 20 首未能播放，已停止。其余曲目尚未检查。';this.emit();return
    }
    if(this.automatic&&this.state.mode!=='repeat_one'){
      const next=this.nextEntry(false);if(next){this.begin(next,true);return}
      this.finishQueue(true);return
    }
    this.state.phase=error instanceof PlayerError&&error.review?'needs_review':'error';this.state.desiredPlaying=false;this.state.reason=reason;this.state.retryAt=null;this.emit()
  }
  private nextEntry(ended:boolean):QueueEntry|null{
    const current=this.current(),index=this.state.queue.findIndex(item=>item.id===current?.id)
    if(ended&&this.state.mode==='repeat_one')return current
    if(this.state.mode==='shuffle'){
      let choices=this.state.queue.filter(item=>item.id!==current?.id&&!this.pass.has(item.id)&&!this.shuffleVisited.has(item.id))
      if(!choices.length){this.shuffleVisited.clear();choices=this.state.queue.filter(item=>!this.pass.has(item.id)&&(item.id!==current?.id||ended&&this.state.queue.length===1))}
      return choices[Math.min(choices.length-1,Math.floor((this.options.random??Math.random)()*choices.length))]??null
    }
    return this.state.queue.slice(index+1).find(item=>!this.pass.has(item.id))??null
  }
  private finishQueue(failed:boolean):void{
    this.flushHistory();this.release();this.generation++;this.state.desiredPlaying=false;this.state.phase=failed?'error':'ended';this.state.retryAt=null
    this.state.reason=failed?'队列中没有可继续播放的歌曲，已停止。':null;this.emit()
  }
  private flushHistory():void{
    if(!this.history)return
    if(this.state.now)this.history.now=structuredClone(this.state.now)
    this.db.addHistory(this.history,this.accountKey);this.lastHistorySave=this.clock()
  }
  clearHistory():void{this.history=null;this.historyStarted=true;this.db.clearHistory();this.revision();this.emit()}
  libraryChanged():void{this.revision();this.emit()}
  playHistory(id:string):PlayerState{
    const history=this.db.getHistoryEntry(id);if(!history)throw new PlayerError('TRACK_NOT_FOUND')
    let target:PlaybackTarget|null=null
    if(history.now.candidate){this.sources.rememberSnapshot(history.now.candidate);target={kind:'candidate',candidate:{providerId:history.now.candidate.providerId,sourceId:history.now.candidate.sourceId,trackId:history.now.candidate.trackId}}}
    else if(history.now.localId){if(!this.sources.localMatches(history.now))throw new PlayerError('LOCAL_FILE_MISSING');target={kind:'local',localId:history.now.localId}}
    if(target){const entry=this.makeEntry(target);entry.collectionName=history.now.collectionName;this.historyContext.set(entry.id,history.now);this.replace([entry],0);return this.snapshot()}
    return this.command({type:'play',target:history.target})
  }
  close():void{this.flushHistory();this.generation++;this.release()}
}
