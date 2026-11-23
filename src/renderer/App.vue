<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './components/Icon.vue'
import ShareImport from './components/ShareImport.vue'
import SourceSearch from './components/SourceSearch.vue'
import VersionPanel from './components/VersionPanel.vue'
import CollectionArtwork from './components/CollectionArtwork.vue'
import CollectionCard from './components/CollectionCard.vue'
import AccountPanel from './components/AccountPanel.vue'
import AudioBridge from './components/AudioBridge.vue'
import PlayerBar from './components/PlayerBar.vue'
import QueuePanel from './components/QueuePanel.vue'
import PlaybackPages from './components/PlaybackPages.vue'
import CacheSettings from './components/CacheSettings.vue'
import TrackActions from './components/TrackActions.vue'
import type { AppState, Collection, CollectionDetail, CollectionKind, Page, Preferences, UpdateInfo } from '../shared/contracts.ts'
import type { MatchResult, SourceCandidate, TrackReference } from '../shared/music.ts'
import { candidateKey, validateTrackReference } from '../shared/music.ts'
import type { AudioCacheState, CurrentTrackLocation, PlaybackLibrary, PlaybackTarget, PlayerCommand, PlayerState } from '../shared/playback.ts'
import { validatePlayerCommand } from '../shared/playback.ts'
import { centerListItem } from './playback-ui.ts'

const state = ref<AppState | null>(null)
const player = ref<PlayerState | null>(null)
const playbackLibrary = ref<PlaybackLibrary | null>(null)
const error = ref('')
const detail = ref<CollectionDetail | null>(null)
const category = ref<'all' | CollectionKind>('all')
const nameFilter = ref('')
const detailFilter = ref('')
const selectedPosition = ref<number | null>(null)
const expandedPosition = ref<number | null>(null)
const queueOpen = ref(false)
const versionOpen = ref<{ reference?: TrackReference; candidate?: SourceCandidate } | null>(null)
const previousPage = ref<Page>('library')
const volume = ref(70)
const notices = ref('')
const noticesBusy = ref(false)
const noticesDialog = ref<HTMLDialogElement | null>(null)
const updateInfo = ref<UpdateInfo | null>(null)
const updateBusy = ref(false)
const updateApplying = ref(false)
const backgroundBusy = ref(false)
const contentElement = ref<HTMLElement | null>(null)
const contentAtTop = ref(true)
const narrowMedia = window.matchMedia('(max-width: 1100px)')
const narrowWindow = ref(narrowMedia.matches)
function updateNarrowWindow(event: MediaQueryListEvent): void { narrowWindow.value = event.matches }
const trackLocation = ref<CurrentTrackLocation | null>(null)
const locating = ref(false)
const locatedPosition = ref<number | null>(null)
let locationGeneration = 0, highlightTimer: ReturnType<typeof setTimeout> | null = null
let volumeRevision = 0, savedVolumeRevision = 0, volumeSaving = false
let volumeSaveTimer: ReturnType<typeof setTimeout> | null = null

// Search Flyout & History state
const searchFlyoutOpen = ref(false)
const searchFlyoutQuery = ref('')
const searchHistory = ref<string[]>([])
const searchFlyoutInput = ref<HTMLInputElement | null>(null)
const searchRequest = ref<{ id: number; query: string } | null>(null)
let searchRequestId = 0

let libraryScroll = 0, detailRefreshGeneration = 0, lastSuccessfulSync: string | null = null, previousScroll = 0, playbackRevision = -1, libraryGeneration = 0
let unsubscribe: (() => void) | undefined
let unsubscribePlayer: (() => void) | undefined

const page = computed(() => state.value?.preferences.currentPage || 'library')
watch(page, async (target, previous) => {
  if (previous === 'search' && target !== 'search') searchRequest.value = null
  if (target === 'search' && previous !== 'search') {
    await nextTick()
    if (contentElement.value) contentElement.value.scrollTop = 0
  }
})
const preferences = computed(() => state.value?.preferences)
const distributionLabel = computed(() => state.value?.app.distribution === 'portable' ? 'PORTABLE' : state.value?.app.distribution === 'installed' ? 'INSTALLER' : 'DEVELOPMENT')
const currentReference = computed(() => {
  const current = player.value?.queue.find(item => item.id === player.value?.currentId)
  return current?.target.kind === 'original' ? current.target.reference : player.value?.now?.reference ?? null
})
const playlistActive = computed(() => page.value === 'library' && Boolean(detail.value))
const compactDetail = computed(() => playlistActive.value && narrowWindow.value && (queueOpen.value || Boolean(versionOpen.value)))
const currentDetailPosition = computed(() => {
  if (!playlistActive.value || !player.value?.currentId) return null
  if (trackLocation.value?.currentId === player.value.currentId) return trackLocation.value.position
  const current = player.value.queue.find(item => item.id === player.value?.currentId)
  return current?.target.kind === 'original' && current.target.reference.collectionId === detail.value?.collection.id ? current.target.reference.position : null
})
const locationSignature = computed(() => [
  playlistActive.value ? detail.value?.collection.id : '',
  player.value?.currentId, currentReference.value?.collectionId, currentReference.value?.position,
  player.value?.now?.candidate ? candidateKey(player.value.now.candidate) : '',
  player.value?.now?.localId, player.value?.now?.localStamp, player.value?.historyRevision
].join('|'))
watch([locationSignature, detail], () => { void refreshCurrentLocation() }, { immediate: true, flush: 'post' })
watch(() => player.value?.media?.id, () => { if (page.value === 'settings') void reloadPlaybackLibrary() })

async function refreshCurrentLocation(): Promise<void> {
  const generation = ++locationGeneration, id = detail.value?.collection.id, signature = locationSignature.value
  trackLocation.value = null
  locatedPosition.value = null
  if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null }
  if (!playlistActive.value || !id || !player.value?.currentId) return
  try {
    const result = await window.suMusic.locateCurrentTrack(id)
    if (generation !== locationGeneration || signature !== locationSignature.value || detail.value?.collection.id !== id) return
    if (result.ok && result.value.currentId === player.value?.currentId) trackLocation.value = result.value
  } catch { /* Navigation stays available while a lookup is superseded or unavailable. */ }
}

