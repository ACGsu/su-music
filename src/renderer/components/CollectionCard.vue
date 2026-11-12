<script setup lang="ts">
import type { Collection } from '../../shared/contracts.ts'
import CollectionArtwork from './CollectionArtwork.vue'
import Icon from './Icon.vue'

defineProps<{ collection: Collection; view: 'grid' | 'list'; meta: string }>()
const emit = defineEmits<{ open: [collection: Collection] }>()
</script>

<template>
  <button class="collection-card" :class="{ 'is-list': view === 'list' }" :aria-label="'打开歌单 ' + collection.name" @click="emit('open', collection)">
    <span class="collection-cover" :class="'cover-' + collection.kind" aria-hidden="true">
      <CollectionArtwork :name="collection.name" :url="collection.coverUrl" :album="collection.subtype === 'album'" />
    </span>
    <span class="collection-dock">
      <span class="collection-name">{{ collection.name }}</span>
      <span class="collection-enter" aria-hidden="true"><Icon name="arrow" /></span>
    </span>
    <span class="collection-meta">{{ meta }}</span>
  </button>
</template>

<style scoped>
.collection-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-self: start;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
}
.collection-card .collection-cover {
  grid-column: 1 / -1;
  width: 100%;
  aspect-ratio: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 17px 20px;
  position: relative;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--surface);
}
.collection-card .collection-cover::after { content: none; }
.collection-cover :deep(.first-track-cover) { object-fit: contain; }
.collection-dock {
  grid-column: 1 / -1;
  display: flex;
  align-items: stretch;
  width: 100%;
  min-width: 0;
  min-height: 43px;
  margin-top: -1px;
  position: relative;
  border: 1px solid var(--line-light);
  background: var(--collection-dock-bg, #181A1F);
  color: #F0F2F5;
}
.collection-dock::before {
  content: '';
  position: absolute;
  top: 11px;
  bottom: 11px;
  left: -1px;
  width: 2px;
  background: var(--accent);
  pointer-events: none;
}
.collection-dock .collection-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 10px 13px;
  color: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.collection-enter {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 37px;
  width: 37px;
  border-left: 1px solid var(--line-light);
  transition: background 100ms, color 100ms;
}
.collection-enter .icon { width: 15px; height: 15px; }
.collection-card .collection-meta {
  grid-column: 1 / -1;
  padding-top: 8px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
}
.collection-card:hover .collection-cover { border-color: var(--line-light); }
.collection-card:hover { background: transparent; }
.collection-card:hover .collection-enter,
.collection-card:focus-visible .collection-enter { background: var(--accent); color: var(--on-accent); }
:global([data-theme="day"]) { --collection-dock-bg: #1A1A18; }

.collection-card.is-list {
  grid-template-columns: 72px minmax(0, 1fr) 37px;
  grid-template-rows: auto auto;
  min-height: 76px;
  border: 1px solid var(--line);
  background: var(--surface);
  align-items: center;
}
.collection-card.is-list:hover { background: var(--elevated); border-color: var(--line-light); }
.collection-card.is-list .collection-cover {
  grid-column: 1;
  grid-row: 1 / 3;
  width: 72px;
  height: 72px;
  padding: 9px;
  border: 0;
  border-right: 1px solid var(--line);
  background: var(--elevated);
}
.collection-card.is-list .collection-cover :deep(.first-track-cover) { object-fit: cover; }
.collection-card.is-list .collection-dock { display: contents; }
.collection-card.is-list .collection-dock::before { content: none; }
.collection-card.is-list .collection-name {
  grid-column: 2;
  grid-row: 1;
  padding: 10px 16px 0;
  font-size: 14px;
  color: var(--heading);
}
.collection-card.is-list .collection-enter {
  grid-column: 3;
  grid-row: 1 / 3;
  width: 37px;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--text);
}
.collection-card.is-list .collection-meta {
  grid-column: 2;
  grid-row: 2;
  padding: 4px 16px 10px;
}
@media (prefers-reduced-motion: reduce) { .collection-enter { transition: none; } }
</style>
