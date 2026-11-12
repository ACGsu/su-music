import type { Track } from './contracts.ts'
import type { CandidateId, SourceCandidate, TrackReference } from './music.ts'
import { validateCandidateId, validateTrackReference } from './music.ts'

export type PlaybackMode='sequence'|'shuffle'|'repeat_one'
export type PlaybackTarget={kind:'original';reference:TrackReference}|{kind:'candidate';candidate:CandidateId}|{kind:'local';localId:string}
export interface QueueEntry {id:string;target:PlaybackTarget;title:string;artist:string|null;collectionName:string|null}
export interface PlaybackNow {
  title:string;artist:string|null;album:string|null;version:string|null;expectedDurationMs:number|null;observedDurationMs?:number
  reference:TrackReference|null;original:Track|null;collectionName:string|null;candidate:SourceCandidate|null;localId:string|null
  binding:'same'|'alternative'|'local'|'direct';source:string;localStamp?:string
  format:string|null;returnedBitrateKbps:number|null;verifiedBitrateKbps:number|null;qualityCode:number|null;fromCache:boolean
}
export type PlayerPhase='idle'|'resolving'|'loading'|'playing'|'paused'|'waiting_retry'|'needs_review'|'error'|'ended'
export interface PlayerState {
  phase:PlayerPhase;queue:QueueEntry[];currentId:string|null;mode:PlaybackMode;now:PlaybackNow|null
  media:{id:string;url:string}|null;desiredPlaying:boolean;positionMs:number;durationMs:number|null;seekToMs:number;seekSerial:number
  reason:string|null;retryAt:number|null;skipped:{queueId:string;title:string;reason:string}[];historyRevision:number
}
export interface MediaEvent {id:string;type:'metadata'|'playing'|'paused'|'progress'|'ended'|'error'|'waiting'|'seeking';positionMs:number;durationMs:number|null;code?:number}
export interface LocalTrack {id:string;name:string;format:string;durationMs:number|null;bitrateKbps:number|null;missing:boolean;addedAt:string}
export interface HistoryEntry {id:string;at:string;target:PlaybackTarget;now:PlaybackNow;playedMs:number;completed:boolean}
export interface ProblemTrack {reference:TrackReference;title:string;collectionName:string;reason:string;status:string}
export interface AudioCacheState {directory:string;usingDefault:boolean;bytes:number;tracks:number;limitBytes:number;warning:string|null}
export interface PlaybackLibrary {local:LocalTrack[];history:HistoryEntry[];issues:ProblemTrack[];cache:AudioCacheState}
export type PlayerCommand =
  {type:'play';target:PlaybackTarget}|{type:'play_collection';collectionId:string;position:number;skipUnavailable?:boolean}|
  {type:'enqueue';target:PlaybackTarget;placement:'next'|'end'}|{type:'control';action:'resume'|'pause'|'next'|'previous'|'stop'}|
  {type:'seek';positionMs:number}|{type:'mode';mode:PlaybackMode}|{type:'queue_jump';id:string}|
  {type:'queue_remove';id:string}|{type:'queue_move';id:string;index:number}|
  {type:'choose';reference:TrackReference;candidate:CandidateId;persistence:'once'|'remember'}|
  {type:'restore_original';reference:TrackReference}|{type:'link_local';reference:TrackReference;localId:string}|{type:'retry'}

