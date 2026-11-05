<script setup lang="ts">
// 版本历史面板（docs/设计/08 第 3 节），放在右侧检查器的位置：新的在前，每版写什么时候、谁、为什么存的。
// 点一版就和当前的内容对比（ComparePane，那里还能换成任意两版）
import { onMounted, watch } from 'vue'
import OeIcon from './OeIcon.vue'
import { shortTime } from './formats'
import type { VersionStore } from './useVersions'
import type { RevisionItem } from './types'

const props = defineProps<{
  store: VersionStore
  /** 变了就重新取列表（文档的版本号：自己保存了、别人保存了、状态变了） */
  stamp: number
}>()
defineEmits<{ compare: [version: number]; close: [] }>()

const REASONS: Record<RevisionItem['reason'], string> = { create: '创建', edit: '编辑', start: '开始盖章', submit: '提交盖章', reject: '驳回', void: '作废', sign: '签署' }
onMounted(() => void props.store.refresh())
watch(
  () => props.stamp,
  () => void props.store.refresh(),
)
</script>

<template>
  <div class="inspector-body versions" aria-label="版本">
    <h2 class="section-title">版本<button type="button" class="icon-button small" aria-label="关闭版本" @click="$emit('close')"><OeIcon name="xmark" /></button></h2>
    <p v-if="store.error.value" class="comment-error" role="alert">{{ store.error.value }}</p>
    <p v-else-if="!store.items.value.length" class="empty-note">还没有保存过的版本</p>
    <ul class="rows">
      <li v-for="v in store.items.value" :key="v.version">
        <button type="button" class="row version-row" :data-version="v.version" :title="`和当前的对比（第 ${v.version} 版）`" @click="$emit('compare', v.version)">
          <span>{{ shortTime(v.at) }}<span class="row-meta">{{ v.operatorName ?? '' }}</span></span>
          <span class="row-meta">{{ REASONS[v.reason] ?? v.reason }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
