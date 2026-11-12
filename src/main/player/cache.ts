import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import type {AudioCacheState} from '../../shared/playback.ts'
import type {MusicDatabase} from '../database.ts'
import {inspectAudioHeader} from '../music/audio.ts'

const LIMIT=2*1024*1024*1024,MAX_TRACK=512*1024*1024
const MARKER='.su-music-cache.json',MARKER_VALUE='su-music-audio-cache-v1'
export interface CacheMetadata {identity:string;format:string|null;bitrate:number|null;qualityCode:number|null;durationMs:number|null;verifiedBitrate?:number|null}
export interface CachedAudio extends CacheMetadata {key:string;filename:string;size:number;mtime:number;mime:string;lastAccess:number}
const managed=(name:string):boolean=>/^[a-f0-9]{64}\.(audio|json)$/.test(name)||/^[a-f0-9]{64}\.[a-f0-9-]{36}\.part$/.test(name)

// Only the native directory dialog supplies a custom root. File paths never cross the bridge.
export class SongCache {
  private root:string
  private readonly defaultRoot:string
  private warning:string|null=null
  private writers=new Set<CacheWriter>()
  private pins=new Set<string>()
  private db:MusicDatabase
  private limit:number
  constructor(db:MusicDatabase,userData:string,limit=LIMIT){
    this.db=db;this.limit=limit
    this.defaultRoot=path.resolve(userData,'Audio Cache')
    const saved=db.getSetting<unknown>('audio-cache-directory',null)
    this.root=typeof saved==='string'&&path.isAbsolute(saved)?path.resolve(saved):this.defaultRoot
    try{this.prepare(this.root);this.cleanPartial(this.root)}catch{this.warning='缓存目录暂不可写，播放仍可使用在线资源。'}
  }
  private prepare(directory:string):void{
    fs.mkdirSync(directory,{recursive:true})
    const marker=path.join(directory,MARKER)
    if(fs.existsSync(marker)){
      if(fs.lstatSync(marker).isSymbolicLink()||fs.readFileSync(marker,'utf8')!==MARKER_VALUE)throw new Error('CACHE_DIRECTORY_INVALID')
    }else{
      // An existing, nonempty user folder is never taken over as an application cache.
      if(fs.readdirSync(directory).length)throw new Error('CACHE_DIRECTORY_INVALID')
      fs.writeFileSync(marker,MARKER_VALUE,{flag:'wx'})
    }
    const probe=path.join(directory,createHash('sha256').update(randomUUID()).digest('hex')+'.'+randomUUID()+'.part')
    fs.writeFileSync(probe,'',{flag:'wx'});fs.unlinkSync(probe)
  }
  choose(parent:string):AudioCacheState{
    const selected=fs.realpathSync(parent),root=this.safeRoot(selected)?selected:path.join(selected,'Su Music Cache')
    this.prepare(root);const next=fs.realpathSync(root)
    this.db.setSetting('audio-cache-directory',next);this.root=next;this.warning=null;this.cleanPartial(this.root)
    return this.snapshot()
  }
  reset():AudioCacheState{
    this.prepare(this.defaultRoot);this.db.setSetting('audio-cache-directory',null);this.root=this.defaultRoot;this.warning=null
    return this.snapshot()
  }
  private safeRoot(root:string):boolean{
    try{return fs.readFileSync(path.join(root,MARKER),'utf8')===MARKER_VALUE&&!fs.lstatSync(path.join(root,MARKER)).isSymbolicLink()}catch{return false}
  }
  private cleanPartial(root:string):void{
    if(!this.safeRoot(root))return
    const active=new Set([...this.writers].map(writer=>writer.filename))
    for(const name of fs.readdirSync(root))if(managed(name)&&name.endsWith('.part')){
      const file=path.join(root,name);if(!active.has(file)&&!fs.lstatSync(file).isSymbolicLink())fs.unlinkSync(file)
    }
  }
  private entries(root=this.root):CachedAudio[]{
    if(!this.safeRoot(root))return[]
    const result:CachedAudio[]=[]
    for(const name of fs.readdirSync(root).slice(0,10000))if(/^[a-f0-9]{64}\.json$/.test(name)){
      try{
        const sidecar=path.join(root,name),sideStat=fs.lstatSync(sidecar)
        if(!sideStat.isFile()||sideStat.isSymbolicLink()||sideStat.size>16384)continue
        const row=JSON.parse(fs.readFileSync(sidecar,'utf8')) as CachedAudio,filename=path.join(root,name.slice(0,-5)+'.audio'),stat=fs.lstatSync(filename)
        if(row.key!==name.slice(0,-5)||!/^gd:netease:[1-9]\d{0,17}$/.test(row.identity)||!['MP3','FLAC','WAV'].includes(row.format??'')||!stat.isFile()||stat.isSymbolicLink()||stat.size!==row.size||stat.mtimeMs!==row.mtime||row.size<=0||row.size>MAX_TRACK)continue
        result.push({...row,filename})
      }catch{}
    }return result
  }
  lookup(identity:string):CachedAudio|null{
    const found=this.entries().filter(item=>item.identity===identity).sort((a,b)=>(b.bitrate??0)-(a.bitrate??0)||b.lastAccess-a.lastAccess)[0]
    if(!found)return null
    found.lastAccess=Date.now()
    try{this.saveMetadata(found)}catch{}
    return found
  }
  private saveMetadata(record:CachedAudio):void{
    const {filename:_filename,...row}=record,sidecar=path.join(path.dirname(record.filename),record.key+'.json')
    const temporary=path.join(path.dirname(sidecar),record.key+'.'+randomUUID()+'.part')
    try{fs.writeFileSync(temporary,JSON.stringify(row),{flag:'wx'});fs.renameSync(temporary,sidecar)}finally{try{fs.unlinkSync(temporary)}catch{}}
  }
  snapshot():AudioCacheState{
    const entries=this.entries()
    return{directory:this.root,usingDefault:path.resolve(this.root)===this.defaultRoot,bytes:entries.reduce((sum,item)=>sum+item.size,0),tracks:entries.length,limitBytes:this.limit,warning:this.warning}
  }
  createWriter(metadata:CacheMetadata,total:number,mime:string):CacheWriter|null{
    if(!Number.isSafeInteger(total)||total<=0||total>MAX_TRACK||total>this.limit)return null
    try{
      if(!this.safeRoot(this.root))return null
      const writer=new CacheWriter(this.root,metadata,total,mime,(record)=>{
        this.saveMetadata(record);this.warning=null;this.prune(path.dirname(record.filename),record.filename)
      },()=>{this.warning='歌曲缓存未能写入，播放仍可继续。'},writer=>this.writers.delete(writer))
      this.writers.add(writer);return writer
    }catch{this.warning='歌曲缓存未能写入，播放仍可继续。';return null}
  }
  private removeEntry(record:CachedAudio):void{
    if(this.pins.has(record.filename))return
    for(const file of [record.filename,path.join(path.dirname(record.filename),record.key+'.json')]){
      try{if(!fs.lstatSync(file).isSymbolicLink())fs.unlinkSync(file)}catch{}
    }
  }
  private prune(root:string,keep:string):void{
    const entries=this.entries(root).sort((a,b)=>a.lastAccess-b.lastAccess);let total=entries.reduce((sum,item)=>sum+item.size,0)
    for(const row of entries)if(total>this.limit&&row.filename!==keep&&!this.pins.has(row.filename)){this.removeEntry(row);total-=row.size}
  }
  pin(filename:string):void{this.pins.add(filename)}
  unpin(filename:string):void{this.pins.delete(filename)}
  invalidate(identity:string):void{for(const row of this.entries())if(row.identity===identity)this.removeEntry(row)}
  clear(protectedFiles:string[]=[]):AudioCacheState{
    if(!this.safeRoot(this.root)){this.warning='缓存目录暂不可用，请选择其他位置。';return this.snapshot()}
    for(const writer of [...this.writers])if(path.dirname(writer.filename)===this.root)writer.abort()
    const keep=new Set(protectedFiles.map(file=>path.resolve(file)))
    for(const name of fs.readdirSync(this.root))if(managed(name)){
      const file=path.join(this.root,name),audio=name.endsWith('.json')?path.join(this.root,name.slice(0,-5)+'.audio'):file
      if(!keep.has(path.resolve(audio))&&!this.pins.has(audio))try{if(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink())fs.unlinkSync(file)}catch{}
    }
    this.cleanPartial(this.root)
    this.warning=keep.size?'当前正在播放的缓存会保留，其余歌曲缓存已清理。':null
    return this.snapshot()
  }
  close():void{for(const writer of [...this.writers])writer.abort()}
}

