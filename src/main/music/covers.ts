import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { MusicDatabase } from '../database.ts'
import { PublicHttpClient, checkedPublicUrl } from './http.ts'
import { SourceError } from './errors.ts'

export type ImageSanitizer = (input: Buffer) => Buffer
interface CoverBinding { firstHash: string; imageKey: string; coverUrl?: string }
const MIME_LIMIT = 2 * 1024 * 1024
export class CoverImageStore {
  private directory: string
  private sanitize: ImageSanitizer
  private http: PublicHttpClient
  private limitBytes: number | null
  private pending = new Map<string, Promise<string>>()
  constructor(directory: string, sanitize: ImageSanitizer, http = new PublicHttpClient(), limitBytes: number | null = null) {
    this.directory = path.resolve(directory)
    this.sanitize = sanitize; this.http = http; this.limitBytes = limitBytes
    fs.mkdirSync(this.directory, { recursive: true })
  }
  private file(key: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(key)) return null
    try {
      const target = fs.realpathSync(path.join(this.directory, key + '.jpg')), root = fs.realpathSync(this.directory), stat = fs.statSync(target)
      return target.startsWith(root + path.sep) && stat.isFile() && stat.size > 0 && stat.size <= MIME_LIMIT ? target : null
    } catch { return null }
  }
  has(key: string): boolean {
    const target = this.file(key)
    if (target && this.limitBytes !== null) try { const now = new Date(); fs.utimesSync(target, now, now) } catch {}
    return target !== null
  }
  read(key: string): Buffer | null {
    const target = this.file(key)
    if (!target) return null
    try {
      const bytes = fs.readFileSync(target)
      if (this.limitBytes !== null) try { const now = new Date(); fs.utimesSync(target, now, now) } catch {}
      return bytes
    } catch { return null }
  }
  download(address: string): Promise<string> {
    const url = checkedPublicUrl(address, 'cover').href, pending = this.pending.get(url)
    if (pending) return pending
    const job = this.downloadOnce(url).finally(() => this.pending.delete(url))
    this.pending.set(url, job)
    return job
  }
  private async downloadOnce(address: string): Promise<string> {
    const response = await this.http.response(address, 'cover'), parts: Uint8Array[] = []
    if (!/^image\/(?:jpeg|jpg|png|webp|jfif|gif)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel(); throw new SourceError('COVER_UNAVAILABLE')
    }
    let bytes = 0
    const reader = response.body?.getReader()
    if (!reader) throw new SourceError('COVER_UNAVAILABLE')
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > MIME_LIMIT) throw new SourceError('COVER_UNAVAILABLE')
        parts.push(part.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const image = this.sanitize(Buffer.concat(parts))
    if (!image.length || image.length > MIME_LIMIT) throw new SourceError('COVER_UNAVAILABLE')
    const key = createHash('sha256').update(image).digest('hex'), target = path.join(this.directory, key + '.jpg')
    if (!fs.existsSync(target)) {
      const temporary = target + '.' + randomUUID() + '.tmp'
      try { fs.writeFileSync(temporary, image, { flag: 'wx' }); fs.renameSync(temporary, target) }
      finally { fs.rmSync(temporary, { force: true }) }
    }
    if (this.limitBytes !== null) try { const now = new Date(); fs.utimesSync(target, now, now) } catch {}
    this.trim(key)
    return key
  }
  private trim(protectedKey: string): void {
    if (this.limitBytes === null) return
    try {
      const entries = fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.jpg$/.test(name)).flatMap(name => {
        const target = this.file(name.slice(0, -4))
        if (!target) return []
        const stat = fs.statSync(target)
        return [{ name, target, size: stat.size, at: stat.mtimeMs }]
      }).sort((a, b) => a.at - b.at)
      let total = entries.reduce((sum, entry) => sum + entry.size, 0)
      for (const entry of entries) {
        if (total <= this.limitBytes) break
        if (entry.name === protectedKey + '.jpg') continue
        fs.unlinkSync(entry.target); total -= entry.size
      }
    } catch { /* Cache maintenance never interrupts playback or artwork delivery. */ }
  }
}
export function kugouCoverMetadata(input: unknown, expectedHash: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const outer = input as Record<string, unknown>, data = outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data) ? outer.data as Record<string, unknown> : outer
  const returned = typeof data.hash === 'string' && data.hash ? data.hash : typeof data.req_hash === 'string' ? data.req_hash : ''
  if (returned.toUpperCase() !== expectedHash.toUpperCase()) return null
  const address = typeof data.album_img === 'string' && data.album_img ? data.album_img : typeof data.imgUrl === 'string' ? data.imgUrl : null
  if (!address || address.length > 2048) return null
  try { return checkedPublicUrl(address.replaceAll('{size}', '500'), 'cover').href } catch { return null }
}
export class CollectionCoverCache {
  private db: MusicDatabase
  private http: PublicHttpClient
  private images: CoverImageStore
  private pending = new Map<string, Promise<void>>()
  constructor(db: MusicDatabase, directory: string, sanitize: ImageSanitizer, http = new PublicHttpClient()) {
    this.db = db; this.http = http; this.images = new CoverImageStore(directory, sanitize, http)
  }
  private firstHash(id: string): string | null {
    const hash = this.db.getOriginal({ collectionId: id, position: 1 })?.hash
    return typeof hash === 'string' && /^[a-fA-F0-9]{32}$/.test(hash) ? hash.toUpperCase() : null
  }
  url(id: string): string | null {
    const binding = this.db.getSetting<CoverBinding | null>('collection-cover:' + id, null)
    if (!binding || !/^[a-f0-9]{64}$/.test(binding.imageKey) || !this.read(binding.imageKey)) return null
    const coverUrl = this.db.getCollectionCoverUrl(id)
    if (coverUrl) {
      if (binding.coverUrl !== coverUrl) return null
    } else {
      if (binding.coverUrl) return null
      const first = this.firstHash(id)
      if (first && binding.firstHash && binding.firstHash !== first) return null
    }
    return `su-music://app/cover/${binding.imageKey}.jpg`
  }
  read(key: string): Buffer | null {
    return this.images.read(key)
  }
  refresh(id: string): Promise<void> {
    const previous = this.pending.get(id); if (previous) return previous
    const job = this.refreshOnce(id).finally(() => this.pending.delete(id)); this.pending.set(id, job); return job
  }
  private async refreshOnce(id: string): Promise<void> {
    if (this.url(id)) return
    const coverUrl = this.db.getCollectionCoverUrl(id)
    const hash = this.firstHash(id)
    if (!coverUrl && !hash) return
    const cacheKey = coverUrl ?? hash!
    const absent = this.db.getSourceCache<boolean>('cover_missing', cacheKey)
    if (absent) return
    try {
      let imageUrl: string | null = null
      if (coverUrl) {
        try { imageUrl = checkedPublicUrl(coverUrl, 'cover').href } catch { imageUrl = null }
      } else if (hash) {
        const address = new URL('https://m.kugou.com/app/i/getSongInfo.php')
        address.search = new URLSearchParams({ cmd: 'playInfo', hash }).toString()
        const metadata = await this.http.json(address.href, 'kugou')
        imageUrl = kugouCoverMetadata(metadata, hash)
      }
      if (!imageUrl) throw new SourceError('COVER_UNAVAILABLE')
      const key = await this.images.download(imageUrl)
      this.db.setSetting('collection-cover:' + id, { firstHash: hash ?? '', imageKey: key, coverUrl: coverUrl ?? undefined })
    } catch {
      this.db.setSourceCache('cover_missing', cacheKey, true, 30_000)
    }
  }
}
