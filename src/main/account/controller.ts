import type { AccountInfo, AccountState, Device, KugouAccountState, KugouSession, NeteaseAccountInfo, NeteaseAccountState } from '../../shared/account.ts'
import type { MusicDatabase } from '../database.ts'
import type { CredentialVault } from '../vault.ts'
import { AccountError, newKugouDevice, parseAccountIdentity, record, sessionValid } from './protocol.ts'
import type { KugouTransport } from './protocol.ts'
import { readKugouLibrary } from './library.ts'
import { qrImage } from './qr.ts'
import { GdNeteaseAdapter, type NeteasePlaylistSummary } from '../music/gd.ts'
import { SourceError } from '../music/errors.ts'

const MESSAGES: Record<string, string> = {
  ACCOUNT_TIMEOUT: '酷狗请求超时，已保留本地曲库。',
  ACCOUNT_NETWORK_ERROR: '暂时无法连接酷狗，已保留本地曲库。',
  SESSION_INVALID: '登录状态已失效，请重新扫码。',
  ACCOUNT_IDENTITY_MISMATCH: '返回账号与登录账号不一致，请重新扫码。',
  UNKNOWN_LIST_CLASSIFICATION: '发现待核对的歌单分类，本次未更新曲库。',
  DIRECTORY_CHANGED: '同步期间歌单发生变化，请再次刷新。',
  TRACKS_CHANGED: '同步期间曲目发生变化，请再次刷新。',
  DIRECTORY_DUPLICATE: '歌单目录存在重复项，本次未更新曲库。',
  DIRECTORY_TRACK_COUNT_MISMATCH: '歌单曲目数量不一致，本次未更新曲库。',
  INCOMPLETE_ACCOUNT_LIBRARY: '歌单资料未完整读全，本次未更新曲库。',
  EMPTY_ACCOUNT_LIBRARY: '歌单列表为空或未能读出，已保留本地曲库。',
  ADDITIONAL_VERIFICATION_REQUIRED: '酷狗要求额外验证，请在官方客户端检查账号后重试。',
  CREDENTIAL_PROTECTION_UNAVAILABLE: 'Windows 凭据保护暂不可用，无法保存登录。',
  ACCOUNT_CANCELLED: '操作已取消，已保留本地曲库。',
  ACCOUNT_ALREADY_CONNECTED: '当前账号已处于连接状态。',
  ACCOUNT_REQUIRED: '请先连接账号。',
  INVALID_UID: '网易云 UID 格式不正确，请输入 1–18 位数字。',
  SOURCE_RATE_LIMITED: '请求频繁，受到服务限制，请稍后刷新继续。',
  SOURCE_TIMEOUT: '网易云接口请求超时，已保留本地曲库。',
  SOURCE_NETWORK_ERROR: '无法连接网易云接口，已保留本地曲库。',
  SOURCE_RESPONSE_INVALID: '网易云响应未能正确解析，已保留本地曲库。'
}

export function accountMessage(error: unknown): string | null {
  if (error instanceof AccountError) return MESSAGES[error.code] ?? '账号资料未能读全，本次未更新曲库。'
  if (error instanceof SourceError) return MESSAGES[error.code] ?? '音源服务未能读全资料，本次未更新曲库。'
  return null
}

const emptyKugouSync = (): KugouAccountState['sync'] => ({
  phase: 'idle', trigger: null, completedCollections: 0, totalCollections: 0,
  rawDirectoryCount: null, positionCount: null, lastSuccessAt: null, error: null,
  unknownClassifications: 0, added: 0, removed: 0
})

const emptyNeteaseSync = (): NeteaseAccountState['sync'] => ({
  phase: 'idle', trigger: null, completedCollections: 0, totalCollections: 0,
  positionCount: null, lastSuccessAt: null, error: null, added: 0, removed: 0
})

function neteaseDirSignature(playlists: NeteasePlaylistSummary[]): string {
  return JSON.stringify(playlists.map(p => [p.id, p.name, p.trackCount, p.updateTime, p.kind]))
}

