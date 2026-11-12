import type {AccountCollection,AccountInfo,AccountLibrary,KugouSession} from '../../shared/account.ts'
import {AccountError,record} from './protocol.ts'
import type {KugouTransport} from './protocol.ts'
import {catalogTitle} from '../../shared/track-name.ts'

export interface SyncProgress{phase:'reading_directory'|'reading_tracks'|'checking_directory';completedCollections:number;totalCollections:number;rawDirectoryCount:number;unknownClassifications:number}
function listIdentity(row:Record<string,unknown>):string{return JSON.stringify([String(row.type),String(row.listid)])}
export function classifyKugouList(row:Record<string,unknown>):{kind:AccountCollection['kind'];subtype:'album'|null}|null{
  const type=String(row.type),source=String(row.source),def=String(row.is_def??0)
  if(type==='1'&&source==='2')return{kind:'favorite',subtype:'album'}
  if(type==='0'&&source==='1'){if(def==='1'||def==='2')return{kind:'default',subtype:null};if(def==='0')return{kind:'created',subtype:null}}
  if(type==='1'&&source==='1')return{kind:'favorite',subtype:null}
  return null
}
export function normalizeKugouTrack(raw:Record<string,unknown>,position:number):AccountCollection['tracks'][number]{
  const artists=Array.isArray(raw.singerinfo)?raw.singerinfo.map(item=>record(item)?.name).filter((name):name is string=>typeof name==='string'&&!!name):[]
  const filename=typeof raw.name==='string'?raw.name:null
  const title=catalogTitle(typeof raw.songname==='string'?raw.songname:null,filename,artists.length?artists.join('、'):null)
  return{position,title,filename,artist:artists.length?artists.join('、'):null,album:typeof record(raw.albuminfo)?.name==='string'?String(record(raw.albuminfo)!.name):null,
    durationMs:typeof raw.timelen==='number'&&Number.isFinite(raw.timelen)&&raw.timelen>0?raw.timelen:null,
    version:typeof raw.version==='string'?raw.version:raw.version!=null?String(raw.version):null,
    ...(typeof raw.hash==='string'?{hash:raw.hash}:{}),raw}
}
async function directory(transport:KugouTransport,session:KugouSession,signal:AbortSignal):Promise<{lists:Record<string,unknown>[];count:number;version:unknown}>{
  const lists:Record<string,unknown>[]=[],ids=new Set<string>();let count:number|null=null,version:unknown=undefined
  for(let page=1;page<=100;page++){
    const body=await transport.call('directory',session,{page,pagesize:100},signal),data=record(body.data)
    if(body.status!==1||!data||String(data.userid)!==session.userid||!Number.isInteger(data.list_count)||Number(data.list_count)<0)throw new AccountError('DIRECTORY_RESPONSE_INVALID')
    if(count!==null&&(count!==data.list_count||version!==data.total_ver))throw new AccountError('DIRECTORY_CHANGED')
    count=Number(data.list_count);version=data.total_ver
    const rows=data.info===null&&lists.length===count?[]:data.info
    if(!Array.isArray(rows)||rows.length>100)throw new AccountError('DIRECTORY_RESPONSE_INVALID')
    for(const value of rows){const row=record(value);if(!row||!['number','string'].includes(typeof row.listid)||String(row.listid)===''||typeof row.name!=='string'||!Number.isInteger(Number(row.count))||Number(row.count)<0)throw new AccountError('DIRECTORY_RESPONSE_INVALID')
      const id=listIdentity(row);if(ids.has(id))throw new AccountError('DIRECTORY_DUPLICATE');ids.add(id);lists.push(row)}
    if(lists.length>count)throw new AccountError('DIRECTORY_COUNT_MISMATCH');if(lists.length===count)return{lists,count,version}
    if(!rows.length)throw new AccountError('DIRECTORY_COUNT_MISMATCH')
  }throw new AccountError('DIRECTORY_PAGE_LIMIT')
}
function directorySignature(value:{lists:Record<string,unknown>[];count:number;version:unknown}):string{return JSON.stringify([value.count,value.version,value.lists.map(row=>[listIdentity(row),row.source,row.is_def,row.name,row.count])])}
export async function readKugouLibrary(transport:KugouTransport,session:KugouSession,owner:AccountInfo,signal:AbortSignal,onProgress:(value:SyncProgress)=>void):Promise<AccountLibrary>{
  const initial=await directory(transport,session,signal),unknown=initial.lists.filter(row=>!classifyKugouList(row)).length
  onProgress({phase:'reading_directory',completedCollections:0,totalCollections:initial.count,rawDirectoryCount:initial.count,unknownClassifications:unknown})
  if(unknown)throw new AccountError('UNKNOWN_LIST_CLASSIFICATION')
  const collections:AccountCollection[]=[]
  for(const [order,list]of initial.lists.entries()){
    const classification=classifyKugouList(list)!;const tracks:AccountCollection['tracks']=[];let count:number|null=null,version:unknown=undefined
    for(let page=1;page<=200;page++){
      const body=await transport.call('tracks',session,{listid:list.listid as string|number,type:Number(list.type),page,pagesize:100},signal),data=record(body.data)
      if(body.status!==1||!data||!Number.isInteger(data.count)||Number(data.count)<0)throw new AccountError('TRACK_RESPONSE_INVALID')
      if(data.userid!==undefined&&String(data.userid)!==session.userid||data.listid!==undefined&&String(data.listid)!==String(list.listid))throw new AccountError('TRACK_IDENTITY_MISMATCH')
      if(Number(data.page)!==page||Number(data.pagesize)!==100)throw new AccountError('TRACK_PAGE_PARAMETERS_IGNORED')
      if(count!==null&&(count!==data.count||version!==data.list_ver))throw new AccountError('TRACKS_CHANGED')
      count=Number(data.count);version=data.list_ver
      const rows=data.info===null&&tracks.length===count?[]:data.info
      if(!Array.isArray(rows)||rows.length>100)throw new AccountError('TRACK_RESPONSE_INVALID')
      for(const value of rows){const raw=record(value);if(!raw)throw new AccountError('TRACK_RESPONSE_INVALID');tracks.push(normalizeKugouTrack(raw,tracks.length+1))}
      if(tracks.length>count)throw new AccountError('TRACK_COUNT_MISMATCH')
      if(tracks.length===count)break
      if(!rows.length||page===200)throw new AccountError('TRACK_COUNT_MISMATCH')
    }
    if(tracks.length!==Number(list.count))throw new AccountError('DIRECTORY_TRACK_COUNT_MISMATCH')
    const global=list.global_collection_id??list.global_specialid
    collections.push({sourceKey:listIdentity(list),sourceGlobalKey:typeof global==='string'||typeof global==='number'?String(global):null,name:String(list.name),...classification,order,reportedCount:tracks.length,raw:list,tracks})
    onProgress({phase:'reading_tracks',completedCollections:collections.length,totalCollections:initial.count,rawDirectoryCount:initial.count,unknownClassifications:0})
  }
  onProgress({phase:'checking_directory',completedCollections:collections.length,totalCollections:initial.count,rawDirectoryCount:initial.count,unknownClassifications:0})
  const last=await directory(transport,session,signal)
  if(directorySignature(initial)!==directorySignature(last))throw new AccountError('DIRECTORY_CHANGED')
  if(signal.aborted)throw new AccountError('ACCOUNT_CANCELLED')
  return{owner,at:new Date().toISOString(),collections,rawDirectoryCount:initial.count,unknownClassifications:0,directoryVerified:true}
}
