<script setup lang="ts">
import {ref} from 'vue'
import Icon from './Icon.vue'
import type {AudioCacheState} from '../../shared/playback.ts'
defineProps<{cache:AudioCacheState|null}>()
const emit=defineEmits<{changed:[state:AudioCacheState]}>()
const busy=ref(false),message=ref(''),error=ref('')
async function change(action:'choose'|'reset'|'clear'):Promise<void>{
  busy.value=true;error.value='';message.value=''
  try{
    const result=await(action==='choose'?window.suMusic.chooseCacheDirectory():action==='reset'?window.suMusic.resetCacheDirectory():window.suMusic.clearAudioCache())
    if(result.ok){emit('changed',result.value);message.value=action==='clear'?'歌曲缓存已清理。':'后续歌曲使用此目录，正在播放的歌曲继续播放。'}else error.value=result.error.message
  }catch{error.value='缓存设置未能完成，请重试。'}finally{busy.value=false}
}
function size(bytes:number):string{return(bytes/1024/1024).toFixed(1)+' MB'}
</script>
<template>
  <section class="settings-group cache-settings"><h2>歌曲缓存</h2><div class="setting-row cache-location"><div><h3>缓存存放位置</h3><p>可选择任意可写目录。缓存放在应用专用子目录中。</p><p class="cache-path" data-cache-directory>{{ cache?.directory??'正在读取…' }}</p><p>{{ cache?.usingDefault?'当前使用默认目录':'当前使用自选目录' }} · {{ cache?.tracks??0 }} 首完整下载缓存 · {{ size(cache?.bytes??0) }}</p></div><button class="button" :disabled="busy" data-cache-choose @click="change('choose')">选择目录<Icon name="folder" /></button></div><div class="cache-actions"><button class="button" :disabled="busy||cache?.usingDefault" data-cache-reset @click="change('reset')">恢复默认目录</button><button class="button" :disabled="busy" data-cache-clear @click="change('clear')">清理歌曲缓存</button><span class="source-note">最多 {{ size(cache?.limitBytes??2*1024*1024*1024) }}，自动清理较早使用的缓存。</span></div><p class="source-note">目录切换后，旧目录的缓存保留。只有下载完整的资源会被复用。</p><p v-if="error" class="inline-warning" role="alert">{{ error }}</p><p v-else-if="cache?.warning" class="inline-warning" role="status">{{ cache.warning }}</p><p v-if="message" class="source-note" role="status">{{ message }}</p></section>
</template>