export class AccountController {
  private db: MusicDatabase
  private vault: CredentialVault
  private transport: KugouTransport
  private notify: () => void
  private adapter: GdNeteaseAdapter | null
  private device: Device
  private session: KugouSession | null = null
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private loginAbort: AbortController | null = null
  private syncAbort: AbortController | null = null
  private syncJob: Promise<void> | null = null
  private authJob: Promise<void> | null = null
  private neteaseSyncAbort: AbortController | null = null
  private neteaseSyncJob: Promise<void> | null = null
  private stopped = false
  private options: { pollMs: number; ttlMs: number; firstPollMs: number }
  private state: {
    activeProvider: 'kugou' | 'netease' | 'local'
    kugou: KugouAccountState
    netease: NeteaseAccountState
  }

  constructor(
    db: MusicDatabase,
    vault: CredentialVault,
    transport: KugouTransport,
    notify: () => void,
    options: { pollMs?: number; ttlMs?: number; firstPollMs?: number } = {},
    adapter: GdNeteaseAdapter | null = null
  ) {
    this.db = db; this.vault = vault; this.transport = transport; this.notify = notify; this.adapter = adapter
    this.device = db.getSetting<Device>('kugou-device', newKugouDevice())
    this.db.setSetting('kugou-device', this.device)
    const cachedKg = db.getSetting<AccountInfo | null>('cached-kugou-account', null)
    const lastKg = db.getSetting<string | null>('last-sync-at', null)
    const cachedNe = db.getSetting<NeteaseAccountInfo | null>('cached-netease-account', null)
    const neConnected = db.getSetting<boolean>('netease-connected', false)
    const lastNe = cachedNe ? db.getSetting<string | null>('last-sync:ne:' + cachedNe.uid, null) : null
    const provider = db.activeAccountProvider()

    this.state = {
      activeProvider: provider,
      kugou: {
        phase: 'logged_out',
        account: null,
        cachedAccount: cachedKg,
        hasStoredSession: false,
        qrImage: null,
        qrDeadline: null,
        qrPolling: false,
        qrChecks: 0,
        message: null,
        sync: { ...emptyKugouSync(), lastSuccessAt: lastKg }
      },
      netease: {
        connected: neConnected,
        account: neConnected ? cachedNe : null,
        cachedAccount: cachedNe,
        sync: { ...emptyNeteaseSync(), lastSuccessAt: lastNe },
        message: null
      }
    }
    this.options = { pollMs: options.pollMs ?? 2500, ttlMs: options.ttlMs ?? 240000, firstPollMs: options.firstPollMs ?? 1000 }
  }

  setAdapter(adapter: GdNeteaseAdapter): void {
    this.adapter = adapter
  }

  snapshot(): AccountState {
    const kugouSnapshot = structuredClone(this.state.kugou)
    const neteaseSnapshot = structuredClone(this.state.netease)
    return {
      activeProvider: this.state.activeProvider,
      kugou: kugouSnapshot,
      netease: neteaseSnapshot,
      ...kugouSnapshot
    }
  }

  private changed(): void {
    if (!this.stopped) this.notify()
  }

  private stopQr(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.state.kugou.qrImage = null
    this.state.kugou.qrDeadline = null
    this.state.kugou.qrPolling = false
  }

