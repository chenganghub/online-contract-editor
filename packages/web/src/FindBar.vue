<script setup lang="ts">
// 查找替换弹层：编辑、填写模式可用（盖章、只读是打印模式，canvas-editor 不画搜索高亮）；替换只在编辑模式。
// 点正文不关，边看边改；Esc 或关闭按钮才关，关的时候清掉高亮。
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type Editor from '@hufe921/canvas-editor'
import OeIcon from './OeIcon.vue'
import { shortcut, tip } from './formats'

const props = defineProps<{ editor: Editor; replace: boolean; left: number; top: number; initial?: string; focusReplace?: boolean }>()
const emit = defineEmits<{ close: []; edited: [] }>()
const cmd = () => props.editor.command

const query = ref(props.initial ?? '')
const replacement = ref('')
const info = reactive({ index: 0, count: 0 })
const rootEl = ref<HTMLElement>()
const input = ref<HTMLInputElement>()
const replaceInput = ref<HTMLInputElement>()

/**
 * canvas-editor 每次重绘都在 setTimeout 里把焦点抢回它自己的输入框（Cursor.drawCursor），搜一次查找框就丢一次焦点，
 * 中文输入法也会被打断。执行命令前记下焦点在这个弹层里的哪个元素，排在它后面的 setTimeout 里还回去
 */
function holdFocus() {
  const el = document.activeElement
  if (el instanceof HTMLElement && rootEl.value?.contains(el)) setTimeout(() => el.focus({ preventScroll: true }))
}
function refresh() {
  const i = cmd().getSearchNavigateInfo()
  info.index = i?.index ?? 0
  info.count = i?.count ?? 0
}
/** 搜索并跳到第 n 个（从 1 起）；n 为 0 时只标出来，不跳 */
function search(n = 1) {
  holdFocus()
  cmd().executeSearch(query.value || null)
  for (let k = 0; k < n; k++) cmd().executeSearchNavigateNext()
  refresh()
}
function onInput(e: Event) {
  // 输入法组字时不搜，组完字 v-model 会再发一次 input
  if (!(e as InputEvent).isComposing) search()
}
function next() {
  if (!info.count) return search()
  holdFocus()
  cmd().executeSearchNavigateNext()
  refresh()
}
function prev() {
  if (!info.count) return search()
  holdFocus()
  cmd().executeSearchNavigatePre()
  refresh()
}
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return
  if (e.key === 'Enter') {
    e.preventDefault()
    if (e.shiftKey) prev()
    else next()
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
const allText = () => {
  const t = cmd().getText()
  return `${t.header}\u0000${t.main}\u0000${t.footer}`
}
/**
 * 替换当前这个，再跳到原来后面那个。搜索也会搜到字段的占位文字（canvas-editor 把它当元素），那些替换不了：
 * 换不动就往后试下一个，正文变了才算换成。换掉的字不再匹配，后面那个就落到同一个序号上；换成的字里还含搜索词时往后多走一个
 */
function replaceOne() {
  if (!query.value || !info.count) return
  holdFocus()
  const total = info.count
  const before = allText()
  let at = Math.max(1, info.index)
  let done = false
  for (let k = 0; k < total && !done; k++) {
    cmd().executeReplace(replacement.value, { index: at - 1 })
    done = allText() !== before
    if (!done) at = (at % total) + 1
  }
  if (!done) return
  emit('edited')
  const again = replacement.value.includes(query.value) ? 1 : 0
  cmd().executeSearch(query.value)
  const count = cmd().getSearchNavigateInfo()?.count ?? 0
  search(count ? ((at - 1 + again) % count) + 1 : 0)
}
function replaceAll() {
  if (!query.value || !info.count) return
  holdFocus()
  const before = allText()
  cmd().executeReplace(replacement.value)
  if (allText() !== before) emit('edited')
  search(0)
}
function close() {
  cmd().executeSearch(null)
  emit('close')
}
/** 打开时、Ctrl+F / Ctrl+H 再按一次：焦点放到对应的框，全选。放在 setTimeout 里，排在编辑器抢焦点之后 */
function focus(toReplace = false) {
  setTimeout(() => {
    const el = toReplace && props.replace ? replaceInput.value : input.value
    el?.focus()
    el?.select()
  })
}
// 别处改了正文（打字、撤销）时计数跟着变，停在原来的序号上
let timer = 0
const onContent = () => {
  clearTimeout(timer)
  timer = window.setTimeout(() => {
    if (!query.value) return
    const at = info.index
    holdFocus()
    cmd().executeSearch(query.value)
    const count = cmd().getSearchNavigateInfo()?.count ?? 0
    for (let k = 0; k < Math.min(at, count); k++) cmd().executeSearchNavigateNext()
    refresh()
  }, 300)
}
onMounted(() => {
  props.editor.eventBus.on('contentChange', onContent)
  if (query.value) search()
  focus(!!props.focusReplace && !!query.value)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  props.editor.eventBus.off('contentChange', onContent)
})
defineExpose({ focus, close })
</script>

<template>
  <div ref="rootEl" class="popover find-bar" role="search" aria-label="查找" editor-component="component" :style="{ left: `${left}px`, top: `${top}px`, transformOrigin: 'top right' }">
    <div class="find-row">
      <input ref="input" v-model="query" type="search" aria-label="查找内容" placeholder="查找" autocomplete="off" @input="onInput" @keydown="onKey" />
      <span class="find-count" aria-live="polite">{{ query ? `${info.index}/${info.count}` : '' }}</span>
      <button type="button" class="icon-button small" aria-label="上一个" :title="tip('上一个', 'Shift+Enter')" :disabled="!info.count" @click="prev"><OeIcon name="chevronUp" /></button>
      <button type="button" class="icon-button small" aria-label="下一个" :title="tip('下一个', 'Enter')" :disabled="!info.count" @click="next"><OeIcon name="chevronDown" /></button>
      <button type="button" class="icon-button small" aria-label="关闭查找" :title="tip('关闭', 'Esc')" @click="close"><OeIcon name="xmark" /></button>
    </div>
    <div v-if="replace" class="find-row">
      <input ref="replaceInput" v-model="replacement" type="search" aria-label="替换为" placeholder="替换为" autocomplete="off" @keydown.enter.prevent="replaceOne" @keydown.esc.prevent="close" />
      <button type="button" class="button-tinted" :disabled="!info.count" :title="tip('替换当前', shortcut('H'))" @click="replaceOne">替换</button>
      <button type="button" class="button-tinted" :disabled="!info.count" @click="replaceAll">全部</button>
    </div>
  </div>
</template>
