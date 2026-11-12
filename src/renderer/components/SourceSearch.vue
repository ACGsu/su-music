<script setup lang="ts">
import { ref,watch } from 'vue'
import type { LibrarySearchItem, OnlineSearchResult, SourceCandidate, TrackReference } from '../../shared/music.ts'
import { GD_ATTRIBUTION } from '../../shared/music.ts'
import Icon from './Icon.vue'
import type {PlaybackTarget} from '../../shared/playback.ts'
const props=defineProps<{libraryRevision?:number}>()
const emit = defineEmits<{ original: [reference: TrackReference]; candidate: [candidate: SourceCandidate];play:[target:PlaybackTarget];next:[target:PlaybackTarget] }>()
const scope = ref<'library' | 'online'>('library'), query = ref(''), busy = ref(false), error = ref(''), searched = ref(false)
const local = ref<LibrarySearchItem[]>([]), online = ref<OnlineSearchResult | null>(null)
let generation = 0
function changeScope(value: 'library' | 'online'): void { generation++; scope.value = value; searched.value = false; error.value = ''; busy.value = false }
async function search(force = false): Promise<void> {
  if (busy.value || !query.value.trim()) return
  const current = ++generation, currentScope = scope.value
  busy.value = true; error.value = ''
  try {
    if (currentScope === 'library') {
      const result = await window.suMusic.searchLibrary(query.value)
      if (current !== generation) return
      if (result.ok) local.value = result.value; else error.value = result.error.message
    } else {
      const result = await window.suMusic.searchOnline(query.value, force)
      if (current !== generation) return
      if (result.ok) online.value = result.value; else error.value = result.error.message
    }
    searched.value = true
  } catch { if (current === generation) error.value = '搜索未能完成，请稍后重试。' }
  finally { if (current === generation) busy.value = false }
}
function duration(value: number | null): string { return value === null ? '时长待补充' : Math.floor(value / 60000) + ':' + String(Math.floor(value / 1000) % 60).padStart(2, '0') }
watch(()=>props.libraryRevision,()=>{if(scope.value==='library'&&searched.value&&!busy.value)void search()})
</script>
<template>
  <div class="source-search">
    <div class="search-scope segmented"><button :aria-pressed="scope === 'library'" data-search-scope="library" @click="changeScope('library')">我的曲库</button><button :aria-pressed="scope === 'online'" data-search-scope="online" @click="changeScope('online')">在线搜索</button></div>
    <form class="song-search-form" @submit.prevent="search(false)"><input v-model="query" maxlength="200" :placeholder="scope === 'library' ? '搜索已导入的歌曲、歌手或专辑' : '输入歌名或歌手，按回车搜索'" aria-label="歌曲搜索关键词" data-song-query /><button class="button primary" :disabled="busy || !query.trim()" data-song-search>{{ busy ? '正在搜索…' : '搜索' }}</button><button v-if="scope === 'online' && searched" class="button" :disabled="busy || !query.trim()" @click="search(true)">重新查询</button></form>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
    <p v-else-if="busy" class="source-note" role="status">正在查找并补全候选资料…</p>
    <p v-if="scope === 'online'" class="source-note">{{ GD_ATTRIBUTION }} · 网易云音源。搜索结果可继续对照版本和检查资源。</p>
    <p v-if="scope === 'online' && online && searched" class="source-note">{{ online.fromCache ? '显示已缓存的搜索记录。' : '已更新搜索记录。' }} {{ online.metadataWarning || '' }}</p>
    <div v-if="scope === 'library' && searched && !error" class="search-results">
      <article v-for="item in local" :key="item.reference.collectionId + ':' + item.reference.position" class="song-result"><div><h3><button class="song-title-action" title="查看或更换版本" @click="emit('original',item.reference)">{{ item.track.title || item.track.filename || '标题待补充' }}</button><span v-if="item.track.playbackChoice==='selected'||item.track.playbackChoice==='local'" class="choice-label">{{ item.track.playbackChoice==='local'?'本地版本':'已选版本' }}</span></h3><p>{{ item.track.artist || '歌手资料缺失' }} · {{ duration(item.track.durationMs) }}</p><p class="source-note">{{ item.collectionName }} · 第 {{ item.reference.position }} 首</p></div><div class="playback-actions"><button class="button" @click="emit('play',{kind:'original',reference:item.reference})"><Icon name="play" />播放</button><button v-if="item.track.playbackReady" class="button" @click="emit('next',{kind:'original',reference:item.reference})"><Icon name="queue" />下一首播放</button><button v-else class="button" @click="emit('original', item.reference)">版本对照</button></div></article>
      <p v-if="!local.length" class="empty-inline">没有找到符合条件的曲目。</p><p v-if="local.length === 100" class="source-note">显示前 100 个曲目位置，可补充关键词缩小范围。</p>
    </div>
    <div v-if="scope === 'online' && online && searched && !error" class="search-results">
      <article v-for="item in online.candidates" :key="item.trackId" class="song-result" data-online-result><div><h3>{{ item.title }}</h3><p>{{ item.artists.join('、') || '歌手资料缺失' }} · {{ duration(item.durationMs) }}</p><p class="source-note">{{ item.album || '专辑资料缺失' }}<span v-if="!item.metadataComplete"> · 资料待核对</span></p></div><div class="playback-actions"><button class="button" @click="emit('play',{kind:'candidate',candidate:{providerId:item.providerId,sourceId:item.sourceId,trackId:item.trackId}})"><Icon name="play" />播放</button><button class="button" @click="emit('candidate', item)">查看候选</button></div></article><p v-if="!online.candidates.length" class="empty-inline">没有找到相关候选。</p>
    </div>
    <p v-if="!searched && !busy" class="empty-inline">输入关键词后提交搜索。曲库中的重复歌曲按各自位置保留。</p>
  </div>
</template>
