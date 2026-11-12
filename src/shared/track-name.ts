import type {Track} from './contracts.ts'

// Strip only a known audio-file suffix at the end. Recording labels and inner dots stay intact.
export function withoutAudioExtension(value:string):string{
  const cleaned=value.replace(/[.．](?:mp3|flac|wav|m4a|aac|ogg|opus|wma|ape)\s*$/iu,'')
  return cleaned===value?value:cleaned.trimEnd()
}
export function catalogTitle(title:string|null,filename:string|null,artist:string|null):string|null{
  if(title?.trim())return withoutAudioExtension(title)
  if(!filename||!artist)return null
  const names=artist.split(/\s*[、，,;；]\s*/u).filter(Boolean)
  const prefixes=[artist,names.join('、'),names.join(' & '),names.join('&')].filter(Boolean)
  const prefix=prefixes.find(value=>filename.startsWith(value+' - '))
  return prefix?withoutAudioExtension(filename.slice(prefix.length+3)):null
}
export function publicTrack<T extends Track>(track:T):T{
  return{...track,title:catalogTitle(track.title,track.filename,track.artist),filename:track.filename?withoutAudioExtension(track.filename):null}
}