function onContentScroll(): void { contentAtTop.value = (contentElement.value?.scrollTop ?? 0) <= 1 }
function scrollToTop(): void { contentElement.value?.scrollTo({ top: 0, behavior: 'auto' }) }
async function locatePlayingTrack(): Promise<void> {
  const id = detail.value?.collection.id, currentId = player.value?.currentId, signature = locationSignature.value, generation = locationGeneration
  if (!id || !currentId || locating.value) return
  locating.value = true
  try {
    const result = await window.suMusic.locateCurrentTrack(id)
    if (generation !== locationGeneration || signature !== locationSignature.value || !playlistActive.value) return
    if (!result.ok) { error.value = result.error.message; return }
    if (result.value.currentId !== currentId) return
    trackLocation.value = result.value
    const position = result.value.position
    if (position === null) return
    if (!filteredDetailTracks.value.some(track => track.position === position)) detailFilter.value = ''
    await nextTick()
    if (generation !== locationGeneration || signature !== locationSignature.value || detail.value?.collection.id !== id) return
    const row = contentElement.value?.querySelector<HTMLElement>('[data-track-position="' + position + '"]')
    if (!row || !contentElement.value) return
    centerListItem(contentElement.value, row)
    locatedPosition.value = position
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => { locatedPosition.value = null; highlightTimer = null }, 1600)
  } catch { error.value = '当前歌曲暂时无法定位，请重试。' }
  finally { locating.value = false }
}

function updateVolume(value: number): void {
  const next = Math.max(0, Math.min(100, Math.round(value)))
  if (next !== volume.value) { volume.value = next; volumeRevision++ }
}
function saveVolume(value: number, deferred = false): void {
  updateVolume(value)
  if (volumeSaveTimer) clearTimeout(volumeSaveTimer)
  volumeSaveTimer = null
  if (deferred) volumeSaveTimer = setTimeout(() => { volumeSaveTimer = null; void flushVolume() }, 160)
  else void flushVolume()
}
async function flushVolume(): Promise<void> {
  if (volumeSaveTimer) { clearTimeout(volumeSaveTimer); volumeSaveTimer = null }
  if (volumeSaving || savedVolumeRevision === volumeRevision) return
  volumeSaving = true
  try {
    while (savedVolumeRevision < volumeRevision) {
      const revision = volumeRevision
      const result = await window.suMusic.setPreferences({ volume: volume.value })
      if (!result.ok) { error.value = result.error.message; break }
      savedVolumeRevision = revision
      // Preference broadcasts update app state; this reply acknowledges the saved volume.
    }
  } catch { error.value = '音量设置未能保存，请重试。' }
  finally { volumeSaving = false }
}
function volumeKeyReleased(event: KeyboardEvent): void {
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') void flushVolume()
}

const myCollections = computed(() => (state.value?.library.collections || []).filter(item => item.kind !== 'shared'))
const shares = computed(() => (state.value?.library.collections || []).filter(item => item.kind === 'shared'))
const pinned = computed(() => (state.value?.library.collections || []).filter(item => item.pinned))

const navigation: { page: Page; label: string; icon: string }[] = [
  { page: 'library', label: '我的歌单', icon: 'library' },
  { page: 'search', label: '歌曲搜索', icon: 'search' },
  { page: 'history', label: '播放历史', icon: 'history' },
  { page: 'review', label: '待处理歌曲', icon: 'review' },
  { page: 'local', label: '本地音乐', icon: 'folder' }
]

const tabs: { kind: 'all' | CollectionKind; label: string }[] = [
  { kind: 'all', label: '全部' },
  { kind: 'default', label: '默认' },
  { kind: 'created', label: '自建' },
  { kind: 'favorite', label: '收藏' }
]

const titles: Record<Page, string> = {
  library: '我的歌单',
  search: '歌曲搜索',
  history: '播放历史',
  review: '待处理歌曲',
  local: '本地音乐',
  settings: '账号与设置',
  now: '正在播放'
}

const visibleCollections = computed(() => {
  const filter = nameFilter.value.trim().toLocaleLowerCase()
  const items = myCollections.value.filter(item => (category.value === 'all' || item.kind === category.value) && item.name.toLocaleLowerCase().includes(filter))
  return [...items].sort((a, b) => preferences.value?.librarySort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') :
    preferences.value?.librarySort === 'count' ? b.positionCount - a.positionCount : (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''))
})

const filteredDetailTracks = computed(() => {
  if (!detail.value) return []
  const q = detailFilter.value.trim().toLocaleLowerCase()
  if (!q) return detail.value.tracks
  return detail.value.tracks.filter(t => {
    const title = (t.title ?? '').toLocaleLowerCase()
    const filename = (t.filename ?? '').toLocaleLowerCase()
    const artist = (t.artist ?? '').toLocaleLowerCase()
    const album = (t.album ?? '').toLocaleLowerCase()
    const version = (t.version ?? '').toLocaleLowerCase()
    return title.includes(q) || filename.includes(q) || artist.includes(q) || album.includes(q) || version.includes(q)
  })
})

function providerLabel(item: Collection): string {
  if (item.kind === 'shared') return '分享导入'
  if (item.provider === 'netease') return '网易云'
  if (item.provider === 'kugou') return '酷狗'
  return item.provider || '本地'
}

const sidebarAccountText = computed(() => {
  const acc = state.value?.account
  if (!acc) return '尚未连接账号'
  if (acc.activeProvider === 'netease') {
    return acc.netease?.connected ? '网易云已连接' : '网易云未连接'
  }
  return acc.kugou?.phase === 'authenticated' ? '酷狗已连接' : acc.kugou?.cachedAccount ? '酷狗 · 本地缓存' : '酷狗尚未连接'
})
const sidebarAccountConnected = computed(() => {
  const account = state.value?.account
  return account?.activeProvider === 'netease' ? Boolean(account.netease?.connected) : account?.kugou?.phase === 'authenticated'
})

const canSwitchProvider = computed(() => {
  const acc = state.value?.account
  if (!acc) return false
  const hasKg = Boolean(acc.kugou?.account || acc.kugou?.cachedAccount)
  const hasNe = Boolean(acc.netease?.account || acc.netease?.cachedAccount)
  return hasKg && hasNe
})

async function quickSwitchProvider(): Promise<void> {
  const acc = state.value?.account
  if (!acc) return
  if (acc.activeProvider === 'kugou') {
    await window.suMusic.switchAccount('netease')
  } else {
    await window.suMusic.switchAccount('kugou')
  }
}

function applyPlayer(value: PlayerState): void {
  player.value = value
  if (value.historyRevision !== playbackRevision) {
    playbackRevision = value.historyRevision
    void reloadPlaybackLibrary()
    void reloadOpenDetail()
  }
}

function versionActed(): void {
  void reloadPlaybackLibrary()
  void reloadOpenDetail()
}

