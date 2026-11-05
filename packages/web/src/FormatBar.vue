<script setup lang="ts">
// 编辑模式的悬浮格式栏和它的弹层（颜色、行距、表格、更多、页面设置），值按 docs/设计/04-界面规范.md 第 3、6 节。
// 组件有多个根节点：格式栏带 backdrop-filter，放在它里面的 position: fixed 会以格式栏为准、还会被它的横向滚动裁掉，
// 所以弹层和格式栏平级。弹层都带 format-pop，打开它们的按钮带 data-pop，点别处时按这两个判断要不要关。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { EditorZone, ListStyle, ListType, RowFlex, TitleLevel } from '@hufe921/canvas-editor'
import type Editor from '@hufe921/canvas-editor'
import { layoutOptions, type PageSetup } from '@oe/core'
import OeIcon from './OeIcon.vue'
import type { IconName } from './icons'
import { uid } from './ids'
import {
  FONTS, HIGHLIGHTS, PAGE_NUMBER_FORMATS, PAPERS, ROW_MARGINS, SIZES, SYMBOLS, TEXT_COLORS, WATERMARKS,
  fromMm, mm, shortcut, shownMargins, sizeLabel, storedMargins, tip, todayTexts, type FormatState,
} from './formats'

const props = defineProps<{
  editor?: Editor
  state: FormatState
  /** 编辑模式才可用；其他模式格式栏只是藏起来，位置照留，切模式时页面不上下跳 */
  active: boolean
  /** 模板设计时显示「设为字段」 */
  fieldButton: boolean
  canField: boolean
  page?: PageSetup
  /** 正文宽度（px）：插图片时按它限宽 */
  contentWidth: () => number
}>()
const emit = defineEmits<{ area: []; condition: [anchor: DOMRect]; field: []; page: [page: PageSetup]; notice: [text: string] }>()

const cmd = () => props.editor!.command
/** 下拉框拿了焦点，选完把焦点还给编辑器，接着打字 */
const focusEditor = () => props.editor?.command.getContainer().querySelector<HTMLElement>('.ce-inputarea')?.focus({ preventScroll: true })
/** 点格式栏不抢编辑器的焦点和选区；下拉框例外，不然鼠标点不开 */
function keep(e: MouseEvent) {
  if (!(e.target as Element).closest('select')) e.preventDefault()
}

const TITLES: [string, string][] = [['', '正文'], [TitleLevel.FIRST, '标题 1'], [TitleLevel.SECOND, '标题 2'], [TitleLevel.THIRD, '标题 3']]
const FLEX: { key: IconName; value: RowFlex; label: string; keys: string }[] = [
  { key: 'left', value: RowFlex.LEFT, label: '左对齐', keys: 'L' },
  { key: 'center', value: RowFlex.CENTER, label: '居中', keys: 'E' },
  { key: 'right', value: RowFlex.RIGHT, label: '右对齐', keys: 'R' },
  { key: 'alignment', value: RowFlex.ALIGNMENT, label: '两端对齐', keys: 'J' },
]
// 文档里用了列表外的字体或字号（导入的 Word、旧文档）时，下拉框也要显示出来，不显示空白
const fontOptions = computed(() => (!props.state.font || FONTS.some((f) => f.value === props.state.font) ? FONTS : [{ value: props.state.font, label: props.state.font }, ...FONTS]))
const nearSize = (v: number) => SIZES.find((s) => Math.abs(s.value - v) < 0.05)
const sizeOptions = computed(() => (nearSize(props.state.size) ? SIZES : [...SIZES, { label: sizeLabel(props.state.size), value: props.state.size }].sort((a, b) => b.value - a.value)))
const sizeValue = computed(() => String(nearSize(props.state.size)?.value ?? props.state.size))

function onTitle(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  cmd().executeTitle(v ? (v as TitleLevel) : null)
  focusEditor()
}
function onFont(e: Event) {
  cmd().executeFont((e.target as HTMLSelectElement).value)
  focusEditor()
}
function onSize(e: Event) {
  cmd().executeSize(Number((e.target as HTMLSelectElement).value))
  focusEditor()
}

