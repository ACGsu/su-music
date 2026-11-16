import type { CandidateId, OnlineSearchRequest, OnlineSearchResult, ResourceCheck, SourceCandidate } from '../../shared/music.ts'
import type { Track } from '../../shared/contracts.ts'
import { candidateKey, validateOnlineSearchRequest } from '../../shared/music.ts'
import type { NeteaseAccountInfo } from '../../shared/account.ts'
import { GdRequestBudget } from './budget.ts'
import { SourceError } from './errors.ts'
import { PublicHttpClient, checkedPublicUrl } from './http.ts'
import { inspectAudioHeader } from './audio.ts'
import { normalizedText } from './matching.ts'
import { withoutAudioExtension, catalogTitle } from '../../shared/track-name.ts'

export interface SourceCache {
  getSourceCache<T>(kind: string, key: string): T | null
  setSourceCache(kind: string, key: string, value: unknown, ttlMs: number): void
}
export interface PlaybackAttempts { used: number; limit: number }
const DAY = 86_400_000

function record(input: unknown): Record<string, unknown> | null { return typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : null }
function text(input: unknown): string | null { return typeof input === 'string' && input.trim() ? input.trim() : null }
function names(input: unknown): string[] {
  if (typeof input === 'string' && input.trim()) return input.split(/[、,，/]/u).map(s => s.trim()).filter(Boolean)
  return Array.isArray(input) ? input.map(item => typeof item === 'string' ? text(item) : text(record(item)?.name)).filter((item): item is string => Boolean(item)) : []
}
function identifier(value: unknown): string | null {
  const result = typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' ? String(value) : ''
  return /^[1-9]\d{0,17}$/.test(result) && Number.isSafeInteger(Number(result)) ? result : null
}
function milliseconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 * 3600_000 ? Math.round(value) : null
}

export function parseGdSearch(input: unknown, maxCount = 20): SourceCandidate[] {
  if (!Array.isArray(input)) throw new SourceError('SOURCE_RESPONSE_INVALID')
  const candidates: SourceCandidate[] = [], seen = new Set<string>()
  for (const item of input) {
    const row = record(item), id = identifier(row?.id), title = text(row?.name)
    if (!row || row.source !== 'netease' || !id || !title || seen.has(id)) continue
    seen.add(id)
    candidates.push({
      providerId: 'gd', sourceId: 'netease', trackId: id, title: withoutAudioExtension(title),
      artists: names(row.artist), album: text(row.album), aliases: [], durationMs: null, metadataComplete: false
    })
    if (candidates.length === maxCount) break
  }
  if (input.length && !candidates.length) throw new SourceError('SOURCE_RESPONSE_INVALID')
  return candidates
}

export function enrichNeteaseCandidates(candidates: SourceCandidate[], input: unknown): SourceCandidate[] {
  const body = record(input)
  if (!body || body.code !== 200 || !Array.isArray(body.songs)) throw new SourceError('SOURCE_RESPONSE_INVALID')
  const songs = new Map<string, Record<string, unknown>>()
  for (const item of body.songs) { const song = record(item), id = identifier(song?.id); if (song && id) songs.set(id, song) }
  return candidates.map(candidate => {
    const song = songs.get(candidate.trackId)
    if (!song) return candidate
    const rawTitle = text(song.name), title = rawTitle ? withoutAudioExtension(rawTitle) : null, artists = names(song.ar ?? song.artists), album = text(record(song.al ?? song.album)?.name)
    const durationMs = milliseconds(song.dt ?? song.duration)
    const consistent = title !== null && normalizedText(title) === normalizedText(candidate.title) &&
      artists.map(normalizedText).sort().join('|') === candidate.artists.map(normalizedText).sort().join('|')
    return {
      ...candidate, title: title ?? candidate.title, artists: artists.length ? artists : candidate.artists,
      album: album ?? candidate.album, durationMs, aliases: [...names(song.alia), ...names(song.alias), ...names(song.tns)],
      metadataComplete: consistent && durationMs !== null && artists.length > 0
    }
  })
}

