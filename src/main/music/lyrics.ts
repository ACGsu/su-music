import type { LyricLine, TrackLyrics } from '../../shared/metadata.ts'
import { activeLyricIndex } from '../../shared/metadata.ts'
import { SourceError } from './errors.ts'

const MAX_TEXT = 512 * 1024, MAX_LINES = 5000
const TIME = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
const TAG = /\[(?:al|ar|au|by|id|offset|re|ti|ve|length):[^\]]*\]/gi
interface ParsedLine { timeMs: number; text: string }

export function parseLrc(input: string): { lines: ParsedLine[]; text: string } {
  const source = input.slice(0, MAX_TEXT).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(source)?.[1] ?? 0)
  const adjustment = Number.isSafeInteger(offset) && Math.abs(offset) <= 86400_000 ? offset : 0
  const lines: ParsedLine[] = [], plain: string[] = [], seen = new Set<string>()
  for (const raw of source.split('\n').slice(0, MAX_LINES)) {
    const tags = [...raw.matchAll(TIME)]
    const text = raw.replace(TIME, '').replace(TAG, '').trim().slice(0, 2000)
    if (!text) continue
    if (!tags.length) { plain.push(text); continue }
    for (const tag of tags) {
      const seconds = Number(tag[2]), fraction = (tag[3] ?? '').padEnd(3, '0')
      const timeMs = Math.max(0, Number(tag[1]) * 60_000 + seconds * 1000 + Number(fraction) - adjustment)
      if (seconds >= 60 || timeMs > 86400_000) continue
      const key = timeMs + ':' + text
      if (!seen.has(key) && lines.length < MAX_LINES) { seen.add(key); lines.push({ timeMs, text }) }
    }
  }
  lines.sort((a, b) => a.timeMs - b.timeMs)
  const grouped: ParsedLine[] = []
  for (const line of lines) {
    const previous = grouped.at(-1)
    if (previous?.timeMs === line.timeMs) previous.text += '\n' + line.text
    else grouped.push({ ...line })
  }
  return { lines: grouped, text: (grouped.length ? '' : plain.join('\n')).trim() }
}

export function emptyLyrics(state: TrackLyrics['state'] = 'unavailable', reason: string | null = null): TrackLyrics {
  return { state, lines: [], text: null, reason, retryAt: null }
}

export function parseNeteaseLyrics(input: unknown): TrackLyrics {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SourceError('SOURCE_RESPONSE_INVALID')
  const body = input as Record<string, unknown>
  if (body.code !== 200) throw new SourceError('SOURCE_RESPONSE_INVALID')
  if (body.nolyric === true) return emptyLyrics('instrumental')
  const lyricText = (value: unknown): string => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
    const lyric = (value as Record<string, unknown>).lyric
    return typeof lyric === 'string' ? lyric : ''
  }
  const original = parseLrc(lyricText(body.lrc)), translated = parseLrc(lyricText(body.tlyric))
  const instrumental = (value: string) => /^(?:纯音乐[，,。\s]*(?:请欣赏)?|instrumental)$/i.test(value)
  if (original.lines.length && original.lines.every(line => instrumental(line.text))) return emptyLyrics('instrumental')
  if (!original.lines.length) {
    if (instrumental(original.text)) return emptyLyrics('instrumental')
    return original.text ? { ...emptyLyrics('plain'), text: original.text } : emptyLyrics()
  }
  const lines: LyricLine[] = original.lines.map(line => ({ ...line, translation: null }))
  for (const translation of translated.lines) {
    const previous = activeLyricIndex(lines, translation.timeMs), next = previous + 1
    const before = previous >= 0 ? Math.abs(lines[previous]!.timeMs - translation.timeMs) : Infinity
    const after = next < lines.length ? Math.abs(lines[next]!.timeMs - translation.timeMs) : Infinity
    const index = before <= after ? previous : next
    if (Math.min(before, after) > 500 || index < 0) continue
    const line = lines[index]!
    if (translation.text === line.text) continue
    line.translation = line.translation ? line.translation + '\n' + translation.text : translation.text
  }
  return { ...emptyLyrics('timed'), lines }
}
