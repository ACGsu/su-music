import type { Track } from './contracts.ts'

export const GD_ATTRIBUTION = 'GD音乐台(music.gdstudio.xyz)'
export interface CandidateId { providerId: 'gd'; sourceId: 'netease'; trackId: string }
export interface SourceCandidate extends CandidateId {
  title: string
  artists: string[]
  album: string | null
  aliases: string[]
  durationMs: number | null
  metadataComplete: boolean
}
export interface OriginalTrack extends Track { hash?: string | null; aliases?: string[] }
export interface TrackReference { collectionId: string; position: number }
export type MatchStatus = 'unchecked' | 'candidate_matched' | 'needs_review' | 'not_found'
export interface CandidateComparison {
  candidate: SourceCandidate
  decision: 'matched' | 'review' | 'rejected'
  reasons: string[]
  durationDifferenceMs: number | null
}
export interface MatchResult {
  original: Track
  status: Exclude<MatchStatus, 'unchecked'>
  candidates: CandidateComparison[]
  automaticCandidate: string | null
  checkedAt: string
  fromCache: boolean
}
export interface OnlineSearchRequest {
  query: string
  page?: number
  pageSize?: number
  refresh?: boolean
}
export interface OnlineSearchResult {
  query: string
  page: number
  pageSize: number
  hasMore: boolean
  candidates: SourceCandidate[]
  fromCache: boolean
  metadataWarning: string | null
}
export interface LibrarySearchItem { reference: TrackReference; collectionName: string; collectionKind: string; track: Track }
export interface ResourceCheck {
  candidate: CandidateId
  status: 'readable' | 'unavailable' | 'unverified'
  checkedAt: string
  fromCache: boolean
  requestedBitrateKbps: number
  returnedBitrateKbps: number | null
  returnedQualityCode?: number | null
  verifiedBitrateKbps: number | null
  format: string | null
  sampleRateHz: number | null
  reportedSize: number | null
  totalBytes: number | null
  inspectedBytes: number
  rangeSupported: boolean | null
  completeness: 'not_verified'
  reason: string | null
}
export interface ImportedPlaylist {
  provider?: 'kugou' | 'netease'
  sourceKey: string
  name: string
  originalUrl: string
  observedAt: string
  coverUrl?: string | null
  tracks: (OriginalTrack & { songId?: string; raw: unknown })[]
}
export function candidateKey(candidate: CandidateId): string { return `${candidate.providerId}:${candidate.sourceId}:${candidate.trackId}` }

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('INVALID_REQUEST')
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error('INVALID_REQUEST')
  return input as Record<string, unknown>
}
export function validateQuery(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 200 || /[\u0000-\u001f]/u.test(input)) throw new Error('INVALID_REQUEST')
  return input.trim()
}
export function validateOnlineSearchRequest(input: unknown): Required<OnlineSearchRequest> {
  if (typeof input === 'string') {
    return { query: validateQuery(input), page: 1, pageSize: 20, refresh: false }
  }
  const value = object(input, ['query', 'page', 'pageSize', 'refresh'])
  const query = validateQuery(value.query)
  const page = value.page === undefined ? 1 : typeof value.page === 'number' && Number.isSafeInteger(value.page) && value.page >= 1 ? value.page : null
  if (page === null) throw new Error('INVALID_REQUEST')
  const pageSize = value.pageSize === undefined ? 20 : typeof value.pageSize === 'number' && Number.isSafeInteger(value.pageSize) && value.pageSize >= 1 && value.pageSize <= 50 ? value.pageSize : null
  if (pageSize === null) throw new Error('INVALID_REQUEST')
  const refresh = value.refresh === undefined ? false : typeof value.refresh === 'boolean' ? value.refresh : null
  if (refresh === null) throw new Error('INVALID_REQUEST')
  return { query, page, pageSize, refresh }
}
export function validateTrackReference(input: unknown): TrackReference {
  const value = object(input, ['collectionId', 'position'])
  if (typeof value.collectionId !== 'string' || !value.collectionId || value.collectionId.length > 128 ||
    typeof value.position !== 'number' || !Number.isSafeInteger(value.position) || value.position < 1 || value.position > 1_000_000) throw new Error('INVALID_REQUEST')
  return { collectionId: value.collectionId, position: value.position }
}
export function validateCandidateId(input: unknown): CandidateId {
  const value = object(input, ['providerId', 'sourceId', 'trackId'])
  if (value.providerId !== 'gd' || value.sourceId !== 'netease' || typeof value.trackId !== 'string' || !/^[1-9]\d{0,17}$/.test(value.trackId) || !Number.isSafeInteger(Number(value.trackId))) throw new Error('INVALID_REQUEST')
  return { providerId: 'gd', sourceId: 'netease', trackId: value.trackId }
}
