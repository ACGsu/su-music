<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
import type { CandidateId, MatchResult, ResourceCheck, SourceCandidate, TrackReference } from '../../shared/music.ts'
import { candidateKey, GD_ATTRIBUTION } from '../../shared/music.ts'
import type {LocalTrack,PlayerCommand} from '../../shared/playback.ts'
import {validatePlayerCommand} from '../../shared/playback.ts'
const props = defineProps<{ reference?: TrackReference; candidate?: SourceCandidate;locals?:LocalTrack[] }>()
const emit = defineEmits<{ close: []; checked: [reference: TrackReference, result: MatchResult];acted:[] }>()
const match = ref<MatchResult | null>(null), selected = ref<SourceCandidate | null>(null), resource = ref<ResourceCheck | null>(null)
const busy = ref(false), resourceBusy = ref(false), error = ref('')
const actionBusy=ref(false),localSelection=ref(''),extraQuery=ref(''),extraBusy=ref(false),extraCandidates=ref<SourceCandidate[]>([])
const resourceSection = ref<HTMLElement | null>(null), resourceResult = ref<HTMLElement | null>(null)
let generation = 0, resourceGeneration = 0
const label = computed(() => match.value?.status === 'candidate_matched' ? '候选已匹配' : match.value?.status === 'not_found' ? '未找到候选' : '需要对照版本')
const comparisons = computed(() => [...(match.value?.candidates ?? []),...extraCandidates.value.filter(candidate=>!match.value?.candidates.some(item=>candidateKey(item.candidate)===candidateKey(candidate))).map(candidate=>({candidate,decision:'review' as const,reasons:['手动搜索候选，请对照歌手、版本与时长。'],durationDifferenceMs:match.value?.original.durationMs!=null&&candidate.durationMs!=null?Math.abs(candidate.durationMs-match.value.original.durationMs):null}))].sort((a,b) => {
  const chosen = selected.value ? candidateKey(selected.value) : null
  const rank = { matched: 0, review: 1, rejected: 2 }
  return Number(candidateKey(b.candidate) === chosen) - Number(candidateKey(a.candidate) === chosen) ||
    rank[a.decision] - rank[b.decision] || a.reasons.length - b.reasons.length ||
    (a.durationDifferenceMs ?? Infinity) - (b.durationDifferenceMs ?? Infinity)
}))
function qualityLabel(value: ResourceCheck): string {
  return value.returnedQualityCode === 999 ? '接口标记 24bit 无损' : value.returnedQualityCode === 740 ? '接口标记 16bit 无损' :
    value.returnedBitrateKbps ? '接口返回 ' + value.returnedBitrateKbps + ' kbps' : '接口音质待确认'
}
function duration(value: number | null | undefined): string { return value == null ? '时长待补充' : Math.floor(value / 60000) + ':' + String(Math.floor(value / 1000) % 60).padStart(2,'0') + ' · ' + (value / 1000).toFixed(3) + ' 秒' }
async function load(force = false): Promise<void> {
  const current = ++generation; resourceGeneration++; resource.value = null; resourceBusy.value = false; match.value = null; selected.value = props.candidate ?? null; error.value = ''
  extraCandidates.value=[];extraQuery.value='';localSelection.value=''
  busy.value = Boolean(props.reference)
  if (!props.reference) return
  const reference = { ...props.reference }; busy.value = true
  try {
    const result = await window.suMusic.matchTrack(reference, force)
    if (current !== generation) return
    if (result.ok) {
      match.value = result.value
      extraQuery.value=(result.value.original.title??result.value.original.filename??'').slice(0,180)
      selected.value = result.value.candidates.find(item => candidateKey(item.candidate) === result.value.automaticCandidate)?.candidate ?? null
      emit('checked', reference, result.value)
    } else error.value = result.error.message
  } catch { if (current === generation) error.value = '版本资料未能读取，请重试。' }
  finally { if (current === generation) busy.value = false }
}
async function act(command:PlayerCommand):Promise<void>{actionBusy.value=true;error.value='';try{const result=await window.suMusic.playerCommand(validatePlayerCommand(command));if(result.ok){emit('acted');emit('close')}else error.value=result.error.message}catch{error.value='播放选择未能完成，请重试。'}finally{actionBusy.value=false}}
function choose(persistence:'once'|'remember'):void{if(!selected.value)return;const candidate:CandidateId={providerId:selected.value.providerId,sourceId:selected.value.sourceId,trackId:selected.value.trackId};void act(props.reference?{type:'choose',reference:props.reference,candidate,persistence}:{type:'play',target:{kind:'candidate',candidate}})}
async function linkFile():Promise<void>{if(!props.reference)return;actionBusy.value=true;error.value='';const reference={...props.reference};try{const result=await window.suMusic.importLocal(reference);if(!result.ok)error.value=result.error.message;else if(result.value.length){emit('acted');await act({type:'play',target:{kind:'original',reference}})}}catch{error.value='本地文件未能关联，请重试。'}finally{actionBusy.value=false}}
async function extraSearch():Promise<void>{if(!extraQuery.value.trim()||extraBusy.value)return;const load=generation;extraBusy.value=true;error.value='';try{const result=await window.suMusic.searchOnline(extraQuery.value);if(load!==generation)return;if(result.ok)extraCandidates.value=result.value.candidates;else error.value=result.error.message}catch{error.value='补充搜索未能完成。'}finally{extraBusy.value=false}}
async function select(candidate: SourceCandidate): Promise<void> { resourceGeneration++; resourceBusy.value = false; selected.value = candidate; resource.value = null; error.value = ''; await nextTick(); resourceSection.value?.scrollIntoView({block:'nearest'}) }
async function inspect(force = false): Promise<void> {
  if (!selected.value || resourceBusy.value) return
  const current = ++resourceGeneration, item = selected.value
  const id: CandidateId = { providerId: item.providerId, sourceId: item.sourceId, trackId: item.trackId }
  resourceBusy.value = true; error.value = ''
  try {
    const result = await window.suMusic.checkResource(id, force)
    if (current !== resourceGeneration) return
    if (result.ok) { resource.value = result.value; await nextTick(); resourceResult.value?.scrollIntoView({block:'nearest'}) } else error.value = result.error.message
  } catch { if (current === resourceGeneration) error.value = '资源检查未能完成，请重试。' }
  finally { if (current === resourceGeneration) resourceBusy.value = false }
}
const reasonCopy: Record<string, string> = { RESOURCE_UNAVAILABLE: '音源暂未提供此版本。', RESOURCE_URL_INVALID: '未获得可检查的资源地址。', RESOURCE_NOT_AUDIO: '返回内容不是可确认的音频。', RESOURCE_RANGE_INVALID: '资源范围读取未完成。', SOURCE_HTTP_ERROR: '资源服务暂时不可用。', SOURCE_TIMEOUT: '资源读取超时。', SOURCE_NETWORK_ERROR: '资源暂时无法连接。' }
watch(() => [props.reference?.collectionId, props.reference?.position, props.candidate?.trackId], () => { void load() }, { immediate: true })
</script>
<template>
  <aside class="version-panel" aria-label="歌曲版本对照" data-version-panel>
    <header class="queue-heading"><div><p class="eyebrow">VERSION COMPARISON</p><h2>版本对照</h2></div><button class="icon-button" aria-label="关闭版本对照" @click="emit('close')"><Icon name="close" /></button></header>
    <p v-if="busy" class="source-note" role="status">正在查找并补全候选版本…</p>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
    <section v-if="match" class="original-summary"><p class="eyebrow">原始曲目 · 第 {{ match.original.position }} 首</p><h3>{{ match.original.title || match.original.filename }}</h3><p>{{ match.original.artist || '歌手资料缺失' }}</p><p>{{ match.original.album || '专辑资料缺失' }}</p><p>{{ duration(match.original.durationMs) }}</p><div class="comparison-status" data-match-status>{{ label }}</div><p class="source-note">{{ match.fromCache ? '显示已缓存的版本记录。' : '已更新版本记录。' }} 元数据匹配需另行检查资源。</p><button class="button" :disabled="busy" @click="load(true)">重新核对候选</button></section>
    <section v-if="selected" ref="resourceSection" class="resource-summary"><p class="eyebrow">当前对照候选</p><h3>{{ selected.title }}</h3><p>{{ selected.artists.join('、') }}</p><p>{{ selected.album || '专辑资料缺失' }} · {{ duration(selected.durationMs) }}</p><div class="version-play-actions"><button v-if="props.reference" class="button primary" :disabled="actionBusy" data-use-remember @click="choose('remember')">选定并播放</button><button class="button" :class="{primary:!props.reference}" :disabled="actionBusy" data-use-once @click="choose('once')">{{ props.reference?'仅试听':'播放此版本' }}</button><button v-if="!props.reference" class="button" :disabled="actionBusy" @click="act({type:'enqueue',target:{kind:'candidate',candidate:{providerId:selected.providerId,sourceId:selected.sourceId,trackId:selected.trackId}},placement:'end'})">加入队列</button></div><p v-if="props.reference" class="source-note">选定后歌单按此版本显示，同步会保留你的选择。仅试听不会更改歌单。</p><button class="button" :disabled="resourceBusy" data-resource-check @click="inspect(Boolean(resource))">{{ resourceBusy ? '正在检查…' : resource ? '重新检查资源' : '检查资源' }}</button><div v-if="resource" ref="resourceResult" class="resource-result" data-resource-result><h3>{{ resource.status === 'readable' ? '资源可读（局部检查）' : resource.status === 'unverified' ? '资源尚未确认' : '资源暂不可用' }}</h3><p v-if="resource.format">{{ resource.format }} · {{ qualityLabel(resource) }}</p><p v-if="resource.verifiedBitrateKbps" class="source-note">局部音频帧 {{ resource.verifiedBitrateKbps }} kbps<span v-if="resource.sampleRateHz"> · {{ resource.sampleRateHz / 1000 }} kHz</span></p><p v-if="resource.reason">{{ reasonCopy[resource.reason] || resource.reason }}</p><p class="source-note">这是局部读取记录，整曲播放另行记录。{{ resource.fromCache ? '本次显示缓存检查记录。' : '' }}</p><details class="resource-diagnostics"><summary>查看检查详情</summary><dl><div><dt>检查时间</dt><dd>{{ new Date(resource.checkedAt).toLocaleString('zh-CN') }}</dd></div><div><dt>读取字节</dt><dd>{{ resource.inspectedBytes.toLocaleString() }}</dd></div><div><dt>HTTP 总字节</dt><dd>{{ resource.totalBytes?.toLocaleString() || '未知' }}</dd></div><div><dt>接口 size 原值</dt><dd>{{ resource.reportedSize?.toLocaleString() || '未知' }}（单位待核对）</dd></div><div><dt>范围请求</dt><dd>{{ resource.rangeSupported === true ? '支持' : resource.rangeSupported === false ? '未按范围返回' : '未确认' }}</dd></div></dl></details></div></section>
    <section v-if="props.reference" class="local-version-options"><h3>原版与本地文件</h3><div class="version-play-actions"><button class="button" :disabled="actionBusy" data-restore-original @click="act({type:'restore_original',reference:props.reference!})">恢复原版</button><button class="button" :disabled="actionBusy" data-link-local @click="linkFile">关联本地文件并播放</button></div><div v-if="locals?.some(item=>!item.missing)" class="local-association"><select v-model="localSelection" aria-label="选择已有本地音乐"><option value="">选择已有本地音乐</option><option v-for="item in locals.filter(value=>!value.missing)" :key="item.id" :value="item.id">{{ item.name }} · {{ item.format }}</option></select><button class="button" :disabled="!localSelection||actionBusy" @click="act({type:'link_local',reference:props.reference!,localId:localSelection})">关联并播放</button></div></section>
    <form v-if="match" class="extra-version-search" @submit.prevent="extraSearch"><h3>补充查找版本</h3><input v-model="extraQuery" maxlength="200" aria-label="补充版本搜索关键词" placeholder="歌名、歌手或版本" /><button class="button" :disabled="extraBusy||!extraQuery.trim()">{{ extraBusy?'正在搜索…':'搜索其他版本' }}</button></form>
    <section v-if="match" class="candidate-list"><h3>候选版本 <span>{{ comparisons.length }}</span></h3><article v-for="item in comparisons" :key="candidateKey(item.candidate)" :data-candidate-id="candidateKey(item.candidate)" class="comparison-candidate" :class="{ chosen: selected && candidateKey(selected) === candidateKey(item.candidate) }"><h3>{{ item.candidate.title }}</h3><p>{{ item.candidate.artists.join('、') || '歌手资料缺失' }}</p><p>{{ item.candidate.album || '专辑资料缺失' }}</p><p>{{ duration(item.candidate.durationMs) }}</p><p v-if="item.durationDifferenceMs !== null" class="source-note">与原始时长相差 {{ (item.durationDifferenceMs / 1000).toFixed(3) }} 秒</p><p v-for="reason in item.reasons" :key="reason" class="comparison-reason">{{ reason }}</p><p v-if="item.decision === 'matched'" class="source-note">标题、歌手、版本与时长符合候选规则</p><button class="button" :aria-pressed="selected ? candidateKey(selected) === candidateKey(item.candidate) : false" @click="select(item.candidate)">对照此候选</button></article><p v-if="!comparisons.length" class="source-note">可在在线搜索中尝试其他关键词。</p></section>
    <p class="source-note attribution">{{ GD_ATTRIBUTION }} · 网易云音源</p>
  </aside>
</template>