export function parseGdResource(input: unknown): { url: string; bitrate: number | null; qualityCode: number | null; size: number | null } {
  const row = record(input)
  const code = row && (typeof row.br === 'number' || typeof row.br === 'string' && /^-?\d+$/.test(row.br)) ? Number(row.br) : null
  if (!row || !text(row.url) || code === -1) throw new SourceError('RESOURCE_UNAVAILABLE')
  const url = checkedPublicUrl(String(row.url), 'audio').href
  const size = typeof row.size === 'number' || typeof row.size === 'string' && /^\d+$/.test(row.size) ? Number(row.size) : null
  return {
    url, bitrate: code !== null && code > 0 && code <= 320 ? code : null, qualityCode: code !== null && code > 0 ? code : null,
    size: size !== null && Number.isFinite(size) && size > 0 ? size : null
  }
}

export interface NeteasePlaylistSummary {
  id: string
  name: string
  kind: 'default' | 'created' | 'favorite'
  trackCount: number
  updateTime: number | null
  coverUrl: string | null
  raw: unknown
}

export function parseNeteaseUserlist(input: unknown, uid: string): { owner: NeteaseAccountInfo; playlists: NeteasePlaylistSummary[] } {
  const body = record(input)
  let rawList: unknown[] | null = null
  let nickname: string | null = null
  if (Array.isArray(input)) {
    rawList = input
  } else if (body) {
    if (body.code !== undefined && body.code !== 200) throw new SourceError('SOURCE_RESPONSE_INVALID')
    if (Array.isArray(body.playlist)) rawList = body.playlist
    else if (Array.isArray(body.data)) rawList = body.data
    else if (record(body.data) && Array.isArray((body.data as Record<string, unknown>).playlist)) rawList = (body.data as Record<string, unknown>).playlist as unknown[]
    else if (Array.isArray(body.playlists)) rawList = body.playlists
  }
  if (!rawList) throw new SourceError('SOURCE_RESPONSE_INVALID')
  const playlists: NeteasePlaylistSummary[] = []
  const ids = new Set<string>()
  for (const item of rawList) {
    const row = record(item)
    if (!row) continue
    const id = identifier(row.id)
    const title = text(row.name)
    if (!id || !title) continue
    if (ids.has(id)) throw new SourceError('SOURCE_RESPONSE_INVALID')
    ids.add(id)
    const count = typeof row.trackCount === 'number' && Number.isSafeInteger(row.trackCount) && row.trackCount >= 0
      ? row.trackCount
      : typeof row.count === 'number' && Number.isSafeInteger(row.count) && row.count >= 0
      ? row.count : 0
    const updateTime = typeof row.updateTime === 'number' && Number.isSafeInteger(row.updateTime) ? row.updateTime : null
    const coverUrl = text(row.coverImgUrl) ?? text(row.cover_url) ?? text(row.picUrl) ?? null
    const creator = record(row.creator)
    if (!nickname && creator && String(creator.userId) === String(uid)) {
      if (typeof creator.nickname === 'string' && creator.nickname.trim()) nickname = creator.nickname.trim()
    }
    const specialType = Number(row.specialType ?? 0)
    const isFavorite = specialType === 5 || title === '我喜欢的音乐' || title === '喜欢的音乐'
    const creatorId = creator?.userId ? String(creator.userId) : null
    const rowUserId = row.userId ? String(row.userId) : null
    const isSubscribed = row.subscribed === true || (creatorId !== null && creatorId !== String(uid)) || (rowUserId !== null && rowUserId !== String(uid))
    const isOwner = !isSubscribed && (creatorId === String(uid) || rowUserId === String(uid))
    const kind: 'default' | 'created' | 'favorite' = isFavorite ? 'default' : isOwner ? 'created' : 'favorite'
    playlists.push({ id, name: title, kind, trackCount: count, updateTime, coverUrl, raw: item })
  }
  if (!nickname) {
    for (const item of rawList) {
      const c = record(record(item)?.creator)
      if (typeof c?.nickname === 'string' && c.nickname.trim()) { nickname = c.nickname.trim(); break }
    }
  }
  return { owner: { uid, nickname }, playlists }
}

