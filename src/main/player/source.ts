import type {MusicDatabase} from '../database.ts'
import type {MusicSourceService} from '../music/service.ts'
import type {GdNeteaseAdapter,PlaybackAttempts} from '../music/gd.ts'
import type {CandidateId,SourceCandidate,TrackReference} from '../../shared/music.ts'
import {candidateKey} from '../../shared/music.ts'
import type {PlaybackNow,PlaybackTarget,QueueEntry} from '../../shared/playback.ts'
import type {Track} from '../../shared/contracts.ts'
import type {StreamSource} from './media.ts'
import type {SongCache} from './cache.ts'
import {compareCandidate} from '../music/matching.ts'
import {candidateVersion} from '../music/catalog.ts'
import {PlayerError} from './errors.ts'
import {SourceError} from '../music/errors.ts'
import {publicTrack,withoutAudioExtension} from '../../shared/track-name.ts'

export interface ResolvedPlayback {now:PlaybackNow;stream:StreamSource}
export interface ResolveOptions {attempts:PlaybackAttempts;force?:boolean;recovery?:boolean;override?:SourceCandidate;isCurrent?:()=>boolean}
const publicOriginal=(value:Track):Track=>publicTrack({position:value.position,title:value.title,filename:value.filename,artist:value.artist,album:value.album,durationMs:value.durationMs,version:value.version})
export class PlaybackSources {
  private db:MusicDatabase
  private music:MusicSourceService
  private adapter:GdNeteaseAdapter
  private cache:SongCache
  constructor(db:MusicDatabase,music:MusicSourceService,adapter:GdNeteaseAdapter,cache:SongCache){this.db=db;this.music=music;this.adapter=adapter;this.cache=cache}
  candidate(id:CandidateId,snapshot?:SourceCandidate):SourceCandidate{
    const item=snapshot??this.db.getSourceCache<SourceCandidate>('candidate',candidateKey(id))
    if(!item||candidateKey(item)!==candidateKey(id))throw new SourceError('CANDIDATE_NOT_FOUND')
    return item
  }
  rememberSnapshot(candidate:SourceCandidate):void{this.db.setSourceCache('candidate',candidateKey(candidate),candidate,86400000)}
  localMatches(now:PlaybackNow):boolean{const local=now.localId?this.db.getLocal(now.localId):null;return Boolean(local&&!local.missing&&(!now.localStamp||now.localStamp===local.size+':'+local.mtime))}
  describe(target:PlaybackTarget):Omit<QueueEntry,'id'|'target'>{
    if(target.kind==='original'){
      const presentation=this.db.getTrackPresentation(target.reference)
      if(!presentation)throw new PlayerError('TRACK_NOT_FOUND')
      const track=presentation.track
      return{title:withoutAudioExtension(track.title??track.filename??'标题待补充'),artist:track.artist,collectionName:presentation.collectionName}
    }
    if(target.kind==='local'){
      const local=this.db.getLocal(target.localId);if(!local)throw new PlayerError('LOCAL_FILE_MISSING')
      return{title:local.name,artist:null,collectionName:null}
    }
    const candidate=this.candidate(target.candidate)
    return{title:candidate.title,artist:candidate.artists.join('、')||null,collectionName:null}
  }
  choose(reference:TrackReference,id:CandidateId,persistence:'once'|'remember'):SourceCandidate{
    const original=this.db.getOriginal(reference);if(!original)throw new PlayerError('TRACK_NOT_FOUND')
    const candidate=this.candidate(id),same=compareCandidate(original,candidate).decision==='matched'
    if(persistence==='remember')this.db.saveBinding(reference,same?'original':'alternative',{target:{kind:'candidate',candidate:id},candidate})
    return candidate
  }
  linkLocal(reference:TrackReference,localId:string):void{
    const local=this.db.getLocal(localId);if(!local||local.missing)throw new PlayerError('LOCAL_FILE_MISSING')
    this.db.saveBinding(reference,'local',{target:{kind:'local',localId}})
  }
  restore(reference:TrackReference):void{this.db.restoreOriginal(reference)}
  async resolve(target:PlaybackTarget,options:ResolveOptions):Promise<ResolvedPlayback>{
    let reference:TrackReference|null=null,original:Track|null=null,collectionName:string|null=null
    let localId:string|null=target.kind==='local'?target.localId:null,candidate:SourceCandidate|null=null,binding:PlaybackNow['binding']='direct'
    if(target.kind==='original'){
      reference=target.reference
      const value=this.db.getOriginal(reference),collection=this.db.getCollection(reference.collectionId),signature=this.db.originalSignature(reference)
      if(!value||!collection)throw new PlayerError('TRACK_NOT_FOUND')
      original=publicOriginal(value);collectionName=collection.collection.name
      const saved=this.db.getBinding(reference)
      if(options.override){candidate=options.override;binding=compareCandidate(value,candidate).decision==='matched'?'same':'alternative'}
      else if(saved?.target.kind==='local'){localId=saved.target.localId;binding='local'}
      else if(saved?.target.kind==='candidate'){
        candidate=this.candidate(saved.target.candidate,saved.candidate);binding=compareCandidate(value,candidate).decision==='matched'?'same':'alternative'
      }else{
        const match=await this.music.match(reference,options.force)
        if(options.isCurrent&&!options.isCurrent())throw new PlayerError('PLAYBACK_CANCELLED')
        if(signature!==this.db.originalSignature(reference))throw new PlayerError('TRACK_CHANGED')
        const latest=this.db.getBinding(reference)
        if(latest?.target.kind==='local'){localId=latest.target.localId;binding='local'}
        else if(latest?.target.kind==='candidate'){candidate=this.candidate(latest.target.candidate,latest.candidate);binding=compareCandidate(value,candidate).decision==='matched'?'same':'alternative'}
        else{
          candidate=match.candidates.find(item=>candidateKey(item.candidate)===match.automaticCandidate)?.candidate??null
          if(!candidate)throw new PlayerError(match.status==='not_found'?'NO_ORIGINAL':'NEEDS_VERSION',true)
          binding='same';this.db.saveBinding(reference,'original',{target:{kind:'candidate',candidate:{providerId:candidate.providerId,sourceId:candidate.sourceId,trackId:candidate.trackId}},candidate},false)
        }
      }
    }else if(target.kind==='candidate')candidate=this.candidate(target.candidate)
    if(localId){
      const local=this.db.getLocal(localId);if(!local||local.missing)throw new PlayerError('LOCAL_FILE_MISSING')
      return{stream:{kind:'file',filename:local.filename,size:local.size,mtime:local.mtime,mime:local.format==='MP3'?'audio/mpeg':local.format==='FLAC'?'audio/flac':'audio/wav'},
        now:{title:local.name,artist:null,album:null,version:null,expectedDurationMs:local.durationMs,reference,original,collectionName,candidate:null,localId,binding:reference?'local':'direct',source:'本地文件',localStamp:local.size+':'+local.mtime,format:local.format,returnedBitrateKbps:null,verifiedBitrateKbps:local.bitrateKbps,qualityCode:null,fromCache:false}}
    }
    if(!candidate)throw new PlayerError('MEDIA_UNAVAILABLE')
    const identity=candidateKey(candidate),cached=options.force||options.recovery?null:this.cache.lookup(identity)
    const now:PlaybackNow={title:candidate.title,artist:candidate.artists.join('、')||null,album:candidate.album,version:candidateVersion(candidate.title),expectedDurationMs:candidate.durationMs,reference,original,collectionName,candidate,localId:null,binding,source:'GD 音乐台 · 网易云',format:null,returnedBitrateKbps:null,verifiedBitrateKbps:null,qualityCode:null,fromCache:Boolean(cached)}
    if(cached)return{now:{...now,format:cached.format,returnedBitrateKbps:cached.bitrate,verifiedBitrateKbps:cached.verifiedBitrate??null,qualityCode:cached.qualityCode},stream:{kind:'file',filename:cached.filename,size:cached.size,mtime:cached.mtime,mime:cached.mime,cacheIdentity:identity}}
    const address=await this.adapter.resolvePlayback(candidate,{attempts:options.attempts,force:options.force||options.recovery,lowQuality:options.recovery})
    return{now:{...now,returnedBitrateKbps:address.bitrate,qualityCode:address.qualityCode},stream:{kind:'remote',url:address.url,cacheMetadata:{identity,format:null,bitrate:address.bitrate,qualityCode:address.qualityCode,durationMs:candidate.durationMs}}}
  }
  invalidate(candidate:SourceCandidate|null):void{if(candidate)this.cache.invalidate(candidateKey(candidate))}
}
