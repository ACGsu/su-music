import { createHash } from 'node:crypto'
import type { MusicDatabase } from '../database.ts'
import type { MatchResult, SourceCandidate, TrackReference, CandidateId } from '../../shared/music.ts'
import { candidateKey, validateCandidateId, validateQuery, validateTrackReference } from '../../shared/music.ts'
import { GdNeteaseAdapter } from './gd.ts'
import { KugouShareImporter } from './share.ts'
import { SourceError } from './errors.ts'
import { compareCandidate, matchCandidates, titleForms, titleIdentity } from './matching.ts'
import {withoutAudioExtension} from '../../shared/track-name.ts'

export class MusicSourceService {
  private db: MusicDatabase
  private adapter: GdNeteaseAdapter
  private shares: KugouShareImporter
  private pending = new Map<string, Promise<MatchResult>>()
  constructor(db: MusicDatabase, adapter: GdNeteaseAdapter, shares = new KugouShareImporter()) { this.db = db; this.adapter = adapter; this.shares = shares }
  async importShare(link: string, name: string): Promise<ReturnType<MusicDatabase['getCollection']>> {
    return this.db.replaceSharedPlaylist(await this.shares.import(link, name))
  }
  search(query: string, force = false): ReturnType<GdNeteaseAdapter['search']> { return this.adapter.search(validateQuery(query), force) }
  searchLibrary(query: string): ReturnType<MusicDatabase['searchLibrary']> { return this.db.searchLibrary(validateQuery(query)) }
  match(input: TrackReference, force = false): Promise<MatchResult> {
    const reference = validateTrackReference(input), original = this.db.getOriginal(reference)
    if (!original) throw new SourceError('TRACK_NOT_FOUND')
    const signature = createHash('sha256').update(JSON.stringify(original)).digest('hex')
    const cached = force ? null : this.db.getMatch(reference, signature)
    if (cached) {
      const updated=matchCandidates(original,cached.candidates.map(item=>item.candidate),cached.checkedAt)
      this.db.saveMatch(reference,signature,updated)
      return Promise.resolve({ ...updated, fromCache: true })
    }
    const key = `${reference.collectionId}:${reference.position}:${signature}`
    const previous = this.pending.get(key); if (previous) return previous
    const job = (async () => {
      const title = withoutAudioExtension(original.title || original.filename || '')
      if (!title) throw new SourceError('SOURCE_RESPONSE_INVALID')
      const base = titleForms(title).at(-1) ?? title, primaryArtist = (original.artist ?? '').split(/[、，,]/u)[0] ?? ''
      const query = `${base.slice(0,150)} ${primaryArtist.slice(0,45)}`.trim()
      let found = (await this.adapter.search(query, force)).candidates
      let result = matchCandidates(original, found)
      const labels = titleIdentity(title + ' ' + (original.version ?? '')).versions
      const qualifier = labels.includes('original') ? 'Original' : labels.includes('movie_edit') ? 'Movie edit' : labels.includes('movie') ? 'Movie ver.' : original.album
      if (!result.automaticCandidate && qualifier) {
        const supplement = (await this.adapter.search(`${base.slice(0,110)} ${qualifier.slice(0,40)} ${primaryArtist.slice(0,40)}`.trim(), force)).candidates
        const rank = (candidate: SourceCandidate): number => ({ matched: 0, review: 1, rejected: 2 })[compareCandidate(original, candidate).decision]
        found = [...supplement, ...found].sort((a,b) => rank(a) - rank(b))
        result = matchCandidates(original, found)
      }
      this.db.saveMatch(reference, signature, result)
      return result
    })().finally(() => this.pending.delete(key))
    this.pending.set(key, job); return job
  }
  checkResource(input: CandidateId, force = false): ReturnType<GdNeteaseAdapter['checkResource']> {
    const id = validateCandidateId(input)
    if (!this.db.getSourceCache<SourceCandidate>('candidate', candidateKey(id))) throw new SourceError('CANDIDATE_NOT_FOUND')
    return this.adapter.checkResource(id, force)
  }
}
