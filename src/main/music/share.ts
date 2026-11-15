import type { ImportedPlaylist } from '../../shared/music.ts'
import { checkedPublicUrl, PublicHttpClient } from './http.ts'
import { SourceError } from './errors.ts'
import { withoutAudioExtension } from '../../shared/track-name.ts'
import { parseNeteasePlaylistTracks } from './gd.ts'

export function extractShareUrl(input: string): string {
  const match = /(https?:\/\/[^\s"'<>]+)/i.exec(input)
  return match && match[1] ? match[1] : input.trim()
}

export function parseNeteasePlaylistId(url: URL): string | null {
  const fromQuery = url.searchParams.get('id')
  if (fromQuery && /^[1-9]\d{0,17}$/.test(fromQuery)) return fromQuery

  if (url.hash) {
    const match = /[?&]id=([1-9]\d{0,17})/.exec(url.hash)
    if (match && match[1]) return match[1]
  }

  const pathMatch = /^\/(?:m\/)?playlist\/([1-9]\d{0,17})\/?$/.exec(url.pathname)
  if (pathMatch && pathMatch[1]) return pathMatch[1]

  return null
}

export function detectShareProvider(input: string): 'kugou' | 'netease' {
  const extracted = extractShareUrl(input)
  if (/^[1-9]\d{0,17}$/.test(extracted)) return 'netease'
  let url: URL
  try { url = new URL(extracted) } catch { throw new SourceError('SHARE_LINK_INVALID') }
  if (url.hostname.endsWith('.kugou.com')) return 'kugou'
  if (['music.163.com', 'y.music.163.com', '163cn.tv', '163.lu'].includes(url.hostname)) return 'netease'
  throw new SourceError('SHARE_LINK_INVALID')
}

export function validateShareLink(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new SourceError('SHARE_LINK_INVALID')
  const provider = detectShareProvider(input)
  const extracted = extractShareUrl(input)
  if (provider === 'kugou') {
    const url = checkedPublicUrl(extracted, 'kugou')
    if (!(url.hostname === 't1.kugou.com' && /^\/[A-Za-z0-9]{6,40}\/?$/.test(url.pathname)) &&
      !(url.hostname === 'wwwapi.kugou.com' && url.pathname === '/share/zlist.html') &&
      !(url.hostname === 'activity.kugou.com' && url.pathname.startsWith('/share/'))) throw new SourceError('SHARE_LINK_INVALID')
    return url.href
  }
  if (/^[1-9]\d{0,17}$/.test(extracted)) {
    return `https://music.163.com/playlist?id=${extracted}`
  }
  const url = checkedPublicUrl(extracted, 'netease')
  if (!(url.hostname === '163cn.tv' || url.hostname === '163.lu') && !parseNeteasePlaylistId(url)) {
    throw new SourceError('SHARE_LINK_INVALID')
  }
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
    return { position: index + 1, hash: raw.hash, title: withoutAudioExtension(title), artist: artist || null,
      filename: typeof raw.audio_name === 'string' ? raw.audio_name : null,
      durationMs: Math.round(length), album: typeof raw.album_name === 'string' ? raw.album_name : null,
      version: null, raw }
  })
  return { provider: 'kugou', sourceKey: key, name: options.name?.trim() || '酷狗分享歌单', originalUrl: options.originalUrl,
    observedAt: options.observedAt ?? new Date().toISOString(), tracks }
}

