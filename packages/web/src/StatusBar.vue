<script setup lang="ts">
// 底部状态栏：大纲、第几页 / 共几页、字数、缩放。四种模式都有。
import OeIcon from './OeIcon.vue'

defineProps<{ pageNo: number; pageCount: number; words: number | null; scale: number; outlineOpen?: boolean }>()
defineEmits<{ zoom: [step: -1 | 0 | 1]; outline: [anchor: DOMRect] }>()
</script>

<template>
  <footer class="statusbar" editor-component="component">
    <button type="button" class="icon-button small oe-outline" aria-label="大纲" title="大纲（按标题跳转）" :aria-expanded="!!outlineOpen" @click="$emit('outline', ($event.currentTarget as HTMLElement).getBoundingClientRect())"><OeIcon name="list" /></button>
    <span class="status-item" aria-live="polite">第 {{ Math.min(pageNo + 1, Math.max(pageCount, 1)) }} 页，共 {{ Math.max(pageCount, 1) }} 页</span>
    <span v-if="words !== null" class="status-item">{{ words.toLocaleString('zh-CN') }} 字</span>
    <span class="status-spacer"></span>
    <span class="zoom" role="group" aria-label="缩放">
      <button type="button" class="icon-button small" aria-label="缩小" title="缩小" :disabled="scale <= 0.5" @click="$emit('zoom', -1)"><OeIcon name="minus" /></button>
      <button type="button" class="zoom-value" aria-label="缩放比例，点一下恢复 100%" title="恢复 100%" @click="$emit('zoom', 0)">{{ Math.round(scale * 100) }}%</button>
      <button type="button" class="icon-button small" aria-label="放大" title="放大" :disabled="scale >= 3" @click="$emit('zoom', 1)"><OeIcon name="plus" /></button>
    </span>
  </footer>
</template>