  async restore(): Promise<void> {
    const generation = ++this.generation
    try {
      const loaded = await this.vault.read<unknown>()
      if (generation !== this.generation || this.stopped) return
      if (!loaded) {
        this.state.kugou.phase = 'logged_out'
        this.changed()
        if (this.state.activeProvider === 'netease' && this.state.netease.connected) {
          void this.syncNetease('startup').catch(() => {})
        }
      } else if (!sessionValid(loaded)) {
        throw new AccountError('SESSION_INVALID')
      } else {
        this.session = loaded
        this.device = loaded.device
        this.state.kugou.hasStoredSession = true
        this.state.kugou.phase = 'stored_session'
        this.changed()
        const controller = new AbortController()
        this.loginAbort = controller
        const account = parseAccountIdentity(await this.transport.call('identity', loaded, {}, controller.signal), loaded.userid)
        if (generation !== this.generation || this.stopped) return
        this.state.kugou.account = account
        this.state.kugou.cachedAccount = account
        this.state.kugou.phase = 'authenticated'
        this.state.kugou.message = null
        if (this.state.activeProvider === 'kugou') {
          this.db.selectAccount(account)
          this.changed()
          void this.sync('startup').catch(() => {})
        } else {
          this.db.setSetting('cached-kugou-account', account)
          this.changed()
        }
        if (this.state.activeProvider === 'netease' && this.state.netease.connected) {
          void this.syncNetease('startup').catch(() => {})
        }
      }
    } catch (error) {
      if (generation !== this.generation || this.stopped) return
      this.state.kugou.phase = error instanceof AccountError && error.code === 'SESSION_INVALID' ? 'session_invalid' : 'error'
      this.state.kugou.message = accountMessage(error) ?? '本机登录资料暂时无法读取，请重试。'
      this.changed()
      if (this.state.activeProvider === 'netease' && this.state.netease.connected) {
        void this.syncNetease('startup').catch(() => {})
      }
    }
  }

  async startLogin(): Promise<void> {
    if (this.state.kugou.phase === 'authenticated' || this.state.kugou.phase === 'verifying') throw new AccountError('ACCOUNT_ALREADY_CONNECTED')
    if (this.state.kugou.phase === 'creating_qr' || this.state.kugou.qrPolling) return
    const generation = ++this.generation
    this.stopQr()
    this.loginAbort?.abort()
    const controller = new AbortController()
    this.loginAbort = controller
    this.state.kugou.phase = 'creating_qr'
    this.state.kugou.qrChecks = 0
    this.state.kugou.message = null
    this.changed()
    try {
      if (!this.vault.available()) throw new AccountError('CREDENTIAL_PROTECTION_UNAVAILABLE')
      const response = await this.transport.call('qr_key', this.device, {}, controller.signal)
      const data = record(response.data), key = data?.qrcode
      if (typeof key !== 'string' || !key || key.length > 512 || response.status !== 1) throw new AccountError('QR_RESPONSE_INVALID')
      if (generation !== this.generation || this.stopped) return
      this.state.kugou.qrImage = qrImage(key)
      this.state.kugou.qrDeadline = Date.now() + this.options.ttlMs
      this.state.kugou.qrPolling = true
      this.state.kugou.phase = 'waiting_scan'
      this.changed()
      this.timer = setTimeout(() => { void this.poll(key, generation, 0) }, this.options.firstPollMs)
    } catch (error) {
      if (generation !== this.generation || this.stopped) return
      this.stopQr()
      this.state.kugou.phase = 'error'
      this.state.kugou.message = accountMessage(error) ?? '二维码暂时无法生成，请重试。'
      this.changed()
    }
  }

