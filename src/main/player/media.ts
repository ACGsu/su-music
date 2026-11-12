import fs from 'node:fs'
import {randomBytes} from 'node:crypto'
import {Readable} from 'node:stream'
import {checkedPublicUrl} from '../music/http.ts'
import type {FetchFunction} from '../music/http.ts'
import {inspectAudioHeader} from '../music/audio.ts'
import type {AudioHeader} from '../music/audio.ts'
import type {CacheMetadata,CacheWriter,SongCache} from './cache.ts'

export type StreamSource={kind:'remote';url:string;cacheMetadata?:CacheMetadata}|{kind:'file';filename:string;size:number;mtime:number;mime:string;cacheIdentity?:string}
export function byteRange(input:string|null,size:number):{start:number;end:number}|null{
  if(!input)return null
  const match=/^bytes=(\d*)-(\d*)$/.exec(input);if(!match||!match[1]&&!match[2])throw new Error('MEDIA_RANGE_INVALID')
  let start:number,end:number
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)throw new Error('MEDIA_RANGE_INVALID');start=Math.max(0,size-suffix);end=size-1}
  else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new Error('MEDIA_RANGE_INVALID')
  return{start,end}
}
export class MediaRegistry{
  private resources=new Map<string,{source:StreamSource;writer:CacheWriter|null;entity:string|null;total:number|null;cacheDisabled:boolean}>()
  private failures=new Map<string,string>();private qualities=new Map<string,AudioHeader>();private controllers=new Map<string,Set<AbortController>>()
  readonly observations:{id:string;kind:string;status:number;range:string|null;totalBytes:number|null;receivedBytes:number;cancelled:boolean;finished:boolean}[]=[]
  private fetcher:FetchFunction
  private cache?:SongCache
  constructor(fetcher:FetchFunction=fetch,cache?:SongCache){this.fetcher=fetcher;this.cache=cache}
  register(source:StreamSource):{id:string;url:string}{
    if(source.kind==='remote')checkedPublicUrl(source.url,'audio')
    const id=randomBytes(24).toString('hex');this.resources.set(id,{source,writer:null,entity:null,total:null,cacheDisabled:false})
    if(source.kind==='file'&&source.cacheIdentity)this.cache?.pin(source.filename)
    return{id,url:'su-music://media/'+id}
  }
  revoke(id:string):void{
    const entry=this.resources.get(id);this.resources.delete(id)
    for(const controller of this.controllers.get(id)??[])controller.abort()
    entry?.writer?.abort();if(entry?.source.kind==='file'&&entry.source.cacheIdentity)this.cache?.unpin(entry.source.filename)
    this.controllers.delete(id);this.failures.delete(id);this.qualities.delete(id)
  }
  close():void{for(const id of this.resources.keys())this.revoke(id)}
  failure(id:string):string|null{return this.failures.get(id)??null}
  quality(id:string):AudioHeader|null{return this.qualities.get(id)??null}
  protectedFiles():string[]{return [...this.resources.values()].flatMap(entry=>entry.source.kind==='file'&&entry.source.cacheIdentity?[entry.source.filename]:[])}
  private observe(id:string,kind:string,status:number,range:string|null,totalBytes:number|null):typeof this.observations[number]{const entry={id,kind,status,range,totalBytes,receivedBytes:0,cancelled:false,finished:false};this.observations.push(entry);if(this.observations.length>500)this.observations.splice(0,250);return entry}
  async respond(request:Request):Promise<Response>{
    const url=new URL(request.url),id=url.pathname.slice(1),entry=this.resources.get(id),source=entry?.source
    if(url.protocol!=='su-music:'||url.hostname!=='media'||url.port||url.username||url.password||url.search||url.hash||!/^([a-f0-9]{48})$/.test(id)||!entry||!source||!['GET','HEAD'].includes(request.method))return new Response('Forbidden',{status:403})
    const range=request.headers.get('range')
    if(range&&!/^bytes=\d*-\d*$/.test(range))return new Response('Range not satisfiable',{status:416})
    const controller=new AbortController(),list=this.controllers.get(id)??new Set<AbortController>();list.add(controller);this.controllers.set(id,list)
    const interrupted=()=>controller.abort();request.signal.addEventListener('abort',interrupted,{once:true})
    const cleanup=()=>{list.delete(controller);request.signal.removeEventListener('abort',interrupted);if(!list.size)this.controllers.delete(id)}
    let transferred=false
    try{
      if(request.signal.aborted)throw new Error('MEDIA_NETWORK_ERROR')
      if(source.kind==='file'){
        const stat=fs.lstatSync(source.filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==source.size||stat.mtimeMs!==source.mtime)throw new Error('LOCAL_FILE_CHANGED')
        let bounds:{start:number;end:number}|null
        try{bounds=byteRange(range,stat.size)}catch{return new Response(null,{status:416,headers:{'Content-Range':`bytes */${stat.size}`}})}
        const headers:Record<string,string>={'Content-Type':source.mime,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Length':String(bounds?bounds.end-bounds.start+1:stat.size)}
        if(bounds)headers['Content-Range']=`bytes ${bounds.start}-${bounds.end}/${stat.size}`
        const status=bounds?206:200;this.observe(id,'file',status,range,stat.size)
        if(request.method==='HEAD')return new Response(null,{status,headers})
        const stream=fs.createReadStream(source.filename,bounds??undefined)
        const abort=()=>stream.destroy();controller.signal.addEventListener('abort',abort,{once:true})
        stream.once('close',()=>{controller.signal.removeEventListener('abort',abort);cleanup()})
        stream.once('error',()=>{if(this.resources.has(id))this.failures.set(id,'LOCAL_FILE_CHANGED')})
        transferred=true
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{status,headers})
      }
      let address=checkedPublicUrl(source.url,'audio'),response:Response|null=null
      const deadline=setTimeout(()=>controller.abort(),12000)
      try{
        for(let hop=0;hop<=5;hop++){
          response=await this.fetcher(address,{method:request.method,credentials:'omit',redirect:'manual',signal:controller.signal,headers:{'User-Agent':'Su-Music/0.3',Accept:'audio/*,application/octet-stream;q=0.8','Accept-Encoding':'identity',...(range?{Range:range}:{})}})
          if([301,302,303,307,308].includes(response.status)){
            const location=response.headers.get('location');await response.body?.cancel();if(!location||hop===5)throw new Error('MEDIA_REDIRECT_INVALID');address=checkedPublicUrl(new URL(location,address).href,'audio');continue
          }break
        }
      }finally{clearTimeout(deadline)}
      if(!response||!response.ok){await response?.body?.cancel();throw new Error(response&&[401,403,404,410].includes(response.status)?'MEDIA_ADDRESS_EXPIRED':response?.status===416?'MEDIA_RANGE_INVALID':'MEDIA_UNAVAILABLE')}
      const contentType=response.headers.get('content-type')??'application/octet-stream'
      if(/text\/|json|html/i.test(contentType)){await response.body?.cancel();throw new Error('MEDIA_NOT_AUDIO')}
      const headers=new Headers({'Content-Type':contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
      for(const key of ['content-length','content-range','accept-ranges']){const value=response.headers.get(key);if(value)headers.set(key,value)}
      const rangeMatch=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??''),length=Number(response.headers.get('content-length'))||null
      const total=rangeMatch?Number(rangeMatch[3]):response.status===200?length:null,start=rangeMatch?Number(rangeMatch[1]):0,end=rangeMatch?Number(rangeMatch[2]):null
      if(response.status===206&&(!rangeMatch||!total||!Number.isSafeInteger(total)||end!<start||end!>=total||length!==null&&length!==end!-start+1)){
        await response.body?.cancel();throw new Error('MEDIA_RANGE_INVALID')
      }
      if(range&&response.status===206&&total){const asked=byteRange(range,total);if(!asked||asked.start!==start||end!>asked.end){await response.body?.cancel();throw new Error('MEDIA_RANGE_INVALID')}}
      const observation=this.observe(id,'remote',response.status,range,total)
      if(request.method==='HEAD')return new Response(null,{status:response.status,headers})
      const reader=response.body?.getReader();if(!reader)throw new Error('MEDIA_UNAVAILABLE')
      const entity=response.headers.get('etag')??response.headers.get('last-modified')
      if(entry.total!==null&&(entry.total!==total||entry.entity&&entity&&entry.entity!==entity)){entry.writer?.abort();entry.cacheDisabled=true}
      entry.total=total;entry.entity=entity
      if(!entry.cacheDisabled&&!entry.writer&&source.cacheMetadata&&total)entry.writer=this.cache?.createWriter(source.cacheMetadata,total,contentType)??null
      const writer=entry.writer,failures=this.failures,qualities=this.qualities,resources=this.resources
      let consumed=0,prefix=Buffer.alloc(0)
      const body=new ReadableStream<Uint8Array>({
        async pull(output){
          const stall=setTimeout(()=>controller.abort(),12000)
          try{
            const item=await reader.read()
            if(item.done){
              if(length!==null&&consumed!==length)throw new Error('MEDIA_NETWORK_ERROR')
              writer?.finishRange();observation.finished=true;cleanup();output.close()
            }else{
              if(length!==null&&consumed+item.value.byteLength>length)throw new Error('MEDIA_NETWORK_ERROR')
              if(start===0&&prefix.length<65536){prefix=Buffer.concat([prefix,Buffer.from(item.value.subarray(0,65536-prefix.length))]);const audio=inspectAudioHeader(prefix);if(audio.format&&resources.has(id))qualities.set(id,audio)}
              writer?.write(start+consumed,item.value);consumed+=item.value.byteLength;observation.receivedBytes=consumed
              // Chromium can stop after Content-Length bytes without reading the final EOF.
              // Complete coverage is sufficient; a later cancellation must not remove this cache.
              const expected=rangeMatch?end!-start+1:length
              if(expected!==null&&consumed===expected){writer?.finishRange();observation.finished=true}
              output.enqueue(item.value)
            }
          }
          catch{cleanup();writer?.abort();if(!request.signal.aborted&&resources.has(id))failures.set(id,'MEDIA_NETWORK_ERROR');output.error(new Error('MEDIA_NETWORK_ERROR'))}
          finally{clearTimeout(stall)}
        },async cancel(){observation.cancelled=true;cleanup();controller.abort();await reader.cancel().catch(()=>{})}
      })
      transferred=true
      return new Response(body,{status:response.status,headers})
    }catch(error){const code=source.kind==='file'?'LOCAL_FILE_CHANGED':error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'MEDIA_UNAVAILABLE';if(this.resources.has(id))this.failures.set(id,code);return new Response('Audio unavailable',{status:502})}
    finally{if(!transferred)cleanup()}
  }
}
