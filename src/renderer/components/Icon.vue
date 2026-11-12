<script setup lang="ts">
const props = defineProps<{ name: string }>()
const paths: Record<string, string> = {
  library: 'M4 4h5v16H4zM11 4h4v16h-4zM17 5l3-1 3 15-3 1z',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M16 16l5 5',
  history: 'M4 10a8 8 0 1 1 1 7M4 4v6h6M12 7v5l3 2',
  review: 'M8 5h12M8 12h12M8 19h12M3 5h1M3 12h1M3 19h1',
  folder: 'M3 6h7l2 2h9v12H3z',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  day: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2',
  night: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1',
  arrow: 'M4 12h16M14 6l6 6-6 6',
  back: 'M20 12H4M10 6l-6 6 6 6',
  play: 'M8 5l12 7-12 7z',
  pause:'M8 5v14M16 5v14',
  sequence:'M4 5h16M16 2l4 3-4 3M4 12h12M4 19h12',
  shuffle:'M3 5h3l12 14h3M17 15l4 4-4 3M3 19h3l4-5M13 10l5-5h3M17 2l4 3-4 3',
  'repeat-one':'M5 6h13l3 3M21 4v5h-5M19 18H6l-3-3M3 20v-5h5M11 10l2-1v7',
  up:'M6 15l6-6 6 6',
  down:'M6 9l6 6 6-6',
  previous: 'M5 5v14M19 5L7 12l12 7z',
  next: 'M19 5v14M5 5l12 7-12 7z',
  volume: 'M3 9h4l5-4v14l-5-4H3zM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14',
  queue: 'M3 5h18M3 11h18M3 17h10M17 15l5 4-5 3z',
  close: 'M5 5l14 14M19 5L5 19',
  disc: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6',
  chevron: 'M6 9l6 6 6-6'
}
</script>
<template><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path :d="paths[props.name] || paths.disc" /></svg></template>