  private async poll(key: string, generation: number, errors: number): Promise<void> {
    if (generation !== this.generation || !this.state.kugou.qrPolling || this.stopped) return
    if (Date.now() >= (this.state.kugou.qrDeadline ?? 0)) {
      this.stopQr()
      this.state.kugou.phase = 'local_deadline'
      this.state.kugou.message = '等待时间已到，请重新生成二维码。'
      this.changed()
      return
    }
    try {
      this.state.kugou.qrChecks++
      const response = await this.transport.call('qr_check', this.device, { key }, this.loginAbort?.signal)
      const data = record(response.data), status = Number(data?.status)
      if (generation !== this.generation || !this.state.kugou.qrPolling || this.stopped) return
      if (status === 0) {
        this.stopQr()
        this.state.kugou.phase = 'invalidated'
        this.state.kugou.message = '二维码已失效：可能过期或手机已取消确认，请重新生成。'
        this.changed()
        return
      }
      if (status === 1 || status === 2) {
        this.state.kugou.phase = status === 1 ? 'waiting_scan' : 'waiting_confirm'
        this.state.kugou.message = null
        errors = 0
        this.changed()
      } else if (status === 4) {
        const token = data?.token, userid = String(data?.userid ?? '')
        if (typeof token !== 'string' || !token || !Number.isSafeInteger(Number(userid)) || !/^[1-9]\d{0,15}$/.test(userid)) throw new AccountError('QR_RESPONSE_INVALID')
        this.stopQr()
        this.state.kugou.phase = 'verifying'
        this.changed()
        const session: KugouSession = { schema: 1, platform: 'standard', savedAt: new Date().toISOString(), device: this.device, userid, token }
        this.authJob = (async () => {
          const account = parseAccountIdentity(await this.transport.call('identity', session, {}, this.loginAbort?.signal), userid)
          if (generation !== this.generation || this.stopped) return
          await this.vault.save(session)
          if (generation !== this.generation || this.stopped) return
          this.session = session
          this.state.kugou.hasStoredSession = true
          this.state.kugou.phase = 'authenticated'
          this.state.kugou.account = account
          this.state.kugou.cachedAccount = account
          this.state.kugou.message = null
          this.state.activeProvider = 'kugou'
          this.db.selectAccount(account)
          this.changed()
          void this.sync('login')
        })()
        await this.authJob
        this.authJob = null
        return
      } else {
        throw new AccountError('QR_RESPONSE_INVALID')
      }
    } catch (error) {
      if (generation !== this.generation || this.stopped) return
      errors++
      if (errors >= 3 || error instanceof AccountError && error.code === 'ADDITIONAL_VERIFICATION_REQUIRED' || this.state.kugou.phase === 'verifying') {
        this.stopQr()
        this.state.kugou.phase = 'error'
        this.state.kugou.message = accountMessage(error) ?? '二维码状态未能确认，请重新生成。'
        this.changed()
        return
      }
    }
    if (generation === this.generation && this.state.kugou.qrPolling) {
      this.timer = setTimeout(() => { void this.poll(key, generation, errors) }, this.options.pollMs)
    }
  }

  cancelLogin(): void {
    if (this.state.kugou.phase === 'authenticated' || this.state.kugou.phase === 'verifying') return
    this.generation++
    this.loginAbort?.abort()
    this.stopQr()
    this.state.kugou.phase = 'cancelled'
    this.state.kugou.message = '本机扫码已取消。'
    this.changed()
  }

