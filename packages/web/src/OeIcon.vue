<script setup lang="ts">
import { computed } from 'vue'
import { ICONS, type IconName, type IconShape } from './icons'

const props = defineProps<{ name: IconName }>()
const shape = computed<IconShape>(() => ICONS[props.name])
</script>

<template>
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path v-for="d in shape.d" :key="d" :d="d" />
    <circle v-for="([cx, cy], i) in shape.dots ?? []" :key="i" :cx="cx" :cy="cy" r=".75" fill="currentColor" stroke="none" />
  </svg>
</template>
