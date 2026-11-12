<script setup lang="ts">
import { ref } from 'vue'
import type { CollectionDetail } from '../../shared/contracts.ts'
const emit = defineEmits<{ imported: [detail: CollectionDetail] }>()
const link = ref(''), name = ref(''), error = ref(''), busy = ref(false)
async function submit(): Promise<void> {
  if (busy.value || !link.value.trim()) return
  busy.value = true; error.value = ''
  try {
    const result = await window.suMusic.importShare(link.value.trim(), name.value.trim())
    if (result.ok) { emit('imported', result.value); link.value = ''; name.value = '' }
    else error.value = result.error.message
  } catch { error.value = '歌单暂时无法导入，请重试。' }
  finally { busy.value = false }
}
</script>
<template>
  <details class="share-import" data-share-import>
    <summary>导入酷狗分享歌单</summary>
    <form @submit.prevent="submit">
      <label><span>分享链接</span><input v-model="link" maxlength="2048" placeholder="https://t1.kugou.com/…" required data-share-link /></label>
      <label><span>歌单名称（可选）</span><input v-model="name" maxlength="200" placeholder="为这张分享歌单命名" data-share-name /></label>
      <button class="button primary" :disabled="busy || !link.trim()" data-share-submit>{{ busy ? '正在读取…' : '导入歌单' }}</button>
    </form>
    <p class="source-note">按公开分享页的曲目和顺序导入，保存在“分享导入”中。</p>
    <p v-if="error" class="inline-warning" role="alert">{{ error }}</p>
  </details>
</template>
