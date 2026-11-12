import type { CandidateComparison, MatchResult, OriginalTrack, SourceCandidate } from '../../shared/music.ts'
import { candidateKey } from '../../shared/music.ts'
import {catalogTitle,publicTrack,withoutAudioExtension} from '../../shared/track-name.ts'

const VERSION_PATTERNS: [string, RegExp][] = [
  ['movie_edit', /\bmovie\s*edit\b/gi], ['movie', /\bmovie(?:\s*(?:ver(?:sion)?\.?))?\b|映画版/gi],
  ['original', /\boriginal(?:\s*ver(?:sion)?\.?)?\b/gi], ['live', /\blive\b|ライブ|现场|現場/gi],
  ['remix', /\bremix\b|混音/gi], ['cover', /\bcover\b|翻唱|翻自|カバー/gi],
  ['instrumental', /\binstrumental\b|纯音乐|純音樂|伴奏/gi], ['acoustic', /\bacoustic\b/gi],
  ['radio_edit', /\bradio\s*edit\b/gi], ['extended', /\bextended\b/gi],
  ['remaster', /\bremaster(?:ed)?\b/gi], ['demo', /\bdemo\b/gi], ['karaoke', /\bkaraoke\b|カラオケ/gi],
  ['short', /\bshort(?:\s*ver(?:sion)?\.?)?\b|短版|剪辑版|剪輯版/gi], ['tv_size', /\btv\s*(?:size|ver\.?|version)\b/gi],
  ['reimagined', /\bre[\s-]*imagined(?:\s*version)?\b/gi], ['chinese', /中文版|国语版|國語版|\bchinese\s*(?:ver\.?|version)\b/gi],
  ['english', /\benglish\s*(?:ver\.?|version|edition)\b|英文版/gi]
]
export function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{Z}\s]+/gu, '')
}
export function titleIdentity(value: string): { title: string; versions: string[] } {
  let text = withoutAudioExtension(value).normalize('NFKC')
  const versions = new Set<string>()
  for (const [label, expression] of VERSION_PATTERNS) {
    expression.lastIndex = 0
    text = text.replace(expression, () => { versions.add(label); return '' })
  }
  return { title: normalizedText(text), versions: [...versions].sort() }
}
export function titleForms(value: string): string[] {
  let text = withoutAudioExtension(value).normalize('NFKC')
  // Parenthetical translations in a Japanese title are aliases; version labels are handled separately.
  if (/[\p{Script=Han}\u3040-\u30ff]/u.test(text)) text = text.replace(/\(([^()]*)\)/gu, (whole, content: string) => {
    return /\p{Script=Han}/u.test(content) && !/[\u3040-\u30ffA-Za-z\d]/u.test(content) &&
      !/版|录|錄|片段|剪辑|剪輯|试听|試聽/u.test(content) && titleIdentity(content).versions.length === 0 ? '' : whole
  })
  const withoutCredit = text.replace(/\(?\bfeat\.?\s*[^()]+\)?/giu, '')
  return [...new Set([value, text, withoutCredit].map(item => titleIdentity(item).title).filter(Boolean))]
}
function artists(value: string[]): string[] { return [...new Set(value.map(normalizedText).filter(Boolean))].sort() }
function originalArtists(value: string | null): string[] {
  return artists((value ?? '').split(/\s*(?:、|，|,|;|；|\s+&\s+|\s+feat\.?\s+)\s*/iu))
}
function same(values: string[], other: string[]): boolean { return values.length === other.length && values.every((value, index) => value === other[index]) }

export function compareCandidate(original: OriginalTrack, candidate: SourceCandidate): CandidateComparison {
  original={...original,title:catalogTitle(original.title,original.filename,original.artist)}
  const reasons: string[] = [], failures: string[] = []
  const source = titleIdentity((original.title ?? '') + (original.version ? ` (${original.version})` : ''))
  const target = titleIdentity(candidate.title)
  const albumVersions = (value: string | null): string[] => titleIdentity(value ?? '').versions.filter(label => ['live','remix','cover','instrumental','english','chinese','reimagined','karaoke'].includes(label))
  source.versions = [...new Set([...source.versions, ...albumVersions(original.album)])].sort()
  target.versions = [...new Set([...target.versions, ...albumVersions(candidate.album)])].sort()
  const sourceTitles = [original.title, ...(original.aliases ?? [])].filter((value): value is string => Boolean(value)).flatMap(titleForms)
  const targetTitles = [candidate.title, ...candidate.aliases].flatMap(titleForms)
  if (!original.title || !source.title) reasons.push('原始标题缺失')
  else if (!sourceTitles.some(value => targetTitles.includes(value))) failures.push('曲名不一致')
  if (!same(source.versions, target.versions)) failures.push('录音版本标签不一致')
  const sourceArtists = originalArtists(original.artist), targetArtists = artists(candidate.artists)
  if (!sourceArtists.length || !targetArtists.length) reasons.push('歌手资料缺失')
  else if (!same(sourceArtists, targetArtists)) failures.push('歌手不一致')
  const difference = original.durationMs !== null && candidate.durationMs !== null ? Math.abs(original.durationMs - candidate.durationMs) : null
  if (difference === null) reasons.push('时长资料缺失')
  else if (difference > 2000) failures.push('时长相差超过 2 秒')
  if (!candidate.metadataComplete) reasons.push('候选资料尚未补全')
  return { candidate, decision: failures.length ? 'rejected' : reasons.length ? 'review' : 'matched', reasons: [...failures, ...reasons], durationDifferenceMs: difference }
}
export function matchCandidates(original: OriginalTrack, candidates: SourceCandidate[], now = new Date().toISOString()): MatchResult {
  original={...original,title:catalogTitle(original.title,original.filename,original.artist)}
  const seen = new Set<string>()
  const compared = candidates.filter(candidate => { const key = candidateKey(candidate); if (seen.has(key)) return false; seen.add(key); return true }).slice(0, 20).map(candidate => compareCandidate(original, candidate))
  const eligible = compared.filter(item => item.decision === 'matched')
  const sameAlbum=(item:CandidateComparison):number=>Number(Boolean(original.album&&item.candidate.album&&normalizedText(item.candidate.album)===normalizedText(original.album)))
  // Multiple releases of the same confirmed version can play without a version-selection prompt.
  const selected=eligible.sort((a,b)=>sameAlbum(b)-sameAlbum(a)||(a.durationDifferenceMs??Infinity)-(b.durationDifferenceMs??Infinity)||Number(Boolean(b.candidate.album))-Number(Boolean(a.candidate.album))||(candidateKey(a.candidate)<candidateKey(b.candidate)?-1:candidateKey(a.candidate)>candidateKey(b.candidate)?1:0))[0]
  const publicOriginal = publicTrack({ position: original.position, title: original.title, filename: original.filename,
    artist: original.artist, album: original.album, durationMs: original.durationMs, version: original.version })
  return {
    original: publicOriginal, status: selected ? 'candidate_matched' : compared.length ? 'needs_review' : 'not_found',
    candidates: compared, automaticCandidate: selected ? candidateKey(selected.candidate) : null, checkedAt: now, fromCache: false
  }
}
