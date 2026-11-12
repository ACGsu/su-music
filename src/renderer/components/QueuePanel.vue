<script setup lang="ts">
import Icon from './Icon.vue'
import type {PlayerCommand,PlayerState} from '../../shared/playback.ts'
const props=defineProps<{player:PlayerState|null}>()
const emit=defineEmits<{close:[];command:[command:PlayerCommand]}>()
</script>
<template>
  <aside class="queue-panel" aria-label="播放队列" data-queue-panel>
    <div class="queue-heading"><div><p class="eyebrow">UP NEXT</p><h2>播放队列 <span>{{ props.player?.queue.length??0 }}</span></h2></div><button class="icon-button" aria-label="关闭播放队列" @click="emit('close')"><Icon name="close" /></button></div>
    <ol v-if="player?.queue.length" class="queue-list"><li v-for="(item,index) in player.queue" :key="item.id" :class="{'queue-current':item.id===player.currentId}" :data-queue-id="item.id"><button class="queue-song" :aria-label="'播放 '+item.title" @click="emit('command',{type:'queue_jump',id:item.id})"><span class="queue-index">{{ String(index+1).padStart(2,'0') }}</span><span><strong>{{ item.title }}</strong><small>{{ item.artist??'本地音乐' }}<span v-if="item.collectionName"> · {{ item.collectionName }}</span></small><small v-if="item.id===player.currentId&&player.now?.binding==='alternative'">实际播放：{{ player.now.title }}</small></span></button><div class="queue-actions"><button class="icon-button" :disabled="index===0" aria-label="上移此曲目" @click="emit('command',{type:'queue_move',id:item.id,index:index-1})"><Icon name="up" /></button><button class="icon-button" :disabled="index===player.queue.length-1" aria-label="下移此曲目" @click="emit('command',{type:'queue_move',id:item.id,index:index+1})"><Icon name="down" /></button><button class="icon-button" aria-label="从队列移除此曲目" @click="emit('command',{type:'queue_remove',id:item.id})"><Icon name="close" /></button></div></li></ol>
    <div v-else class="queue-empty"><Icon name="queue" /><h3>队列还是空的</h3><p>在歌曲操作中选择“下一首播放”或“加入队列”。</p></div>
    <details v-if="player?.skipped.length" class="queue-failures"><summary>未能播放 {{ player.skipped.length }} 首</summary><p v-for="(item,index) in player.skipped" :key="item.queueId+':'+index"><strong>{{ item.title }}</strong><br />{{ item.reason }}</p></details>
  </aside>
</template>