  sync(trigger = 'manual'): Promise<void> {
    if (this.syncJob) return this.syncJob
    if (!this.session || this.state.kugou.phase !== 'authenticated') return Promise.reject(new AccountError('ACCOUNT_REQUIRED'))
    const captured = this.session, controller = new AbortController()
    this.syncAbort = controller
    this.state.kugou.sync = { ...this.state.kugou.sync, phase: 'reading_directory', trigger, completedCollections: 0, totalCollections: 0, error: null, unknownClassifications: 0, added: 0, removed: 0 }
    this.changed()
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000)
    this.syncJob = (async () => {
      try {
        const account = parseAccountIdentity(await this.transport.call('identity', captured, {}, controller.signal), captured.userid)
        const library = await readKugouLibrary(this.transport, captured, account, controller.signal, value => {
          Object.assign(this.state.kugou.sync, value)
          this.changed()
        })
        if (controller.signal.aborted || this.session !== captured || this.stopped) throw new AccountError('ACCOUNT_CANCELLED')
        const result = this.db.replaceAccountLibrary(library)
        this.state.kugou.cachedAccount = account
        this.state.kugou.sync = { ...this.state.kugou.sync, phase: 'completed', positionCount: result.positionCount, lastSuccessAt: library.at, error: null, added: result.added, removed: result.removed }
        this.changed()
      } catch (error) {
        const code = error instanceof AccountError ? error.code : 'ACCOUNT_SYNC_FAILED'
        this.state.kugou.sync.phase = code === 'ACCOUNT_CANCELLED' ? 'cancelled' : 'failed'
        this.state.kugou.sync.error = accountMessage(error) ?? '同步未能完成，已保留上次成功的曲库。'
        if (code === 'SESSION_INVALID') {
          this.state.kugou.phase = 'session_invalid'
          this.state.kugou.account = null
          this.state.kugou.message = accountMessage(error)
        }
        this.changed()
      } finally {
        clearTimeout(timer)
        this.syncAbort = null
        this.syncJob = null
      }
    })()
    return this.syncJob
  }

  cancelSync(): void {
    this.syncAbort?.abort()
  }

  async logout(): Promise<void> {
    this.generation++
    this.loginAbort?.abort()
    this.stopQr()
    this.syncAbort?.abort()
    await this.authJob?.catch(() => {})
    await this.syncJob
    await this.vault.clear()
    this.session = null
    this.state.kugou.hasStoredSession = false
    this.state.kugou.phase = 'logged_out'
    this.state.kugou.account = null
    this.state.kugou.message = '已退出登录，本地曲库仍可查看。'
    this.changed()
  }

  async connectNetease(uid: string): Promise<void> {
    const trimmed = typeof uid === 'string' ? uid.trim() : ''
    if (!/^[1-9]\d{0,17}$/.test(trimmed)) throw new AccountError('INVALID_UID')
    this.db.setSetting('netease-connected', true)
    const accountInfo: NeteaseAccountInfo = { uid: trimmed, nickname: null }
    this.db.setSetting('cached-netease-account', accountInfo)
    this.db.selectNeteaseAccount(accountInfo)
    this.state.activeProvider = 'netease'
    this.state.netease.connected = true
    this.state.netease.account = accountInfo
    this.state.netease.cachedAccount = accountInfo
    this.state.netease.message = null
    this.changed()
    void this.syncNetease('connect')
  }

  refreshNetease(): Promise<void> {
    return this.syncNetease('manual')
  }

  cancelNeteaseSync(): void {
    this.neteaseSyncAbort?.abort()
  }

  async logoutNetease(): Promise<void> {
    this.neteaseSyncAbort?.abort()
    await this.neteaseSyncJob
    this.db.setSetting('netease-connected', false)
    this.state.netease.connected = false
    this.state.netease.account = null
    this.state.netease.message = '已退出网易云，本地曲库仍可查看。'
    if (this.state.activeProvider === 'netease') {
      if (this.state.kugou.phase === 'authenticated' && this.state.kugou.account) {
        this.db.switchAccount('kugou')
        this.state.activeProvider = 'kugou'
      } else {
        this.db.switchAccount('kugou')
        this.state.activeProvider = this.db.activeAccountProvider()
      }
    }
    this.changed()
  }

  switchAccount(provider: 'kugou' | 'netease'): void {
    if (provider !== 'kugou' && provider !== 'netease') return
    this.db.switchAccount(provider)
    this.state.activeProvider = this.db.activeAccountProvider()
    this.changed()
  }

  private syncNetease(trigger = 'manual'): Promise<void> {
    if (this.neteaseSyncJob) return this.neteaseSyncJob
    if (!this.state.netease.connected || !this.state.netease.account?.uid) {
      return Promise.reject(new AccountError('ACCOUNT_REQUIRED'))
    }
    if (!this.adapter) {
      return Promise.reject(new AccountError('ACCOUNT_NETWORK_ERROR'))
    }
    const uid = this.state.netease.account.uid
    const controller = new AbortController()
    this.neteaseSyncAbort = controller
    this.state.netease.sync = {
      ...this.state.netease.sync,
      phase: 'reading_directory',
      trigger,
      completedCollections: 0,
      totalCollections: 0,
      error: null,
      added: 0,
      removed: 0
    }
    this.changed()
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000)

    this.neteaseSyncJob = (async () => {
      try {
        const initial = await this.adapter!.fetchUserPlaylists(uid, controller.signal)
        if (controller.signal.aborted || this.stopped) throw new AccountError('ACCOUNT_CANCELLED')
        if (!initial.playlists.length) throw new AccountError('EMPTY_ACCOUNT_LIBRARY')

        const idSet = new Set(initial.playlists.map(p => p.id))
        if (idSet.size !== initial.playlists.length) throw new AccountError('DIRECTORY_DUPLICATE')

        if (initial.owner.nickname) {
          this.state.netease.account = { uid, nickname: initial.owner.nickname }
          this.state.netease.cachedAccount = { uid, nickname: initial.owner.nickname }
          this.db.setSetting('cached-netease-account', this.state.netease.account)
        }

        this.state.netease.sync.totalCollections = initial.playlists.length
        this.state.netease.sync.phase = 'reading_tracks'
        this.changed()

        const collections: Array<{
          sourceKey: string
          name: string
          kind: 'default' | 'created' | 'favorite'
          subtype: 'album' | null
          order: number
          reportedCount: number
          coverUrl: string | null
          updateTime: number | null
          raw: unknown
          tracks: ReturnType<GdNeteaseAdapter['fetchPlaylistTracks']> extends Promise<infer T> ? T : never
        }> = []

        for (const [order, p] of initial.playlists.entries()) {
          if (controller.signal.aborted || this.stopped) throw new AccountError('ACCOUNT_CANCELLED')

          let tracks = this.db.getNeteasePlaylistCache(p.id, p.updateTime, p.trackCount)
          if (!tracks || tracks.length !== p.trackCount) {
            tracks = await this.adapter!.fetchPlaylistTracks(p.id, controller.signal)
            if (controller.signal.aborted || this.stopped) throw new AccountError('ACCOUNT_CANCELLED')
            if (tracks.length !== p.trackCount) {
              throw new AccountError('DIRECTORY_TRACK_COUNT_MISMATCH')
            }
            this.db.setNeteasePlaylistCache(p.id, p.updateTime, p.trackCount, tracks)
          }

          collections.push({
            sourceKey: p.id,
            name: p.name,
            kind: p.kind,
            subtype: null,
            order,
            reportedCount: tracks.length,
            coverUrl: p.coverUrl,
            updateTime: p.updateTime,
            raw: p.raw,
            tracks
          })

          this.state.netease.sync.completedCollections = collections.length
          this.changed()
        }

        this.state.netease.sync.phase = 'checking_directory'
        this.changed()

        const last = await this.adapter!.fetchUserPlaylists(uid, controller.signal)
        if (controller.signal.aborted || this.stopped) throw new AccountError('ACCOUNT_CANCELLED')
        if (neteaseDirSignature(initial.playlists) !== neteaseDirSignature(last.playlists)) {
          throw new AccountError('DIRECTORY_CHANGED')
        }

        const library = {
          owner: this.state.netease.account!,
          at: new Date().toISOString(),
          collections,
          rawDirectoryCount: initial.playlists.length,
          directoryVerified: true
        }

        const result = this.db.replaceNeteaseLibrary(library)
        this.state.netease.sync = {
          ...this.state.netease.sync,
          phase: 'completed',
          positionCount: result.positionCount,
          lastSuccessAt: library.at,
          error: null,
          added: result.added,
          removed: result.removed
        }
        this.changed()
      } catch (error) {
        const code = error instanceof AccountError ? error.code : error instanceof SourceError ? error.code : 'ACCOUNT_SYNC_FAILED'
        this.state.netease.sync.phase = code === 'ACCOUNT_CANCELLED' ? 'cancelled' : 'failed'
        this.state.netease.sync.error = accountMessage(error) ?? '网易云同步未能完成，已保留上次成功的曲库。'
        this.changed()
      } finally {
        clearTimeout(timer)
        this.neteaseSyncAbort = null
        this.neteaseSyncJob = null
      }
    })()
    return this.neteaseSyncJob
  }

  close(): void {
    this.stopped = true
    this.generation++
    this.loginAbort?.abort()
    this.syncAbort?.abort()
    this.neteaseSyncAbort?.abort()
    this.stopQr()
  }
}
