import {SourceError,sourceMessage} from '../music/errors.ts'
export class PlayerError extends Error {readonly code:string;readonly review:boolean;constructor(code:string,review=false){super(code);this.code=code;this.review=review}}
const messages:Record<string,string>={
  TRACK_CHANGED:'收藏资料已更新，请重新选择这首歌。',TRACK_NOT_FOUND:'这首歌已不在当前曲库中。',
  NEEDS_VERSION:'这首歌需要先选择版本。',NO_ORIGINAL:'原版暂不可用，可选择其他版本或关联本地文件。',
  LOCAL_FILE_MISSING:'本地文件缺失或已改变，请重新关联。',LOCAL_AUDIO_INVALID:'请选择有效的 MP3、FLAC 或 WAV 文件。',
  MEDIA_ADDRESS_EXPIRED:'播放资源已失效。',MEDIA_NETWORK_ERROR:'音频读取中断。',MEDIA_UNAVAILABLE:'播放资源暂不可用。',
  MEDIA_NOT_AUDIO:'音源返回的内容无法播放。',MEDIA_RANGE_INVALID:'音频范围读取失败。',LOCAL_FILE_CHANGED:'本地文件缺失或已改变，请重新关联。',
  MEDIA_DECODE_ERROR:'这个音频暂时无法解码。',MEDIA_PLAY_BLOCKED:'播放未能开始，请点击播放重试。',MEDIA_STALLED:'音频长时间没有继续加载。',
  MEDIA_DURATION_MISMATCH:'资源时长与所选版本不一致，请对照版本。',QUEUE_LIMIT:'队列最多保留 20,000 个曲目位置。',
  CACHE_DIRECTORY_INVALID:'缓存目录无法使用，请选择其他位置。',CACHE_DIRECTORY_UNWRITABLE:'缓存目录暂不可写，请选择其他位置。'
}
export function playerMessage(error:unknown):string{
  if(error instanceof SourceError)return sourceMessage(error)
  const code=error instanceof Error?error.message:''
  return messages[code]??'播放未能完成，可重试或选择其他版本。'
}
