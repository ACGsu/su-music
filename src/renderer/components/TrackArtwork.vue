<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { observeArtwork } from '../artwork-observer.ts'
import Icon from './Icon.vue'

const props = defineProps<{ collectionId?: string; position?: number; url?: string | null; revision?: number }>()
const element = ref<HTMLElement | null>(null), fetched = ref<string | null>(null), failed = ref(false)
let visible = false, generation = 0, loading = false, attemptedAt = 0, stop = () => {}
const url = computed(() => {
  const value = props.collectionId ? fetched.value : props.url
  return !failed.value && typeof value === 'string' && /^su-music:\/\/app\/artwork\/[a-f0-9]{64}\.jpg$/.test(value) ? value : null
})
async function load(): Promise<void> {
  const collectionId = props.collectionId, position = props.position
  if (!visible || !collectionId || !position || loading || fetched.value && !failed.value || attemptedAt && Date.now() - attemptedAt < 30_000) return
  const serial = generation
  loading = true; attemptedAt = Date.now()
  try {
    const result = await window.suMusic.getTrackArtwork({ collectionId, position })
    if (serial !== generation) return
    fetched.value = result.ok ? result.value?.url ?? null : null
    failed.value = false
  } catch { if (serial === generation) fetched.value = null }
  finally { if (serial === generation) loading = false }
}
watch([() => props.collectionId, () => props.position, () => props.revision], () => {
  generation++; fetched.value = null; failed.value = false; loading = false; attemptedAt = 0
  void load()
})
watch(() => props.url, () => { failed.value = false })
onMounted(() => {
  if (props.collectionId && element.value) stop = observeArtwork(element.value, value => { visible = value; if (value) void load() })
})
onBeforeUnmount(() => { generation++; stop() })
</script>

<template>
  <span ref="element" class="track-artwork" aria-hidden="true" data-track-artwork>
    <img v-if="url" :src="url" alt="" :loading="collectionId ? 'lazy' : 'eager'" decoding="async" data-artwork-image @error="failed = true" />
    <Icon v-else name="disc" />
  </span>
</template>
