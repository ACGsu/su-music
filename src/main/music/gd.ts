import type { CandidateId, OnlineSearchResult, ResourceCheck, SourceCandidate } from '../../shared/music.ts'
import { candidateKey, validateQuery } from '../../shared/music.ts'
import { GdRequestBudget } from './budget.ts'
import { SourceError } from './errors.ts'
import { PublicHttpClient, checkedPublicUrl } from './http.ts'
import { inspectAudioHeader } from './audio.ts'
import { normalizedText } from './matching.ts'
import {withoutAudioExtension} from '../../shared/track-name.ts'

export interface SourceCache {
  getSourceCache<T>(kind: string, key: string): T | null
  setSourceCache(kind: string, key: string, value: unknown, ttlMs: number): void
}
export interface PlaybackAttempts {used:number;limit:number}
const DAY = 86_400_000
function record(input: unknown): Record<string, unknown> | null { return typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : null }
function text(input: unknown): string | null { return typeof input === 'string' && input.trim() ? input.trim() : null }
function names(input: unknown): string[] { return Array.isArray(input) ? input.map(item => typeof item === 'string' ? text(item) : text(record(item)?.name)).filter((item): item is string => Boolean(item)) : [] }
function identifier(value: unknown): string | null { const result = typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' ? String(value) : ''; return /^[1-9]\d{0,17}$/.test(result) && Number.isSafeInteger(Number(result)) ? result : null }
function milliseconds(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 * 3600_000 ? Math.round(value) : null }

export function parseGdSearch(input: unknown): SourceCandidate[] {
  if (!Array.isArray(input)) throw new SourceError('SOURCE_RESPONSE_INVALID')
  const candidates: SourceCandidate[] = [], seen = new Set<string>()
  for (const item of input) {
    const row = record(item), id = identifier(row?.id), title = text(row?.name)
    if (!row || row.source !== 'netease' || !id || !title || seen.has(id)) continue
    seen.add(id)
    candidates.push({ providerId: 'gd', sourceId: 'netease', trackId: id, title:withoutAudioExtension(title), artists: names(row.artist),
      album: text(row.album), aliases: [], durationMs: null, metadataComplete: false })
    if (candidates.length === 20) break
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
    const rawTitle = text(song.name),title=rawTitle?withoutAudioExtension(rawTitle):null, artists = names(song.ar ?? song.artists), album = text(record(song.al ?? song.album)?.name)
    const durationMs = milliseconds(song.dt ?? song.duration)
    const consistent = title !== null && normalizedText(title) === normalizedText(candidate.title) &&
      artists.map(normalizedText).sort().join('|') === candidate.artists.map(normalizedText).sort().join('|')
    return { ...candidate, title: title ?? candidate.title, artists: artists.length ? artists : candidate.artists,
      album: album ?? candidate.album, durationMs, aliases: [...names(song.alia), ...names(song.alias), ...names(song.tns)],
      metadataComplete: consistent && durationMs !== null && artists.length > 0 }
  })
}
export function parseGdResource(input: unknown): { url: string; bitrate: number | null; qualityCode: number | null; size: number | null } {
  const row = record(input)
  const code = row && (typeof row.br === 'number' || typeof row.br === 'string' && /^-?\d+$/.test(row.br)) ? Number(row.br) : null
  if (!row || !text(row.url) || code === -1) throw new SourceError('RESOURCE_UNAVAILABLE')
  const url = checkedPublicUrl(String(row.url), 'audio').href
  const size = typeof row.size === 'number' || typeof row.size === 'string' && /^\d+$/.test(row.size) ? Number(row.size) : null
  return { url, bitrate: code !== null && code > 0 && code <= 320 ? code : null, qualityCode: code !== null && code > 0 ? code : null,
    size: size !== null && Number.isFinite(size) && size > 0 ? size : null }
}

