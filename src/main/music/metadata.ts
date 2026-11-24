import type { MusicDatabase } from '../database.ts'
import type { GdNeteaseAdapter } from './gd.ts'
import type { CandidateId } from '../../shared/music.ts'
import { candidateKey } from '../../shared/music.ts'
import type { PlayerState } from '../../shared/playback.ts'
import type { CurrentTrackMetadata, TrackLyrics } from '../../shared/metadata.ts'
import { currentMetadataIdentity } from '../../shared/metadata.ts'
import { CoverImageStore, kugouCoverMetadata } from './covers.ts'
import type { ImageSanitizer } from './covers.ts'
import { PublicHttpClient, checkedPublicUrl } from './http.ts'
import { SourceError } from './errors.ts'
import { emptyLyrics } from './lyrics.ts'

export interface ArtworkSource {
  identity: string
  coverUrl: string | null
  candidate: CandidateId | null
  hash: string | null
  candidateCover?: boolean
}
interface ArtworkBinding { imageKey: string; sourceCover: string | null }
interface MetadataJob { priority: number; start: () => Promise<void> }
const DAY = 86400_000

export class TrackMetadataService {
  private db: MusicDatabase
  private adapter: GdNeteaseAdapter
  private images: CoverImageStore
  private http: PublicHttpClient
  private active = 0
  private queue: MetadataJob[] = []
  private pending = new Map<string, { promise: Promise<unknown>; job: MetadataJob }>()
  private closed = false
  constructor(db: MusicDatabase, adapter: GdNeteaseAdapter, directory: string, sanitize: ImageSanitizer, http = new PublicHttpClient()) {
    this.db = db; this.adapter = adapter; this.http = http
    this.images = new CoverImageStore(directory, sanitize, http, 256 * 1024 * 1024)
  }
  close(): void { this.closed = true }
  readArtwork(key: string): Buffer | null { return this.images.read(key) }
  private schedule<T>(key: string, priority: number, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key)
    if (previous) { previous.job.priority = Math.min(previous.job.priority, priority); return previous.promise as Promise<T> }
    let resolve!: (value: T) => void, reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    const job: MetadataJob = { priority, start: async () => {
      try { resolve(await work()) } catch (error) { reject(error) }
      finally { this.pending.delete(key); this.active--; this.pump() }
    } }
    this.pending.set(key, { promise, job }); this.queue.push(job); this.pump()
    return promise
  }
  private pump(): void {
    this.queue.sort((a, b) => a.priority - b.priority)
    while (this.active < 3 && this.queue.length) { const job = this.queue.shift()!; this.active++; void job.start() }
  }
  private cachedArtwork(source: ArtworkSource): string | null {
    if (this.closed) return null
    const binding = this.db.getSetting<ArtworkBinding | null>('track-artwork:' + source.identity, null)
    if (!binding || source.coverUrl && binding.sourceCover !== source.coverUrl || !this.images.has(binding.imageKey)) return null
    return `su-music://app/artwork/${binding.imageKey}.jpg`
  }
  artwork(source: ArtworkSource, current = false): Promise<string | null> {
    const cached = this.cachedArtwork(source)
    if (cached || this.closed || source.identity.startsWith('local:')) return Promise.resolve(cached)
    const key = source.identity + ':' + (source.coverUrl ?? '')
    if (this.db.getSourceCache<boolean>('track-artwork-missing', key)) return Promise.resolve(null)
    return this.schedule('artwork:' + key, current ? 0 : 1, async () => {
      if (this.closed) return null
      const available = this.cachedArtwork(source)
      if (available) return available
      try {
        let address: string | null = null
        if (source.coverUrl) try { address = checkedPublicUrl(source.coverUrl, 'cover').href } catch {}
        const supplement = async (excluded: string | null = null): Promise<string | null> => {
          let value: string | null = null
          if (source.hash) {
            const url = new URL('https://m.kugou.com/app/i/getSongInfo.php')
            url.search = new URLSearchParams({ cmd: 'playInfo', hash: source.hash }).toString()
            try { value = kugouCoverMetadata(await this.http.json(url.href, 'kugou'), source.hash) }
            catch (error) { if (!source.candidate || error instanceof SourceError && error.code === 'SOURCE_RATE_LIMITED') throw error }
          }
          if (value === excluded) value = null
          if (!value && source.candidate) {
            const foreground = current || this.pending.get('artwork:' + key)?.job.priority === 0
            value = await this.adapter.fetchTrackArtwork(source.candidate, !foreground)
          }
          return value === excluded ? null : value
        }
        const fromCatalog = Boolean(address)
        if (!address) address = await supplement()
        if (!address) throw new SourceError('COVER_UNAVAILABLE')
        let imageKey: string
        try { imageKey = await this.images.download(address) }
        catch (error) {
          if (!fromCatalog || error instanceof SourceError && error.code === 'SOURCE_RATE_LIMITED') throw error
          const fallback = await supplement(address)
          if (!fallback) throw error
          imageKey = await this.images.download(fallback)
        }
        if (this.closed) return null
        this.db.setSetting('track-artwork:' + source.identity, { imageKey, sourceCover: source.coverUrl } satisfies ArtworkBinding)
        return `su-music://app/artwork/${imageKey}.jpg`
      } catch (error) {
        if (!this.closed) this.db.setSourceCache('track-artwork-missing', key, true, Math.max(30_000, error instanceof SourceError && error.retryAt ? error.retryAt - Date.now() : 0))
        return null
      }
    })
  }
  private lyrics(candidate: CandidateId): Promise<TrackLyrics> {
    if (this.closed) return Promise.resolve(emptyLyrics())
    const key = candidateKey(candidate)
    const cached = this.db.getSourceCache<TrackLyrics>('track-lyrics', key) ?? this.db.getSourceCache<TrackLyrics>('track-lyrics-error', key)
    if (cached) return Promise.resolve(cached)
    return this.schedule('lyrics:' + key, 0, async () => {
      if (this.closed) return emptyLyrics()
      try {
        const lyrics = await this.adapter.fetchTrackLyrics(candidate)
        if (!this.closed) this.db.setSourceCache('track-lyrics', key, lyrics, lyrics.state === 'unavailable' ? DAY : 365 * DAY)
        return lyrics
      } catch (error) {
        const retryAt = Math.max(Date.now() + 30_000, error instanceof SourceError ? error.retryAt ?? 0 : 0)
        const lyrics = { ...emptyLyrics('error', error instanceof SourceError && error.code === 'SOURCE_RATE_LIMITED' ? '歌词请求额度暂时用尽，请稍后重试。' : '暂未获取到歌词，请稍后重试。'), retryAt }
        if (!this.closed) this.db.setSourceCache('track-lyrics-error', key, lyrics, retryAt - Date.now())
        return lyrics
      }
    })
  }
  async current(player: PlayerState): Promise<CurrentTrackMetadata | null> {
    const identity = currentMetadataIdentity(player), now = player.now
    if (!player.currentId || !now || !identity || this.closed) return null
    const entry = player.queue.find(item => item.id === player.currentId)
    const reference = now.reference ?? (entry?.target.kind === 'original' ? entry.target.reference : null)
    const original = reference ? this.db.getTrackArtworkSource(reference) : null
    if (now.localId || original?.identity.startsWith('local:') && !now.candidate || entry?.target.kind === 'local') {
      return { currentId: player.currentId, identity, artworkUrl: null, lyrics: emptyLyrics('unavailable', '本地音频暂不提供在线歌词。') }
    }
    const candidate = now.candidate ?? (entry?.target.kind === 'candidate' ? entry.target.candidate : original?.candidate ?? null)
    const source: ArtworkSource = candidate ? {
      identity: candidateKey(candidate), candidate, hash: null,
      coverUrl: original?.candidateCover && original.candidate && candidateKey(original.candidate) === candidateKey(candidate) ? original.coverUrl : null
    } : original ?? { identity, candidate: null, hash: null, coverUrl: null }
    const [artworkUrl, lyrics] = await Promise.all([this.artwork(source, true), candidate ? this.lyrics(candidate) : Promise.resolve(emptyLyrics())])
    return this.closed ? null : { currentId: player.currentId, identity, artworkUrl, lyrics }
  }
}
