<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
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
import type { AppState, Collection, CollectionDetail, CollectionKind, Page, Preferences } from '../shared/contracts.ts'
import type { MatchResult, SourceCandidate, TrackReference } from '../shared/music.ts'
import {validateTrackReference} from '../shared/music.ts'
import type {AudioCacheState,PlaybackLibrary,PlaybackTarget,PlayerCommand,PlayerState} from '../shared/playback.ts'
import {validatePlayerCommand} from '../shared/playback.ts'

const state = ref<AppState | null>(null)
const player=ref<PlayerState|null>(null),playbackLibrary=ref<PlaybackLibrary|null>(null)
const error = ref('')
const detail = ref<CollectionDetail | null>(null)
const category = ref<'all' | CollectionKind>('all')
const nameFilter = ref('')
const selectedPosition = ref<number | null>(null)
const queueOpen = ref(false)
const versionOpen = ref<{ reference?: TrackReference; candidate?: SourceCandidate } | null>(null)
const previousPage = ref<Page>('library')
const volume = ref(70)
const notices = ref('')
const noticesBusy = ref(false)
const noticesDialog = ref<HTMLDialogElement | null>(null)
const contentElement=ref<HTMLElement|null>(null)
let libraryScroll=0,detailRefreshGeneration=0,lastSuccessfulSync:string|null=null,previousScroll=0,playbackRevision=-1,libraryGeneration=0
let unsubscribe: (() => void) | undefined
let unsubscribePlayer:(()=>void)|undefined
const page = computed(() => state.value?.preferences.currentPage || 'library')
const preferences = computed(() => state.value?.preferences)
const currentReference=computed(()=>{const current=player.value?.queue.find(item=>item.id===player.value?.currentId);return current?.target.kind==='original'?current.target.reference:player.value?.now?.reference??null})
const selectedTrack=computed(()=>detail.value?.tracks.find(track=>track.position===selectedPosition.value)??null)
const myCollections = computed(() => (state.value?.library.collections || []).filter(item => item.kind !== 'shared'))
const shares = computed(() => (state.value?.library.collections || []).filter(item => item.kind === 'shared'))
const pinned = computed(() => (state.value?.library.collections||[]).filter(item => item.pinned))
const navigation: { page: Page; label: string; icon: string }[] = [
  { page: 'library', label: '我的歌单', icon: 'library' }, { page: 'search', label: '歌曲搜索', icon: 'search' },
  { page: 'history', label: '播放历史', icon: 'history' }, { page: 'review', label: '待处理歌曲', icon: 'review' },
  { page: 'local', label: '本地音乐', icon: 'folder' }
]
const tabs: { kind: 'all' | CollectionKind; label: string }[] = [
  { kind: 'all', label: '全部' }, { kind: 'default', label: '默认' }, { kind: 'created', label: '自建' }, { kind: 'favorite', label: '收藏' }
]
const titles: Record<Page, string> = { library: '我的歌单', search: '歌曲搜索', history: '播放历史', review: '待处理歌曲', local: '本地音乐', settings: '账号与设置', now: '正在播放' }
const visibleCollections = computed(() => {
  const filter = nameFilter.value.trim().toLocaleLowerCase()
  const items = myCollections.value.filter(item => (category.value === 'all' || item.kind === category.value) && item.name.toLocaleLowerCase().includes(filter))
  return [...items].sort((a, b) => preferences.value?.librarySort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') :
    preferences.value?.librarySort === 'count' ? b.positionCount - a.positionCount : (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''))
})
function applyPlayer(value:PlayerState):void{player.value=value;if(value.historyRevision!==playbackRevision){playbackRevision=value.historyRevision;void reloadPlaybackLibrary();void reloadOpenDetail()}}
function versionActed():void{void reloadPlaybackLibrary();void reloadOpenDetail()}
async function reloadPlaybackLibrary():Promise<void>{const generation=++libraryGeneration;const result=await window.suMusic.getPlaybackLibrary();if(generation!==libraryGeneration)return;if(result.ok)playbackLibrary.value=result.value}
async function command(value:PlayerCommand):Promise<void>{try{const result=await window.suMusic.playerCommand(validatePlayerCommand(value));if(!result.ok)error.value=result.error.message}catch{error.value='播放请求未能发送，请重新选择歌曲。'}}
function originalTarget(position:number):PlaybackTarget{return{kind:'original',reference:{collectionId:detail.value!.collection.id,position}}}
function playTrack(position:number):void{if(detail.value)void command({type:'play_collection',collectionId:detail.value.collection.id,position})}
function trackKey(event:KeyboardEvent,position:number):void{if(event.target===event.currentTarget){event.preventDefault();playTrack(position)}}
function trackDouble(event:MouseEvent,position:number):void{if(!(event.target as Element|null)?.closest('button'))playTrack(position)}
function enqueue(position:number,placement:'next'|'end'):void{if(detail.value)void command({type:'enqueue',target:originalTarget(position),placement})}
async function importLocal(reference?:TrackReference):Promise<void>{const result=await window.suMusic.importLocal(reference?validateTrackReference(reference):undefined);if(!result.ok)error.value=result.error.message;else{await reloadPlaybackLibrary();if(reference&&result.value.length)await command({type:'play',target:{kind:'original',reference}})}}
async function removeLocal(id:string):Promise<void>{const result=await window.suMusic.removeLocal(id);if(result.ok)playbackLibrary.value=result.value;else error.value=result.error.message}
async function clearHistory():Promise<void>{const result=await window.suMusic.clearHistory();if(result.ok)playbackLibrary.value=result.value;else error.value=result.error.message}
async function playHistory(id:string):Promise<void>{const result=await window.suMusic.playHistory(id);if(!result.ok)error.value=result.error.message}
async function openSourceCollection(id:string):Promise<void>{const item=state.value?.library.collections.find(value=>value.id===id);if(item)await openCollection(item);else error.value='来源歌单已不在当前曲库中。'}
function cacheChanged(value:AudioCacheState):void{if(playbackLibrary.value)playbackLibrary.value.cache=value}
function applyState(value: AppState): void {
  const priorAccount=state.value?.account?.cachedAccount?.id
  state.value = value
  if(detail.value){const updated=value.library.collections.find(item=>item.id===detail.value!.collection.id);if(updated)detail.value.collection.coverUrl=updated.coverUrl}
  if(priorAccount&&value.account?.cachedAccount?.id&&priorAccount!==value.account.cachedAccount.id){detail.value=null;versionOpen.value=null}
  const sync=value.account?.sync
  if(sync?.phase==='completed'&&sync.lastSuccessAt!==lastSuccessfulSync){lastSuccessfulSync=sync.lastSuccessAt;void reloadOpenDetail()}
  volume.value = value.preferences.volume
  document.documentElement.dataset.theme = value.effectiveTheme
  document.documentElement.dataset.density = value.preferences.density
}
async function reloadOpenDetail():Promise<void>{
  if(!detail.value)return;const id=detail.value.collection.id,generation=++detailRefreshGeneration
  const result=await window.suMusic.getCollection(id)
  if(generation!==detailRefreshGeneration||detail.value?.collection.id!==id)return
  if(result.ok){detail.value=result.value;if(!result.value)versionOpen.value=null}
}
async function backToLibrary():Promise<void>{detailRefreshGeneration++;detail.value=null;selectedPosition.value=null;versionOpen.value=null;await nextTick();if(contentElement.value)contentElement.value.scrollTop=libraryScroll}
async function patchPreferences(patch: Partial<Preferences>): Promise<void> {
  const result = await window.suMusic.setPreferences(patch)
  if (result.ok) { applyState(result.value); error.value = '' }
  else error.value = result.error.message
}
async function navigate(target: Page, returning = false): Promise<void> {
  if (target !== page.value) versionOpen.value = null
  if (target === 'now' && page.value !== 'now') {previousPage.value = page.value;previousScroll=contentElement.value?.scrollTop??0}
  if (target === 'library' && !returning) { detail.value = null; selectedPosition.value = null }
  await patchPreferences({ currentPage: target })
  if(['history','review','local','settings'].includes(target))void reloadPlaybackLibrary()
  if(returning){await nextTick();if(contentElement.value)contentElement.value.scrollTop=previousScroll}
}
async function openCollection(item: Collection): Promise<void> {
  versionOpen.value = null
  libraryScroll=contentElement.value?.scrollTop||0
  const result = await window.suMusic.getCollection(item.id)
  if (result.ok && result.value) { detail.value = result.value; selectedPosition.value = null; await patchPreferences({ currentPage: 'library' }) }
  else error.value = result.ok ? '这张歌单暂时无法打开。' : result.error.message
}
async function pinCurrent():Promise<void>{if(!detail.value)return;const result=await window.suMusic.setPinned(detail.value.collection.id,!detail.value.collection.pinned);if(result.ok){applyState(result.value);await reloadOpenDetail()}else error.value=result.error.message}
async function importedCollection(value: CollectionDetail): Promise<void> {
  detail.value = value; selectedPosition.value = null; versionOpen.value = null
  await patchPreferences({ currentPage: 'library' })
}
function inspectOriginal(reference: TrackReference): void { queueOpen.value = false; versionOpen.value = { reference } }
function inspectCandidate(candidate: SourceCandidate): void { queueOpen.value = false; versionOpen.value = { candidate } }
function matchChecked(reference: TrackReference, result: MatchResult): void {
  void reloadPlaybackLibrary()
  if (detail.value?.collection.id !== reference.collectionId) return
  const track = detail.value.tracks.find(item => item.position === reference.position)
  if (track) { track.matchStatus = result.status; track.matchCheckedAt = result.checkedAt;void reloadOpenDetail() }
}
function toggleQueue(): void { versionOpen.value = null; queueOpen.value = !queueOpen.value }
function matchLabel(status: string | undefined): string { return status === 'candidate_matched' ? '候选已匹配' : status === 'needs_review' ? '需要对照版本' : status === 'not_found' ? '未找到候选' : '未检查' }
async function showNotices(): Promise<void> {
  noticesBusy.value = true
  try {
    const result = await window.suMusic.getNotices()
    if (result.ok) { notices.value = result.value; await nextTick(); noticesDialog.value?.showModal() }
    else error.value = result.error.message
  } finally { noticesBusy.value = false }
}
function count(kind: string): number { return kind === 'all' ? myCollections.value.length : myCollections.value.filter(item => item.kind === kind).length }
function kindLabel(item: Collection): string { return item.kind === 'default' ? '默认歌单' : item.kind === 'created' ? '自建歌单' : item.kind === 'shared' ? '分享导入' : item.subtype === 'album' ? '收藏 · 专辑' : '收藏歌单' }
function duration(value: number | null): string { return value === null ? '—' : Math.floor(value / 60000) + ':' + String(Math.floor(value / 1000) % 60).padStart(2, '0') }
function keyboard(event: KeyboardEvent): void {
  if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); void navigate('search') }
  if (event.key === 'Escape') { queueOpen.value = false; versionOpen.value = null }
  const target=event.target as HTMLElement|null
  if(event.code==='Space'&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!target?.isContentEditable&&!['INPUT','TEXTAREA','SELECT','BUTTON','SUMMARY'].includes(target?.tagName??'')&&!noticesDialog.value?.open){event.preventDefault();void command({type:'control',action:player.value?.desiredPlaying?'pause':'resume'})}
}
onMounted(async () => {
  window.addEventListener('keydown', keyboard)
  try {
    unsubscribe = window.suMusic.onStateChanged(applyState)
    unsubscribePlayer=window.suMusic.onPlayerChanged(applyPlayer)
    const result = await window.suMusic.getState()
    if (result.ok) { applyState(result.value); document.body.dataset.ready = 'true' }
    else error.value = result.error.message
    const initial=await window.suMusic.getPlayer();if(initial.ok)applyPlayer(initial.value)
  } catch { error.value = '本机资料未能连接，请重新启动应用。' }
})
onBeforeUnmount(() => { unsubscribe?.();unsubscribePlayer?.(); window.removeEventListener('keydown', keyboard) })
</script>