export function parseNeteasePlaylistTracks(input: unknown): (Track & { songId: string; raw: unknown })[] {
  let list: unknown[] | null = null
  if (Array.isArray(input)) list = input
  else {
    const body = record(input)
    if (body) {
      if (body.code !== undefined && body.code !== 200) throw new SourceError('SOURCE_RESPONSE_INVALID')
      const pl = record(body.playlist)
      if (pl && Array.isArray(pl.tracks)) list = pl.tracks
      else if (Array.isArray(body.tracks)) list = body.tracks
      else if (Array.isArray(body.songs)) list = body.songs
      else if (Array.isArray(body.data)) list = body.data
    }
  }
  if (!list) throw new SourceError('SOURCE_RESPONSE_INVALID')
  const tracks: (Track & { songId: string; raw: unknown })[] = []
  for (const [index, item] of list.entries()) {
    const row = record(item)
    if (!row) throw new SourceError('SOURCE_RESPONSE_INVALID')
    const id = identifier(row.id)
    if (!id) throw new SourceError('SOURCE_RESPONSE_INVALID')
    const rawTitle = text(row.name) ?? text(row.title)
    const title = rawTitle ? withoutAudioExtension(rawTitle) : '标题待补充'
    const artists = names(row.ar ?? row.artists ?? row.artist)
    const album = text(record(row.al ?? row.album)?.name) ?? text(row.album) ?? null
    const durationMs = milliseconds(row.dt ?? row.duration ?? row.durationMs)
    tracks.push({
      position: index + 1,
      songId: id,
      title: catalogTitle(title, null, artists.join('、')),
      filename: null,
      artist: artists.length ? artists.join('、') : null,
      album,
      durationMs,
      version: null,
      raw: item
    })
  }
  return tracks
}

export function extractNeteaseTrackIds(input: unknown): string[] {
  const body = record(input)
  const pl = record(body?.playlist) ?? body
  const list = Array.isArray(pl?.trackIds) ? pl.trackIds : null
  if (!list) return []
  const ids: string[] = []
  for (const item of list) {
    const id = identifier(record(item)?.id ?? item)
    if (id) ids.push(id)
  }
  return ids
}

export class GdNeteaseAdapter {
  private http: PublicHttpClient
  private budget: GdRequestBudget
  private cache: SourceCache
  private pending = new Map<string, Promise<OnlineSearchResult>>()
  private addresses = new Map<string, { value: { url: string; bitrate: number | null; qualityCode: number | null; size: number | null }; at: number }>()

  constructor(cache: SourceCache, budget: GdRequestBudget, http = new PublicHttpClient()) {
    this.cache = cache; this.budget = budget; this.http = http
  }

  private async json(url: string, scope: 'gd' | 'netease', onReserved?: () => void, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
    this.budget.reserve()
    onReserved?.()
    try { return await this.http.json(url, scope, maxBytes) }
    catch (error) { if (error instanceof SourceError && error.code === 'SOURCE_RATE_LIMITED') this.budget.cooldown(error.retryAt ?? Date.now() + 60_000); throw error }
  }

  search(input: string | OnlineSearchRequest, force = false): Promise<OnlineSearchResult> {
    const req = validateOnlineSearchRequest(typeof input === 'string' ? { query: input, refresh: force } : { ...input, refresh: force || input.refresh })
    const cleanQuery = withoutAudioExtension(req.query)
    const key = cleanQuery.normalize('NFKC').toLocaleLowerCase('en-US')
    const pageKey = `${key}:${req.page}`
    const cached = req.refresh ? null : (this.cache.getSourceCache<OnlineSearchResult>('search', pageKey) ?? (req.page === 1 ? this.cache.getSourceCache<OnlineSearchResult>('search', key) : null))
    if (cached) return Promise.resolve({ ...cached, fromCache: true })
    const pendingKey = pageKey
    const waiting = this.pending.get(pendingKey)
    if (waiting) return waiting
    const work = this.searchFresh(cleanQuery, key, pageKey, req.page, req.pageSize, req.refresh).finally(() => this.pending.delete(pendingKey))
    this.pending.set(pendingKey, work)
    return work
  }

