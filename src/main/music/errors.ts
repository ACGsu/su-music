const MESSAGES: Record<string, string> = {
  SOURCE_TIMEOUT: '音源请求超时，请稍后重试。', SOURCE_NETWORK_ERROR: '音源暂时无法连接，请稍后重试。',
  SOURCE_HTTP_ERROR: '音源服务暂时未能完成请求。', SOURCE_RESPONSE_INVALID: '音源返回的资料不完整，请稍后重试。',
  SOURCE_RATE_LIMITED: '请求频率已达上限，请稍后重试。', SOURCE_BODY_TOO_LARGE: '返回资料超过本次读取范围。',
  SHARE_LINK_INVALID: '请使用酷狗公开歌单的分享链接。', SHARE_REDIRECT_INVALID: '歌单分享跳转未能完成。',
  SHARE_RESPONSE_INVALID: '公开歌单资料不完整，已保留原有曲库。', SHARE_COUNT_MISMATCH: '歌单曲目数量未读全，已保留原有曲库。',
  CANDIDATE_NOT_FOUND: '请先搜索或检查这首歌曲的候选版本。', TRACK_NOT_FOUND: '这首歌曲暂时无法读取。',
  RESOURCE_URL_INVALID: '音源没有返回可检查的资源地址。', RESOURCE_UNAVAILABLE: '该音源暂时没有可用资源。',
  RESOURCE_NOT_AUDIO: '返回内容未能确认为音频。', RESOURCE_RANGE_INVALID: '资源范围响应不完整，暂无法确认。'
}
export class SourceError extends Error {
  code: string
  retryAt: number | null
  constructor(code: string, retryAt: number | null = null) { super(code); this.code = code; this.retryAt = retryAt }
}
export function sourceMessage(error: unknown): string {
  return error instanceof SourceError ? MESSAGES[error.code] ?? '音乐资料暂时无法读取，请重试。' : '操作未能完成，请重试。'
}
