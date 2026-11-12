import type {OriginalTrack,SourceCandidate} from '../../shared/music.ts'
import type {Track} from '../../shared/contracts.ts'
import {catalogTitle,withoutAudioExtension} from '../../shared/track-name.ts'
import {normalizedText,titleForms,titleIdentity} from './matching.ts'

export function candidateVersion(title:string):string|null{
  const names:Record<string,string>={original:'Original',movie:'Movie ver.',movie_edit:'Movie edit',live:'Live',remix:'Remix',cover:'翻唱',instrumental:'Instrumental'}
  const labels=titleIdentity(title).versions
  return labels.length?labels.map(label=>names[label]??label).join(' · '):null
}
export function candidateTrack(candidate:SourceCandidate,position:number):Track{
  return{position,title:withoutAudioExtension(candidate.title),filename:null,artist:candidate.artists.join('、')||null,album:candidate.album,durationMs:candidate.durationMs,version:candidateVersion(candidate.title)}
}
function identity(track:OriginalTrack):{title:string;artists:string;versions:string;key:string|null}{
  const title=catalogTitle(track.title,track.filename,track.artist)??track.filename??''
  const base=titleForms(title).at(-1)??''
  const artists=(track.artist??'').split(/\s*(?:、|，|,|;|；|\s+&\s+)\s*/u).map(normalizedText).filter(Boolean).sort().join('|')
  const versions=titleIdentity(title+' '+(track.version??'')).versions.join('|')
  return{title:base,artists,versions,key:base?JSON.stringify([base,artists,versions]):null}
}
// Reconcile positions inside one source collection. Duplicates remain separate occurrences.
export function reconcileCatalogPositions(previous:OriginalTrack[],next:OriginalTrack[]):Map<number,number>{
  const result=new Map<number,number>(),unused=new Set(previous.map(track=>track.position))
  const old=previous.map(track=>({track,identity:identity(track)})),incoming=next.map(track=>({track,identity:identity(track)}))
  type Item=typeof old[number]
  type Bucket={items:Item[];offset:number}
  const index=(key:(item:Item)=>string|null):Map<string,Bucket>=>{
    const map=new Map<string,Bucket>()
    for(const item of old){const value=key(item);if(value===null)continue;const bucket=map.get(value)??{items:[],offset:0};bucket.items.push(item);map.set(value,bucket)}return map
  }
  const hashes=index(item=>item.track.hash?.toLowerCase()??null)
  const hashNames=index(item=>item.track.hash?JSON.stringify([item.track.hash.toLowerCase(),item.identity.title]):null)
  const hashIdentities=index(item=>item.track.hash?JSON.stringify([item.track.hash.toLowerCase(),item.identity.key]):null)
  const identities=index(item=>item.identity.key),titles=index(item=>item.identity.title?JSON.stringify([item.identity.title,item.identity.versions]):null)
  const take=(map:Map<string,Bucket>,key:string):Item|undefined=>{const bucket=map.get(key);if(!bucket)return;while(bucket.offset<bucket.items.length&&!unused.has(bucket.items[bucket.offset]!.track.position))bucket.offset++;return bucket.items[bucket.offset]}
  const usedNew=new Set<number>()
  const connect=(before:typeof old[number],after:typeof incoming[number])=>{result.set(before.track.position,after.track.position);unused.delete(before.track.position);usedNew.add(after.track.position)}
  const incomingByIdentity=new Map<string,typeof incoming>()
  for(const item of incoming)if(item.identity.key){const group=incomingByIdentity.get(item.identity.key)??[];group.push(item);incomingByIdentity.set(item.identity.key,group)}
  // Identical duplicate occurrences keep their relative order even if just one returned hash changes.
  for(const [key,after]of incomingByIdentity){
    const before=identities.get(key)?.items??[]
    if(before.length>1&&before.length===after.length&&new Set(before.map(item=>item.track.hash?.toLowerCase()??null)).size===1){for(let index=0;index<before.length;index++)connect(before[index]!,after[index]!)}
  }
  for(const after of incoming){
    if(usedNew.has(after.track.position))continue
    const hash=after.track.hash?.toLowerCase();if(!hash)continue
    const before=take(hashIdentities,JSON.stringify([hash,after.identity.key]))??take(hashNames,JSON.stringify([hash,after.identity.title]))??take(hashes,hash)
    if(before)connect(before,after)
  }
  for(const after of incoming){
    if(usedNew.has(after.track.position)||!after.identity.key)continue
    const before=take(identities,after.identity.key)
    if(before)connect(before,after)
  }
  for(const after of incoming){
    if(usedNew.has(after.track.position)||!after.identity.title)continue
    const candidates=(titles.get(JSON.stringify([after.identity.title,after.identity.versions]))?.items??[]).filter(before=>unused.has(before.track.position)&&(!before.identity.artists||!after.identity.artists||before.identity.artists===after.identity.artists))
    if(candidates.length===1)connect(candidates[0]!,after)
  }
  return result
}