async function reloadPlaybackLibrary(): Promise<void> {
  const generation = ++libraryGeneration
  const result = await window.suMusic.getPlaybackLibrary()
  if (generation !== libraryGeneration) return
  if (result.ok) playbackLibrary.value = result.value
}

async function command(value: PlayerCommand): Promise<void> {
  try {
    const result = await window.suMusic.playerCommand(validatePlayerCommand(value))
    if (!result.ok) error.value = result.error.message
  } catch {
    error.value = '播放请求未能发送，请重新选择歌曲。'
  }
}

function originalTarget(position: number): PlaybackTarget {
  return { kind: 'original', reference: { collectionId: detail.value!.collection.id, position } }
}

function playTrack(position: number): void {
  if (detail.value) void command({ type: 'play_collection', collectionId: detail.value.collection.id, position })
}
function toggleTrackPlayback(position: number): void {
  if (position === currentDetailPosition.value) void command({ type: 'control', action: player.value?.desiredPlaying ? 'pause' : 'resume' })
  else playTrack(position)
}

function trackKey(event: KeyboardEvent, position: number): void {
  if (event.target === event.currentTarget) {
    event.preventDefault()
    playTrack(position)
  }
}
function trackSpace(event: KeyboardEvent, position: number): void {
  if (event.target === event.currentTarget) { event.preventDefault(); toggleRowExpand(position) }
}

function trackDouble(event: MouseEvent, position: number): void {
  if (!(event.target as Element | null)?.closest('button')) playTrack(position)
}

function toggleRowExpand(position: number): void {
  if (expandedPosition.value === position) {
    expandedPosition.value = null
  } else {
    expandedPosition.value = position
  }
  selectedPosition.value = expandedPosition.value
}

function enqueue(position: number, placement: 'next' | 'end'): void {
  if (detail.value) void command({ type: 'enqueue', target: originalTarget(position), placement })
}

async function importLocal(reference?: TrackReference): Promise<void> {
  const result = await window.suMusic.importLocal(reference ? validateTrackReference(reference) : undefined)
  if (!result.ok) error.value = result.error.message
  else {
    await reloadPlaybackLibrary()
    if (reference && result.value.length) await command({ type: 'play', target: { kind: 'original', reference } })
  }
}

async function removeLocal(id: string): Promise<void> {
  const result = await window.suMusic.removeLocal(id)
  if (result.ok) playbackLibrary.value = result.value
  else error.value = result.error.message
}

async function clearHistory(): Promise<void> {
  const result = await window.suMusic.clearHistory()
  if (result.ok) playbackLibrary.value = result.value
  else error.value = result.error.message
}

async function playHistory(id: string): Promise<void> {
  const result = await window.suMusic.playHistory(id)
  if (!result.ok) error.value = result.error.message
}
async function enqueueHistory(id: string): Promise<void> {
  const result = await window.suMusic.enqueueHistory(id)
  if (!result.ok) error.value = result.error.message
}

async function openSourceCollection(id: string): Promise<void> {
  const item = state.value?.library.collections.find(value => value.id === id)
  if (item) await openCollection(item)
  else error.value = '来源歌单已不在当前曲库中。'
}

function cacheChanged(value: AudioCacheState): void {
  if (playbackLibrary.value) { playbackLibrary.value.cache = value; void reloadPlaybackLibrary() }
}

function applyState(value: AppState, syncVolume = true): void {
  const priorAccount = state.value?.account?.cachedAccount?.id
  const priorProvider = state.value?.account?.activeProvider
  state.value = value
  if (detail.value) {
    const updated = value.library.collections.find(item => item.id === detail.value!.collection.id)
    if (updated) detail.value.collection.coverUrl = updated.coverUrl
  }
  if (priorProvider && priorProvider !== value.account?.activeProvider || priorAccount && value.account?.cachedAccount?.id && priorAccount !== value.account.cachedAccount.id) {
    detail.value = null
    versionOpen.value = null
  }
  const sync = value.account?.sync
  if (sync?.phase === 'completed' && sync.lastSuccessAt !== lastSuccessfulSync) {
    lastSuccessfulSync = sync.lastSuccessAt
    void reloadOpenDetail()
  }
  if (syncVolume && savedVolumeRevision === volumeRevision) volume.value = value.preferences.volume
  document.documentElement.dataset.theme = value.effectiveTheme
  document.documentElement.dataset.density = value.preferences.density
}

async function reloadOpenDetail(): Promise<void> {
  if (!detail.value) return
  const id = detail.value.collection.id, generation = ++detailRefreshGeneration
  const result = await window.suMusic.getCollection(id)
  if (generation !== detailRefreshGeneration || detail.value?.collection.id !== id) return
  if (result.ok) {
    detail.value = result.value
    if (!result.value) versionOpen.value = null
  }
}

async function backToLibrary(): Promise<void> {
  detailRefreshGeneration++
  detail.value = null
  selectedPosition.value = null
  expandedPosition.value = null
  detailFilter.value = ''
  versionOpen.value = null
  await nextTick()
  if (contentElement.value) contentElement.value.scrollTop = libraryScroll
}

async function patchPreferences(patch: Partial<Preferences>): Promise<void> {
  const result = await window.suMusic.setPreferences(patch)
  if (result.ok) { applyState(result.value, false); error.value = '' }
  else error.value = result.error.message
}
async function setBackgroundPlayback(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  backgroundBusy.value = true
  try { await patchPreferences({ backgroundPlayback: input.checked }) }
  catch { error.value = '后台播放设置未能保存，请稍后重试。' }
  finally { input.checked = preferences.value?.backgroundPlayback ?? false; backgroundBusy.value = false }
}

async function navigate(target: Page, returning = false): Promise<void> {
  if (target !== page.value) versionOpen.value = null
  if (target === 'now' && page.value !== 'now') {
    previousPage.value = page.value
    previousScroll = contentElement.value?.scrollTop ?? 0
  }
  if (target === 'library' && !returning) {
    detail.value = null
    selectedPosition.value = null
    expandedPosition.value = null
    detailFilter.value = ''
  }
  await patchPreferences({ currentPage: target })
  if (['history', 'review', 'local', 'settings'].includes(target)) void reloadPlaybackLibrary()
  if (returning) {
    await nextTick()
    if (contentElement.value) contentElement.value.scrollTop = target === 'search' ? 0 : previousScroll
  }
}

