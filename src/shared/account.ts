import type { CollectionKind, Track } from './contracts.ts'

export type LoginPhase = 'logged_out' | 'stored_session' | 'creating_qr' | 'waiting_scan' | 'waiting_confirm' | 'verifying' | 'authenticated' | 'invalidated' | 'local_deadline' | 'cancelled' | 'session_invalid' | 'error'
export type SyncPhase = 'idle' | 'reading_directory' | 'reading_tracks' | 'checking_directory' | 'completed' | 'failed' | 'cancelled'
export type AccountProvider = 'kugou' | 'netease' | 'local'

export interface AccountInfo { id: string; nickname: string | null }
export interface NeteaseAccountInfo { uid: string; nickname: string | null }

export interface NeteaseSyncState {
  phase: SyncPhase
  trigger: string | null
  completedCollections: number
  totalCollections: number
  positionCount: number | null
  lastSuccessAt: string | null
  error: string | null
  added: number
  removed: number
}

export interface NeteaseAccountState {
  connected: boolean
  account: NeteaseAccountInfo | null
  cachedAccount: NeteaseAccountInfo | null
  sync: NeteaseSyncState
  message: string | null
}

export interface KugouSyncState {
  phase: SyncPhase
  trigger: string | null
  completedCollections: number
  totalCollections: number
  rawDirectoryCount: number | null
  positionCount: number | null
  lastSuccessAt: string | null
  error: string | null
  unknownClassifications: number
  added: number
  removed: number
}

export interface KugouAccountState {
  phase: LoginPhase
  account: AccountInfo | null
  cachedAccount: AccountInfo | null
  hasStoredSession: boolean
  qrImage: string | null
  qrDeadline: number | null
  qrPolling: boolean
  qrChecks: number
  message: string | null
  sync: KugouSyncState
}

export interface AccountState extends KugouAccountState {
  activeProvider: AccountProvider
  kugou: KugouAccountState
  netease: NeteaseAccountState
}

export interface AccountCollection {
  sourceKey: string
  sourceGlobalKey: string | null
  name: string
  kind: Exclude<CollectionKind, 'shared'>
  subtype: 'album' | null
  order: number
  reportedCount: number
  coverUrl?: string | null
  raw: unknown
  tracks: (Track & { hash?: string; raw: unknown })[]
}

export interface AccountLibrary {
  owner: AccountInfo
  at: string
  collections: AccountCollection[]
  rawDirectoryCount: number
  unknownClassifications: number
  directoryVerified: boolean
}

export interface NeteaseCollection {
  sourceKey: string
  name: string
  kind: Exclude<CollectionKind, 'shared'>
  subtype: 'album' | null
  order: number
  reportedCount: number
  coverUrl: string | null
  updateTime: number | null
  raw: unknown
  tracks: (Track & { songId: string; raw: unknown })[]
}

export interface NeteaseLibrary {
  owner: NeteaseAccountInfo
  at: string
  collections: NeteaseCollection[]
  rawDirectoryCount: number
  directoryVerified: boolean
}

export interface Device { guid: string; mid: string; dev: string; dfid: string }
export interface KugouSession { schema: 1; platform: 'standard'; savedAt: string; device: Device; userid: string; token: string; t1?: string }