// ---------- 弹层 ----------
type Pop = '' | 'color' | 'spacing' | 'table' | 'more' | 'page' | 'symbol'
const pop = reactive({ name: '' as Pop, left: 0, top: 0 })
const pos = computed(() => ({ left: `${pop.left}px`, top: `${pop.top}px` }))
function toggle(name: Pop, e: MouseEvent, width = 320) {
  if (pop.name === name) return close()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  Object.assign(pop, { name, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 8 })
}
const close = () => (pop.name = '')
/** 执行一条命令并关掉弹层 */
function run(fn: () => void) {
  fn()
  close()
}
function onPointerDown(e: PointerEvent) {
  if (pop.name && !(e.target as Element).closest?.('.format-pop, [data-pop]')) close()
}
function onKeydown(e: KeyboardEvent) {
  if (pop.name && e.key === 'Escape') close()
}

// 窄屏放不下时格式栏横向滚动：哪边还有按钮就在哪边淡出提示；鼠标滚轮上下滚也能横着翻
const barEl = ref<HTMLElement>()
const more = reactive({ left: false, right: false })
function measure() {
  const el = barEl.value
  if (!el) return
  more.left = el.scrollLeft > 1
  more.right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}
function onWheel(e: WheelEvent) {
  const el = barEl.value!
  if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
  e.preventDefault()
  el.scrollLeft += e.deltaY
}
let resize: ResizeObserver | undefined
onMounted(() => {
  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeydown, true)
  resize = new ResizeObserver(measure)
  resize.observe(barEl.value!)
  measure()
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('keydown', onKeydown, true)
  resize?.disconnect()
})
watch(() => props.active, close)

const same = (a: string | null, b: string) => !!a && a.toLowerCase() === b

// 表格：10 列 × 8 行里选。i 从 0 起，按行排
const grid = reactive({ rows: 0, cols: 0 })
const cellAt = (i: number) => ({ rows: Math.floor(i / 10) + 1, cols: (i % 10) + 1 })
function insertTable() {
  if (grid.rows && grid.cols) cmd().executeInsertTable(grid.rows, grid.cols)
  close()
}

// ---------- 图片：本机选一张，宽不超过正文；太大的按 2 倍正文宽重新压缩，免得文档 JSON 太大 ----------
const IMAGE_LIMIT = 10 * 1024 * 1024
const readAsDataURL = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片打不开'))
    img.src = src
  })
function pickImage() {
  // 不放进页面：编辑器里只留一个文件框（导入 Word 用）
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/bmp'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void insertImage(file)
  }
  input.click()
}
async function insertImage(file: File) {
  if (file.size > IMAGE_LIMIT) return emit('notice', '图片超过 10 MB')
  try {
    let src = await readAsDataURL(file)
    const img = await loadImage(src)
    const limit = Math.round(props.contentWidth() * 2)
    if (img.naturalWidth > limit || file.size > 1024 * 1024) {
      const scale = Math.min(1, limit / img.naturalWidth)
      const c = document.createElement('canvas')
      c.width = Math.round(img.naturalWidth * scale)
      c.height = Math.round(img.naturalHeight * scale)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      // PNG 可能带透明（logo），照样存 PNG；其他存 JPEG
      src = file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9)
    }
    const width = Math.min(img.naturalWidth, props.contentWidth())
    const height = Math.round((img.naturalHeight * width) / img.naturalWidth)
    cmd().executeImage({ id: `image-${uid()}`, value: src, width, height })
  } catch {
    emit('notice', '图片打不开')
  }
}

