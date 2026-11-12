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
export interface OnlineSearchResult {
  query: string
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
  sourceKey: string
  name: string
  originalUrl: string
  observedAt: string
  tracks: (OriginalTrack & { raw: unknown })[]
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
