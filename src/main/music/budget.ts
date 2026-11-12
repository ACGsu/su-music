import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SourceError } from './errors.ts'

// One file is shared by the desktop adapter and the live-validation CLI.
export class GdRequestBudget {
  private db: DatabaseSync
  private now: () => number
  readonly limit: number
  readonly windowMs: number
  constructor(filename: string, options: { now?: () => number; limit?: number; windowMs?: number } = {}) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
    this.db = new DatabaseSync(filename); this.now = options.now ?? Date.now
    this.limit = options.limit ?? 45; this.windowMs = options.windowMs ?? 300_000
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS gd_requests(id INTEGER PRIMARY KEY,at_ms INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS gd_requests_time ON gd_requests(at_ms); CREATE TABLE IF NOT EXISTS gd_cooldown(id INTEGER PRIMARY KEY CHECK(id=1),until_ms INTEGER NOT NULL);')
  }
  close(): void { this.db.close() }
  reserve(): void {
    const now = this.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM gd_requests WHERE at_ms<=?').run(now - this.windowMs)
      const blocked = this.db.prepare('SELECT until_ms FROM gd_cooldown WHERE id=1').get()
      if (blocked && Number(blocked.until_ms) > now) throw new SourceError('SOURCE_RATE_LIMITED', Number(blocked.until_ms))
      const used = this.db.prepare('SELECT COUNT(*) AS n,MIN(at_ms) AS first FROM gd_requests').get()!
      if (Number(used.n) >= this.limit) throw new SourceError('SOURCE_RATE_LIMITED', Number(used.first) + this.windowMs)
      this.db.prepare('INSERT INTO gd_requests(at_ms) VALUES(?)').run(now); this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  cooldown(retryAt: number): void {
    const until = Number.isFinite(retryAt) ? Math.max(this.now(), retryAt) : this.now() + this.windowMs
    this.db.prepare('INSERT INTO gd_cooldown(id,until_ms) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)').run(until)
  }
}