// ---------- 页面设置：写进 doc.page，渲染服务和 docx 导出都按它 ----------
const pageForm = computed(() => {
  const o = layoutOptions(props.page)
  return {
    paper: PAPERS.find((p) => p.width === o.width && p.height === o.height)?.label ?? '',
    horizontal: o.paperDirection === 'horizontal',
    margins: shownMargins(props.page).map(mm),
  }
})
/** 页边距输入框：两列，上下一行、左右一行；第二项是 shownMargins 里的下标（上、右、下、左） */
const MARGIN_INPUTS: [string, number][] = [['上', 0], ['下', 2], ['左', 3], ['右', 1]]
/** 从「更多」打开的弹层，宽 320，放在「更多」按钮下面，靠右放不下就往左挪 */
function openFromMore(name: 'page' | 'symbol') {
  pop.left = Math.max(8, Math.min(pop.left, window.innerWidth - 328))
  pop.name = name
}
const pageNumber = computed(() => {
  const p = layoutOptions(props.page).pageNumber
  return { ...p, known: PAGE_NUMBER_FORMATS.some((f) => f.value === p.format) }
})
/** 页码：不显示，或换格式、位置。只改给了的项，其余照文档原来的（Word 导入的格式也保留） */
function setPageNumber(change: { format?: string; rowFlex?: 'left' | 'center' | 'right' }) {
  const off = change.format === ''
  const current = props.page?.pageNumber ?? {}
  const next = { ...current, ...(off ? { disabled: true } : { ...change, disabled: false }) }
  if (off) delete next.format
  emit('page', { ...(props.page ?? pageOf()), pageNumber: next })
}
function setWatermark(text: string) {
  const data = text.trim().slice(0, 20)
  const next: PageSetup = { ...(props.page ?? pageOf()) }
  if (data) next.watermark = { ...props.page?.watermark, data }
  else delete next.watermark
  emit('page', next)
}
/** 文档还没有 page 时，按默认 A4 写一份 */
const pageOf = (): PageSetup => {
  const o = layoutOptions()
  return { width: o.width, height: o.height, paperDirection: o.paperDirection, margins: o.margins }
}
function insertSymbol(text: string) {
  cmd().executeInsertElementList([{ value: text }])
  close()
  focusEditor()
}
/** 页眉、页脚：切过去，光标放在那一区文字的末尾，接着打字（在页面上方、下方点一下也能切过去） */
function editZone(zone: EditorZone) {
  close()
  const c = cmd()
  const text = zone === EditorZone.HEADER ? c.getText().header : c.getText().footer
  c.executeSetZone(zone)
  // 区里第一个元素是开头的零宽字符，纯文字时第 n 个字的下标就是 n
  c.executeSetRange(text.length, text.length)
  focusEditor()
}
function setPage(change: { paper?: string; horizontal?: boolean; margin?: [number, number] }) {
  const o = layoutOptions(props.page)
  const paper = PAPERS.find((p) => p.label === change.paper)
  const horizontal = change.horizontal ?? o.paperDirection === 'horizontal'
  // 只改方向时存的页边距不变，编辑器把它跟着纸转 90°（和 Word 一样）；改了页边距按现在看到的方向换算
  let margins = o.margins
  if (change.margin) {
    const [i, value] = change.margin
    if (!Number.isFinite(value) || value < 0 || value > 100) return emit('notice', '页边距在 0～100 毫米之间')
    const shown = shownMargins(props.page)
    shown[i] = fromMm(value)
    margins = storedMargins(shown, horizontal)
  }
  const width = paper?.width ?? o.width
  const height = paper?.height ?? o.height
  // 横放时页面的宽是纸的高
  const [w, h] = horizontal ? [height, width] : [width, height]
  const [t, r, b, l] = horizontal ? [margins[1], margins[2], margins[3], margins[0]] : margins
  if (w - l - r < 96 || h - t - b < 96) return emit('notice', '页边距太大')
  emit('page', { ...props.page, width, height, paperDirection: horizontal ? 'horizontal' : 'vertical', margins })
}
</script>

