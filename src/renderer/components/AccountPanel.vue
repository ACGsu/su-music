<script setup lang="ts">
import { ref } from 'vue'
import type { AccountState } from '../../shared/account.ts'
import type { AppState, Result } from '../../shared/contracts.ts'

const props = defineProps<{ state?: AccountState }>()
const emit = defineEmits<{ changed: [state: AppState] }>()

const busy = ref(false), error = ref(''), neteaseUidInput = ref('')

async function action(operation: () => Promise<Result<AppState>>): Promise<void> {
  if (busy.value) return; busy.value = true; error.value = ''
  try {
    const result = await operation()
    if (result.ok) emit('changed', result.value)
    else error.value = result.error.message
  } catch {
    error.value = '账号操作暂时无法完成，请重试。'
  } finally {
    busy.value = false
  }
}

const login = () => action(() => window.suMusic.startLogin())
const cancel = () => action(() => window.suMusic.cancelLogin())
const logout = () => action(() => window.suMusic.logout())
const sync = () => action(() => window.suMusic.syncAccount())
const cancelSync = () => action(() => window.suMusic.cancelSync())

const connectNetease = () => {
  const uid = neteaseUidInput.value.trim()
  if (!uid) return
  return action(() => window.suMusic.connectNetease(uid))
}
const refreshNetease = () => action(() => window.suMusic.refreshNetease())
const cancelNeteaseSync = () => action(() => window.suMusic.cancelNeteaseSync())
const logoutNetease = () => action(() => window.suMusic.logoutNetease())
const switchProvider = (provider: 'kugou' | 'netease') => action(() => window.suMusic.switchAccount(provider))

const phaseCopy: Record<string, string> = {
  logged_out: '尚未连接',
  stored_session: '正在恢复登录',
  creating_qr: '正在生成二维码',
  waiting_scan: '请用标准版酷狗扫码',
  waiting_confirm: '请在手机确认登录',
  verifying: '正在核对账号',
  authenticated: '账号已连接',
  invalidated: '二维码已失效',
  local_deadline: '等待时间已到',
  cancelled: '扫码已取消',
  session_invalid: '请重新登录',
  error: '连接暂未完成'
}

const syncCopy: Record<string, string> = {
  idle: '尚未同步',
  reading_directory: '正在读取歌单目录',
  reading_tracks: '正在读取歌曲',
  checking_directory: '正在核对目录',
  completed: '同步已完成',
  failed: '同步未完成',
  cancelled: '同步已取消'
}

const neteaseSyncCopy: Record<string, string> = {
  idle: '尚未同步',
  reading_directory: '正在读取公开歌单目录',
  reading_tracks: '正在读取歌单曲目',
  completed: '同步已完成',
  failed: '同步未完成',
  cancelled: '同步已取消'
}
</script>