export function parseNeteasePlaylistDetail(
  raw: unknown,
  playlistId: string,
  options: { originalUrl: string; name?: string; expectedCount?: number; observedAt?: string }
): ImportedPlaylist {
  const body = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw as Record<string, unknown> : {}
  const pl = (body.playlist && typeof body.playlist === 'object' && !Array.isArray(body.playlist)) ? body.playlist as Record<string, unknown> : null
  const playlistName = (pl && typeof pl.name === 'string' && pl.name.trim())
    ? pl.name.trim()
    : (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : null
  const coverUrl = (pl && typeof pl.coverImgUrl === 'string' && pl.coverImgUrl.trim())
    ? pl.coverImgUrl.trim()
    : (typeof body.coverImgUrl === 'string' && body.coverImgUrl.trim()) ? body.coverImgUrl.trim() : null

  const parsed = parseNeteasePlaylistTracks(raw)
  if (!parsed.length || (options.expectedCount !== undefined && parsed.length !== options.expectedCount)) {
    throw new SourceError('SHARE_COUNT_MISMATCH')
  }

  const tracks = parsed.map(track => ({
    position: track.position,
    hash: 'ne:' + track.songId,
    songId: track.songId,
    title: track.title,
    filename: track.filename,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs,
    version: null,
    raw: track.raw
  }))

  return {
    provider: 'netease',
    sourceKey: playlistId,
    name: options.name?.trim() || playlistName || '网易云歌单',
    originalUrl: options.originalUrl,
    observedAt: options.observedAt ?? new Date().toISOString(),
    coverUrl: coverUrl ?? null,
    tracks
  }
}

export class NeteasePlaylistImporter {
  private http: PublicHttpClient
  constructor(http = new PublicHttpClient()) { this.http = http }

  async resolvePlaylistId(url: URL): Promise<string> {
    const directId = parseNeteasePlaylistId(url)
    if (directId) return directId
    if (url.hostname === '163cn.tv' || url.hostname === '163.lu') {
      const page = await this.http.text(url.href, 'netease')
      const finalUrl = new URL(page.finalUrl)
      const resolvedId = parseNeteasePlaylistId(finalUrl)
      if (resolvedId) return resolvedId
      const htmlMatch = /(?:playlist\?id=|\/playlist\/)([1-9]\d{0,17})/.exec(page.text)
      if (htmlMatch && htmlMatch[1]) return htmlMatch[1]
    }
    throw new SourceError('SHARE_LINK_INVALID')
  }

  async import(input: string, name?: string, expectedCount?: number): Promise<ImportedPlaylist> {
    const link = validateShareLink(input)
    if (name !== undefined && (typeof name !== 'string' || name.length > 200 || /[\u0000-\u001f]/u.test(name))) throw new SourceError('SHARE_LINK_INVALID')
    const url = new URL(link)
    const playlistId = await this.resolvePlaylistId(url)

    const gdUrl = new URL('https://music-api.gdstudio.xyz/api.php')
    gdUrl.search = new URLSearchParams({ types: 'playlist', source: 'netease', id: playlistId }).toString()
    let raw: unknown
    try {
      raw = await this.http.json(gdUrl.href, 'gd')
      if (typeof raw !== 'object' || raw === null || (raw as Record<string, unknown>).code === 404) {
        throw new Error('FALLBACK')
      }
    } catch {
      raw = await this.http.json(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}`, 'netease')
    }

    return parseNeteasePlaylistDetail(raw, playlistId, { originalUrl: link, name, expectedCount })
  }
}

export class KugouShareImporter {
  private http: PublicHttpClient
  private netease: NeteasePlaylistImporter
  constructor(http = new PublicHttpClient()) {
    this.http = http
    this.netease = new NeteasePlaylistImporter(http)
  }

  async import(input: string, name?: string, expectedCount?: number): Promise<ImportedPlaylist> {
    const provider = detectShareProvider(input)
    if (provider === 'netease') {
      return this.netease.import(input, name, expectedCount)
    }
    const link = validateShareLink(input)
    if (name !== undefined && (typeof name !== 'string' || name.length > 200 || /[\u0000-\u001f]/u.test(name))) throw new SourceError('SHARE_LINK_INVALID')
    const page = await this.http.text(link, 'kugou')
    return parseSharePage(page.text, page.finalUrl, { originalUrl: link, name, expectedCount })
  }
}

export const ShareImporter = KugouShareImporter