async function openCollection(item: Collection): Promise<void> {
  versionOpen.value = null
  libraryScroll = contentElement.value?.scrollTop || 0
  const result = await window.suMusic.getCollection(item.id)
  if (result.ok && result.value) {
    detail.value = result.value
    selectedPosition.value = null
    expandedPosition.value = null
    detailFilter.value = ''
    await patchPreferences({ currentPage: 'library' })
  } else {
    error.value = result.ok ? '这张歌单暂时无法打开。' : result.error.message
  }
}

async function pinCurrent(): Promise<void> {
  if (!detail.value) return
  const result = await window.suMusic.setPinned(detail.value.collection.id, !detail.value.collection.pinned)
  if (result.ok) {
    applyState(result.value)
    await reloadOpenDetail()
  } else {
    error.value = result.error.message
  }
}

async function importedCollection(value: CollectionDetail): Promise<void> {
  detail.value = value
  selectedPosition.value = null
  expandedPosition.value = null
  detailFilter.value = ''
  versionOpen.value = null
  await patchPreferences({ currentPage: 'library' })
}

function inspectOriginal(reference: TrackReference): void {
  queueOpen.value = false
  versionOpen.value = { reference }
}

function inspectCandidate(candidate: SourceCandidate): void {
  queueOpen.value = false
  versionOpen.value = { candidate }
}

function matchChecked(reference: TrackReference, result: MatchResult): void {
  void reloadPlaybackLibrary()
  if (detail.value?.collection.id !== reference.collectionId) return
  const track = detail.value.tracks.find(item => item.position === reference.position)
  if (track) {
    track.matchStatus = result.status
    track.matchCheckedAt = result.checkedAt
    void reloadOpenDetail()
  }
}

function toggleQueue(): void {
  versionOpen.value = null
  queueOpen.value = !queueOpen.value
}

function matchLabel(status: string | undefined): string {
  return status === 'candidate_matched' ? '候选已匹配' : status === 'needs_review' ? '需要对照版本' : status === 'not_found' ? '未找到候选' : '未检查'
}

async function showNotices(): Promise<void> {
  noticesBusy.value = true
  try {
    const result = await window.suMusic.getNotices()
    if (result.ok) { notices.value = result.value; await nextTick(); noticesDialog.value?.showModal() }
    else error.value = result.error.message
  } finally { noticesBusy.value = false }
}

async function checkUpdate(): Promise<void> {
  if (updateBusy.value || updateApplying.value) return
  updateBusy.value = true
  updateInfo.value = null
  try {
    const result = await window.suMusic.checkUpdate()
    if (result.ok) { updateInfo.value = result.value; error.value = '' }
    else error.value = result.error.message
  } catch {
    error.value = '更新检查未能发送，请稍后重试。'
  } finally {
    updateBusy.value = false
  }
}

async function applyUpdate(): Promise<void> {
  if (updateApplying.value || updateInfo.value?.state !== 'available') return
  updateApplying.value = true
  try {
    const result = await window.suMusic.applyUpdate()
    if (!result.ok) { error.value = result.error.message; updateApplying.value = false }
  } catch {
    error.value = '更新程序未能启动，请稍后重试。'
    updateApplying.value = false
  }
}

function updateDescription(): string {
  if (updateApplying.value) return '正在下载并校验更新包，完成后应用会自动退出、更新并重新启动。'
  if (updateBusy.value) return '正在连接 GitHub Release 检查新版本…'
  if (updateInfo.value?.state === 'available') return `发现 ${updateInfo.value.latestVersion}${updateInfo.value.prerelease ? ' 预发布版' : ''}，已匹配当前${updateInfo.value.distribution === 'portable' ? '便携版' : '安装版'}更新包。`
  if (updateInfo.value?.state === 'up-to-date') return `当前 ${updateInfo.value.currentVersion} 已是此更新通道中的最新版本。`
  return `当前版本 ${state.value?.app.version ?? '—'}；仅在点击后连接 GitHub，不会后台自动下载。`
}

function count(kind: string): number {
  return kind === 'all' ? myCollections.value.length : myCollections.value.filter(item => item.kind === kind).length
}

function kindLabel(item: Collection): string {
  return item.kind === 'default' ? '默认歌单' : item.kind === 'created' ? '自建歌单' : item.kind === 'shared' ? '分享导入' : item.subtype === 'album' ? '收藏 · 专辑' : '收藏歌单'
}

function duration(value: number | null): string {
  return value === null ? '—' : Math.floor(value / 60000) + ':' + String(Math.floor(value / 1000) % 60).padStart(2, '0')
}

// Search Flyout Actions
async function openSearchFlyout(): Promise<void> {
  searchFlyoutOpen.value = true
  const res = await window.suMusic.getSearchHistory()
  if (res.ok) searchHistory.value = res.value
  await nextTick()
  searchFlyoutInput.value?.focus()
}

async function submitFlyoutSearch(queryToSearch?: string): Promise<void> {
  const q = (queryToSearch ?? searchFlyoutQuery.value).trim()
  if (!q) return
  searchFlyoutOpen.value = false
  searchFlyoutQuery.value = ''
  searchRequest.value = { id: ++searchRequestId, query: q }
  await navigate('search')
}

async function deleteHistoryItem(item: string): Promise<void> {
  const res = await window.suMusic.removeSearchHistory(item)
  if (res.ok) searchHistory.value = res.value
}

async function clearAllHistory(): Promise<void> {
  const res = await window.suMusic.clearSearchHistory()
  if (res.ok) searchHistory.value = res.value
}

