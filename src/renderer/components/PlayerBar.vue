<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import Icon from './Icon.vue'
import type {PlayerCommand,PlayerState,PlaybackMode} from '../../shared/playback.ts'
import {bindingText,phaseText,playTime,qualityText} from '../playback-ui.ts'
const props=defineProps<{player:PlayerState|null;volume:number;queueOpen:boolean}>()
const emit=defineEmits<{command:[command:PlayerCommand];volume:[value:number];saveVolume:[value:number];now:[];queue:[]}>()
const seek=ref(0),dragging=ref(false),length=computed(()=>props.player?.durationMs??props.player?.now?.expectedDurationMs??0)
watch(()=>props.player?.positionMs,value=>{if(!dragging.value)seek.value=value??0})
const title=computed(()=>props.player?.now?.title??props.player?.queue.find(item=>item.id===props.player?.currentId)?.title??'未选择歌曲')
const modes:PlaybackMode[]=['sequence','shuffle','repeat_one'],modeNames={sequence:'顺序播放',shuffle:'随机播放',repeat_one:'单曲循环'}
function changeMode():void{emit('command',{type:'mode',mode:modes[(modes.indexOf(props.player?.mode??'sequence')+1)%modes.length]!})}
function commitSeek():void{emit('command',{type:'seek',positionMs:seek.value});dragging.value=false}
</script>
<template>
  <footer class="player">
    <div class="player-track"><button class="player-cover icon-button" aria-label="打开正在播放" data-now @click="emit('now')"><Icon name="disc" /></button><div><p class="player-title" :title="title" data-player-title>{{ title }}</p><p class="player-subtitle" :title="player?.now?.artist??''">{{ player?.now?.artist??phaseText(player?.phase) }}<span v-if="player?.now && player.now.binding!=='direct'"> · {{ bindingText(player.now) }}</span></p></div></div>
    <div class="player-center"><div class="transport"><button class="icon-button" :disabled="!player?.queue.length" aria-label="上一首" data-previous @click="emit('command',{type:'control',action:'previous'})"><Icon name="previous" /></button><button class="play-button" :disabled="!player?.queue.length" :aria-label="player?.desiredPlaying?'暂停':'播放'" data-play-toggle @click="emit('command',{type:'control',action:player?.desiredPlaying?'pause':'resume'})"><Icon :name="player?.desiredPlaying?'pause':'play'" /></button><button class="icon-button" :disabled="!player?.queue.length" aria-label="下一首" data-next @click="emit('command',{type:'control',action:'next'})"><Icon name="next" /></button></div><div class="progress"><span>{{ playTime(dragging?seek:player?.positionMs??0) }}</span><input v-model.number="seek" type="range" min="0" :max="length||1" step="100" class="playback-seek" :disabled="!player?.media||!length" aria-label="播放进度" data-seek @input="dragging=true" @change="commitSeek" /><span>{{ playTime(length||null) }}</span></div></div>
    <div class="player-tools"><div class="player-quality" :title="qualityText(player?.now)" data-player-quality>{{ qualityText(player?.now) }}</div><label class="volume-control"><Icon name="volume" /><input :value="volume" type="range" min="0" max="100" aria-label="音量" data-volume @input="emit('volume',Number(($event.target as HTMLInputElement).value))" @change="emit('saveVolume',Number(($event.target as HTMLInputElement).value))" /><span>{{ volume }}%</span></label><button class="icon-button mode-toggle" :aria-label="modeNames[player?.mode??'sequence']+'，点击切换'" :title="modeNames[player?.mode??'sequence']" data-play-mode @click="changeMode"><Icon :name="player?.mode==='shuffle'?'shuffle':player?.mode==='repeat_one'?'repeat-one':'sequence'" /></button><button class="icon-button queue-toggle" :aria-expanded="queueOpen" aria-label="打开播放队列" data-queue @click="emit('queue')"><Icon name="queue" /></button></div>
  </footer>
</template>
