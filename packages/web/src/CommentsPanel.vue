<script setup lang="ts">
// 批注面板（docs/设计/08 第 3 节），放在右侧检查器的位置：上面写批注（编辑、填写模式里先选中正文，就引用那段文字），
// 下面是没解决的批注串，最后是已解决的（收起）。点一串选中引用的原文；原文改了找不到时标「原文已修改」。批注不进文档、不进导出
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type Editor from '@hufe921/canvas-editor'
import OeIcon from './OeIcon.vue'
import { shortTime } from './formats'
import type { CommentStore, CommentThread } from './useComments'
import type { CommentItem } from './types'

const props = defineProps<{
  editor: Editor
  store: CommentStore
  /** 自己的 userId（自己的才能改、删） */
  me: string
  /** 能加、回复、解决（盖章模式、作废的文档不能） */
  canWrite: boolean
  /** 能引用选中的正文（编辑、填写模式；盖章、只读是打印模式，选不了字） */
  quotable: boolean
  /** 选中引用的原文并滚过去；找不到返回 false */
  locate: (quote: string, occurrence: number) => boolean
}>()
defineEmits<{ close: [] }>()
const cmd = () => props.editor.command

// ---------- 写批注：引用当前选中的正文 ----------
/** 最长引用多少字（和服务端一致）；选中的更长时只引用前面这些 */
const QUOTE_MAX = 500
const quote = ref<{ text: string; occurrence: number } | null>(null)
function readQuote() {
  if (!props.quotable) return (quote.value = null)
  const text = cmd().getRangeText().replace(/\u200B/g, '').slice(0, QUOTE_MAX)
  if (!text.trim()) return (quote.value = null)
  // 是第几处：按选区开头对上搜到的那一处（搜到的 startIndex 是第一个字的下标，选区的 startIndex 是它前一个，同一个单元格里比）
  const range = cmd().getRange()
  const at = cmd()
    .getKeywordRangeList(text)
    .findIndex((r) => r.startIndex - 1 === range.startIndex && (r.tableId ?? null) === (range.tableId ?? null) && (r.startTdIndex ?? null) === (range.startTdIndex ?? null) && (r.startTrIndex ?? null) === (range.startTrIndex ?? null))
  quote.value = { text, occurrence: Math.max(0, at) }
}
const draft = ref('')
const busy = ref(false)
async function add() {
  const body = draft.value.trim()
  if (!body || busy.value) return
  busy.value = true
  const created = await props.store.add({ body, ...(quote.value ? { quote: quote.value.text, occurrence: quote.value.occurrence } : {}) })
  busy.value = false
  if (!created) return
  draft.value = ''
  quote.value = null
  active.value = created.id
}

// ---------- 批注串 ----------
const open = computed(() => props.store.threads.value.filter((t) => !t.resolved))
const resolved = computed(() => props.store.threads.value.filter((t) => t.resolved))
const showResolved = ref(false)
const active = ref<string | null>(null)
/** 引用的原文现在找不到的那几串（改过正文后重新算） */
const missing = reactive(new Set<string>())
function checkMissing() {
  missing.clear()
  for (const t of props.store.threads.value) if (t.quote && cmd().getKeywordRangeList(t.quote).length <= (t.occurrence ?? 0)) missing.add(t.id)
}
function select(t: CommentThread) {
  active.value = t.id
  if (t.quote && !props.locate(t.quote, t.occurrence ?? 0)) missing.add(t.id)
}
const replying = ref<string | null>(null)
const reply = ref('')
async function startReply(t: CommentThread) {
  replying.value = t.id
  reply.value = ''
  await nextTick()
  document.querySelector<HTMLTextAreaElement>(`.oe .comment-thread[data-id="${t.id}"] .comment-reply textarea`)?.focus()
}
async function sendReply(t: CommentThread) {
  const body = reply.value.trim()
  if (!body) return
  if (await props.store.add({ body, parentId: t.id })) replying.value = null
}
const mine = (c: CommentItem) => c.authorId === props.me
/** Ctrl / ⌘ + 回车发出去 */
const sendKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing

// 选区变了重读引用；正文改了、批注换了重新看哪些原文找不到
let timer = 0
const onContent = () => {
  clearTimeout(timer)
  timer = window.setTimeout(checkMissing, 400)
}
watch(() => props.store.threads.value, checkMissing)
onMounted(() => {
  props.editor.eventBus.on('rangeStyleChange', readQuote)
  props.editor.eventBus.on('contentChange', onContent)
  readQuote()
  checkMissing()
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  props.editor.eventBus.off('rangeStyleChange', readQuote)
  props.editor.eventBus.off('contentChange', onContent)
})
</script>

<template>
  <div class="inspector-body comments" aria-label="批注">
    <h2 class="section-title">批注<button type="button" class="icon-button small" aria-label="关闭批注" @click="$emit('close')"><OeIcon name="xmark" /></button></h2>
    <form v-if="canWrite" class="comment-new" @submit.prevent="add">
      <p v-if="quote" class="comment-quote">{{ quote.text }}</p>
      <textarea v-model="draft" rows="3" placeholder="添加批注" aria-label="批注内容" maxlength="2000" @keydown="sendKey($event) && add()"></textarea>
      <div class="comment-actions"><button type="submit" class="button-tinted" :disabled="!draft.trim() || busy">添加</button></div>
    </form>
    <p v-if="store.error.value" class="comment-error" role="alert">{{ store.error.value }}</p>
    <p v-if="!store.threads.value.length" class="empty-note">没有批注</p>
    <ul class="comment-list">
      <li v-for="t in open" :key="t.id" class="comment-thread" :class="{ active: active === t.id }" :data-id="t.id" @click="select(t)">
        <p v-if="t.quote" class="comment-quote">{{ t.quote }}</p>
        <span v-if="missing.has(t.id)" class="row-tag">原文已修改</span>
        <div v-for="c in [t, ...t.replies]" :key="c.id" class="comment-item">
          <div class="comment-meta">
            <span>{{ c.authorName }} · {{ shortTime(c.createdAt) }}</span>
            <button v-if="mine(c) && canWrite" type="button" class="icon-button small remove" aria-label="删除批注" @click.stop="store.remove(c.id)"><OeIcon name="xmark" /></button>
          </div>
          <p class="comment-body">{{ c.body }}</p>
        </div>
        <div v-if="canWrite" class="comment-actions" @click.stop>
          <button type="button" class="button-tinted small" @click="startReply(t)">回复</button>
          <button type="button" class="button-tinted small" @click="store.update(t.id, { resolved: true })">解决</button>
        </div>
        <form v-if="replying === t.id" class="comment-reply" @click.stop @submit.prevent="sendReply(t)">
          <textarea v-model="reply" rows="2" placeholder="回复" aria-label="回复内容" maxlength="2000" @keydown="sendKey($event) && sendReply(t)" @keydown.esc="replying = null"></textarea>
          <div class="comment-actions"><button type="submit" class="button-tinted small" :disabled="!reply.trim()">回复</button></div>
        </form>
      </li>
    </ul>
    <template v-if="resolved.length">
      <button type="button" class="comment-resolved" :aria-expanded="showResolved" @click="showResolved = !showResolved">
        <OeIcon :name="showResolved ? 'chevronDown' : 'chevronRight'" />已解决 {{ resolved.length }}
      </button>
      <ul v-if="showResolved" class="comment-list resolved">
        <li v-for="t in resolved" :key="t.id" class="comment-thread" :data-id="t.id" @click="select(t)">
          <p v-if="t.quote" class="comment-quote">{{ t.quote }}</p>
          <div class="comment-item">
            <div class="comment-meta"><span>{{ t.authorName }} · {{ shortTime(t.createdAt) }}{{ t.replies.length ? ` · ${t.replies.length} 条回复` : '' }}</span></div>
            <p class="comment-body">{{ t.body }}</p>
          </div>
          <div v-if="canWrite" class="comment-actions" @click.stop>
            <button type="button" class="button-tinted small" @click="store.update(t.id, { resolved: false })">重新打开</button>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
