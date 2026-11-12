import fs from 'node:fs'
import path from 'node:path'
type EventName = 'startup' | 'preferences_saved' | 'ipc_rejected' | 'error' | 'shutdown'
const CODES = new Set(['INTERNAL_ERROR', 'IPC_SENDER_DENIED', 'INVALID_PREFERENCES', 'INVALID_REQUEST', 'SCHEMA_TOO_NEW', 'EACCES', 'EPERM', 'ENOSPC', 'ERR_SQLITE_ERROR','ACCOUNT_TIMEOUT','ACCOUNT_NETWORK_ERROR','SESSION_INVALID','DIRECTORY_CHANGED','TRACKS_CHANGED','ACCOUNT_CANCELLED','ADDITIONAL_VERIFICATION_REQUIRED','UNKNOWN_LIST_CLASSIFICATION','ACCOUNT_IDENTITY_MISMATCH'])
export class LocalLog {
  readonly filename: string
  constructor(directory: string) { this.filename = path.join(path.resolve(directory), 'events.jsonl') }
  event(event: EventName, input: Record<string, unknown> = {}): void {
    const data: Record<string, string | number | boolean> = {}
    if (typeof input.code === 'string') data.code = CODES.has(input.code) ? input.code : 'INTERNAL_ERROR'
    if (typeof input.theme === 'string' && ['system', 'day', 'night'].includes(input.theme)) data.theme = input.theme
    for (const key of ['schemaVersion', 'collectionCount', 'positionCount']) if (typeof input[key] === 'number' && Number.isInteger(input[key]) && input[key] >= 0) data[key] = input[key]
    if (typeof input.protectionAvailable === 'boolean') data.protectionAvailable = input.protectionAvailable
    try {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true })
      if (fs.existsSync(this.filename) && fs.statSync(this.filename).size > 1024 * 1024) fs.renameSync(this.filename, this.filename + '.previous')
      fs.appendFileSync(this.filename, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n')
    } catch { /* Diagnostic failure must not undo a successful data operation. */ }
  }
}
