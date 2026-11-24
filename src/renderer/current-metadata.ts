import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { Ref } from 'vue'
import type { PlayerState } from '../shared/playback.ts'
import type { CurrentTrackMetadata } from '../shared/metadata.ts'
import { currentMetadataIdentity } from '../shared/metadata.ts'

export function useCurrentMetadata(player: Ref<PlayerState | null>, account: () => string) {
  const metadata = shallowRef<CurrentTrackMetadata | null>(null), busy = ref(false)
  let generation = 0
  async function reload(): Promise<void> {
    const id = player.value?.currentId, identity = currentMetadataIdentity(player.value), owner = account(), serial = ++generation
    if (!id || !identity) { metadata.value = null; busy.value = false; return }
    busy.value = true
    try {
      const result = await window.suMusic.getCurrentTrackMetadata(id)
      if (serial !== generation || identity !== currentMetadataIdentity(player.value) || owner !== account()) return
      if (result.ok) metadata.value = result.value?.identity === identity ? result.value : null
      else throw new Error('METADATA_UNAVAILABLE')
    } catch {
      if (serial === generation && identity === currentMetadataIdentity(player.value) && owner === account()) metadata.value = {
        currentId: id, identity, artworkUrl: metadata.value?.identity === identity ? metadata.value.artworkUrl : null,
        lyrics: { state: 'error', lines: [], text: null, reason: '暂未获取到歌词，请稍后重试。', retryAt: null }
      }
    } finally { if (serial === generation) busy.value = false }
  }
  watch([() => currentMetadataIdentity(player.value), account], () => { metadata.value = null; void reload() }, { immediate: true })
  onBeforeUnmount(() => { generation++ })
  return { metadata, metadataBusy: busy, reloadMetadata: reload }
}