function keyboard(event: KeyboardEvent): void {
  if (event.ctrlKey && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    void openSearchFlyout()
    return
  }
  if (event.key === 'Escape') {
    if (searchFlyoutOpen.value) {
      searchFlyoutOpen.value = false
      return
    }
    queueOpen.value = false
    versionOpen.value = null
  }
  const target = event.target instanceof Element ? event.target as HTMLElement : null
  if (state.value && !event.defaultPrevented && !event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey &&
      !noticesDialog.value?.open && !searchFlyoutOpen.value && !versionOpen.value && !target?.isContentEditable &&
      !target?.closest('input,textarea,select,[role="textbox"],[role="combobox"],[role="slider"],[role="dialog"],[role="menu"],[role="listbox"],[role="tree"],[role="tablist"]') &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault()
    saveVolume(volume.value + (event.key === 'ArrowUp' ? 5 : -5), true)
    return
  }
  // Space shortcut on song row toggles expand/collapse; elsewhere toggles playback
  if (event.code === 'Space' && !event.ctrlKey && !event.altKey && !event.metaKey && !target?.isContentEditable && !noticesDialog.value?.open) {
    if (target?.closest('tr[data-track-position]')) {
      // Row handles Space via @keydown.space.prevent
      return
    }
    if (!['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(target?.tagName ?? '')) {
      event.preventDefault()
      void command({ type: 'control', action: player.value?.desiredPlaying ? 'pause' : 'resume' })
    }
  }
}

onMounted(async () => {
  window.addEventListener('keydown', keyboard)
  window.addEventListener('keyup', volumeKeyReleased)
  narrowMedia.addEventListener('change', updateNarrowWindow)
  try {
    unsubscribe = window.suMusic.onStateChanged(applyState)
    unsubscribePlayer = window.suMusic.onPlayerChanged(applyPlayer)
    const result = await window.suMusic.getState()
    if (result.ok) { applyState(result.value); document.body.dataset.ready = 'true' }
    else error.value = result.error.message
    const initial = await window.suMusic.getPlayer()
    if (initial.ok) applyPlayer(initial.value)
  } catch {
    error.value = '本机资料未能连接，请重新启动应用。'
  }
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribePlayer?.()
  window.removeEventListener('keydown', keyboard)
  window.removeEventListener('keyup', volumeKeyReleased)
  narrowMedia.removeEventListener('change', updateNarrowWindow)
  if (highlightTimer) clearTimeout(highlightTimer)
  void flushVolume()
})
</script>

<template>
  <div class="app-shell">
    <AudioBridge :player="player" :volume="volume" />
    <header class="titlebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <strong>SU MUSIC</strong>
        <span class="brand-divider" aria-hidden="true">/</span>
        <span class="brand-caption">音乐库</span>
      </div>
      <div class="title-context">{{ titles[page] }}</div>
      <button class="search-shortcut" data-search-shortcut @click="openSearchFlyout" aria-keyshortcuts="Control+K">
        <Icon name="search" />
        <span>在线搜索</span>
        <kbd>Ctrl K</kbd>
      </button>
      <button
        class="icon-button theme-shortcut"
        :aria-label="state?.effectiveTheme === 'day' ? '切换到黑夜模式' : '切换到白天模式'"
        @click="patchPreferences({ theme: state?.effectiveTheme === 'day' ? 'night' : 'day' })"
      >
        <Icon :name="state?.effectiveTheme === 'day' ? 'night' : 'day'" />
      </button>
      <span class="window-controls-space" aria-hidden="true"></span>
    </header>

    <!-- Top Search Flyout Overlay -->
    <div v-if="searchFlyoutOpen" class="search-flyout-backdrop" @click="searchFlyoutOpen = false"></div>
    <div v-if="searchFlyoutOpen" class="search-flyout" role="dialog" aria-label="在线搜索浮层" data-search-flyout>
      <div class="search-flyout-input-wrap">
        <Icon name="search" />
        <input
          ref="searchFlyoutInput"
          v-model="searchFlyoutQuery"
          placeholder="搜索网易云在线歌曲，按回车搜索"
          aria-label="在线搜索输入"
          data-search-flyout-input
          @keydown.enter.prevent="submitFlyoutSearch()"
          @keydown.esc="searchFlyoutOpen = false"
        />
      </div>
      <div class="search-flyout-header">
        <span>搜索历史（最近 20 条）</span>
        <button v-if="searchHistory.length" class="search-flyout-clear" data-clear-history-btn @click="clearAllHistory">清空全部</button>
      </div>
      <ul v-if="searchHistory.length" class="search-flyout-list" data-search-flyout-list>
        <li
          v-for="item in searchHistory"
          :key="item"
          class="search-flyout-item"
          data-search-history-item
          @click="submitFlyoutSearch(item)"
        >
          <span class="search-flyout-item-text">{{ item }}</span>
          <button class="search-flyout-delete" title="删除记录" @click.stop="deleteHistoryItem(item)">
            <Icon name="close" />
          </button>
        </li>
      </ul>
      <div v-else class="search-flyout-empty">
        暂无搜索历史
      </div>
    </div>

    <aside class="sidebar" aria-label="主导航">
      <div class="nav-caption">音乐与收藏 <span>01—05</span></div>
      <nav>
        <button
          v-for="item in navigation"
          :key="item.page"
          class="nav-item"
          :class="{ active: page === item.page }"
          :aria-current="page === item.page ? 'page' : undefined"
          :data-nav="item.page"
          @click="navigate(item.page)"
        >
          <Icon :name="item.icon" />
          <span>{{ item.label }}</span>
          <span v-if="item.page === 'library'" class="nav-count">{{ myCollections.length }}</span>
        </button>
      </nav>
      <div class="pinned-heading">
        <span>常用歌单</span>
        <span class="small-rule" aria-hidden="true"></span>
      </div>
      <div class="pinned-list">
        <button v-for="item in pinned" :key="item.id" class="pinned-item" @click="openCollection(item)">
          <span class="pin-marker" aria-hidden="true"></span>
          <span>{{ item.name }}</span>
        </button>
        <p v-if="!pinned.length" class="empty-pins">暂无置顶歌单</p>
      </div>
      <div class="sidebar-bottom">
        <button class="sidebar-account-btn" data-sidebar-account @click="quickSwitchProvider" title="点击快速切换曲库">
          <span class="neutral-dot" :class="{ connected: sidebarAccountConnected }" aria-hidden="true" data-account-dot></span>
          <span>{{ sidebarAccountText }}</span>
          <span v-if="canSwitchProvider" class="sidebar-account-switch">切换</span>
        </button>
        <button
          class="nav-item"
          :class="{ active: page === 'settings' }"
          :aria-current="page === 'settings' ? 'page' : undefined"
          data-nav="settings"
          @click="navigate('settings')"
        >
          <Icon name="settings" />
          <span>账号与设置</span>
        </button>
      </div>
    </aside>

    <div class="content-frame" :class="{ 'playlist-active': playlistActive, 'compact-detail': compactDetail, 'with-queue': queueOpen, 'with-version': Boolean(versionOpen) }">
    <main ref="contentElement" class="content" :class="{ 'with-queue': queueOpen, 'with-version': Boolean(versionOpen) }" @scroll="onContentScroll">
      <div v-if="error" class="error-banner" role="alert">
        <span>{{ error }}</span>
        <button class="icon-button" aria-label="关闭提示" @click="error = ''"><Icon name="close" /></button>
      </div>
      <div v-if="player?.reason && ['needs_review','error','waiting_retry','resolving'].includes(player.phase)" class="playback-banner" role="status">
        <p>{{ player.reason }}</p>
        <div class="playback-actions">
          <button v-if="currentReference" class="button" @click="inspectOriginal(currentReference)">选择版本或本地文件</button>
          <button v-if="['error','needs_review'].includes(player.phase)" class="button" @click="command({type:'retry'})">重试播放</button>
          <button class="button" @click="toggleQueue">查看队列</button>
        </div>
      </div>
      <div v-if="!state && !error" class="loading-copy" role="status">正在读取本机资料…</div>

      <!-- Library Page -->
      <section v-if="page === 'library' && !detail" class="page library-page">
        <div class="page-heading">
          <div>
            <p class="eyebrow">LOCAL COLLECTIONS / 01</p>
            <h1>我的歌单</h1>
            <p class="page-description">收藏、整理，再回到熟悉的音乐。</p>
          </div>
          <div class="library-totals">
            <span>{{ myCollections.length }} 个歌单</span>
            <span>{{ state?.library.positionCount || 0 }} 个曲目位置</span>
          </div>
        </div>

        <p v-if="state?.account?.kugou && ['reading_directory','reading_tracks','checking_directory'].includes(state.account.kugou.sync.phase)" class="source-note" role="status">
          正在同步酷狗歌单：{{ state.account.kugou.sync.completedCollections }} / {{ state.account.kugou.sync.totalCollections }}。同步期间可继续浏览缓存。
        </p>
        <p v-if="state?.account?.netease && ['reading_directory','reading_tracks'].includes(state.account.netease.sync.phase)" class="source-note" role="status">
          正在同步网易云歌单：{{ state.account.netease.sync.completedCollections }} / {{ state.account.netease.sync.totalCollections }}。同步期间可继续浏览缓存。
        </p>
        <p v-if="state?.account?.kugou?.sync.error" class="inline-warning">{{ state.account.kugou.sync.error }}</p>
        <p v-if="state?.account?.netease?.sync.error" class="inline-warning">{{ state.account.netease.sync.error }}</p>

        <ShareImport @imported="importedCollection" />

        <div class="library-toolbar">
          <div class="category-tabs" aria-label="歌单分类">
            <button v-for="tab in tabs" :key="tab.kind" :aria-pressed="category === tab.kind" @click="category = tab.kind">
              <span>{{ tab.label }}</span>
              <span class="tab-count">{{ count(tab.kind) }}</span>
            </button>
          </div>
          <div class="view-switch" aria-label="歌单显示方式">
            <button class="icon-button" aria-label="网格视图" data-view="grid" :aria-pressed="preferences?.libraryView === 'grid'" @click="patchPreferences({ libraryView: 'grid' })">
              <Icon name="grid" />
            </button>
            <button class="icon-button" aria-label="列表视图" data-view="list" :aria-pressed="preferences?.libraryView === 'list'" @click="patchPreferences({ libraryView: 'list' })">
              <Icon name="list" />
            </button>
          </div>
        </div>

        <div class="filter-row">
          <label class="filter-input">
            <Icon name="search" />
            <input v-model="nameFilter" maxlength="100" aria-label="筛选歌单名称" placeholder="筛选歌单名称" />
            <button v-if="nameFilter" class="icon-button" aria-label="清空歌单筛选" @click="nameFilter = ''"><Icon name="close" /></button>
          </label>
          <label class="sort-select">
            <span>排序</span>
            <select aria-label="歌单排序" :value="preferences?.librarySort || 'recent'" @change="patchPreferences({ librarySort: ($event.target as HTMLSelectElement).value as Preferences['librarySort'] })">
              <option value="recent">最近打开</option>
              <option value="name">歌单名称</option>
              <option value="count">歌曲数量</option>
            </select>
            <Icon name="chevron" />
          </label>
        </div>

        <div v-if="visibleCollections.length" class="collection-grid" :class="{ 'collection-list': preferences?.libraryView === 'list' }" data-collections>
          <CollectionCard
            v-for="item in visibleCollections"
            :key="item.id"
            :collection="item"
            :view="preferences?.libraryView || 'grid'"
            :meta="item.positionCount + ' 首 · ' + providerLabel(item) + ' · ' + kindLabel(item)"
            @open="openCollection"
          />
        </div>

        <div v-else-if="!shares.length || myCollections.length" class="empty-stage">
          <div class="empty-art" aria-hidden="true">
            <span class="art-rail"></span>
            <Icon name="library" />
            <span class="art-coordinate">COLLECTION / 00</span>
          </div>
          <h2>{{ myCollections.length ? '没有符合条件的歌单' : '你的歌单，从这里开始' }}</h2>
          <p>{{ myCollections.length ? '换一个名称，或切换歌单分类。' : '连接账号后，默认、自建与收藏歌单会显示在这里。' }}</p>
          <button v-if="myCollections.length" class="button" @click="nameFilter = ''; category = 'all'">清空筛选</button>
          <button v-else class="button primary" @click="navigate('settings')">查看账号设置<Icon name="arrow" /></button>
        </div>

        <section v-if="shares.length" class="shared-section">
          <h2>分享导入 <span>{{ shares.length }}</span></h2>
          <div class="collection-grid" :class="{ 'collection-list': preferences?.libraryView === 'list' }" data-shared-list>
            <CollectionCard
              v-for="item in shares"
              :key="item.id"
              :collection="item"
              :view="preferences?.libraryView || 'grid'"
              :meta="item.positionCount + ' 首 · ' + providerLabel(item) + ' · 分享导入'"
              data-shared-item
              @open="openCollection"
            />
          </div>
        </section>
      </section>

      <!-- Detail Page -->
      <section v-else-if="page === 'library' && detail" class="page detail-page">
        <div class="detail-actions">
          <div class="detail-actions-left">
            <button class="button back-button" @click="backToLibrary"><Icon name="back" />返回我的歌单</button>
          </div>
          <div class="detail-actions-right">
            <button class="button" data-pin-current :aria-pressed="detail.collection.pinned" @click="pinCurrent">
              {{ detail.collection.pinned ? '取消置顶' : '置顶到侧栏' }}
            </button>
          </div>
        </div>

        <div class="detail-heading">
          <div class="detail-cover" aria-hidden="true">
            <CollectionArtwork :name="detail.collection.name" :url="detail.collection.coverUrl" :album="detail.collection.subtype === 'album'" />
          </div>
          <div class="detail-heading-info">
            <p class="eyebrow">{{ kindLabel(detail.collection) }}</p>
            <h1>{{ detail.collection.name }}</h1>
            <p class="page-description">{{ detail.tracks.length }} 首 · {{ providerLabel(detail.collection) }} · 本地资料</p>
            <div class="detail-play-row">
              <button
                class="button primary"
                :disabled="!detail.tracks.length"
                data-play-collection
                @click="command({ type: 'play_collection', collectionId: detail!.collection.id, position: detail!.tracks[0]!.position, skipUnavailable: true })"
              >
                <Icon name="play" />播放歌单
              </button>
              <div class="detail-filter">
                <label class="detail-filter-input">
                  <Icon name="search" />
                  <input
                    v-model="detailFilter"
                    placeholder="筛选当前歌单歌曲"
                    aria-label="筛选歌单歌曲"
                    data-detail-filter-input
                  />
                  <button v-if="detailFilter" class="icon-button" aria-label="清空歌单内筛选" @click="detailFilter = ''">
                    <Icon name="close" />
                  </button>
                </label>
                <span class="detail-filter-count" data-detail-filter-count>
                  {{ detailFilter.trim() ? filteredDetailTracks.length + ' / ' + detail.tracks.length : detail.tracks.length }} 首
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Track Table with Inline Actions -->
        <div class="track-table-wrap">
          <table class="track-table">
            <thead>
              <tr>
                <th class="position-cell">#</th>
                <th>歌曲 / 歌手</th>
                <th v-if="!compactDetail" class="album-cell">专辑</th>
                <th v-if="!compactDetail" class="duration-cell">时长</th>
                <th class="state-cell">操作</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="track in filteredDetailTracks" :key="track.position">
                <tr
                  :data-track-position="track.position"
                  :class="{
                    selected: selectedPosition === track.position,
                    'playing-track': currentDetailPosition === track.position,
                    'located-track': locatedPosition === track.position
                  }"
                  tabindex="0"
                  @click="toggleRowExpand(track.position)"
                  @dblclick="trackDouble($event, track.position)"
                  @keydown.enter="trackKey($event, track.position)"
                  @keydown.space="trackSpace($event, track.position)"
                >
                  <td class="position-cell">
                    <span>{{ String(track.position).padStart(2, '0') }}</span>
                  </td>
                  <td>
                    <p class="track-name">
                      {{ track.title || track.filename || '标题待补充' }}
                      <span v-if="track.version" class="version-label">{{ track.version }}</span>
                      <span v-if="track.playbackChoice === 'selected' || track.playbackChoice === 'local'" class="choice-label">
                        {{ track.playbackChoice === 'local' ? '本地版本' : '已选版本' }}
                      </span>
                    </p>
                    <p class="track-artist">
                      {{ track.artist || (track.playbackChoice === 'local' ? '本地音频' : '歌手信息缺失') }}
                      <span v-if="!track.playbackReady" class="track-match-note"> · {{ matchLabel(track.matchStatus) }}</span>
                    </p>
                  </td>
                  <td v-if="!compactDetail" class="album-cell"><span class="album-text" :title="track.album || '—'">{{ track.album || '—' }}</span></td>
                  <td v-if="!compactDetail" class="duration-cell">{{ duration(track.durationMs) }}</td>
                  <td class="state-cell">
                    <TrackActions
                      :track="track"
                      :current="currentDetailPosition === track.position"
                      :desired-playing="player?.desiredPlaying"
                      @play="toggleTrackPlayback"
                      @next="position => enqueue(position, 'next')"
                      @version="position => inspectOriginal({ collectionId: detail!.collection.id, position })"
                    />
                  </td>
                </tr>

                <!-- Inline Action Row Directly Underneath Song Row -->
                <tr v-if="expandedPosition === track.position" class="inline-action-row" :data-inline-actions="track.position">
                  <td :colspan="compactDetail ? 3 : 5">
                    <div class="inline-action-panel">
                      <div class="inline-action-content">
                        <div class="inline-action-title">
                          {{ track.title ?? track.filename }}
                          <span class="source-note"> · 第 {{ track.position }} 首</span>
                        </div>
                        <div class="inline-action-buttons">
                          <button class="button" @click.stop="playTrack(track.position)">
                            <Icon name="play" />播放
                          </button>
                          <button class="button" @click.stop="enqueue(track.position, 'next')">下一首播放</button>
                          <button class="button" @click.stop="enqueue(track.position, 'end')">加入队列</button>
                          <button class="button" data-edit-version @click.stop="inspectOriginal({ collectionId: detail!.collection.id, position: track.position })">
                            {{ track.playbackReady ? '更换版本' : '选择版本' }}
                          </button>
                          <button
                            v-if="track.playbackChoice === 'selected' || track.playbackChoice === 'local'"
                            class="button"
                            data-restore-row
                            @click.stop="command({ type: 'restore_original', reference: { collectionId: detail!.collection.id, position: track.position } })"
                          >
                            恢复原版
                          </button>
                          <button class="button" @click.stop="importLocal({ collectionId: detail!.collection.id, position: track.position })">
                            关联本地文件
                          </button>
                        </div>
                        <p v-if="track.playbackIssue" class="inline-action-note">{{ track.playbackIssue }}</p>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div v-if="!detail.tracks.length" class="empty-inline">这张歌单还没有曲目。</div>
        <p class="table-footnote">每个曲目位置独立保留，包括重复歌曲。</p>
      </section>

      <!-- Online Search Page -->
      <section v-else-if="page === 'search'" class="page search-page">
        <div class="page-heading">
          <div>
            <p class="eyebrow">MUSIC SEARCH</p>
            <h1>歌曲搜索</h1>
            <p class="page-description">在在线网易云音源中查找音乐，每页 20 首。</p>
          </div>
        </div>
        <SourceSearch
          :request="searchRequest"
          @original="inspectOriginal"
          @candidate="inspectCandidate"
          @play="target => command({ type: 'play', target })"
          @next="target => command({ type: 'enqueue', target, placement: 'next' })"
        />
      </section>

      <!-- Settings Page -->
      <section v-else-if="page === 'settings'" class="page settings-page">
        <div class="page-heading">
          <div>
            <p class="eyebrow">PREFERENCES</p>
            <h1>账号与设置</h1>
            <p class="page-description">让音乐库符合你的使用习惯。</p>
          </div>
        </div>
        <AccountPanel :state="state?.account" @changed="applyState" />
        <section class="settings-group">
          <h2>本机保护</h2>
          <div class="setting-row">
            <div>
              <h3>本机凭据保护</h3>
              <p>账号凭据由 Windows 加密，保存在本机。</p>
            </div>
            <span class="protection-state">
              <Icon name="shield" />
              {{ state?.security.credentialProtectionAvailable ? '加密可用' : '保护暂不可用' }}
            </span>
          </div>
        </section>
        <section class="settings-group">
          <h2>在线音源</h2>
          <div class="setting-row">
            <div>
              <h3>GD 音乐台 · 网易云</h3>
              <p>GD音乐台(music.gdstudio.xyz) 提供在线搜索与资源解析。</p>
              <p>候选匹配和资源读取分别检查，曲目版本差异会保留。</p>
            </div>
            <span class="status-label">已接入</span>
          </div>
        </section>
        <CacheSettings :cache="playbackLibrary?.cache ?? null" @changed="cacheChanged" />
        <section class="settings-group">
          <h2>软件更新</h2>
          <div class="setting-row update-row">
            <div>
              <h3>GitHub Release</h3>
              <p>{{ updateDescription() }}</p>
              <p v-if="updateInfo?.state === 'available' && updateInfo.releaseName" class="update-release-name">{{ updateInfo.releaseName }}</p>
            </div>
            <div class="update-actions">
              <button class="button" :disabled="updateBusy || updateApplying || state?.app.distribution === 'development'" data-check-update @click="checkUpdate">
                {{ updateBusy ? '正在检查' : '检查更新' }}
              </button>
              <button v-if="updateInfo?.state === 'available'" class="button primary" :disabled="updateApplying" data-apply-update @click="applyUpdate">
                {{ updateApplying ? '正在下载' : '一键更新' }}
              </button>
            </div>
          </div>
        </section>
        <section class="settings-group">
          <h2>播放与关闭</h2>
          <div class="setting-row">
            <div><h3>后台播放</h3><p>开启后，关闭窗口将进入系统托盘并继续播放。</p></div>
            <label class="background-toggle">
              <input type="checkbox" role="switch" aria-label="后台播放" data-background-playback :checked="preferences?.backgroundPlayback ?? false" :disabled="backgroundBusy" @change="setBackgroundPlayback" />
              <span>{{ preferences?.backgroundPlayback ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
        </section>
        <section class="settings-group">
          <h2>外观与显示</h2>
          <div class="setting-row">
            <div>
              <h3>界面外观</h3>
              <p>昼夜使用同一布局，选择会在下次启动时恢复。</p>
            </div>
            <div class="segmented">
              <button
                v-for="item in ([['system', '跟随系统'], ['day', '白天'], ['night', '黑夜']] as const)"
                :key="item[0]"
                :data-theme-choice="item[0]"
                :aria-pressed="preferences?.theme === item[0]"
                @click="patchPreferences({ theme: item[0] })"
              >
                {{ item[1] }}
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div>
              <h3>歌单默认视图</h3>
              <p>网格突出封面，列表便于浏览较多歌单。</p>
            </div>
            <div class="segmented">
              <button :aria-pressed="preferences?.libraryView === 'grid'" @click="patchPreferences({ libraryView: 'grid' })">网格</button>
              <button :aria-pressed="preferences?.libraryView === 'list'" @click="patchPreferences({ libraryView: 'list' })">列表</button>
            </div>
          </div>
        </section>
        <section class="settings-group about-group">
          <h2>关于</h2>
          <div class="setting-row">
            <div>
              <h3>Su Music <span class="version-number">{{ state?.app.version }}</span></h3>
              <p>独立音乐库 · Windows 开发版</p>
            </div>
            <button class="button" :disabled="noticesBusy" data-notices @click="showNotices">查看开源许可<Icon name="arrow" /></button>
          </div>
          <details class="runtime-details">
            <summary>运行环境</summary>
            <dl>
              <div><dt>Electron</dt><dd>{{ state?.environment.electron }}</dd></div>
              <div><dt>Node.js</dt><dd>{{ state?.environment.node }}</dd></div>
              <div><dt>SQLite</dt><dd>{{ state?.environment.sqlite }}</dd></div>
            </dl>
          </details>
        </section>
      </section>

      <PlaybackPages
        v-else
        :page="page"
        :player="player"
        :library="playbackLibrary"
        :app="state"
        @command="command"
        @inspect="inspectOriginal"
        @collection="openSourceCollection"
        @import-local="importLocal()"
        @remove-local="removeLocal"
        @play-history="playHistory"
        @enqueue-history="enqueueHistory"
        @clear-history="clearHistory"
        @back="navigate(previousPage, true)"
      />
    </main>
    <aside v-if="playlistActive" class="playlist-navigation" aria-label="歌单导航" data-playlist-navigation>
      <button v-if="currentDetailPosition !== null" class="icon-button" :disabled="locating" aria-label="定位当前歌曲" title="定位当前歌曲" data-locate-current @click.stop="locatePlayingTrack"><Icon name="locate" /></button>
      <button class="icon-button" :disabled="contentAtTop" aria-label="回到顶部" title="回到顶部" data-scroll-top @click.stop="scrollToTop"><Icon name="top" /></button>
    </aside>
    </div>

    <VersionPanel
      v-if="versionOpen"
      :reference="versionOpen.reference"
      :candidate="versionOpen.candidate"
      :locals="playbackLibrary?.local ?? []"
      @close="versionOpen = null"
      @checked="matchChecked"
      @acted="versionActed"
    />
    <QueuePanel v-if="queueOpen" :player="player" @close="queueOpen = false" @command="command" />
    <PlayerBar
      :player="player"
      :volume="volume"
      :queue-open="queueOpen"
      @command="command"
      @volume="updateVolume"
      @save-volume="saveVolume"
      @now="navigate('now')"
      @queue="toggleQueue"
    />
    <div class="statusbar">
      <span>
        <span class="status-tick" aria-hidden="true"></span>
        {{ state ? '本机资料已就绪' : '正在连接本机资料' }}
        <span v-if="state?.app.testProfile" class="test-label">布局测试资料</span>
      </span>
      <span class="status-meta">
        {{ state?.effectiveTheme === 'day' ? 'DAY / 白天' : 'NIGHT / 黑夜' }}
        <span class="status-separator" aria-hidden="true">/</span>
        {{ distributionLabel }}
      </span>
    </div>
    <dialog ref="noticesDialog" class="notices-dialog" aria-labelledby="notices-title">
      <header>
        <div>
          <p class="eyebrow">OPEN SOURCE</p>
          <h2 id="notices-title">开源许可</h2>
        </div>
        <button class="icon-button" autofocus aria-label="关闭开源许可" @click="noticesDialog?.close()"><Icon name="close" /></button>
      </header>
      <pre>{{ notices }}</pre>
    </dialog>
  </div>
</template>
