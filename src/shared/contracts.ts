import type { CandidateId, LibrarySearchItem, MatchResult, MatchStatus, OnlineSearchResult, ResourceCheck, TrackReference } from './music.ts'
import type { AccountState } from './account.ts'
import type { PlayerState, PlayerCommand, MediaEvent, PlaybackLibrary, LocalTrack, AudioCacheState } from './playback.ts'
export const CHANNELS = Object.freeze({ state: 'su:state', preferences: 'su:preferences', collection: 'su:collection', notices: 'su:notices', changed: 'su:changed',
  importShare: 'su:import-share', onlineSearch: 'su:online-search', librarySearch: 'su:library-search', matchTrack: 'su:match-track', checkResource: 'su:check-resource',
  login:'su:login',cancelLogin:'su:cancel-login',logout:'su:logout',sync:'su:sync',cancelSync:'su:cancel-sync',pin:'su:pin',
  player:'su:player',playerCommand:'su:player-command',mediaEvent:'su:media-event',playerChanged:'su:player-changed',playbackLibrary:'su:playback-library',
  importLocal:'su:import-local',removeLocal:'su:remove-local',clearHistory:'su:clear-history',playHistory:'su:play-history',
  chooseCache:'su:choose-cache',resetCache:'su:reset-cache',clearCache:'su:clear-cache',checkUpdate:'su:check-update',applyUpdate:'su:apply-update' })
export const PAGES = ['library', 'search', 'history', 'review', 'local', 'settings', 'now'] as const
export type Page = typeof PAGES[number]
export type ThemeChoice = 'system' | 'day' | 'night'
export type EffectiveTheme = 'day' | 'night'
export type CollectionKind = 'default' | 'created' | 'favorite' | 'shared'
export interface Preferences {
  theme: ThemeChoice
  density: 'comfortable' | 'compact'
  libraryView: 'grid' | 'list'
  librarySort: 'recent' | 'name' | 'count'
  currentPage: Page
  volume: number
}
export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({ theme: 'system', density: 'comfortable', libraryView: 'grid', librarySort: 'recent', currentPage: 'library', volume: 70 })
export interface Collection {
  id: string
  name: string
  kind: CollectionKind
  subtype: 'album' | null
  provider: string
  positionCount: number
  pinned: boolean
  lastOpenedAt: string | null
  coverUrl?: string | null
}
export interface Track {
  position: number
  title: string | null
  filename: string | null
  artist: string | null
  album: string | null
  durationMs: number | null
  version: string | null
  matchStatus?: MatchStatus
  matchCheckedAt?: string | null
  playbackReady?: boolean
  playbackChoice?: 'matched' | 'selected' | 'local'
  playbackIssue?: string | null
}
export interface CollectionDetail { collection: Collection; tracks: Track[] }
export interface AppState {
  app: { name: string; version: string; packaged: boolean; testProfile: boolean; distribution: 'installed' | 'portable' | 'development' }
  preferences: Preferences
  effectiveTheme: EffectiveTheme
  library: { collections: Collection[]; positionCount: number }
  security: { credentialProtectionAvailable: boolean }
  environment: { electron: string; node: string; sqlite: string; platform: string }
  account?: AccountState
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
export interface UpdateInfo {
  state: 'up-to-date' | 'available'
  currentVersion: string
  latestVersion: string
  distribution: 'installed' | 'portable' | 'development'
  releaseName: string | null
  publishedAt: string | null
  prerelease: boolean
  assetName: string | null
}
export interface DesktopAPI {
  getState(): Promise<Result<AppState>>
  setPreferences(patch: Partial<Preferences>): Promise<Result<AppState>>
  getCollection(id: string): Promise<Result<CollectionDetail | null>>
  getNotices(): Promise<Result<string>>
  importShare(link: string, name: string): Promise<Result<CollectionDetail>>
  searchOnline(query: string, force?: boolean): Promise<Result<OnlineSearchResult>>
  searchLibrary(query: string): Promise<Result<LibrarySearchItem[]>>
  matchTrack(reference: TrackReference, force?: boolean): Promise<Result<MatchResult>>
  checkResource(candidate: CandidateId, force?: boolean): Promise<Result<ResourceCheck>>
  startLogin(): Promise<Result<AppState>>
  cancelLogin(): Promise<Result<AppState>>
  logout(): Promise<Result<AppState>>
  syncAccount(): Promise<Result<AppState>>
  cancelSync(): Promise<Result<AppState>>
  setPinned(id:string,pinned:boolean):Promise<Result<AppState>>
  getPlayer():Promise<Result<PlayerState>>
  playerCommand(command:PlayerCommand):Promise<Result<PlayerState>>
  reportMediaEvent(event:MediaEvent):Promise<Result<null>>
  getPlaybackLibrary():Promise<Result<PlaybackLibrary>>
  importLocal(reference?:TrackReference):Promise<Result<LocalTrack[]>>
  removeLocal(id:string):Promise<Result<PlaybackLibrary>>
  clearHistory():Promise<Result<PlaybackLibrary>>
  playHistory(id:string):Promise<Result<PlayerState>>
  chooseCacheDirectory():Promise<Result<AudioCacheState>>
  resetCacheDirectory():Promise<Result<AudioCacheState>>
  clearAudioCache():Promise<Result<AudioCacheState>>
  checkUpdate():Promise<Result<UpdateInfo>>
  applyUpdate():Promise<Result<UpdateInfo>>
  onPlayerChanged(callback:(state:PlayerState)=>void):()=>void
  onStateChanged(callback: (state: AppState) => void): () => void
}
export function validatePreferencesPatch(input: unknown): Partial<Preferences> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('INVALID_PREFERENCES')
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(input).some(key => typeof key !== 'string')) throw new Error('INVALID_PREFERENCES')
  const values = input as Record<string, unknown>
  const rules: Record<string, (value: unknown) => boolean> = {
    theme: value => ['system', 'day', 'night'].includes(String(value)),
    density: value => ['comfortable', 'compact'].includes(String(value)),
    libraryView: value => ['grid', 'list'].includes(String(value)),
    librarySort: value => ['recent', 'name', 'count'].includes(String(value)),
    currentPage: value => PAGES.includes(value as Page),
    volume: value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
  }
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(rules, key) || (key !== 'volume' && typeof value !== 'string') || !rules[key]!(value)) throw new Error('INVALID_PREFERENCES')
  }
  if (Object.keys(values).length > Object.keys(rules).length) throw new Error('INVALID_PREFERENCES')
  return values as Partial<Preferences>
}
