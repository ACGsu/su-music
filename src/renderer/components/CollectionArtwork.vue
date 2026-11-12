<script setup lang="ts">
import { ref, watch } from 'vue'
const props=defineProps<{name:string;url?:string|null;album?:boolean}>()
const failed=ref(false)
watch(()=>props.url,()=>{failed.value=false})
</script>
<template>
  <img v-if="url && !failed" class="first-track-cover" :src="url" alt="" loading="lazy" @error="failed=true" data-first-track-cover />
  <template v-else><span class="cover-code">{{ album ? 'ALBUM' : 'COLLECTION' }}</span><strong>{{ Array.from(name).slice(0,2).join('') }}</strong><span class="cover-lines" aria-hidden="true"></span></template>
</template>
