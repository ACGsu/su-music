<script setup lang="ts">
import Icon from './Icon.vue'
import type {Track} from '../../shared/contracts.ts'
defineProps<{track:Track}>()
const emit=defineEmits<{play:[position:number];next:[position:number];version:[position:number]}>()
</script>
<template>
  <div v-if="track.playbackReady" class="track-row-actions" data-track-ready>
    <button class="icon-button" :aria-label="'播放 '+(track.title??track.filename??'歌曲')" title="播放" :data-row-play="track.position" @click.stop="emit('play',track.position)"><Icon name="play" /></button>
    <button class="icon-button" :aria-label="'下一首播放 '+(track.title??track.filename??'歌曲')" title="下一首播放" :data-row-next="track.position" @click.stop="emit('next',track.position)"><Icon name="queue" /></button>
  </div>
  <button v-else class="button track-version-button" :data-match-position="track.position" @click.stop="emit('version',track.position)">版本对照</button>
</template>
