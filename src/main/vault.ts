import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
export interface EncryptionCodec {
  available(): boolean
  encrypt(value: string): Buffer | Promise<Buffer>
  decrypt(value: Buffer): string | { value: string; reencrypt: boolean } | Promise<string | { value: string; reencrypt: boolean }>
}
export class CredentialVault {
  private codec: EncryptionCodec
  private pending: Promise<void> = Promise.resolve()
  readonly filename: string
  constructor(directory: string, codec: EncryptionCodec) {
    this.filename = path.join(path.resolve(directory), 'credentials.bin')
    this.codec = codec
  }
  available(): boolean { return this.codec.available() }
  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }
  private write(encrypted: Buffer): void {
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('ENCRYPTION_FAILED')
    fs.mkdirSync(path.dirname(this.filename), { recursive: true })
    const temporary = this.filename + '.' + randomUUID() + '.tmp'
    try { fs.writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.filename) }
    finally { fs.rmSync(temporary, { force: true }) }
  }
  async save(value: unknown): Promise<void> {
    const encoded = JSON.stringify(value)
    if (typeof encoded !== 'string') throw new Error('INVALID_CREDENTIAL_PAYLOAD')
    await this.enqueue(async () => {
      if (!this.available()) throw new Error('CREDENTIAL_PROTECTION_UNAVAILABLE')
      this.write(await this.codec.encrypt(encoded))
    })
  }
  read<T>(): Promise<T | null> {
    return this.enqueue(async () => {
      if (!fs.existsSync(this.filename)) return null
      if (!this.available()) throw new Error('CREDENTIAL_PROTECTION_UNAVAILABLE')
      const decoded = await this.codec.decrypt(fs.readFileSync(this.filename))
      const text = typeof decoded === 'string' ? decoded : decoded.value
      const value = JSON.parse(text) as T
      if (typeof decoded !== 'string' && decoded.reencrypt) this.write(await this.codec.encrypt(text))
      return value
    })
  }
  clear(): Promise<void> { return this.enqueue(() => fs.rmSync(this.filename, { force: true })) }
}
