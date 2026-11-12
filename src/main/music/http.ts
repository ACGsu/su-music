import { SourceError } from './errors.ts'

export type HttpScope = 'gd' | 'netease' | 'kugou' | 'audio' | 'cover'
export type FetchFunction = typeof fetch
const audioHost = (host: string): boolean => ['music.126.net', 'music.163.com', 'music126.net'].some(domain => host === domain || host.endsWith('.' + domain))
export function checkedPublicUrl(input: string, scope: HttpScope): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new SourceError(scope === 'audio' ? 'RESOURCE_URL_INVALID' : 'SHARE_LINK_INVALID') }
  const allowed = scope === 'gd' ? url.hostname === 'music-api.gdstudio.xyz' && url.pathname === '/api.php' :
    scope === 'netease' ? url.hostname === 'music.163.com' && url.pathname.startsWith('/api/') :
    scope === 'kugou' ? url.hostname.endsWith('.kugou.com') : scope === 'cover' ?
      ['imge.kugou.com','imgessl.kugou.com','singerimg.kugou.com'].includes(url.hostname) : audioHost(url.hostname)
  if (!allowed || url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new SourceError(scope === 'audio' ? 'RESOURCE_URL_INVALID' : 'SHARE_REDIRECT_INVALID')
  if (url.protocol === 'http:' && (scope === 'kugou' || scope === 'audio' || scope === 'cover')) { url.protocol = 'https:'; if (url.port === '80') url.port = '' }
  if (url.protocol !== 'https:' || url.port && url.port !== '443') throw new SourceError(scope === 'audio' ? 'RESOURCE_URL_INVALID' : 'SHARE_REDIRECT_INVALID')
  return url
}
export class PublicHttpClient {
  private request: FetchFunction
  private timeoutMs: number
  constructor(request: FetchFunction = fetch, timeoutMs = 12_000) { this.request = request; this.timeoutMs = timeoutMs }
  async response(address: string, scope: HttpScope, headers: Record<string, string> = {}): Promise<Response> {
    let url = checkedPublicUrl(address, scope)
    const signal = AbortSignal.timeout(this.timeoutMs)
    try {
      for (let hop = 0; hop <= 5; hop++) {
        const response = await this.request(url, { credentials: 'omit', redirect: 'manual', signal,
          headers: { 'User-Agent': 'Su-Music/0.1', Accept: '*/*', ...headers } })
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location'); await response.body?.cancel()
          if (!location || hop === 5) throw new SourceError('SHARE_REDIRECT_INVALID')
          url = checkedPublicUrl(new URL(location, url).href, scope); continue
        }
        if (response.status === 429) {
          const value = response.headers.get('retry-after'), seconds = Number(value)
          const until = value && Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : value ? Date.parse(value) : NaN
          await response.body?.cancel(); throw new SourceError('SOURCE_RATE_LIMITED', Number.isFinite(until) ? until : Date.now() + 60_000)
        }
        if (!response.ok) { await response.body?.cancel(); throw new SourceError('SOURCE_HTTP_ERROR') }
        // Preserve the final address without exposing it to the renderer.
        Object.defineProperty(response, 'publicFinalUrl', { value: url.href })
        return response
      }
    } catch (error) {
      if (error instanceof SourceError) throw error
      throw new SourceError(signal.aborted ? 'SOURCE_TIMEOUT' : 'SOURCE_NETWORK_ERROR')
    }
    throw new SourceError('SHARE_REDIRECT_INVALID')
  }
  async text(address: string, scope: HttpScope): Promise<{ text: string; finalUrl: string }> {
    const response = await this.response(address, scope), chunks: Uint8Array[] = []
    let count = 0
    try {
      if (response.body) for await (const chunk of response.body) {
        count += chunk.byteLength
        if (count > 2 * 1024 * 1024) throw new SourceError('SOURCE_BODY_TOO_LARGE')
        chunks.push(chunk)
      }
    } catch (error) { if (error instanceof SourceError) throw error; throw new SourceError('SOURCE_TIMEOUT') }
    return { text: Buffer.concat(chunks).toString('utf8'), finalUrl: (response as Response & { publicFinalUrl: string }).publicFinalUrl }
  }
  async json(address: string, scope: HttpScope): Promise<unknown> {
    const page = await this.text(address, scope)
    try { return JSON.parse(page.text) as unknown } catch { throw new SourceError('SOURCE_RESPONSE_INVALID') }
  }
}
