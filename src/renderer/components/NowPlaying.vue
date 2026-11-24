<script setup lang="ts">
import { computed } from 'vue'
import type { AppState } from '../../shared/contracts.ts'
import type { PlayerState } from '../../shared/playback.ts'
import type { TrackReference } from '../../shared/music.ts'
import type { CurrentTrackMetadata } from '../../shared/metadata.ts'
import { currentMetadataIdentity } from '../../shared/metadata.ts'
import { bindingText, phaseText, playTime, qualityText } from '../playback-ui.ts'
import Icon from './Icon.vue'
import TrackArtwork from './TrackArtwork.vue'
import LyricsView from './LyricsView.vue'

const props = defineProps<{ player: PlayerState | null; app: AppState | null; metadata: CurrentTrackMetadata | null; metadataBusy: boolean; queueOpen: boolean }>()
const emit = defineEmits<{ back: []; inspect: [reference: TrackReference]; collection: [id: string]; retryMetadata: [] }>()
const identity = computed(() => currentMetadataIdentity(props.player))
const queuedTitle = computed(() => props.player?.queue.find(item => item.id === props.player?.currentId)?.title ?? '')
const canOpenCollection = computed(() => props.player?.now?.reference && props.app?.library.collections.some(item => item.id === props.player!.now!.reference!.collectionId))
</script>

<template>
  <section class="page now-page" :class="{ 'queue-expanded': queueOpen }" data-now-page>
    <div class="now-toolbar"><button class="button back-button" data-now-back @click="emit('back')"><Icon name="back" />返回浏览</button><span class="eyebrow">NOW PLAYING</span></div>
    <div v-if="player?.now" class="now-body" data-now-playing>
      <div v-show="!queueOpen" class="now-cover-stage" data-now-cover-stage>
        <TrackArtwork class="now-artwork" :url="metadata?.artworkUrl" />
      </div>
      <div class="now-lyrics-stage">
        <header class="now-song-info">
          <p class="eyebrow">{{ phaseText(player.phase) }}</p>
          <h1 :title="player.now.title">{{ player.now.title }}</h1>
          <p class="now-artist" :title="player.now.artist ?? ''">{{ player.now.artist ?? (player.now.localId ? '本地音频' : '歌手资料待补充') }}</p>
          <p class="now-source" :title="[player.now.album, player.now.source].filter(Boolean).join(' · ')">{{ player.now.album ?? player.now.source }} · {{ qualityText(player.now) }} · {{ playTime(player.durationMs ?? player.now.expectedDurationMs) }}</p>
          <div class="now-track-options">
            <span v-if="['alternative', 'local'].includes(player.now.binding)" class="now-binding">{{ bindingText(player.now) }}</span>
            <button v-if="player.now.reference" class="button" @click="emit('inspect', player.now.reference)">对照收藏版本</button>
            <button v-if="canOpenCollection && player.now.reference" class="button" @click="emit('collection', player.now.reference.collectionId)">回到来源歌单</button>
          </div>
          <p v-if="player.reason" class="inline-warning">{{ player.reason }}</p>
        </header>
        <LyricsView :lyrics="metadata?.lyrics ?? null" :position-ms="player.positionMs" :seek-serial="player.seekSerial" :identity="identity" :busy="metadataBusy" @retry="emit('retryMetadata')" />
      </div>
    </div>
    <div v-else class="empty-stage now-empty"><div class="empty-art"><Icon name="disc" /></div><template v-if="player?.currentId"><h2>{{ ['resolving', 'loading', 'waiting_retry'].includes(player.phase) ? '正在准备播放…' : phaseText(player.phase) }}</h2><p>{{ player.reason ?? queuedTitle }}</p></template><template v-else><h2>还没有正在播放的音乐</h2><p>在歌单中双击曲目，或添加本地音乐开始播放。</p></template></div>
  </section>
</template>