<template>
  <div class="app-shell">
    <AudioBridge :player="player" :volume="volume" />
    <header class="titlebar">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span><strong>SU MUSIC</strong><span class="brand-divider" aria-hidden="true">/</span><span class="brand-caption">音乐库</span></div>
      <div class="title-context">{{ titles[page] }}</div>
      <button class="search-shortcut" @click="navigate('search')" aria-keyshortcuts="Control+K"><Icon name="search" /><span>歌曲搜索</span><kbd>Ctrl K</kbd></button>
      <button class="icon-button theme-shortcut" :aria-label="state?.effectiveTheme === 'day' ? '切换到黑夜模式' : '切换到白天模式'" @click="patchPreferences({ theme: state?.effectiveTheme === 'day' ? 'night' : 'day' })"><Icon :name="state?.effectiveTheme === 'day' ? 'night' : 'day'" /></button>
      <span class="window-controls-space" aria-hidden="true"></span>
    </header>
    <aside class="sidebar" aria-label="主导航">
      <div class="nav-caption">音乐与收藏 <span>01—05</span></div>
      <nav>
        <button v-for="item in navigation" :key="item.page" class="nav-item" :class="{ active: page === item.page }" :aria-current="page === item.page ? 'page' : undefined" :data-nav="item.page" @click="navigate(item.page)"><Icon :name="item.icon" /><span>{{ item.label }}</span><span v-if="item.page === 'library'" class="nav-count">{{ myCollections.length }}</span></button>
      </nav>
      <div class="pinned-heading"><span>常用歌单</span><span class="small-rule" aria-hidden="true"></span></div>
      <div class="pinned-list"><button v-for="item in pinned" :key="item.id" class="pinned-item" @click="openCollection(item)"><span class="pin-marker" aria-hidden="true"></span><span>{{ item.name }}</span></button><p v-if="!pinned.length" class="empty-pins">暂无置顶歌单</p></div>
      <div class="sidebar-bottom"><div class="account-state"><span class="neutral-dot" aria-hidden="true"></span><span>{{ state?.account?.phase==='authenticated' ? '酷狗已连接' : state?.account?.cachedAccount ? '酷狗 · 本地缓存' : '酷狗尚未连接' }}</span></div><button class="nav-item" :class="{ active: page === 'settings' }" :aria-current="page === 'settings' ? 'page' : undefined" data-nav="settings" @click="navigate('settings')"><Icon name="settings" /><span>账号与设置</span></button></div>
    </aside>

    <main ref="contentElement" class="content" :class="{ 'with-queue': queueOpen, 'with-version': Boolean(versionOpen) }">
      <div v-if="error" class="error-banner" role="alert"><span>{{ error }}</span><button class="icon-button" aria-label="关闭提示" @click="error = ''"><Icon name="close" /></button></div>
      <div v-if="player?.reason&&['needs_review','error','waiting_retry','resolving'].includes(player.phase)" class="playback-banner" role="status"><p>{{ player.reason }}</p><div class="playback-actions"><button v-if="currentReference" class="button" @click="inspectOriginal(currentReference)">选择版本或本地文件</button><button v-if="['error','needs_review'].includes(player.phase)" class="button" @click="command({type:'retry'})">重试播放</button><button class="button" @click="toggleQueue">查看队列</button></div></div>
      <div v-if="!state && !error" class="loading-copy" role="status">正在读取本机资料…</div>

      <section v-if="page === 'library' && !detail" class="page library-page">
        <div class="page-heading"><div><p class="eyebrow">LOCAL COLLECTIONS / 01</p><h1>我的歌单</h1><p class="page-description">收藏、整理，再回到熟悉的音乐。</p></div><div class="library-totals"><span>{{ myCollections.length }} 个歌单</span><span>{{ state?.library.positionCount || 0 }} 个曲目位置</span></div></div>
        <p v-if="state?.account && ['reading_directory','reading_tracks','checking_directory'].includes(state.account.sync.phase)" class="source-note" role="status">正在同步酷狗歌单：{{ state.account.sync.completedCollections }} / {{ state.account.sync.totalCollections }}。同步期间可继续浏览缓存。</p>
        <p v-if="state?.account?.sync.error" class="inline-warning">{{ state.account.sync.error }}</p>
        <ShareImport @imported="importedCollection" />
        <div class="library-toolbar"><div class="category-tabs" aria-label="歌单分类"><button v-for="tab in tabs" :key="tab.kind" :aria-pressed="category === tab.kind" @click="category = tab.kind"><span>{{ tab.label }}</span><span class="tab-count">{{ count(tab.kind) }}</span></button></div><div class="view-switch" aria-label="歌单显示方式"><button class="icon-button" aria-label="网格视图" data-view="grid" :aria-pressed="preferences?.libraryView === 'grid'" @click="patchPreferences({ libraryView: 'grid' })"><Icon name="grid" /></button><button class="icon-button" aria-label="列表视图" data-view="list" :aria-pressed="preferences?.libraryView === 'list'" @click="patchPreferences({ libraryView: 'list' })"><Icon name="list" /></button></div></div>
        <div class="filter-row"><label class="filter-input"><Icon name="search" /><input v-model="nameFilter" maxlength="100" aria-label="筛选歌单名称" placeholder="筛选歌单名称" /><button v-if="nameFilter" class="icon-button" aria-label="清空歌单筛选" @click="nameFilter = ''"><Icon name="close" /></button></label><label class="sort-select"><span>排序</span><select aria-label="歌单排序" :value="preferences?.librarySort || 'recent'" @change="patchPreferences({ librarySort: ($event.target as HTMLSelectElement).value as Preferences['librarySort'] })"><option value="recent">最近打开</option><option value="name">歌单名称</option><option value="count">歌曲数量</option></select><Icon name="chevron" /></label></div>
        <div v-if="visibleCollections.length" class="collection-grid" :class="{ 'collection-list': preferences?.libraryView === 'list' }" data-collections>
          <CollectionCard v-for="item in visibleCollections" :key="item.id" :collection="item" :view="preferences?.libraryView || 'grid'" :meta="item.positionCount + ' 首 · 酷狗 · ' + kindLabel(item)" @open="openCollection" />
        </div>
        <div v-else-if="!shares.length || myCollections.length" class="empty-stage"><div class="empty-art" aria-hidden="true"><span class="art-rail"></span><Icon name="library" /><span class="art-coordinate">COLLECTION / 00</span></div><h2>{{ myCollections.length ? '没有符合条件的歌单' : '你的歌单，从这里开始' }}</h2><p>{{ myCollections.length ? '换一个名称，或切换歌单分类。' : '连接酷狗后，默认收藏、我喜欢、自建与收藏歌单会显示在这里。' }}</p><button v-if="myCollections.length" class="button" @click="nameFilter = ''; category = 'all'">清空筛选</button><button v-else class="button primary" @click="navigate('settings')">查看账号设置<Icon name="arrow" /></button></div>
        <section v-if="shares.length" class="shared-section">
          <h2>分享导入 <span>{{ shares.length }}</span></h2>
          <div class="collection-grid" :class="{ 'collection-list': preferences?.libraryView === 'list' }" data-shared-list>
            <CollectionCard v-for="item in shares" :key="item.id" :collection="item" :view="preferences?.libraryView || 'grid'" :meta="item.positionCount + ' 首 · 酷狗 · 分享导入'" data-shared-item @open="openCollection" />
          </div>
        </section>
      </section>

      <section v-else-if="page === 'library' && detail" class="page detail-page">
        <div class="detail-actions"><button class="button back-button" @click="backToLibrary"><Icon name="back" />返回我的歌单</button><button class="button" data-pin-current :aria-pressed="detail.collection.pinned" @click="pinCurrent">{{ detail.collection.pinned ? '取消置顶' : '置顶到侧栏' }}</button></div>
        <div class="detail-heading"><div class="detail-cover" aria-hidden="true"><CollectionArtwork :name="detail.collection.name" :url="detail.collection.coverUrl" :album="detail.collection.subtype==='album'" /></div><div><p class="eyebrow">{{ kindLabel(detail.collection) }}</p><h1>{{ detail.collection.name }}</h1><p class="page-description">{{ detail.tracks.length }} 首 · 酷狗 · 本地资料</p><button class="button primary" :disabled="!detail.tracks.length" data-play-collection @click="command({type:'play_collection',collectionId:detail!.collection.id,position:detail!.tracks[0]!.position,skipUnavailable:true})"><Icon name="play" />播放歌单</button></div></div>
        <div v-if="selectedTrack" class="selected-track-actions"><p>{{ selectedTrack.title??selectedTrack.filename }}<span class="source-note"> · 第 {{ selectedTrack.position }} 首</span></p><div class="playback-actions"><button class="button" @click="playTrack(selectedTrack.position)"><Icon name="play" />播放</button><button class="button" @click="enqueue(selectedTrack.position,'next')">下一首播放</button><button class="button" @click="enqueue(selectedTrack.position,'end')">加入队列</button><button class="button" data-edit-version @click="inspectOriginal({collectionId:detail!.collection.id,position:selectedTrack.position})">{{ selectedTrack.playbackReady?'更换版本':'选择版本' }}</button><button v-if="selectedTrack.playbackChoice==='selected'||selectedTrack.playbackChoice==='local'" class="button" data-restore-row @click="command({type:'restore_original',reference:{collectionId:detail!.collection.id,position:selectedTrack.position}})">恢复原版</button><button class="button" @click="importLocal({collectionId:detail!.collection.id,position:selectedTrack.position})">关联本地文件</button></div><p v-if="selectedTrack.playbackIssue" class="source-note">{{ selectedTrack.playbackIssue }}</p></div>
        <div class="track-table-wrap"><table class="track-table"><thead><tr><th class="position-cell">#</th><th>歌曲 / 歌手</th><th class="album-cell">专辑</th><th class="duration-cell">时长</th><th class="state-cell">操作</th></tr></thead><tbody><tr v-for="track in detail.tracks" :key="track.position" :data-track-position="track.position" :class="{ selected: selectedPosition === track.position,'playing-track':currentReference?.collectionId===detail.collection.id&&currentReference.position===track.position }" tabindex="0" @click="selectedPosition = track.position" @dblclick="trackDouble($event,track.position)" @keydown.enter="trackKey($event,track.position)"><td class="position-cell"><span>{{ String(track.position).padStart(2, '0') }}</span><button class="icon-button row-play" :aria-label="'播放 '+(track.title??track.filename)" :data-play-position="track.position" @click.stop="playTrack(track.position)"><Icon name="play" /></button></td><td><p class="track-name">{{ track.title || track.filename || '标题待补充' }}<span v-if="track.version" class="version-label">{{ track.version }}</span><span v-if="track.playbackChoice==='selected'||track.playbackChoice==='local'" class="choice-label">{{ track.playbackChoice==='local'?'本地版本':'已选版本' }}</span></p><p class="track-artist">{{ track.artist || (track.playbackChoice==='local'?'本地音频':'歌手信息缺失') }}<span v-if="!track.playbackReady" class="track-match-note"> · {{ matchLabel(track.matchStatus) }}</span></p></td><td class="album-cell">{{ track.album || '—' }}</td><td class="duration-cell">{{ duration(track.durationMs) }}</td><td class="state-cell"><TrackActions :track="track" @play="playTrack" @next="position=>enqueue(position,'next')" @version="position=>inspectOriginal({collectionId:detail!.collection.id,position})" /></td></tr></tbody></table></div>
        <div v-if="!detail.tracks.length" class="empty-inline">这张歌单还没有曲目。</div><p class="table-footnote">每个曲目位置独立保留，包括重复歌曲。</p>
      </section>

      <section v-else-if="page === 'search'" class="page search-page"><div class="page-heading"><div><p class="eyebrow">MUSIC SEARCH</p><h1>歌曲搜索</h1><p class="page-description">在曲库与在线音源中查找音乐，对照你想听的版本。</p></div></div><SourceSearch :library-revision="player?.historyRevision??0" @original="inspectOriginal" @candidate="inspectCandidate" @play="target=>command({type:'play',target})" @next="target=>command({type:'enqueue',target,placement:'next'})" /></section>

      <section v-else-if="page === 'settings'" class="page settings-page">
        <div class="page-heading"><div><p class="eyebrow">PREFERENCES</p><h1>账号与设置</h1><p class="page-description">让音乐库符合你的使用习惯。</p></div></div>
        <AccountPanel :state="state?.account" @changed="applyState" /><section class="settings-group"><h2>本机保护</h2><div class="setting-row"><div><h3>本机凭据保护</h3><p>账号凭据由 Windows 加密，保存在本机。</p></div><span class="protection-state"><Icon name="shield" />{{ state?.security.credentialProtectionAvailable ? '加密可用' : '保护暂不可用' }}</span></div></section>
        <section class="settings-group"><h2>在线音源</h2><div class="setting-row"><div><h3>GD 音乐台 · 网易云</h3><p>GD音乐台(music.gdstudio.xyz) 提供在线搜索与资源解析。</p><p>候选匹配和资源读取分别检查，曲目版本差异会保留。</p></div><span class="status-label">已接入</span></div></section>
        <CacheSettings :cache="playbackLibrary?.cache??null" @changed="cacheChanged" />
        <section class="settings-group"><h2>外观与显示</h2><div class="setting-row"><div><h3>界面外观</h3><p>昼夜使用同一布局，选择会在下次启动时恢复。</p></div><div class="segmented"><button v-for="item in ([['system', '跟随系统'], ['day', '白天'], ['night', '黑夜']] as const)" :key="item[0]" :data-theme-choice="item[0]" :aria-pressed="preferences?.theme === item[0]" @click="patchPreferences({ theme: item[0] })">{{ item[1] }}</button></div></div><div class="setting-row"><div><h3>歌曲列表密度</h3><p>调整行距，保留曲名和版本信息。</p></div><div class="segmented"><button data-density="comfortable" :aria-pressed="preferences?.density === 'comfortable'" @click="patchPreferences({ density: 'comfortable' })">舒适</button><button data-density="compact" :aria-pressed="preferences?.density === 'compact'" @click="patchPreferences({ density: 'compact' })">紧凑</button></div></div><div class="setting-row"><div><h3>歌单默认视图</h3><p>网格突出封面，列表便于浏览较多歌单。</p></div><div class="segmented"><button :aria-pressed="preferences?.libraryView === 'grid'" @click="patchPreferences({ libraryView: 'grid' })">网格</button><button :aria-pressed="preferences?.libraryView === 'list'" @click="patchPreferences({ libraryView: 'list' })">列表</button></div></div></section>
        <section class="settings-group about-group"><h2>关于</h2><div class="setting-row"><div><h3>Su Music <span class="version-number">{{ state?.app.version }}</span></h3><p>独立音乐库 · Windows 开发版</p></div><button class="button" :disabled="noticesBusy" data-notices @click="showNotices">查看开源许可<Icon name="arrow" /></button></div><details class="runtime-details"><summary>运行环境</summary><dl><div><dt>Electron</dt><dd>{{ state?.environment.electron }}</dd></div><div><dt>Node.js</dt><dd>{{ state?.environment.node }}</dd></div><div><dt>SQLite</dt><dd>{{ state?.environment.sqlite }}</dd></div></dl></details></section>
      </section>

      <PlaybackPages v-else :page="page" :player="player" :library="playbackLibrary" :app="state" @command="command" @inspect="inspectOriginal" @collection="openSourceCollection" @import-local="importLocal()" @remove-local="removeLocal" @play-history="playHistory" @clear-history="clearHistory" @back="navigate(previousPage,true)" />
    </main>

    <VersionPanel v-if="versionOpen" :reference="versionOpen.reference" :candidate="versionOpen.candidate" :locals="playbackLibrary?.local??[]" @close="versionOpen = null" @checked="matchChecked" @acted="versionActed" />
    <QueuePanel v-if="queueOpen" :player="player" @close="queueOpen=false" @command="command" />
    <PlayerBar :player="player" :volume="volume" :queue-open="queueOpen" @command="command" @volume="volume=$event" @save-volume="patchPreferences({volume:$event})" @now="navigate('now')" @queue="toggleQueue" />
    <div class="statusbar"><span><span class="status-tick" aria-hidden="true"></span>{{ state ? '本机资料已就绪' : '正在连接本机资料' }}<span v-if="state?.app.testProfile" class="test-label">布局测试资料</span></span><span class="status-meta">{{ state?.effectiveTheme === 'day' ? 'DAY / 白天' : 'NIGHT / 黑夜' }}<span class="status-separator" aria-hidden="true">/</span>开发版</span></div>
    <dialog ref="noticesDialog" class="notices-dialog" aria-labelledby="notices-title"><header><div><p class="eyebrow">OPEN SOURCE</p><h2 id="notices-title">开源许可</h2></div><button class="icon-button" autofocus aria-label="关闭开源许可" @click="noticesDialog?.close()"><Icon name="close" /></button></header><pre>{{ notices }}</pre></dialog>
  </div>
</template>
