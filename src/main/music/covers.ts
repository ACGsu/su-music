import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { MusicDatabase } from '../database.ts'
import { PublicHttpClient, checkedPublicUrl } from './http.ts'
import { SourceError } from './errors.ts'

export type ImageSanitizer = (input: Buffer) => Buffer
interface CoverBinding { firstHash: string; imageKey: string }
const MIME_LIMIT = 2 * 1024 * 1024
export function kugouCoverMetadata(input: unknown, expectedHash: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const outer=input as Record<string,unknown>,data=outer.data && typeof outer.data==='object' && !Array.isArray(outer.data)?outer.data as Record<string,unknown>:outer
  const returned=typeof data.hash==='string'&&data.hash?data.hash:typeof data.req_hash==='string'?data.req_hash:''
  if (returned.toUpperCase() !== expectedHash.toUpperCase()) return null
  const address = typeof data.album_img==='string' && data.album_img ? data.album_img : typeof data.imgUrl==='string' ? data.imgUrl : null
  if (!address || address.length>2048) return null
  try { return checkedPublicUrl(address.replaceAll('{size}','500'),'cover').href } catch { return null }
}
export class CollectionCoverCache {
  private db: MusicDatabase
  private directory: string
  private http: PublicHttpClient
  private sanitize: ImageSanitizer
  private pending = new Map<string,Promise<void>>()
  constructor(db:MusicDatabase,directory:string,sanitize:ImageSanitizer,http=new PublicHttpClient()) {
    this.db=db;this.directory=path.resolve(directory);this.sanitize=sanitize;this.http=http
    fs.mkdirSync(this.directory,{recursive:true})
  }
  private firstHash(id:string):string|null {
    const hash=this.db.getOriginal({collectionId:id,position:1})?.hash
    return typeof hash==='string'&&/^[a-fA-F0-9]{32}$/.test(hash)?hash.toUpperCase():null
  }
  url(id:string):string|null {
    const first=this.firstHash(id),binding=this.db.getSetting<CoverBinding|null>('collection-cover:'+id,null)
    return first && binding?.firstHash===first && /^[a-f0-9]{64}$/.test(binding.imageKey) && this.read(binding.imageKey)
      ? `su-music://app/cover/${binding.imageKey}.jpg` : null
  }
  read(key:string):Buffer|null {
    if(!/^[a-f0-9]{64}$/.test(key))return null
    try{
      const target=fs.realpathSync(path.join(this.directory,key+'.jpg')),root=fs.realpathSync(this.directory)
      if(!target.startsWith(root+path.sep)||!fs.statSync(target).isFile()||fs.statSync(target).size>MIME_LIMIT)return null
      return fs.readFileSync(target)
    }catch{return null}
  }
  refresh(id:string):Promise<void> {
    const previous=this.pending.get(id);if(previous)return previous
    const job=this.refreshOnce(id).finally(()=>this.pending.delete(id));this.pending.set(id,job);return job
  }
  private async refreshOnce(id:string):Promise<void> {
    const hash=this.firstHash(id)
    if(!hash||this.url(id))return
    const absent=this.db.getSourceCache<boolean>('cover_missing',hash);if(absent)return
    try{
      const address=new URL('https://m.kugou.com/app/i/getSongInfo.php')
      address.search=new URLSearchParams({cmd:'playInfo',hash}).toString()
      const metadata=await this.http.json(address.href,'kugou'),imageUrl=kugouCoverMetadata(metadata,hash)
      if(!imageUrl)throw new SourceError('COVER_UNAVAILABLE')
      const response=await this.http.response(imageUrl,'cover'),parts:Uint8Array[]=[];let bytes=0
      if(!/^image\/(?:jpeg|png|webp)(?:;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();throw new SourceError('COVER_UNAVAILABLE')}
      if(response.body)for await(const part of response.body){bytes+=part.byteLength;if(bytes>MIME_LIMIT)throw new SourceError('COVER_UNAVAILABLE');parts.push(part)}
      const image=this.sanitize(Buffer.concat(parts));if(!image.length||image.length>MIME_LIMIT)throw new SourceError('COVER_UNAVAILABLE')
      const key=createHash('sha256').update(image).digest('hex'),target=path.join(this.directory,key+'.jpg')
      if(!fs.existsSync(target)){
        const temporary=target+'.'+randomUUID()+'.tmp'
        try{fs.writeFileSync(temporary,image,{flag:'wx'});fs.renameSync(temporary,target)}finally{fs.rmSync(temporary,{force:true})}
      }
      if(this.firstHash(id)===hash)this.db.setSetting('collection-cover:'+id,{firstHash:hash,imageKey:key})
    }catch{this.db.setSourceCache('cover_missing',hash,true,3600_000)}
  }
}
