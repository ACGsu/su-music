<script setup lang="ts">
import { ref } from 'vue'
import type { AccountState } from '../../shared/account.ts'
import type { AppState, Result } from '../../shared/contracts.ts'
defineProps<{ state?: AccountState }>()
const emit=defineEmits<{ changed:[state:AppState] }>()
const busy=ref(false),error=ref('')
async function action(operation:()=>Promise<Result<AppState>>):Promise<void>{
  if(busy.value)return;busy.value=true;error.value=''
  try{const result=await operation();if(result.ok)emit('changed',result.value);else error.value=result.error.message}catch{error.value='账号操作暂时无法完成，请重试。'}finally{busy.value=false}
}
const login=()=>action(()=>window.suMusic.startLogin()),cancel=()=>action(()=>window.suMusic.cancelLogin()),logout=()=>action(()=>window.suMusic.logout()),sync=()=>action(()=>window.suMusic.syncAccount()),cancelSync=()=>action(()=>window.suMusic.cancelSync())
const phaseCopy:Record<string,string>={logged_out:'尚未连接',stored_session:'正在恢复登录',creating_qr:'正在生成二维码',waiting_scan:'请用标准版酷狗扫码',waiting_confirm:'请在手机确认登录',verifying:'正在核对账号',authenticated:'账号已连接',invalidated:'二维码已失效',local_deadline:'等待时间已到',cancelled:'扫码已取消',session_invalid:'请重新登录',error:'连接暂未完成'}
const syncCopy:Record<string,string>={idle:'尚未同步',reading_directory:'正在读取歌单目录',reading_tracks:'正在读取歌曲',checking_directory:'正在核对目录',completed:'同步已完成',failed:'同步未完成',cancelled:'同步已取消'}
</script>
<template>
  <section class="settings-group account-panel" data-account-panel>
    <h2>酷狗账号</h2>
    <div class="setting-row"><div><h3>酷狗标准版</h3><p>{{ state?.account?.nickname || state?.cachedAccount?.nickname || '连接你的账号，读取默认、自建及收藏歌单。' }}</p><p v-if="state?.account || state?.cachedAccount" class="account-number">账号 {{ state.account?.id || state.cachedAccount?.id }}<span v-if="!state.account"> · 本地缓存</span></p></div><span class="status-label" data-login-phase>{{ phaseCopy[state?.phase || 'logged_out'] }}</span></div>
    <div v-if="state?.qrImage" class="qr-area"><div class="qr-frame"><img :src="state.qrImage" alt="酷狗扫码登录二维码" data-login-qr /></div><div><h3>{{ phaseCopy[state.phase] }}</h3><p>使用标准版酷狗扫描二维码，在手机核对并确认登录。</p><p v-if="state.qrDeadline">本机等待截止 {{ new Date(state.qrDeadline).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) }}</p><button class="button" :disabled="busy" data-cancel-login @click="cancel">取消扫码</button></div></div>
    <p v-if="state?.message" class="inline-warning" role="status">{{ state.message }}</p><p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
    <div class="account-actions">
      <template v-if="state?.phase==='authenticated'"><button class="button primary" :disabled="busy || ['reading_directory','reading_tracks','checking_directory'].includes(state.sync.phase)" data-sync-account @click="sync">刷新歌单</button><button class="button" :disabled="busy" data-logout @click="logout">退出登录</button></template>
      <template v-else-if="!['creating_qr','verifying','stored_session'].includes(state?.phase||'') && !state?.qrImage"><button class="button primary" :disabled="busy" data-start-login @click="login">{{ state?.hasStoredSession ? '重新扫码登录' : '扫码登录' }}</button><button v-if="state?.hasStoredSession" class="button" :disabled="busy" @click="logout">退出登录</button></template>
    </div>
    <div class="sync-status" v-if="state && (state.sync.phase!=='idle' || state.sync.lastSuccessAt)" data-sync-status>
      <h3>{{ syncCopy[state.sync.phase] }}</h3><p v-if="['reading_directory','reading_tracks','checking_directory'].includes(state.sync.phase)">{{ state.sync.completedCollections }} / {{ state.sync.totalCollections }} 个歌单<button class="button" :disabled="busy" data-cancel-sync @click="cancelSync">取消同步</button></p>
      <p v-if="state.sync.phase==='completed'">{{ state.sync.totalCollections }} 个歌单 · {{ state.sync.positionCount }} 个曲目位置<span v-if="state.sync.added || state.sync.removed"> · 新增 {{ state.sync.added }} 项，取消 {{ state.sync.removed }} 项</span></p>
      <p v-if="state.sync.error" class="inline-warning">{{ state.sync.error }}</p><p v-if="state.sync.lastSuccessAt" class="source-note">上次成功同步 {{ new Date(state.sync.lastSuccessAt).toLocaleString('zh-CN') }}</p>
      <details v-if="state.sync.rawDirectoryCount!==null" class="runtime-details"><summary>同步详情</summary><p>原始目录 {{ state.sync.rawDirectoryCount }} 项，待核对分类 {{ state.sync.unknownClassifications }} 项。</p></details>
    </div>
  </section>
</template>
<style scoped>
.account-panel{margin-top:0}.account-number{font-size:11px;font-variant-numeric:tabular-nums}.account-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.qr-area{display:flex;align-items:center;gap:24px;padding:22px 0;border-bottom:1px solid var(--line)}.qr-frame{width:196px;height:196px;flex:none;background:#fff;border:1px solid var(--line-light);padding:8px}.qr-frame img{display:block;width:100%;height:100%;image-rendering:pixelated}.qr-area p{max-width:310px;line-height:1.8;font-size:12px;margin-top:8px}.qr-area .button{margin-top:14px}.sync-status{padding:20px 0;border-bottom:1px solid var(--line)}.sync-status>p{font-size:12px;margin-top:9px}.sync-status>p>.button{font-size:11px;margin-left:15px;padding:5px 10px;min-height:28px}.sync-status .inline-warning{margin:12px 0}.sync-status .runtime-details p{margin-top:12px}@media(max-width:1100px){.qr-area{gap:18px}.qr-frame{width:176px;height:176px}}
</style>