  private async searchFresh(query: string, key: string, pageKey: string, page: number, pageSize: number, force: boolean): Promise<OnlineSearchResult> {
    const address = new URL('https://music-api.gdstudio.xyz/api.php')
    address.search = new URLSearchParams({ types: 'search', source: 'netease', name: query, count: String(pageSize), pages: String(page) }).toString()
    const raw = await this.json(address.href, 'gd'), found = parseGdSearch(raw, pageSize)
    const missing = found.filter(candidate => force || !this.cache.getSourceCache<SourceCandidate>('candidate', candidateKey(candidate))?.metadataComplete)
    let filled: SourceCandidate[] = [], warning: string | null = null
    if (missing.length) {
      const metadata = new URL('https://music.163.com/api/song/detail/')
      metadata.search = new URLSearchParams({ id: missing[0]!.trackId, ids: JSON.stringify(missing.map(candidate => Number(candidate.trackId))) }).toString()
      try { filled = enrichNeteaseCandidates(missing, await this.json(metadata.href, 'netease')) }
      catch (error) { if (error instanceof SourceError && error.code === 'SOURCE_RATE_LIMITED') throw error; warning = '部分候选未能补全时长，需人工对照。'; filled = missing }
      for (const candidate of filled) this.cache.setSourceCache('candidate', candidateKey(candidate), candidate, DAY)
    }
    const replacements = new Map(filled.map(candidate => [candidateKey(candidate), candidate]))
    const candidates = found.map(candidate => replacements.get(candidateKey(candidate)) ?? this.cache.getSourceCache<SourceCandidate>('candidate', candidateKey(candidate)) ?? candidate)
    if (!warning && candidates.some(candidate => !candidate.metadataComplete)) warning = '部分候选资料缺失或存在差异，需人工对照。'
    const hasMore = found.length >= pageSize
    const result: OnlineSearchResult = { query, page, pageSize, hasMore, candidates, fromCache: false, metadataWarning: warning }
    this.cache.setSourceCache('search', pageKey, result, warning ? 60_000 : DAY)
    return result
  }

  async checkResource(candidate: CandidateId, force = false): Promise<ResourceCheck> {
    const key = candidateKey(candidate), old = force ? null : this.cache.getSourceCache<ResourceCheck>('resource_check', key)
    if (old) return { ...old, fromCache: true }
    const base: ResourceCheck = {
      candidate, status: 'unavailable', checkedAt: new Date().toISOString(), fromCache: false,
      requestedBitrateKbps: 320, returnedBitrateKbps: null, verifiedBitrateKbps: null, format: null, sampleRateHz: null,
      reportedSize: null, totalBytes: null, inspectedBytes: 0, rangeSupported: null, completeness: 'not_verified', reason: null
    }
    let result = base
    for (const quality of [320, 128]) {
      try {
        const address = new URL('https://music-api.gdstudio.xyz/api.php')
        address.search = new URLSearchParams({ types: 'url', source: 'netease', id: candidate.trackId, br: String(quality) }).toString()
        const resource = parseGdResource(await this.json(address.href, 'gd'))
        result = { ...base, requestedBitrateKbps: quality, returnedBitrateKbps: resource.bitrate, returnedQualityCode: resource.qualityCode, reportedSize: resource.size }
        const response = await this.http.response(resource.url, 'audio', { Range: 'bytes=0-65535' })
        const type = response.headers.get('content-type') ?? ''
        if (/text\/|json|html/i.test(type)) { await response.body?.cancel(); throw new SourceError('RESOURCE_NOT_AUDIO') }
        const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
        if (response.status === 206 && (!range || Number(range[1]) >= Number(range[2]))) { await response.body?.cancel(); throw new SourceError('RESOURCE_RANGE_INVALID') }
        const length = response.headers.get('content-length'), total = range ? Number(range[2]) : response.status === 200 && length ? Number(length) : null
        const chunks: Uint8Array[] = []; let inspected = 0
        const reader = response.body?.getReader()
        if (!reader) throw new SourceError('RESOURCE_UNAVAILABLE')
        try {
          while (inspected < 65_536) {
            const chunk = await reader.read(); if (chunk.done) break
            const remaining = 65_536 - inspected, value = chunk.value.subarray(0, remaining)
            chunks.push(value); inspected += value.byteLength
          }
        } finally { await reader.cancel().catch(() => {}) }
        if (range && inspected < Math.min(Number(range[1]) + 1, 65_536)) throw new SourceError('RESOURCE_RANGE_INVALID')
        const audio = inspectAudioHeader(Buffer.concat(chunks))
        result = {
          ...result, status: audio.format ? 'readable' : 'unverified', format: audio.format,
          verifiedBitrateKbps: audio.bitrateKbps, sampleRateHz: audio.sampleRateHz,
          totalBytes: total !== null && Number.isSafeInteger(total) && total > 0 ? total : null,
          inspectedBytes: inspected, rangeSupported: response.status === 206, reason: audio.format ? null : '音频头部暂未确认'
        }
        break
      } catch (error) {
        if (error instanceof SourceError && error.code === 'SOURCE_RATE_LIMITED') throw error
        result = { ...result, reason: error instanceof SourceError ? error.code : 'SOURCE_TIMEOUT' }
      }
    }
    this.cache.setSourceCache('resource_check', key, result, result.status === 'readable' ? 120_000 : 60_000)
    return result
  }

