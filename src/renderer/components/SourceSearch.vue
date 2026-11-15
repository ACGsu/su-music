<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import type { OnlineSearchResult, SourceCandidate, TrackReference } from '../../shared/music.ts'
import { GD_ATTRIBUTION } from '../../shared/music.ts'
import Icon from './Icon.vue'
import type { PlaybackTarget } from '../../shared/playback.ts'

const props = defineProps<{ initialQuery?: string }>()
const emit = defineEmits<{
  original: [reference: TrackReference]
  candidate: [candidate: SourceCandidate]
  play: [target: PlaybackTarget]
  next: [target: PlaybackTarget]
}>()

const query = ref('')
const busy = ref(false)
const loadingMore = ref(false)
const error = ref('')
const searched = ref(false)
const results = ref<SourceCandidate[]>([])
const page = ref(1)
const hasMore = ref(false)
const fromCache = ref(false)
const metadataWarning = ref<string | null>(null)
const seenTrackIds = new Set<string>()
const sentinel = ref<HTMLElement | null>(null)

let generation = 0
let observer: IntersectionObserver | null = null

function duration(value: number | null): string {
  return value === null ? '时长待补充' : Math.floor(value / 60000) + ':' + String(Math.floor(value / 1000) % 60).padStart(2, '0')
}

async function search(force = false): Promise<void> {
  const trimmed = query.value.trim()
  if (!trimmed || busy.value) return
  const current = ++generation
  busy.value = true
  error.value = ''
  page.value = 1
  results.value = []
  seenTrackIds.clear()
  hasMore.value = false

  try {
    const result = await window.suMusic.searchOnline({ query: trimmed, page: 1, pageSize: 20, refresh: force })
    if (current !== generation) return
    if (result.ok) {
      handlePageResults(result.value, true)
      void window.suMusic.addSearchHistory(trimmed)
    } else {
      error.value = result.error.message
    }
    searched.value = true
  } catch {
    if (current === generation) error.value = '搜索未能完成，请稍后重试。'
  } finally {
    if (current === generation) busy.value = false
  }
}

async function loadNextPage(): Promise<void> {
  const trimmed = query.value.trim()
  if (!trimmed || !hasMore.value || busy.value || loadingMore.value) return
  const current = generation
  const nextPage = page.value + 1
  loadingMore.value = true
  error.value = ''

  try {
    const result = await window.suMusic.searchOnline({ query: trimmed, page: nextPage, pageSize: 20, refresh: false })
    if (current !== generation) return
    if (result.ok) {
      page.value = nextPage
      handlePageResults(result.value, false)
    } else {
      error.value = result.error.message
    }
  } catch {
    if (current === generation) error.value = '加载更多失败，请重试。'
  } finally {
    if (current === generation) loadingMore.value = false
  }
}

function handlePageResults(data: OnlineSearchResult, isFirstPage: boolean): void {
  fromCache.value = data.fromCache
  metadataWarning.value = data.metadataWarning

  let newCount = 0
  for (const item of data.candidates) {
    if (!seenTrackIds.has(item.trackId)) {
      seenTrackIds.add(item.trackId)
      results.value.push(item)
      newCount++
    }
  }

  // Stop if less than 20 items in page, or no new candidates added, or hasMore is false
  if (data.candidates.length < 20 || newCount === 0 || !data.hasMore) {
    hasMore.value = false
  } else {
    hasMore.value = true
  }
}

function retry(): void {
  error.value = ''
  if (results.value.length === 0) {
    void search(false)
  } else {
    void loadNextPage()
  }
}

function searchWithQuery(q: string): void {
  query.value = q
  void search(false)
}

defineExpose({ searchWithQuery })

watch(() => props.initialQuery, (newVal) => {
  if (newVal && newVal.trim() && newVal !== query.value) {
    searchWithQuery(newVal.trim())
  }
}, { immediate: true })

onMounted(() => {
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasMore.value && !busy.value && !loadingMore.value && !error.value) {
        void loadNextPage()
      }
    }, { rootMargin: '100px' })

    if (sentinel.value) observer.observe(sentinel.value)
  }
})

onUnmounted(() => {
  if (observer) {
    observer.disconnect()
    observer = null
  }
})

watch(sentinel, (el) => {
  if (observer) {
    observer.disconnect()
    if (el) observer.observe(el)
  }
})
</script>

<template>
  <div class="source-search">
    <form class="song-search-form" @submit.prevent="search(false)">
      <input
        v-model="query"
        maxlength="200"
        placeholder="输入歌名或歌手，按回车搜索"
        aria-label="歌曲搜索关键词"
        data-song-query
      />
      <button class="button primary" :disabled="busy || !query.trim()" data-song-search>
        {{ busy ? '正在搜索…' : '搜索' }}
      </button>
      <button v-if="searched" class="button" :disabled="busy || !query.trim()" @click="search(true)">
        重新查询
      </button>
    </form>

    <p v-if="error && !results.length" class="inline-warning" role="alert">{{ error }}</p>
    <p v-else-if="busy" class="source-note" role="status">正在查找并补全候选资料…</p>
    <p class="source-note">{{ GD_ATTRIBUTION }} · 网易云音源。搜索结果可继续对照版本和检查资源。</p>
    <p v-if="searched && !busy" class="source-note">
      {{ fromCache ? '显示已缓存的搜索记录。' : '已更新搜索记录。' }} {{ metadataWarning || '' }}
    </p>

    <div v-if="searched && results.length" class="search-results">
      <article
        v-for="item in results"
        :key="item.trackId"
        class="song-result"
        data-online-result
      >
        <div>
          <h3>{{ item.title }}</h3>
          <p>{{ item.artists.join('、') || '歌手资料缺失' }} · {{ duration(item.durationMs) }}</p>
          <p class="source-note">
            {{ item.album || '专辑资料缺失' }}
            <span v-if="!item.metadataComplete"> · 资料待核对</span>
          </p>
        </div>
        <div class="playback-actions">
          <button class="button" @click="emit('play', { kind: 'candidate', candidate: { providerId: item.providerId, sourceId: item.sourceId, trackId: item.trackId } })">
            <Icon name="play" />播放
          </button>
          <button class="button" @click="emit('candidate', item)">查看候选</button>
        </div>
      </article>

      <div v-if="error" class="search-retry">
        <p class="inline-warning" role="alert">{{ error }}</p>
        <button class="button primary search-retry-button" @click="retry">重新加载</button>
      </div>

      <div v-else-if="hasMore" ref="sentinel" class="search-sentinel">
        {{ loadingMore ? '正在加载更多…' : '滑动加载更多' }}
      </div>
      <p v-else class="source-note search-sentinel">已加载全部相关结果（共 {{ results.length }} 首）</p>
    </div>

    <p v-else-if="searched && !results.length && !busy && !error" class="empty-inline">
      没有找到相关候选。
    </p>

    <p v-if="!searched && !busy" class="empty-inline">
      输入关键词后提交搜索，每页 20 首。
    </p>
  </div>
</template>
