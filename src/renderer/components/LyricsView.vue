<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TrackLyrics } from '../../shared/metadata.ts'
import { activeLyricIndex } from '../../shared/metadata.ts'
import Icon from './Icon.vue'

const props = defineProps<{ lyrics: TrackLyrics | null; positionMs: number; seekSerial: number; identity: string; busy: boolean }>()
const emit = defineEmits<{ retry: [] }>()
const scroll = ref<HTMLElement | null>(null), following = ref(true)
const space = ref(160)
const active = computed(() => activeLyricIndex(props.lyrics?.lines ?? [], props.positionMs))
let resize: ResizeObserver | null = null, frame = 0, disposed = false
async function center(smooth = false): Promise<void> {
  await nextTick()
  if (disposed || !following.value || !scroll.value || props.lyrics?.state !== 'timed') return
  const element = scroll.value, row = element.querySelector<HTMLElement>('[data-lyric-index="' + Math.max(0, active.value) + '"]')
  if (!row) return
  const top = element.scrollTop + row.getBoundingClientRect().top - element.getBoundingClientRect().top + row.offsetHeight / 2 - element.clientHeight / 2
  element.scrollTo({ top: Math.max(0, top), behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' })
}
function pauseFollowing(): void {
  if (props.lyrics?.state !== 'timed' || !following.value) return
  following.value = false
  const element = scroll.value
  if (element) element.scrollTo({ top: element.scrollTop, behavior: 'instant' })
}
function follow(): void { following.value = true; void center() }
function key(event: KeyboardEvent): void {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) { event.stopPropagation(); pauseFollowing() }
}
watch(active, () => { void center(true) })
watch(() => props.lyrics, () => { void center() }, { flush: 'post' })
watch(() => props.identity, () => { following.value = true; void center() })
watch(() => props.seekSerial, follow)
onMounted(() => {
  if (scroll.value) {
    resize = new ResizeObserver(() => {
      space.value = scroll.value!.clientHeight / 2
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { void center() })
    })
    resize.observe(scroll.value)
  }
  void center()
})
onBeforeUnmount(() => { disposed = true; resize?.disconnect(); cancelAnimationFrame(frame) })
</script>

<template>
  <div class="lyrics-panel" data-lyrics-panel>
    <div ref="scroll" class="lyrics-scroll" role="region" aria-label="歌曲歌词" tabindex="0" data-lyrics-scroll @wheel.passive="pauseFollowing" @pointerdown="pauseFollowing" @touchmove.passive="pauseFollowing" @keydown="key">
      <div v-if="lyrics?.state === 'timed'" class="lyrics-lines" :style="{ '--lyrics-space': space + 'px' }">
        <div v-for="(line, index) in lyrics.lines" :key="line.timeMs + ':' + index" class="lyric-line" :class="{ active: index === active, past: index < active }" :aria-current="index === active ? 'true' : undefined" :data-lyric-index="index" :data-lyric-time="line.timeMs" :data-lyric-active="index === active ? 'true' : undefined">
          <p class="lyric-original">{{ line.text }}</p>
          <p v-if="line.translation" class="lyric-translation">{{ line.translation }}</p>
        </div>
      </div>
      <div v-else-if="lyrics?.state === 'plain'" class="lyrics-plain">{{ lyrics.text }}</div>
      <div v-else class="lyrics-empty" role="status">
        <Icon name="disc" />
        <p v-if="busy">正在获取歌词…</p>
        <p v-else-if="lyrics?.state === 'instrumental'">纯音乐，请欣赏</p>
        <template v-else><p>{{ lyrics?.reason ?? '这首歌曲暂无歌词' }}</p><button v-if="lyrics?.state === 'error'" class="button" data-lyrics-retry @click="emit('retry')">重新获取歌词</button></template>
      </div>
    </div>
    <button v-if="lyrics?.state === 'timed' && !following" class="button lyrics-follow" data-lyrics-follow @click="follow"><Icon name="locate" />回到当前歌词</button>
  </div>
</template>