  async resolvePlayback(candidate: CandidateId, options: { force?: boolean; lowQuality?: boolean; maxAttempts?: number; attempts?: PlaybackAttempts } = {}): Promise<{ url: string; bitrate: number | null; qualityCode: number | null; size: number | null; attempts: number }> {
    const key = candidateKey(candidate), cached = options.force ? null : this.addresses.get(key)
    if (cached && cached.at + 120000 > Date.now()) return { ...cached.value, attempts: 0 }
    const budget = options.attempts ?? { used: 0, limit: Math.min(2, options.maxAttempts ?? 2) }, before = budget.used
    let last: unknown
    const qualities = options.lowQuality ? [128] : [320, 128]
    for (const bitrate of qualities) {
      if (budget.used >= budget.limit) break
      try {
        const url = new URL('https://music-api.gdstudio.xyz/api.php')
        url.search = new URLSearchParams({ types: 'url', source: 'netease', id: candidate.trackId, br: String(bitrate) }).toString()
        const body = await this.json(url.href, 'gd', () => budget.used++)
        const value = parseGdResource(body)
        const now = Date.now()
        for (const [id, row] of this.addresses) if (row.at + 120000 <= now) this.addresses.delete(id)
        if (this.addresses.size >= 100) this.addresses.delete(this.addresses.keys().next().value!)
        this.addresses.set(key, { value, at: now })
        return { ...value, attempts: budget.used - before }
      } catch (error) {
        if (error instanceof SourceError && error.code === 'SOURCE_RATE_LIMITED') throw error
        last = error
      }
    }
    throw last ?? new SourceError('RESOURCE_UNAVAILABLE')
  }

  async fetchUserPlaylists(uid: string, _signal?: AbortSignal): Promise<{ owner: NeteaseAccountInfo; playlists: NeteasePlaylistSummary[] }> {
    if (!/^[1-9]\d{0,17}$/.test(uid)) throw new SourceError('INVALID_UID')
    const address = new URL('https://music-api.gdstudio.xyz/api.php')
    address.search = new URLSearchParams({ types: 'userlist', source: 'netease', id: uid, uid }).toString()
    const raw = await this.json(address.href, 'gd', undefined, 32 * 1024 * 1024)
    return parseNeteaseUserlist(raw, uid)
  }

  async fetchPlaylistTracks(id: string, signal?: AbortSignal): Promise<(Track & { songId: string; raw: unknown })[]> {
    if (!/^[1-9]\d{0,17}$/.test(id)) throw new SourceError('INVALID_REQUEST')
    const address = new URL('https://music-api.gdstudio.xyz/api.php')
    address.search = new URLSearchParams({ types: 'playlist', source: 'netease', id }).toString()
    const raw = await this.json(address.href, 'gd', undefined, 32 * 1024 * 1024)
    const tracks = parseNeteasePlaylistTracks(raw)
    const allTrackIds = extractNeteaseTrackIds(raw)
    if (allTrackIds.length > tracks.length) {
      const existingIds = new Set(tracks.map(t => t.songId))
      const missingIds = allTrackIds.filter(tid => !existingIds.has(tid))
      const chunkSize = 200
      for (let i = 0; i < missingIds.length; i += chunkSize) {
        if (signal?.aborted) throw new SourceError('SOURCE_TIMEOUT')
        const chunk = missingIds.slice(i, i + chunkSize)
        const metadata = new URL('https://music.163.com/api/song/detail/')
        metadata.search = new URLSearchParams({
          id: chunk[0]!,
          ids: JSON.stringify(chunk.map(v => Number(v)))
        }).toString()
        try {
          const songData = await this.http.json(metadata.href, 'netease')
          const extraTracks = parseNeteasePlaylistTracks(songData)
          for (const t of extraTracks) {
            if (!existingIds.has(t.songId)) {
              existingIds.add(t.songId)
              tracks.push({
                ...t,
                position: tracks.length + 1
              })
            }
          }
        } catch {
          // Gracefully degrade: if a chunk fails to fetch, keep already retrieved tracks
          break
        }
      }
    }
    return tracks
  }
}
