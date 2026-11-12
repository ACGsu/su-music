import type {PlaybackNow,PlayerState} from '../shared/playback.ts'
export function playTime(ms:number|null|undefined):string{if(ms==null)return'—';return Math.floor(ms/60000)+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')}
export function qualityText(now:PlaybackNow|null|undefined):string{
  if(!now)return'音质待确认'
  const format=now.format?now.format+' · ':''
  if(now.verifiedBitrateKbps)return format+now.verifiedBitrateKbps+' kbps'
  if(now.returnedBitrateKbps)return format+'接口 '+now.returnedBitrateKbps+' kbps'
  if(now.qualityCode===999||now.qualityCode===740)return format+'接口标记无损'
  return format+'音质待确认'
}
export function phaseText(phase:PlayerState['phase']|undefined):string{return({idle:'未选择歌曲',resolving:'正在解析',loading:'正在缓冲',playing:'正在播放',paused:'已暂停',waiting_retry:'等待额度恢复',needs_review:'需要选版本',error:'暂不可用',ended:'播放已结束'} as const)[phase??'idle']}
export function bindingText(now:PlaybackNow|null|undefined):string{return now?.binding==='alternative'?'已选替代版':now?.binding==='local'?'关联的本地文件':now?.binding==='same'?'收藏版本候选':'直接播放'}