export class GdNeteaseAdapter {
  private http: PublicHttpClient
  private budget: GdRequestBudget
  private cache: SourceCache
  private pending = new Map<string, Promise<OnlineSearchResult>>()
  private addresses=new Map<string,{value:{url:string;bitrate:number|null;qualityCode:number|null;size:number|null};at:number}>()
  constructor(cache: SourceCache, budget: GdRequestBudget, http = new PublicHttpClient()) { this.cache = cache; this.budget = budget; this.http = http }
  private async json(url: string, scope: 'gd' | 'netease',onReserved?:()=>void): Promise<unknown> {
    this.budget.reserve()
    onReserved?.()
    try { return await this.http.json(url, scope) }
    catch (error) { if (error instanceof SourceError && error.code === 'SOURCE_RATE_LIMITED') this.budget.cooldown(error.retryAt ?? Date.now() + 60_000); throw error }
  }
  search(input: string, force = false): Promise<OnlineSearchResult> {
    const query = validateQuery(withoutAudioExtension(validateQuery(input))), key = query.normalize('NFKC').toLocaleLowerCase('en-US')
    const cached = force ? null : this.cache.getSourceCache<OnlineSearchResult>('search', key)
    if (cached) return Promise.resolve({ ...cached, fromCache: true })
    const waiting = this.pending.get(key)
    if (waiting) return waiting
    const work = this.searchFresh(query, key, force).finally(() => this.pending.delete(key))
    this.pending.set(key, work); return work
  }
  private async searchFresh(query: string, key: string, force: boolean): Promise<OnlineSearchResult> {
    const address = new URL('https://music-api.gdstudio.xyz/api.php')
    address.search = new URLSearchParams({ types: 'search', source: 'netease', name: query, count: '20', pages: '1' }).toString()
    const raw = await this.json(address.href, 'gd'), found = parseGdSearch(raw)
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
    const result = { query, candidates, fromCache: false, metadataWarning: warning }
    this.cache.setSourceCache('search', key, result, warning ? 60_000 : DAY)
    return result
  }
  async checkResource(candidate: CandidateId, force = false): Promise<ResourceCheck> {
    const key = candidateKey(candidate), old = force ? null : this.cache.getSourceCache<ResourceCheck>('resource_check', key)
    if (old) return { ...old, fromCache: true }
    const base: ResourceCheck = { candidate, status: 'unavailable', checkedAt: new Date().toISOString(), fromCache: false,
      requestedBitrateKbps: 320, returnedBitrateKbps: null, verifiedBitrateKbps: null, format: null, sampleRateHz: null,
      reportedSize: null, totalBytes: null, inspectedBytes: 0, rangeSupported: null, completeness: 'not_verified', reason: null }
    let result = base
    for (const quality of [320,128]) {
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
        result = { ...result, status: audio.format ? 'readable' : 'unverified', format: audio.format,
          verifiedBitrateKbps: audio.bitrateKbps, sampleRateHz: audio.sampleRateHz,
          totalBytes: total !== null && Number.isSafeInteger(total) && total > 0 ? total : null,
          inspectedBytes: inspected, rangeSupported: response.status === 206, reason: audio.format ? null : '音频头部暂未确认' }
        break
      } catch (error) {
        if (error instanceof SourceError && error.code === 'SOURCE_RATE_LIMITED') throw error
        result = { ...result, reason: error instanceof SourceError ? error.code : 'SOURCE_TIMEOUT' }
      }
    }
    this.cache.setSourceCache('resource_check', key, result, result.status === 'readable' ? 120_000 : 60_000)
    return result
  }
  async resolvePlayback(candidate:CandidateId,options:{force?:boolean;lowQuality?:boolean;maxAttempts?:number;attempts?:PlaybackAttempts}={}):Promise<{url:string;bitrate:number|null;qualityCode:number|null;size:number|null;attempts:number}>{
    const key=candidateKey(candidate),cached=options.force?null:this.addresses.get(key)
    if(cached&&cached.at+120000>Date.now())return{...cached.value,attempts:0}
    const budget=options.attempts??{used:0,limit:Math.min(2,options.maxAttempts??2)},before=budget.used
    let last:unknown
    const qualities=options.lowQuality?[128]:[320,128]
    for(const bitrate of qualities){
      if(budget.used>=budget.limit)break
      try{const url=new URL('https://music-api.gdstudio.xyz/api.php');url.search=new URLSearchParams({types:'url',source:'netease',id:candidate.trackId,br:String(bitrate)}).toString()
        const body=await this.json(url.href,'gd',()=>budget.used++),value=parseGdResource(body)
        const now=Date.now();for(const [id,row]of this.addresses)if(row.at+120000<=now)this.addresses.delete(id)
        if(this.addresses.size>=100)this.addresses.delete(this.addresses.keys().next().value!)
        this.addresses.set(key,{value,at:now});return{...value,attempts:budget.used-before}
      }catch(error){if(error instanceof SourceError&&error.code==='SOURCE_RATE_LIMITED')throw error;last=error}
    }
    throw last??new SourceError('RESOURCE_UNAVAILABLE')
  }
}
