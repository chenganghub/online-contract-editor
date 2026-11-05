<script setup lang="ts">
// 修订面板（docs/设计/08 第 3 节），放在右侧检查器的位置。面板开着时正文按修订模式显示（只读）：插入的蓝色下划线、删掉的红色删除线，
// 悬停看是谁、什么时候改的。上面是「记录修订」开关（开着时改正文记下插入、删除；字段、可编辑区里的内容不记，它们按字段同步），
// 下面按文档顺序列出每一处，可以接受、拒绝；点一处在正文里选中它
import type { TraceChange } from '@oe/core'
import OeIcon from './OeIcon.vue'
import { shortTime } from './formats'

defineProps<{
  changes: TraceChange[]
  /** 记录修订开着 */
  tracking: boolean
  /** 能改正文（拿着编辑锁、文档还能改）：开关、接受、拒绝都要它 */
  canEdit: boolean
}>()
defineEmits<{ tracking: [on: boolean]; resolve: [action: 'accept' | 'reject', key?: string]; locate: [change: TraceChange]; close: [] }>()
const TYPES = { inserted: '插入', deleted: '删除' } as const
</script>

<template>
  <div class="inspector-body traces" aria-label="修订">
    <h2 class="section-title">修订<button type="button" class="icon-button small" aria-label="关闭修订" @click="$emit('close')"><OeIcon name="xmark" /></button></h2>
    <label class="switch-row">
      <span>记录修订</span>
      <input type="checkbox" role="switch" class="switch" :checked="tracking" :disabled="!canEdit" @change="$emit('tracking', ($event.target as HTMLInputElement).checked)" />
    </label>
    <p v-if="!changes.length" class="empty-note">没有修订</p>
    <template v-else>
      <div v-if="canEdit" class="comment-actions trace-all">
        <button type="button" class="button-tinted small" @click="$emit('resolve', 'accept')">全部接受</button>
        <button type="button" class="button-tinted small" @click="$emit('resolve', 'reject')">全部拒绝</button>
      </div>
      <ul class="comment-list trace-list">
        <li v-for="c in changes" :key="c.key" class="comment-thread trace-item" :data-type="c.type" @click="$emit('locate', c)">
          <div class="comment-meta">
            <span><span class="trace-type">{{ TYPES[c.type] }}</span> · {{ c.author || '未署名' }} · {{ shortTime(c.to) }}</span>
          </div>
          <p class="trace-text">{{ c.text }}</p>
          <div v-if="canEdit" class="comment-actions" @click.stop>
            <button type="button" class="button-tinted small" @click="$emit('resolve', 'accept', c.key)">接受</button>
            <button type="button" class="button-tinted small" @click="$emit('resolve', 'reject', c.key)">拒绝</button>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