<template>
  <div class="format-bar" role="toolbar" aria-label="格式" editor-component="component" :aria-hidden="!active" @mousedown="keep">
  <!-- 里面一层负责横向滚动和两边淡出，外面一层的胶囊底和阴影不受影响 -->
  <div ref="barEl" class="format-scroll" :class="{ 'more-left': more.left, 'more-right': more.right }" @scroll.passive="measure" @wheel="onWheel">
    <select class="format-style" aria-label="样式" title="样式" :value="state.level" @change="onTitle">
      <option v-for="[v, n] in TITLES" :key="v" :value="v">{{ n }}</option>
    </select>
    <select class="format-font" aria-label="字体" title="字体" :value="state.font" @change="onFont">
      <option v-for="f in fontOptions" :key="f.value" :value="f.value">{{ f.label }}</option>
    </select>
    <select class="format-size" aria-label="字号" title="字号" :value="sizeValue" @change="onSize">
      <option v-for="s in sizeOptions" :key="s.value" :value="String(s.value)">{{ s.label }}</option>
    </select>
    <span class="group">
      <button type="button" class="fmt" aria-label="加粗" :title="tip('加粗', shortcut('B'))" :aria-pressed="state.bold" @click="cmd().executeBold()"><b>B</b></button>
      <button type="button" class="fmt" aria-label="斜体" :title="tip('斜体', shortcut('I'))" :aria-pressed="state.italic" @click="cmd().executeItalic()"><i>I</i></button>
      <button type="button" class="fmt" aria-label="下划线" :title="tip('下划线', shortcut('U'))" :aria-pressed="state.underline" @click="cmd().executeUnderline()"><u>U</u></button>
      <button type="button" class="fmt" aria-label="删除线" :title="tip('删除线', shortcut('X', { ctrl: true, shift: true }))" :aria-pressed="state.strikeout" @click="cmd().executeStrikeout()"><s>S</s></button>
      <button type="button" class="fmt color-button" aria-label="颜色" title="文字颜色和突出显示" data-pop="color" :aria-expanded="pop.name === 'color'" @click="toggle('color', $event)">
        <span class="color-glyph" :style="{ backgroundColor: state.highlight ?? 'transparent' }">A</span>
        <span class="color-bar" :style="{ backgroundColor: state.color ?? 'currentColor' }"></span>
      </button>
    </span>
    <span class="group">
      <button v-for="f in FLEX" :key="f.key" type="button" class="fmt" :aria-label="f.label" :title="tip(f.label, shortcut(f.keys))" :aria-pressed="state.rowFlex === f.key" @click="cmd().executeRowFlex(f.value)"><OeIcon :name="f.key" /></button>
    </span>
    <span class="group">
      <button type="button" class="fmt" aria-label="行距" title="行距" data-pop="spacing" :aria-expanded="pop.name === 'spacing'" @click="toggle('spacing', $event, 160)"><OeIcon name="lineSpacing" /></button>
      <button type="button" class="fmt" aria-label="编号" :title="tip('编号', shortcut('U', { shift: true }))" :aria-pressed="state.listType === 'ol'" @click="cmd().executeList(ListType.OL)"><OeIcon name="listNumber" /></button>
      <button type="button" class="fmt" aria-label="项目符号" :title="tip('项目符号', shortcut('I', { shift: true }))" :aria-pressed="state.listType === 'ul'" @click="cmd().executeList(ListType.UL, ListStyle.DISC)"><OeIcon name="list" /></button>
    </span>
    <span class="group">
      <button type="button" class="fmt" aria-label="表格" title="插入表格" data-pop="table" :aria-expanded="pop.name === 'table'" @click="toggle('table', $event, 240)"><OeIcon name="table" /></button>
      <button type="button" class="fmt" aria-label="图片" title="插入图片" @click="pickImage"><OeIcon name="image" /></button>
      <button type="button" class="fmt" aria-label="更多" title="更多" data-pop="more" :aria-expanded="pop.name === 'more' || pop.name === 'page'" @click="toggle(pop.name === 'page' ? 'page' : 'more', $event, 200)"><OeIcon name="more" /></button>
    </span>
    <span class="group">
      <button v-if="fieldButton" type="button" class="button-tinted" :disabled="!canField" @click="emit('field')">设为字段</button>
      <button type="button" class="fmt" aria-label="可编辑区" title="可编辑区" :aria-pressed="state.area" :disabled="!state.canArea" @click="emit('area')"><OeIcon name="area" /></button>
      <button type="button" class="fmt" aria-label="条件条款" title="条件条款：按字段的值出不出这段" :aria-pressed="state.condition" :disabled="!state.canCondition" @click="emit('condition', ($event.currentTarget as HTMLElement).getBoundingClientRect())"><OeIcon name="branch" /></button>
    </span>
  </div>
  </div>

  <div v-if="pop.name === 'color'" class="popover format-pop color-pop" editor-component="component" :style="pos" @mousedown.prevent>
    <div class="pop-head"><span>文字颜色</span><button type="button" class="pop-link" @click="run(() => cmd().executeColor(null))">自动</button></div>
    <div class="swatches">
      <button v-for="c in TEXT_COLORS" :key="c" type="button" class="swatch" :aria-label="`文字颜色 ${c}`" :aria-pressed="same(state.color, c)" :style="{ backgroundColor: c }" @click="run(() => cmd().executeColor(c))"></button>
    </div>
    <div class="pop-head"><span>突出显示</span><button type="button" class="pop-link" @click="run(() => cmd().executeHighlight(null))">无</button></div>
    <div class="swatches">
      <button v-for="c in HIGHLIGHTS" :key="c" type="button" class="swatch" :aria-label="`突出显示 ${c}`" :aria-pressed="same(state.highlight, c)" :style="{ backgroundColor: c }" @click="run(() => cmd().executeHighlight(c))"></button>
    </div>
  </div>

  <div v-if="pop.name === 'spacing'" class="popover menu format-pop" role="menu" aria-label="行距" editor-component="component" :style="pos" @mousedown.prevent>
    <button v-for="v in ROW_MARGINS" :key="v" type="button" role="menuitemradio" :aria-checked="Math.abs(state.rowMargin - v) < 0.01" @click="run(() => cmd().executeRowMargin(v))">
      <span class="menu-check"><OeIcon v-if="Math.abs(state.rowMargin - v) < 0.01" name="checkmark" /></span>{{ Number.isInteger(v) ? v.toFixed(1) : v }}
    </button>
  </div>

  <div v-if="pop.name === 'table'" class="popover format-pop table-pop" editor-component="component" :style="pos" @mousedown.prevent @pointerleave="grid.rows = grid.cols = 0">
    <div class="table-grid" role="group" aria-label="选择表格行列">
      <button
        v-for="i in 80"
        :key="i"
        type="button"
        class="cell"
        :class="{ on: cellAt(i - 1).rows <= grid.rows && cellAt(i - 1).cols <= grid.cols }"
        :aria-label="`${cellAt(i - 1).rows} 行 ${cellAt(i - 1).cols} 列`"
        @pointerenter="Object.assign(grid, cellAt(i - 1))"
        @focus="Object.assign(grid, cellAt(i - 1))"
        @click="insertTable"
      ></button>
    </div>
    <div class="table-size">{{ grid.rows && grid.cols ? `${grid.rows} 行 × ${grid.cols} 列` : '插入表格' }}</div>
  </div>

  <div v-if="pop.name === 'more'" class="popover menu format-pop more-menu" role="menu" aria-label="更多" editor-component="component" :style="pos" @mousedown.prevent>
    <button type="button" role="menuitemcheckbox" :aria-checked="state.type === 'superscript'" @click="run(() => cmd().executeSuperscript())"><span>上标</span><span class="menu-shortcut">{{ shortcut('>', { shift: true }) }}</span></button>
    <button type="button" role="menuitemcheckbox" :aria-checked="state.type === 'subscript'" @click="run(() => cmd().executeSubscript())"><span>下标</span><span class="menu-shortcut">{{ shortcut('<', { shift: true }) }}</span></button>
    <div class="menu-divider" role="separator"></div>
    <button type="button" role="menuitem" @click="run(() => cmd().executePainter({ isDblclick: false }))"><span>格式刷</span></button>
    <button type="button" role="menuitem" @click="run(() => cmd().executeFormat())"><span>清除格式</span></button>
    <div class="menu-divider" role="separator"></div>
    <button type="button" role="menuitem" data-pop="symbol" @click="openFromMore('symbol')"><span>符号和日期</span></button>
    <button type="button" role="menuitem" @click="run(() => cmd().executeSeparator([]))"><span>分隔线</span></button>
    <button type="button" role="menuitem" @click="run(() => cmd().executePageBreak())"><span>分页符</span></button>
    <div class="menu-divider" role="separator"></div>
    <button type="button" role="menuitem" @click="editZone(EditorZone.HEADER)"><span>编辑页眉</span></button>
    <button type="button" role="menuitem" @click="editZone(EditorZone.FOOTER)"><span>编辑页脚</span></button>
    <button type="button" role="menuitem" data-pop="page" @click="openFromMore('page')"><span>页面设置</span><span class="menu-shortcut">纸张、页码、水印</span></button>
  </div>

  <div v-if="pop.name === 'symbol'" class="popover format-pop symbol-pop" aria-label="符号和日期" editor-component="component" :style="pos" @mousedown.prevent>
    <div class="pop-head"><span>符号</span></div>
    <div class="symbols">
      <button v-for="s in SYMBOLS" :key="s" type="button" class="symbol" :aria-label="`插入 ${s}`" @click="insertSymbol(s)">{{ s }}</button>
    </div>
    <div class="pop-head"><span>今天</span></div>
    <div class="dates">
      <button v-for="d in todayTexts()" :key="d" type="button" class="button-tinted" @click="insertSymbol(d)">{{ d }}</button>
    </div>
  </div>

  <form v-if="pop.name === 'page'" class="popover format-pop field-form page-pop" aria-label="页面设置" editor-component="component" :style="pos" @submit.prevent @keydown.esc="close">
    <div class="pop-head"><span>页面设置</span></div>
    <label>纸张<select aria-label="纸张" :value="pageForm.paper" @change="setPage({ paper: ($event.target as HTMLSelectElement).value })">
      <option v-if="!pageForm.paper" value="">自定义</option>
      <option v-for="p in PAPERS" :key="p.label" :value="p.label">{{ p.label }}</option>
    </select></label>
    <div class="segmented small" role="radiogroup" aria-label="方向" @mousedown.prevent>
      <button type="button" role="radio" :aria-selected="!pageForm.horizontal" :aria-checked="!pageForm.horizontal" @click="setPage({ horizontal: false })">纵向</button>
      <button type="button" role="radio" :aria-selected="pageForm.horizontal" :aria-checked="pageForm.horizontal" @click="setPage({ horizontal: true })">横向</button>
    </div>
    <div class="pop-head"><span>页边距（毫米）</span></div>
    <div class="margin-grid">
      <label v-for="[n, i] in MARGIN_INPUTS" :key="n">{{ n }}<input type="number" min="0" max="100" step="0.5" :aria-label="`${n}边距`" :value="pageForm.margins[i]" @change="setPage({ margin: [i, Number(($event.target as HTMLInputElement).value)] })" /></label>
    </div>
    <div class="pop-head"><span>页码</span></div>
    <select aria-label="页码格式" :value="pageNumber.disabled ? '' : pageNumber.format" @change="setPageNumber({ format: ($event.target as HTMLSelectElement).value })">
      <option value="">不显示</option>
      <option v-for="f in PAGE_NUMBER_FORMATS" :key="f.value" :value="f.value">{{ f.label }}</option>
      <option v-if="!pageNumber.known" :value="pageNumber.format">{{ pageNumber.format.replace('{pageNo}', '1').replace('{pageCount}', 'N') }}</option>
    </select>
    <div class="segmented small" role="radiogroup" aria-label="页码位置" @mousedown.prevent>
      <button v-for="[v, n] in ([['left', '左'], ['center', '中'], ['right', '右']] as const)" :key="v" type="button" role="radio" :disabled="pageNumber.disabled" :aria-selected="pageNumber.rowFlex === v" :aria-checked="pageNumber.rowFlex === v" @click="setPageNumber({ rowFlex: v })">{{ n }}</button>
    </div>
    <label>水印<input list="oe-watermarks" aria-label="水印" placeholder="无" maxlength="20" :value="page?.watermark?.data ?? ''" @change="setWatermark(($event.target as HTMLInputElement).value)" /></label>
    <datalist id="oe-watermarks"><option v-for="w in WATERMARKS" :key="w" :value="w"></option></datalist>
  </form>
</template>
