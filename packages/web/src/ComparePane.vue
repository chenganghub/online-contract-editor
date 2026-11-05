<script setup lang="ts">
// 版本对比（docs/设计/08 第 3 节）：盖在编辑器上面，两个下拉框任选两版（「当前」是编辑器里现在的内容，没保存的也算）。
// 两版都按接受全部修订后的样子比（@oe/core 的 resolveTraces），用 canvas-editor 的 compare 标出：新增的蓝色下划线、删掉的红色删除线，
// 悬停看是新增还是删除。只比正文（canvas-editor 的 compare 只比正文），页眉页脚按右边那版显示。只读，不改文档
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Editor, { EditorMode, type IEditorData, type IEditorOption } from '@hufe921/canvas-editor'
import { layoutOptions, resolveTraces, traceChanges, type DocData } from '@oe/core'
import OeIcon from './OeIcon.vue'
import { shortTime } from './formats'
import { uid } from './ids'
import type { VersionStore } from './useVersions'
import type { RevisionItem } from './types'

type Side = number | 'current'
const props = defineProps<{
  store: VersionStore
  /** 编辑器里现在的内容 */
  current: () => DocData
  from: Side
  to: Side
  /** 和主编辑器一样的外观（选区颜色、控件底色这些） */
  look: Partial<IEditorOption>
}>()
const emit = defineEmits<{ close: [] }>()

const REASONS: Record<RevisionItem['reason'], string> = { create: '创建', edit: '编辑', start: '开始盖章', submit: '提交盖章', reject: '驳回', void: '作废', sign: '签署' }
const label = (v: RevisionItem) => [shortTime(v.at), v.operatorName, REASONS[v.reason] ?? v.reason].filter(Boolean).join(' ')
const from = ref<Side>(props.from)
const to = ref<Side>(props.to)
const pagesEl = ref<HTMLDivElement>()
const scrollId = uid()
const counts = ref<{ inserted: number; deleted: number } | null>(null)
const error = ref('')
const summary = computed(() => (error.value ? '' : !counts.value ? '正在对比' : counts.value.inserted + counts.value.deleted ? '' : '没有差别'))
let editor: Editor | undefined
// 换版本时前一次还没取完的结果不要
let seq = 0
const load = (side: Side) => (side === 'current' ? Promise.resolve(props.current()) : props.store.docOf(side))

async function render() {
  const s = ++seq
  error.value = ''
  counts.value = null
  try {
    const [older, newer] = await Promise.all([load(from.value), load(to.value)])
    if (s !== seq) return
    const a = resolveTraces(older, 'accept')
    const b = resolveTraces(newer, 'accept')
    editor?.destroy()
    editor = new Editor(pagesEl.value!, { header: b.header ?? [], main: b.main, footer: b.footer ?? [] } as IEditorData, {
      ...layoutOptions(b.page),
      ...props.look,
      scrollContainerSelector: `[data-oe-scroll="${scrollId}"]`,
      mode: EditorMode.READONLY,
    } as IEditorOption)
    // 对比后编辑器换成修订模式（只读）；结果里的修订记录没有作者、时间，悬停只显示新增、删除
    editor.command.executeCompare({ oldData: a.main, newData: b.main })
    const changes = traceChanges(editor.command.getValue().data as unknown as DocData)
    counts.value = { inserted: changes.filter((c) => c.type === 'inserted').length, deleted: changes.filter((c) => c.type === 'deleted').length }
  } catch (e) {
    if (s === seq) error.value = e instanceof Error ? e.message : '对比失败'
  }
}
watch([from, to], render)
onMounted(render)
onBeforeUnmount(() => editor?.destroy())
</script>

<template>
  <div class="compare" role="dialog" aria-modal="true" aria-label="版本对比" @keydown.esc="emit('close')">
    <header class="compare-toolbar">
      <span class="compare-title">版本对比</span>
      <select v-model="from" aria-label="旧的一版">
        <option value="current">当前</option>
        <option v-for="v in store.items.value" :key="v.version" :value="v.version">{{ label(v) }}</option>
      </select>
      <OeIcon name="chevronRight" />
      <select v-model="to" aria-label="新的一版">
        <option value="current">当前</option>
        <option v-for="v in store.items.value" :key="v.version" :value="v.version">{{ label(v) }}</option>
      </select>
      <span class="compare-summary" role="status">
        <template v-if="counts && counts.inserted + counts.deleted">
          <span class="mark-inserted">新增</span> {{ counts.inserted }} 处 · <span class="mark-deleted">删除</span> {{ counts.deleted }} 处
        </template>
        <template v-else>{{ summary }}</template>
      </span>
      <button type="button" class="button-tinted" autofocus @click="emit('close')">返回</button>
    </header>
    <p v-if="error" class="compare-error" role="alert">{{ error }}</p>
    <div class="compare-canvas" :data-oe-scroll="scrollId"><div ref="pagesEl" class="pages"></div></div>
  </div>
</template>