export class CacheWriter {
  readonly filename:string
  private fd:number|null
  private ranges:{start:number;end:number}[]=[]
  private finished=false
  private metadata:CacheMetadata
  readonly total:number
  private mime:string
  private completed:(record:CachedAudio)=>void
  private failed:()=>void
  private released:(writer:CacheWriter)=>void
  constructor(root:string,metadata:CacheMetadata,total:number,mime:string,
    completed:(record:CachedAudio)=>void,failed:()=>void,released:(writer:CacheWriter)=>void){
    this.metadata=metadata;this.total=total;this.mime=mime;this.completed=completed;this.failed=failed;this.released=released
    const key=createHash('sha256').update(metadata.identity+'\n'+(metadata.qualityCode??metadata.bitrate??'unknown')).digest('hex')
    this.filename=path.join(root,key+'.'+randomUUID()+'.part');this.fd=fs.openSync(this.filename,'wx+')
  }
  write(start:number,bytes:Uint8Array):void{
    if(this.finished||this.fd===null)return
    if(start<0||!Number.isSafeInteger(start)||start+bytes.byteLength>this.total){this.abort();return}
    try{
      const buffer=Buffer.from(bytes);let offset=0
      while(offset<buffer.length){const written=fs.writeSync(this.fd,buffer,offset,buffer.length-offset,start+offset);if(!written)throw new Error('CACHE_WRITE_FAILED');offset+=written}
      this.ranges.push({start,end:start+bytes.byteLength})
      const sorted=this.ranges.sort((a,b)=>a.start-b.start),merged:typeof this.ranges=[]
      for(const item of sorted){const last=merged.at(-1);if(last&&item.start<=last.end)last.end=Math.max(last.end,item.end);else merged.push({...item})}
      this.ranges=merged
    }catch{this.failed();this.abort()}
  }
  finishRange():void{
    if(this.finished||this.fd===null||this.ranges.length!==1||this.ranges[0]!.start!==0||this.ranges[0]!.end!==this.total)return
    try{
      const header=Buffer.alloc(Math.min(this.total,65536));fs.readSync(this.fd,header,0,header.length,0)
      const audio=inspectAudioHeader(header);if(!audio.format){this.abort();return}
      fs.fsyncSync(this.fd);fs.closeSync(this.fd);this.fd=null
      const key=this.filename.split(path.sep).at(-1)!.slice(0,64),filename=path.join(path.dirname(this.filename),key+'.audio')
      fs.renameSync(this.filename,filename);const stat=fs.statSync(filename)
      this.completed({...this.metadata,key,filename,size:stat.size,mtime:stat.mtimeMs,mime:this.mime,format:audio.format,verifiedBitrate:audio.bitrateKbps,lastAccess:Date.now()})
      this.finished=true;this.released(this)
    }catch{this.failed();this.abort()}
  }
  abort():void{
    if(this.finished)return;this.finished=true
    if(this.fd!==null){try{fs.closeSync(this.fd)}catch{}this.fd=null}
    try{fs.unlinkSync(this.filename)}catch{}this.released(this)
  }
}