<template>
  <section class="settings-group account-panel" data-account-panel>
    <h2>账号与曲库</h2>
    <div class="active-provider-row">
      <span>当前活动曲库来源：<strong>{{ state?.activeProvider === 'netease' ? '网易云音乐' : state?.activeProvider === 'kugou' ? '酷狗音乐' : '本地曲库' }}</strong></span>
      <div class="provider-switch-buttons">
        <button
          v-if="state?.activeProvider !== 'kugou' && (state?.kugou?.account || state?.kugou?.cachedAccount)"
          class="button"
          :disabled="busy"
          data-switch-kugou
          @click="switchProvider('kugou')"
        >
          切换为酷狗曲库
        </button>
        <button
          v-if="state?.activeProvider !== 'netease' && (state?.netease?.account || state?.netease?.cachedAccount)"
          class="button"
          :disabled="busy"
          data-switch-netease
          @click="switchProvider('netease')"
        >
          切换为网易云曲库
        </button>
      </div>
    </div>

    <!-- Kugou Account Section -->
    <div class="account-sub-section">
      <div class="setting-row">
        <div>
          <h3>
            酷狗标准版
            <span v-if="state?.activeProvider === 'kugou'" class="provider-active-badge">当前曲库</span>
          </h3>
          <p>{{ state?.kugou?.account?.nickname || state?.kugou?.cachedAccount?.nickname || state?.account?.nickname || state?.cachedAccount?.nickname || '连接你的账号，读取默认、自建及收藏歌单。' }}</p>
          <p v-if="state?.kugou?.account || state?.kugou?.cachedAccount || state?.account || state?.cachedAccount" class="account-number">
            账号 {{ state?.kugou?.account?.id || state?.kugou?.cachedAccount?.id || state?.account?.id || state?.cachedAccount?.id }}
            <span v-if="!(state?.kugou?.account || state?.account)"> · 本地缓存</span>
          </p>
        </div>
        <span class="status-label" data-login-phase>{{ phaseCopy[state?.kugou?.phase || state?.phase || 'logged_out'] }}</span>
      </div>

      <div v-if="state?.kugou?.qrImage || state?.qrImage" class="qr-area">
        <div class="qr-frame">
          <img :src="state?.kugou?.qrImage || state?.qrImage || ''" alt="酷狗扫码登录二维码" data-login-qr />
        </div>
        <div>
          <h3>{{ phaseCopy[state?.kugou?.phase || state?.phase || 'logged_out'] }}</h3>
          <p>使用标准版酷狗扫描二维码，在手机核对并确认登录。</p>
          <p v-if="state?.kugou?.qrDeadline || state?.qrDeadline">
            本机等待截止 {{ new Date(state?.kugou?.qrDeadline || state?.qrDeadline || 0).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
          </p>
          <button class="button" :disabled="busy" data-cancel-login @click="cancel">取消扫码</button>
        </div>
      </div>

      <p v-if="state?.kugou?.message || state?.message" class="inline-warning" role="status">{{ state?.kugou?.message || state?.message }}</p>

      <div class="account-actions">
        <template v-if="(state?.kugou?.phase || state?.phase) === 'authenticated'">
          <button
            class="button primary"
            :disabled="busy || ['reading_directory','reading_tracks','checking_directory'].includes((state?.kugou?.sync || state?.sync)?.phase || '')"
            data-sync-account
            @click="sync"
          >
            刷新歌单
          </button>
          <button class="button" :disabled="busy" data-logout @click="logout">退出登录</button>
        </template>
        <template v-else-if="!['creating_qr','verifying','stored_session'].includes(state?.kugou?.phase || state?.phase || '') && !(state?.kugou?.qrImage || state?.qrImage)">
          <button class="button primary" :disabled="busy" data-start-login @click="login">
            {{ (state?.kugou?.hasStoredSession || state?.hasStoredSession) ? '重新扫码登录' : '扫码登录' }}
          </button>
          <button v-if="state?.kugou?.hasStoredSession || state?.hasStoredSession" class="button" :disabled="busy" @click="logout">退出登录</button>
        </template>
      </div>

      <div class="sync-status" v-if="(state?.kugou?.sync || state?.sync) && ((state?.kugou?.sync || state?.sync)!.phase !== 'idle' || (state?.kugou?.sync || state?.sync)!.lastSuccessAt)" data-sync-status>
        <h3>{{ syncCopy[(state?.kugou?.sync || state?.sync)!.phase] }}</h3>
        <p v-if="['reading_directory','reading_tracks','checking_directory'].includes((state?.kugou?.sync || state?.sync)!.phase)">
          {{ (state?.kugou?.sync || state?.sync)!.completedCollections }} / {{ (state?.kugou?.sync || state?.sync)!.totalCollections }} 个歌单
          <button class="button" :disabled="busy" data-cancel-sync @click="cancelSync">取消同步</button>
        </p>
        <p v-if="(state?.kugou?.sync || state?.sync)!.phase === 'completed'">
          {{ (state?.kugou?.sync || state?.sync)!.totalCollections }} 个歌单 · {{ (state?.kugou?.sync || state?.sync)!.positionCount }} 个曲目位置
          <span v-if="(state?.kugou?.sync || state?.sync)!.added || (state?.kugou?.sync || state?.sync)!.removed">
            · 新增 {{ (state?.kugou?.sync || state?.sync)!.added }} 项，取消 {{ (state?.kugou?.sync || state?.sync)!.removed }} 项
          </span>
        </p>
        <p v-if="(state?.kugou?.sync || state?.sync)!.error" class="inline-warning">{{ (state?.kugou?.sync || state?.sync)!.error }}</p>
        <p v-if="(state?.kugou?.sync || state?.sync)!.lastSuccessAt" class="source-note">上次成功同步 {{ new Date((state?.kugou?.sync || state?.sync)!.lastSuccessAt!).toLocaleString('zh-CN') }}</p>
        <details v-if="(state?.kugou?.sync || state?.sync)!.rawDirectoryCount !== null" class="runtime-details">
          <summary>同步详情</summary>
          <p>原始目录 {{ (state?.kugou?.sync || state?.sync)!.rawDirectoryCount }} 项，待核对分类 {{ (state?.kugou?.sync || state?.sync)!.unknownClassifications }} 项。</p>
        </details>
      </div>
    </div>

    <!-- Netease Account Section -->
    <div class="account-sub-section netease-section" data-netease-panel>
      <div class="setting-row">
        <div>
          <h3>
            网易云音乐（公开 UID）
            <span v-if="state?.activeProvider === 'netease'" class="provider-active-badge">当前曲库</span>
          </h3>
          <p>{{ state?.netease?.account?.nickname || state?.netease?.cachedAccount?.nickname || '通过公开 UID 读取用户公开歌单及曲目，不保存网易云凭据。' }}</p>
          <p v-if="state?.netease?.account || state?.netease?.cachedAccount" class="account-number">
            UID {{ state?.netease?.account?.uid || state?.netease?.cachedAccount?.uid }}
            <span v-if="!state?.netease?.account"> · 本地缓存</span>
          </p>
        </div>
        <span class="status-label" data-netease-status>{{ state?.netease?.connected ? '已连接' : '尚未连接' }}</span>
      </div>

      <div v-if="!state?.netease?.connected" class="netease-connect-form">
        <input
          v-model="neteaseUidInput"
          type="text"
          placeholder="请输入 1–18 位网易云公开 UID"
          data-netease-uid-input
          :disabled="busy"
          @keydown.enter.prevent="connectNetease"
        />
        <button class="button primary" :disabled="busy || !neteaseUidInput.trim()" data-netease-connect @click="connectNetease">
          {{ busy ? '连接中…' : '连接公开 UID' }}
        </button>
      </div>

      <div v-else class="account-actions">
        <button
          class="button primary"
          :disabled="busy || ['reading_directory','reading_tracks'].includes(state?.netease?.sync?.phase || '')"
          data-netease-refresh
          @click="refreshNetease"
        >
          刷新歌单
        </button>
        <button class="button" :disabled="busy" data-netease-logout @click="logoutNetease">退出连接</button>
      </div>

      <div v-if="state?.netease?.sync && (state.netease.sync.phase !== 'idle' || state.netease.sync.lastSuccessAt)" class="sync-status" data-netease-sync-status>
        <h3>{{ neteaseSyncCopy[state.netease.sync.phase] || state.netease.sync.phase }}</h3>
        <p v-if="['reading_directory','reading_tracks'].includes(state.netease.sync.phase)">
          {{ state.netease.sync.completedCollections }} / {{ state.netease.sync.totalCollections }} 个歌单
          <button class="button" :disabled="busy" data-netease-cancel-sync @click="cancelNeteaseSync">取消同步</button>
        </p>
        <p v-if="state.netease.sync.phase === 'completed'">
          {{ state.netease.sync.totalCollections }} 个歌单 · {{ state.netease.sync.positionCount }} 个曲目位置
          <span v-if="state.netease.sync.added || state.netease.sync.removed">
            · 新增 {{ state.netease.sync.added }} 项，取消 {{ state.netease.sync.removed }} 项
          </span>
        </p>
        <p v-if="state.netease.sync.error" class="inline-warning">{{ state.netease.sync.error }}</p>
        <p v-if="state.netease.sync.lastSuccessAt" class="source-note">上次成功同步 {{ new Date(state.netease.sync.lastSuccessAt).toLocaleString('zh-CN') }}</p>
      </div>
    </div>

    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.account-panel{margin-top:0}
.active-provider-row{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--line);font-size:13px;flex-wrap:wrap;gap:10px}
.provider-switch-buttons{display:flex;gap:8px}
.provider-switch-buttons .button{font-size:11px;padding:5px 10px;min-height:30px}
.account-sub-section{padding:16px 0;border-bottom:1px solid var(--line)}
.netease-section{border-bottom:0}
.account-number{font-size:11px;font-variant-numeric:tabular-nums}
.account-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.qr-area{display:flex;align-items:center;gap:24px;padding:22px 0;border-bottom:1px solid var(--line)}
.qr-frame{width:196px;height:196px;flex:none;background:#fff;border:1px solid var(--line-light);padding:8px}
.qr-frame img{display:block;width:100%;height:100%;image-rendering:pixelated}
.qr-area p{max-width:310px;line-height:1.8;font-size:12px;margin-top:8px}
.qr-area .button{margin-top:14px}
.sync-status{padding:20px 0;border-bottom:1px solid var(--line)}
.sync-status>p{font-size:12px;margin-top:9px}
.sync-status>p>.button{font-size:11px;margin-left:15px;padding:5px 10px;min-height:28px}
.sync-status .inline-warning{margin:12px 0}
.sync-status .runtime-details p{margin-top:12px}
.provider-active-badge{font-size:10px;background:var(--accent);color:var(--on-accent);padding:2px 6px;margin-left:8px;font-weight:700;vertical-align:middle}
.netease-connect-form{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0}
.netease-connect-form input{background:var(--bg);border:1px solid var(--line-light);color:var(--heading);padding:8px 12px;min-width:240px;font-size:13px}
@media(max-width:1100px){.qr-area{gap:18px}.qr-frame{width:176px;height:176px}}
</style>
