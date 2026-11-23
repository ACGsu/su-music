<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import Icon from './Icon.vue'
import type {AudioCacheState} from '../../shared/playback.ts'
import {AUDIO_CACHE_DEFAULT_BYTES,AUDIO_CACHE_MB,AUDIO_CACHE_MIN_BYTES,AUDIO_CACHE_MAX_BYTES} from '../../shared/playback.ts'
const props=defineProps<{cache:AudioCacheState|null}>()
const emit=defineEmits<{changed:[state:AudioCacheState]}>()
const busy=ref(false),message=ref(''),error=ref('')
const limitMb=ref<number|string>(AUDIO_CACHE_DEFAULT_BYTES/AUDIO_CACHE_MB)
const presets=[{mb:512,label:'512 MB'},{mb:1024,label:'1 GB'},{mb:2048,label:'2 GB'},{mb:5120,label:'5 GB'},{mb:10240,label:'10 GB'},{mb:20480,label:'20 GB'}]
const limitBytes=computed(()=>Number(limitMb.value)*AUDIO_CACHE_MB)
const validLimit=computed(()=>String(limitMb.value).trim()!==''&&Number.isSafeInteger(Number(limitMb.value))&&limitBytes.value>=AUDIO_CACHE_MIN_BYTES&&limitBytes.value<=AUDIO_CACHE_MAX_BYTES)
const preset=computed(()=>presets.some(item=>item.mb===Number(limitMb.value))?String(limitMb.value):'')
watch(()=>props.cache?.limitBytes,value=>{if(value!==undefined)limitMb.value=value/AUDIO_CACHE_MB},{immediate:true})
function choosePreset(event:Event):void{const value=(event.target as HTMLSelectElement).value;if(value)limitMb.value=Number(value)}
async function change(action:'choose'|'reset'|'clear'):Promise<void>{
  busy.value=true;error.value='';message.value=''
  try{
    const result=await(action==='choose'?window.suMusic.chooseCacheDirectory():action==='reset'?window.suMusic.resetCacheDirectory():window.suMusic.clearAudioCache())
    if(result.ok){emit('changed',result.value);message.value=action==='clear'?'歌曲缓存已清理。':'后续歌曲使用此目录，正在播放的歌曲继续播放。'}else error.value=result.error.message
  }catch{error.value='缓存设置未能完成，请重试。'}finally{busy.value=false}
}
async function saveLimit():Promise<void>{
  if(busy.value||!validLimit.value)return
  busy.value=true;error.value='';message.value=''
  try{
    const result=await window.suMusic.setAudioCacheLimit(limitBytes.value)
    if(result.ok){emit('changed',result.value);message.value='缓存容量已保存。'}else error.value=result.error.message
  }catch{error.value='缓存容量未能保存，请重试。'}finally{busy.value=false}
}
function size(bytes:number):string{return bytes>=1024*AUDIO_CACHE_MB?(bytes/1024/AUDIO_CACHE_MB).toFixed(1).replace(/\.0$/,'')+' GB':(bytes/AUDIO_CACHE_MB).toFixed(1)+' MB'}
</script>
<template>
  <section class="settings-group cache-settings">
    <h2>歌曲缓存</h2>
    <div class="setting-row cache-location">
      <div><h3>缓存存放位置</h3><p>可选择任意可写目录。缓存放在应用专用子目录中。</p><p class="cache-path" data-cache-directory>{{ cache?.directory??'正在读取…' }}</p><p>{{ cache?.usingDefault?'当前使用默认目录':'当前使用自选目录' }} · {{ cache?.tracks??0 }} 首完整下载缓存 · {{ size(cache?.bytes??0) }}</p></div>
      <button class="button" :disabled="busy" data-cache-choose @click="change('choose')">选择目录<Icon name="folder" /></button>
    </div>
    <div class="setting-row cache-capacity">
      <div><h3>容量上限</h3><p>512 MB–20 GB，可按整数 MB 设置。</p></div>
      <div class="cache-capacity-controls">
        <select :value="preset" :disabled="busy||!cache" aria-label="常用缓存容量" data-cache-preset @change="choosePreset">
          <option value="" disabled>自定义</option><option v-for="item in presets" :key="item.mb" :value="String(item.mb)">{{ item.label }}</option>
        </select>
        <label class="cache-limit-input"><input v-model="limitMb" type="number" min="512" max="20480" step="1" :disabled="busy||!cache" :aria-invalid="!validLimit" aria-label="歌曲缓存容量，单位 MB" data-cache-limit /><span>MB</span></label>
        <button class="button" :disabled="busy||!cache||!validLimit||limitBytes===cache.limitBytes" data-cache-save @click="saveLimit">保存容量</button>
      </div>
    </div>
    <p v-if="cache&&!validLimit" class="inline-warning" role="alert">请输入 512–20480 MB 的整数容量。</p>
    <div class="cache-actions"><button class="button" :disabled="busy||cache?.usingDefault" data-cache-reset @click="change('reset')">恢复默认目录</button><button class="button" :disabled="busy" data-cache-clear @click="change('clear')">清理歌曲缓存</button><span class="source-note">最多 {{ size(cache?.limitBytes??AUDIO_CACHE_DEFAULT_BYTES) }}，自动清理较早使用的缓存。</span></div>
    <p class="source-note">容量上限用于当前目录。目录切换后，旧目录的缓存保留。只有下载完整的资源会被复用。</p>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p><p v-else-if="cache?.warning" class="inline-warning" role="status">{{ cache.warning }}</p><p v-if="message" class="source-note" role="status">{{ message }}</p>
  </section>
</template>
