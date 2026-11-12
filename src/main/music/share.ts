import type { ImportedPlaylist } from '../../shared/music.ts'
import { checkedPublicUrl, PublicHttpClient } from './http.ts'
import { SourceError } from './errors.ts'
import {withoutAudioExtension} from '../../shared/track-name.ts'

export function validateShareLink(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new SourceError('SHARE_LINK_INVALID')
  const url = checkedPublicUrl(input.trim(), 'kugou')
  if (!(url.hostname === 't1.kugou.com' && /^\/[A-Za-z0-9]{6,40}\/?$/.test(url.pathname)) &&
    !(url.hostname === 'wwwapi.kugou.com' && url.pathname === '/share/zlist.html') &&
    !(url.hostname === 'activity.kugou.com' && url.pathname.startsWith('/share/'))) throw new SourceError('SHARE_LINK_INVALID')
  return url.href
}
function jsonArrayAssignment(html: string, variable: string): unknown[] {
  const expression = new RegExp(`\\b(?:var|let|const)\\s+${variable}\\s*=\\s*\\[`)
  const found = expression.exec(html)
  if (!found) throw new SourceError('SHARE_RESPONSE_INVALID')
  const start = found.index + found[0].lastIndexOf('[')
  let depth = 0, string = false, escape = false
  for (let index = start; index < html.length; index++) {
    const char = html[index]
    if (string) { if (escape) escape = false; else if (char === '\\') escape = true; else if (char === '"') string = false; continue }
    if (char === '"') string = true
    else if (char === '[' || char === '{') depth++
    else if (char === ']' || char === '}') {
      depth--
      if (depth === 0) {
        try { const value: unknown = JSON.parse(html.slice(start, index + 1)); if (Array.isArray(value)) return value } catch { /* Never execute the page's JavaScript. */ }
        break
      }
    }
  }
  throw new SourceError('SHARE_RESPONSE_INVALID')
}
export function parseSharePage(html: string, finalUrl: string, options: { originalUrl: string; name?: string; expectedCount?: number; observedAt?: string }): ImportedPlaylist {
  const url = checkedPublicUrl(finalUrl, 'kugou'), key = url.searchParams.get('global_collection_id') ?? url.searchParams.get('global_specialid')
  if (!key || !/^[A-Za-z0-9_-]{1,160}$/.test(key)) throw new SourceError('SHARE_RESPONSE_INVALID')
  const rows = jsonArrayAssignment(html, 'dataFromSmarty')
  if (rows.length > 20_000 || !rows.length || options.expectedCount !== undefined && rows.length !== options.expectedCount) throw new SourceError('SHARE_COUNT_MISMATCH')
  const tracks = rows.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new SourceError('SHARE_RESPONSE_INVALID')
    const raw = item as Record<string, unknown>, title = raw.song_name, artist = raw.author_name, length = raw.timelength
    if (typeof raw.hash !== 'string' || !/^[A-Fa-f0-9]{32}$/.test(raw.hash) || typeof title !== 'string' || !title ||
      typeof artist !== 'string' || typeof length !== 'number' || !Number.isFinite(length) || length <= 0 || length > 24 * 3600_000) throw new SourceError('SHARE_RESPONSE_INVALID')
    return { position: index + 1, hash: raw.hash, title:withoutAudioExtension(title), artist: artist || null,
      filename: typeof raw.audio_name === 'string' ? raw.audio_name : null,
      durationMs: Math.round(length), album: typeof raw.album_name === 'string' ? raw.album_name : null,
      version: null, raw }
  })
  return { sourceKey: key, name: options.name?.trim() || '酷狗分享歌单', originalUrl: options.originalUrl,
    observedAt: options.observedAt ?? new Date().toISOString(), tracks }
}
export class KugouShareImporter {
  private http: PublicHttpClient
  constructor(http = new PublicHttpClient()) { this.http = http }
  async import(input: string, name?: string, expectedCount?: number): Promise<ImportedPlaylist> {
    const link = validateShareLink(input)
    if (name !== undefined && (typeof name !== 'string' || name.length > 200 || /[\u0000-\u001f]/u.test(name))) throw new SourceError('SHARE_LINK_INVALID')
    const page = await this.http.text(link, 'kugou')
    return parseSharePage(page.text, page.finalUrl, { originalUrl: link, name, expectedCount })
  }
}