function plain(input:unknown,keys:string[]):Record<string,unknown>{
  if(typeof input!=='object'||input===null||Array.isArray(input))throw new Error('INVALID_REQUEST')
  const p=Object.getPrototypeOf(input);if(p!==Object.prototype&&p!==null||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!keys.includes(key)))throw new Error('INVALID_REQUEST')
  return input as Record<string,unknown>
}
const id=(value:unknown):string=>{if(typeof value!=='string'||!value||value.length>128||!/^[-\w]+$/.test(value))throw new Error('INVALID_REQUEST');return value}
export function validatePlaybackTarget(input:unknown):PlaybackTarget{
  const value=plain(input,['kind','reference','candidate','localId'])
  if(value.kind==='original'&&Object.keys(value).length===2)return{kind:'original',reference:validateTrackReference(value.reference)}
  if(value.kind==='candidate'&&Object.keys(value).length===2)return{kind:'candidate',candidate:validateCandidateId(value.candidate)}
  if(value.kind==='local'&&Object.keys(value).length===2)return{kind:'local',localId:id(value.localId)}
  throw new Error('INVALID_REQUEST')
}
export function validatePlayerCommand(input:unknown):PlayerCommand{
  const all=plain(input,['type','target','collectionId','position','placement','action','positionMs','mode','id','index','reference','candidate','persistence','localId','skipUnavailable'])
  const keys:Record<string,string[]>={play:['type','target'],play_collection:['type','collectionId','position'],enqueue:['type','target','placement'],control:['type','action'],seek:['type','positionMs'],mode:['type','mode'],queue_jump:['type','id'],queue_remove:['type','id'],queue_move:['type','id','index'],choose:['type','reference','candidate','persistence'],restore_original:['type','reference'],link_local:['type','reference','localId'],retry:['type']}
  const type=String(all.type),extra=type==='play_collection'&&Object.hasOwn(all,'skipUnavailable')?1:0
  if(!Object.hasOwn(keys,type)||Object.keys(all).length!==keys[type]!.length+extra||Object.keys(all).some(key=>!keys[type]!.includes(key)&&!(extra&&key==='skipUnavailable')))throw new Error('INVALID_REQUEST')
  switch(type){
    case'play':return{type,target:validatePlaybackTarget(all.target)}
    case'play_collection':{if(extra&&typeof all.skipUnavailable!=='boolean')break;const reference=validateTrackReference({collectionId:all.collectionId,position:all.position});return{type,collectionId:reference.collectionId,position:reference.position,...(extra?{skipUnavailable:all.skipUnavailable as boolean}:{})}}
    case'enqueue':if(all.placement!=='next'&&all.placement!=='end')break;return{type,target:validatePlaybackTarget(all.target),placement:all.placement}
    case'control':if(!['resume','pause','next','previous','stop'].includes(String(all.action)))break;return{type,action:all.action as 'resume'|'pause'|'next'|'previous'|'stop'}
    case'seek':if(typeof all.positionMs!=='number'||!Number.isFinite(all.positionMs)||all.positionMs<0||all.positionMs>86400000)break;return{type,positionMs:all.positionMs}
    case'mode':if(!['sequence','shuffle','repeat_one'].includes(String(all.mode)))break;return{type,mode:all.mode as PlaybackMode}
    case'queue_jump':case'queue_remove':return{type,id:id(all.id)}
    case'queue_move':if(typeof all.index!=='number'||!Number.isSafeInteger(all.index)||all.index<0||all.index>20000)break;return{type,id:id(all.id),index:all.index}
    case'choose':if(all.persistence!=='once'&&all.persistence!=='remember')break;return{type,reference:validateTrackReference(all.reference),candidate:validateCandidateId(all.candidate),persistence:all.persistence}
    case'restore_original':return{type,reference:validateTrackReference(all.reference)}
    case'link_local':return{type,reference:validateTrackReference(all.reference),localId:id(all.localId)}
    case'retry':return{type}
  }throw new Error('INVALID_REQUEST')
}
export function validateMediaEvent(input:unknown):MediaEvent{
  const value=plain(input,['id','type','positionMs','durationMs','code'])
  if(!['metadata','playing','paused','progress','ended','error','waiting','seeking'].includes(String(value.type))||typeof value.positionMs!=='number'||!Number.isFinite(value.positionMs)||value.positionMs<0||value.positionMs>86400000||value.durationMs!==null&&(typeof value.durationMs!=='number'||!Number.isFinite(value.durationMs)||value.durationMs<=0||value.durationMs>86400000)||value.code!==undefined&&(typeof value.code!=='number'||!Number.isInteger(value.code)||value.code<0||value.code>10))throw new Error('INVALID_REQUEST')
  return{id:id(value.id),type:value.type as MediaEvent['type'],positionMs:value.positionMs,durationMs:value.durationMs as number|null,...(value.code!==undefined?{code:value.code as number}:{})}
}
