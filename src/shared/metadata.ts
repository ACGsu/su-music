import type { PlayerState } from './playback.ts'
import { candidateKey } from './music.ts'

export interface LyricLine {
  timeMs: number
  text: string
  translation: string | null
}

export interface TrackLyrics {
  state: 'timed' | 'plain' | 'instrumental' | 'unavailable' | 'error'
  lines: LyricLine[]
  text: string | null
  reason: string | null
  retryAt: number | null
}

export interface TrackArtwork {
  identity: string
  url: string | null
}

export interface CurrentTrackMetadata {
  currentId: string
  identity: string
  artworkUrl: string | null
  lyrics: TrackLyrics
}

export function currentMetadataIdentity(player: PlayerState | null): string {
  if (!player?.currentId || !player.now) return ''
  const now = player.now
  return JSON.stringify([
    player.currentId,
    now.candidate ? candidateKey(now.candidate) : null,
    now.localId, now.localStamp ?? null,
    now.reference?.collectionId ?? null, now.reference?.position ?? null,
    now.title, now.artist, now.album, now.version, now.binding
  ])
}

export function activeLyricIndex(lines: readonly LyricLine[], positionMs: number): number {
  let left = 0, right = lines.length - 1, result = -1
  while (left <= right) {
    const middle = (left + right) >>> 1
    if (lines[middle]!.timeMs <= positionMs) { result = middle; left = middle + 1 }
    else right = middle - 1
  }
  return result
}
