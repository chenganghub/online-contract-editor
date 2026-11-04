<script setup lang="ts">
// 编辑器组件：真实的 canvas-editor + 四种模式 + 检查器 + 数据选择弹层 + 盖章层。
// 界面按 docs/设计/04-界面规范.md，结构和原型 spike/canvas/ui.html 一致。
// 同字段同步、盖章写法来自 K9a 验证和方案第 12 节第 2 轮第 4、5 条。
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, toRaw, watch } from 'vue'
import Editor, { AreaMode, EditorMode, LocationPosition, PaperDirection, type ICatalogItem, type IEditorOption, type IElement, type IRangeStyle } from '@hufe921/canvas-editor'
import {
  AREA_MAX_LENGTH,
  AREA_MAX_RUNS,
  applyBatch,
  type BatchResult,
  type Op,
  DEFAULT_FONT,
  DEFAULT_SIZE,
  areaAnchors,
  hasChoices,
  htmlDocument,
  textDocument,
  areaStyle,
  layoutOptions,
  pageSize,
  setFieldValues,
  type LayoutOptions,
  toChineseAmount,
  type AreaRun,
  type DocData,
  type DocValues,
  type FieldDef,
  type FieldType,
  type FieldValue,
  type Mode,
  type PageSetup,
  type Permission,
  type Snapshot,
} from '@oe/core'
import { FIELD_KEY, fieldElement } from './elements'
import { uid } from './ids'
import { anchorSeals, type SealElement } from './seals'
import OeIcon from './OeIcon.vue'
import FormatBar from './FormatBar.vue'
import FindBar from './FindBar.vue'
import StatusBar from './StatusBar.vue'
import TemplateFields from './TemplateFields.vue'
import TemplateBlanks from './TemplateBlanks.vue'
import TemplatePreview from './TemplatePreview.vue'
import { useTemplateDesign } from './useTemplateDesign'
import { shortcut, tip, type FormatState } from './formats'
import {
  EXTENSION,
  IMPORT_ACCEPT,
  IMPORT_LIMIT,
  MIME,
  docParts,
  downloadBlob,
  exportDocxInBrowser,
  htmlToDoc,
  importDocxInBrowser,
  importFormatOf,
  markdownToHtml,
  parseDocumentJson,
  pdfFromImages,
  safeName,
  textToElements,
  zipImages,
  type DocumentFile,
  type ExportFormat,
  type ImportFormat,
} from './files'
import type { DocActions, EditorEvents, ImportResult, PickItem, PickSearch, PreviewSample, SavePayload, SealOp, SealOption } from './types'

const props = defineProps<{
  mode: Mode
  modes?: Mode[]
  title?: string
  doc: DocData
  values?: DocValues
  fields: FieldDef[]
  libraryFields?: FieldDef[]
  permissions?: Record<string, Permission>
  actions?: DocActions
  seals?: SealOption[]
  search?: PickSearch
  save: (payload: SavePayload) => Promise<void>
  publish?: () => Promise<void>
  previewSamples?: PreviewSample[]
  download?: (format: 'pdf' | 'docx') => void | Promise<void>
  onSeal?: (op: SealOp) => Promise<void>
  importDocx?: (file: File) => Promise<ImportResult>
  /** 有没保存的修改时离开页面提醒；不传算开 */
  confirmLeave?: boolean
}>()

// 给宿主的事件（SDK 的 on，iframe 嵌入转发给父页面）：名字和载荷见 types.ts 的 EditorEvents
const emit = defineEmits<{
  ready: []
  change: []
  'field-change': [change: EditorEvents['field-change']]
  saved: [info: EditorEvents['saved']]
  'mode-change': [mode: Mode]
  'dirty-change': [dirty: boolean]
  'field-focus': [field: EditorEvents['field-focus']]
}>()

const MODE_NAMES: Record<Mode, string> = { edit: '编辑', fill: '填写', seal: '盖章', view: '只读' }
const PRIMARY: Record<Mode, string> = { edit: '保存', fill: '提交', seal: '完成', view: '下载' }
const DONE: Record<Mode, string> = { edit: '已保存', fill: '已提交', seal: '已完成', view: '已保存' }
const TYPE_NAMES: Record<string, string> = { text: '文本', number: '数字', amount: '金额', date: '日期', select: '下拉', radio: '单选', checkbox: '复选', picker: '数据选择', computed: '计算', image: '图片', loop: '表格循环' }
// 盖章、只读用打印模式：不画控件底色和占位提示，看到的就是成稿；打印模式同样不能改正文
const EDITOR_MODE: Record<Mode, EditorMode> = { edit: EditorMode.EDIT, fill: EditorMode.FORM, seal: EditorMode.PRINT, view: EditorMode.PRINT }
const PERMS: [Permission, string][] = [['editable', '可编辑'], ['readonly', '只读'], ['required', '必填'], ['hidden', '隐藏']]
const SEAL_SIZE = 151
// 纸张按文档自己的设置（docx 导入的可能是横向），排版选项和渲染服务同一套
// 导入 Word 后纸张可能变（横向、页边距），这三个跟着换
let layout = layoutOptions(props.doc.page)
const PAGE = reactive(pageSize(props.doc.page))
const pageSetup = shallowRef(props.doc.page)
/** 正文宽度：横放时编辑器把页边距转 90°（上、右、下、左 ← 右、下、左、上） */
const innerWidth = () => {
  const m = layout.margins
  return PAGE.width - (layout.paperDirection === 'horizontal' ? m[2] + m[0] : m[1] + m[3])
}

const root = ref<HTMLElement>()
const docEl = ref<HTMLDivElement>()
const pagesEl = ref<HTMLElement>()
const canvasEl = ref<HTMLElement>()
const modesEl = ref<HTMLElement>()
const pickerEl = ref<HTMLElement>()
const searchEl = ref<HTMLInputElement>()
const exportBtn = ref<HTMLButtonElement>()
const addBtn = ref<HTMLButtonElement>()
const draftEl = ref<HTMLElement>()
const editor = shallowRef<Editor>()

const mode = ref<Mode>(props.mode)
const status = ref('已保存')
const saving = ref(false)
// 有没保存的修改：编辑过、导入过就算；保存、提交、发布成功（含盖章操作交给宿主成功）清掉。失败的提示不改它
const dirty = ref(false)
const SAVED_STATES = new Set(['已保存', '已提交', '已完成', '已发布'])
watch(status, (s) => {
  if (s === '已编辑' || s === '已导入') dirty.value = true
  else if (SAVED_STATES.has(s)) dirty.value = false
})
/** 状态文字用主色提醒：没填完、格式不对、保存失败这类 */
const NORMAL_STATES = new Set([...SAVED_STATES, '已编辑', '已导入', '正在保存', '正在导入', '正在导出'])
const attention = computed(() => !NORMAL_STATES.has(status.value))
const fields = reactive<FieldDef[]>(structuredClone(props.fields))
const perms = reactive<Record<string, Permission>>({ ...props.permissions })
const snapshots = reactive<Record<string, Snapshot>>({ ...props.values?.snapshots })
const active = ref<{ conceptId: string; controlId: string } | null>(null)
const preview = shallowRef<DocData>()
const blankRevision = ref(0)
const tick = ref(0)
const thumb = reactive({ width: 0, x: 0 })
// 光标处的样式，格式栏和撤销重做按钮按它显示（字段说明见 formats.ts 的 FormatState）
const style = reactive<FormatState>({
  bold: false, italic: false, underline: false, strikeout: false, type: '', font: DEFAULT_FONT, size: DEFAULT_SIZE, color: null, highlight: null,
  rowFlex: 'left', rowMargin: 1, listType: '', level: '', painter: false, undo: false, redo: false, area: false, canArea: false,
})
// 状态栏：当前页（从 0 起）、页数、字数、缩放比例。缩放也会被 canvas-editor 自己的 Ctrl + 滚轮改，以它的事件为准
const pageNo = ref(0)
const pageCount = ref(1)
const words = ref<number | null>(null)
const scale = ref(1)
const scrollId = uid()
const shownModes = computed(() => props.modes ?? [props.mode])
// 打印、下载按令牌（宿主给的 actions）；下载见「下载」一节的 canExport
const canPrint = computed(() => props.actions?.print !== false)

interface Placed { id: string; sealId: string; name: string; src: string; pageNo: number; x: number; y: number }
const placed = ref<Placed[]>([])
const handles = ref<(Placed & { left: number; top: number })[]>([])
const dragging = ref<string | null>(null)
const dropTarget = ref(false)

const picker = reactive({ open: false, field: null as FieldDef | null, query: '', page: 0, index: 0, items: [] as PickItem[], pages: 1, left: 0, top: 0, origin: 'top center' })
const menu = reactive({ open: false, left: 0, top: 0 })

const cmd = () => editor.value!.command
const fieldOf = (key: string) => fields.find((f) => f.key === key)
const permOf = (key: string): Permission => perms[key] ?? fieldOf(key)?.permission ?? 'editable'
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------- 程序改文档时不算用户编辑 ----------
let applying = false
let quietUntil = 0
const quiet = () => (quietUntil = performance.now() + 300)
const silently = (fn: () => void) => {
  applying = true
  quiet()
  try {
    fn()
  } finally {
    applying = false
  }
}

// ---------- 字段值 ----------
const valueOf = (key: string) => {
  void tick.value
  // 直接以填写模式打开时，检查器在编辑器建好之前就要渲染（s6 实测：这里报错，整个组件起不来）
  if (!editor.value) return ''
  return (cmd().getControlValue({ conceptId: key })?.[0]?.value as string | undefined) ?? ''
}
/** 检查器里显示的值：下拉、单选、复选的值是 code，显示成选项文字（多选用顿号隔开） */
const shownOf = (key: string) => {
  void tick.value
  if (!editor.value) return ''
  const c = cmd().getControlValue({ conceptId: key })?.[0]
  if (!c?.value) return ''
  if (c.type !== 'select' && c.type !== 'radio' && c.type !== 'checkbox') return c.value
  return c.value.split(',').map((code) => c.valueSets?.find((s) => s.code === code)?.value ?? code).join('、')
}
const readOne = (id: string) => (cmd().getControlValue({ id })?.[0]?.value as string | undefined) ?? ''
const idsOf = (key: string) => [
  ...new Set(cmd().getControlList().filter((e) => e.control?.conceptId === key).map((e) => e.controlId!)),
]

// 注意：canvas-editor 的设值、改属性命令传 isSubmitHistory: false 时会清空整个撤销栈（HistoryManager.recovery），
// 不是「不进历史」。所以同步写入照常进撤销历史，撤销 / 重做由下面的 undoRedo 处理，保证同字段一致。

/** 字段值对应的计算字段（金额大写）的值 */
const computedFor = (key: string, v: string) =>
  fields.filter((f) => f.computed?.fn === 'amountCN' && f.computed.from === key).map((f) => ({ conceptId: f.key, value: v ? toChineseAmount(v) : '' }))

/**
 * 下拉、单选、复选按 code 写（编辑器只认 code）：给的是选项文字的换成 code，复选可以是数组或逗号隔开，和服务端 setFieldValues 一样。
 * 选项按控件上的取（字典数据源的选项装在控件上），没有再按字段定义。
 * strict：有不认识的选项就报错、这一批都不写（宿主 setData）；不 strict 时原样写（数据选择带出，和以前一样）
 */
function optionCodes(values: Record<string, FieldValue>, strict: boolean): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {}
  for (const [key, v] of Object.entries(values)) {
    const type = fieldOf(key)?.type
    if ((type !== 'select' && type !== 'radio' && type !== 'checkbox') || v === null || v === undefined || v === '') {
      out[key] = v
      continue
    }
    const sets: { value: string; code: string }[] = cmd().getControlValue({ conceptId: key })?.[0]?.valueSets ?? fieldOf(key)?.options ?? []
    const list = type === 'checkbox' ? (Array.isArray(v) ? v.map(String) : String(v).split(',')) : [String(v)]
    out[key] = list
      .map((raw) => {
        const hit = sets.find((s) => s.code === raw) ?? sets.find((s) => s.value === raw)
        if (!hit && strict) throw new Error(`字段 ${key} 没有选项「${raw}」，可选：${sets.map((s) => `${s.value}/${s.code}`).join('、')}`)
        return hit?.code ?? raw
      })
      .join(',')
  }
  return out
}

/**
 * 写字段值。文字类：同字段所有控件、计算字段一起写，一次命令，撤销时算一步。
 * 表格循环、图片：用 @oe/core 的 setFieldValues 改文档 JSON 再装回，浏览器和服务端同一套代码（方案 4.6）；装回会清空撤销历史。
 * 选项类先换成 code（optionCodes）
 */
function setValues(input: Record<string, FieldValue>, strict = false) {
  const values = optionCodes(input, strict)
  const structural = Object.keys(values).filter((k) => ['loop', 'image'].includes(fieldOf(k)?.type ?? ''))
  if (structural.length) {
    const data = readDoc()
    // 值不合法（循环不是数组、图片不是 dataURL、文档里没有绑定的表格或图片）时 setFieldValues 先抛错、不改文档，这一批都不生效
    setFieldValues(data as unknown as Parameters<typeof setFieldValues>[0], Object.fromEntries(structural.map((k) => [k, values[k]!])), plain(fields))
    silently(() => cmd().executeSetValue(data))
    // 新生成的循环行也要继承当前模式和字段权限，与保存重开时一致。
    applyPermissions()
    // 装回后字段控件的 controlId 不变（保存时带着）；万一有对不上的，丢掉「最后输入的控件」记录，同步时按第一处来
    for (const [k, id] of Object.entries(lastTyped)) if (!idsOf(k).includes(id)) delete lastTyped[k]
  }
  const list = Object.entries(values)
    .filter(([k]) => !structural.includes(k))
    .flatMap(([conceptId, v]) => {
      const value = v === null || v === undefined ? '' : String(v)
      return [{ conceptId, value }, ...computedFor(conceptId, value)]
    })
  if (list.length) silently(() => cmd().executeSetControlValueList(list))
  tick.value++
}

// 同字段同步（方案第 12 节第 2 轮第 5 条）：记住每个字段最后被手输的控件，延迟一拍按 controlId 只写其他控件
const lastTyped: Record<string, string> = {}
function syncFrom(key: string, sourceId: string) {
  const ids = idsOf(key)
  if (!ids.includes(sourceId)) return
  const v = readOne(sourceId)
  const list = [
    ...ids.filter((id) => id !== sourceId && readOne(id) !== v).map((id) => ({ id, value: v })),
    ...computedFor(key, v).filter((c) => (cmd().getControlValue({ conceptId: c.conceptId })?.[0]?.value ?? '') !== c.value),
  ]
  if (!list.length) return
  const restore = keepCursor(sourceId)
  silently(() => cmd().executeSetControlValueList(list))
  restore()
}
/**
 * 写前面的同字段控件会让后面元素的下标整体移动，光标（按下标记）就不在正在输入的控件里了，接着打的字会落到别处（s6 实测：
 * 在第二处输入「甲乙丙」，只同步了「甲」）。写之前记下光标离控件开头多远，写完按控件新的开头放回去。只处理正文里的控件。
 */
function keepCursor(controlId: string): () => void {
  const r = cmd().getRange()
  if (r.startIndex < 0 || r.tableId || cmd().getRangeContext()?.zone !== 'main') return () => {}
  const start = () => {
    silently(() => cmd().executeLocationControl(controlId, { position: LocationPosition.BEFORE }))
    return cmd().getRange().startIndex
  }
  const offset = r.startIndex - start()
  const length = r.endIndex - r.startIndex
  return () => {
    const s = start()
    silently(() => cmd().executeSetRange(s + offset, s + offset + length))
  }
}
function resyncAll() {
  for (const f of fields) {
    const ids = idsOf(f.key)
    const source = lastTyped[f.key] && ids.includes(lastTyped[f.key]!) ? lastTyped[f.key]! : ids[0]
    if (source) syncFrom(f.key, source)
  }
  tick.value++
}
let syncTimer = 0

/** 同字段的控件值都相同，计算字段等于按来源算出的值 */
function consistent(): boolean {
  for (const f of fields) {
    const vals = idsOf(f.key).map(readOne)
    if (new Set(vals).size > 1) return false
    for (const c of computedFor(f.key, vals[0] ?? '')) if ((cmd().getControlValue({ conceptId: c.conceptId })?.[0]?.value ?? '') !== c.value) return false
  }
  return true
}
/** 用户的一次编辑后面跟着一条同步记录：撤销 / 重做一步后不一致，说明只撤了一半，再走一步 */
function undoRedo(redo: boolean) {
  clearTimeout(syncTimer)
  const step = () => (redo ? cmd().executeRedo() : cmd().executeUndo())
  quiet()
  step()
  if (!consistent()) step()
  status.value = '已编辑'
  tick.value++
}

// ---------- 模式和权限 ----------
/** 取整篇文档（带 id、controlId）。打印模式（盖章、只读）下 getValue 取不到控件（s11 实测），先切到编辑模式取完再切回 */
function readDoc() {
  const m = cmd().getOptions().mode
  if (m !== EditorMode.PRINT) return cmd().getValue({ extraPickAttrs: ['id', 'controlId'] }).data
  let out!: ReturnType<ReturnType<typeof cmd>['getValue']>['data']
  silently(() => {
    cmd().executeMode(EditorMode.EDIT)
    out = cmd().getValue({ extraPickAttrs: ['id', 'controlId'] }).data
    cmd().executeMode(m)
  })
  return out
}

// 不用 executeSetControlPropertiesList：它把整篇文档重新压缩再装回，只带 id 不带 controlId，所有控件的 controlId 都会换新的（s6 实测）。
// 改成在文档 JSON 上设好属性，用 executeSetValue 装回：controlId 不变；setValue 同时清空撤销历史，
// 填写模式里不能一路撤销到权限生效之前，绕过只读、隐藏
function applyPermissions() {
  const want = new Map(
    fields.map((f) => {
      const p = mode.value === 'fill' ? permOf(f.key) : 'editable'
      return [f.key, { disabled: f.type === 'computed' || p === 'readonly', required: p === 'required', hide: p === 'hidden', placeholder: f.label, ...(f.type === 'date' ? { dateFormat: f.format } : {}) }]
    }),
  )
  const data = readDoc()
  const visit = (list: IElement[] | undefined, loopKey?: string) => {
    for (const e of list ?? []) {
      const p = e.type === 'control' && e.control?.conceptId ? want.get(e.control.conceptId) : undefined
      if (p) Object.assign(e.control!, p)
      const loopPermission = loopKey && want.get(loopKey)
      if (e.type === 'control' && loopPermission) {
        const { disabled, required, hide } = loopPermission
        Object.assign(e.control!, { disabled, required, hide })
      }
      // 区域按模式设能不能改、底色（可编辑区，见 areaLook）
      const a = (e as IElement & AreaEl).area
      if (e.type === 'area' && a) Object.assign(a, areaLook(e as IElement & AreaEl))
      if (e.valueList) visit(e.valueList, loopKey)
      for (const tr of e.trList ?? []) {
        const key = (tr as { extension?: { loop?: string } }).extension?.loop
        for (const td of tr.tdList) visit(td.value, key)
      }
    }
  }
  visit(data.header)
  visit(data.main)
  visit(data.footer)
  // 装回也在编辑模式下做（打印模式下装文档不生效），装完切回当前模式
  const m = cmd().getOptions().mode
  silently(() => {
    cmd().executeMode(EditorMode.EDIT)
    cmd().executeSetValue(data)
    cmd().executeMode(m)
  })
  // 印章挂在正文里各自那一页，装回后位置不变（setValue 原样保留元素顺序）
}
function moveThumb() {
  const sel = modesEl.value?.querySelector<HTMLElement>('button[aria-selected="true"]')
  if (!sel) return
  thumb.width = sel.offsetWidth
  thumb.x = sel.offsetLeft - 2
}
async function setMode(next: Mode) {
  if (next === mode.value) return
  closeFind()
  mode.value = next
  quiet()
  cmd().executeMode(EDITOR_MODE[next])
  applyPermissions()
  closePicker()
  menu.open = false
  flagged.value = new Set()
  emit('mode-change', next)
  await nextTick()
  moveThumb()
  renderHandles()
}

// ---------- 检查器 ----------
function insertField(f: FieldDef) {
  if (cmd().getRange().startIndex < 0) cmd().executeSetRange(0, 0)
  cmd().executeInsertElementList([fieldElement(toRaw(f), innerWidth())])
  status.value = '已编辑'
}

function insertLibraryField(field: FieldDef) {
  // 保留已经使用的定义；同时登记回填和计算依赖，保存时字段引用保持完整。
  const register = (f: FieldDef) => {
    if (fieldOf(f.key)) return
    fields.push(structuredClone(toRaw(f)))
    for (const key of [...Object.keys(f.fill ?? {}), ...(f.computed ? [f.computed.from] : [])]) {
      const dependency = props.libraryFields!.find((d) => d.key === key)!
      register(dependency)
    }
  }
  register(field)
  insertField(fieldOf(field.key)!)
}

const design = useTemplateDesign({ editor, mode, library: () => props.libraryFields, canConvert: canConvertField, insert: insertLibraryField, anchor: cursorRect })
function selectBlank() { design.refresh(); revealCursor(); design.open() }
function renameField(key: string, label: string) {
  if (!label.trim()) return
  fieldOf(key)!.label = label.trim()
  applyPermissions()
  status.value = '已编辑'
}
function inspectField(f: FieldDef) {
  if (!props.libraryFields) return insertField(f)
  const control = cmd().getControlList().find((c) => c.control?.conceptId === f.key)
  if (!control) return
  locate(f.key)
  active.value = { conceptId: f.key, controlId: control.controlId! }
}

// 新建字段：名称、类型、键（选项类再填选项），填好才能添加；添加后插到光标处
const NEW_TYPES: FieldType[] = ['text', 'number', 'amount', 'date', 'select', 'radio', 'checkbox', 'picker', 'image']
const OPTION_TYPES: FieldType[] = ['select', 'radio', 'checkbox']
const draft = reactive({ open: false, label: '', type: 'text' as FieldType, key: '', options: '', left: 0, top: 0 })
const draftOptions = computed(() => [...new Set(draft.options.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean))])
const draftOk = computed(
  () => !!draft.label.trim() && FIELD_KEY.test(draft.key.trim()) && !fieldOf(draft.key.trim()) && (!OPTION_TYPES.includes(draft.type) || draftOptions.value.length > 0),
)
function openDraft() {
  if (draft.open) return (draft.open = false)
  let n = fields.length + 1
  while (fieldOf(`field${n}`)) n++
  const r = addBtn.value!.getBoundingClientRect()
  Object.assign(draft, { open: true, label: '', type: 'text', key: `field${n}`, options: '', left: Math.max(8, r.right - 320), top: r.bottom + 8 })
  void nextTick(() => draftEl.value?.querySelector('input')?.focus())
}
function addField() {
  if (!draftOk.value) return
  const f: FieldDef = { key: draft.key.trim(), label: draft.label.trim(), type: draft.type }
  if (OPTION_TYPES.includes(f.type)) f.options = draftOptions.value.map((value) => ({ value, code: value }))
  if (f.type === 'picker') f.dataSource = { id: f.key, kind: 'host' }
  fields.push(f)
  draft.open = false
  insertField(f)
}
function setPermission(key: string, p: Permission) {
  const f = fieldOf(key)
  if (f) f.permission = p
  status.value = '已编辑'
}
function locate(key: string) {
  const [id] = idsOf(key)
  if (!id) return
  cmd().executeLocationControl(id, { position: LocationPosition.AFTER })
  docEl.value?.querySelector<HTMLElement>('.ce-inputarea')?.focus({ preventScroll: true })
  revealCursor()
}
// 表格循环、图片的值由宿主给（setData），填写模式里不列
const visibleFields = computed(() => fields.filter((f) => permOf(f.key) !== 'hidden' && f.type !== 'loop' && f.type !== 'image'))
const fillable = computed(() => visibleFields.value.filter((f) => f.type !== 'computed' && permOf(f.key) !== 'readonly'))
const filledCount = computed(() => fillable.value.filter((f) => valueOf(f.key)).length)
/** 「下一项」：从当前字段往后找第一个没填的，到底了从头找 */
function nextField() {
  const list = fillable.value
  const from = active.value ? list.findIndex((f) => f.key === active.value!.conceptId) : -1
  const next = [...list.slice(from + 1), ...list.slice(0, from + 1)].find((f) => !valueOf(f.key))
  if (next) locate(next.key)
}
/** 字段列表里没有值时显示的字：计算字段自动算，只读的由宿主带 */
const emptyHint = (f: FieldDef) => (f.type === 'computed' ? '自动' : permOf(f.key) === 'readonly' ? '只读' : '未填')
const isNumber = (v: string) => /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, ''))
const badFormat = (f: FieldDef, v: string) => (f.type === 'number' || f.type === 'amount') && !!v && !isNumber(v)
// 上次校验时没填的必填字段、格式不对的字段：列表里标出来，改对了就不标
const flagged = ref(new Set<string>())
const isFlagged = (f: FieldDef) => flagged.value.has(f.key) && (!valueOf(f.key) || badFormat(f, valueOf(f.key)))

/** 校验（验收 5）：必填字段为空、数字和金额不是数字时报错，定位到第一个 */
function validate(): { ok: boolean; missing: string[]; invalid: string[] } {
  const missing = fields.filter((f) => permOf(f.key) === 'required' && !valueOf(f.key)).map((f) => f.key)
  const invalid = fields.filter((f) => permOf(f.key) !== 'hidden' && badFormat(f, valueOf(f.key))).map((f) => f.key)
  flagged.value = new Set([...missing, ...invalid])
  const first = missing[0] ?? invalid[0]
  if (first) locate(first)
  return { ok: !missing.length && !invalid.length, missing, invalid }
}

// ---------- 光标位置 ----------
function cursorRect() {
  const pos = cmd().getCursorPosition()
  const page = pos && docEl.value?.querySelectorAll('.ce-page-container canvas')[pos.pageNo]
  if (!pos || !page) return null
  const base = page.getBoundingClientRect()
  return { left: base.left + pos.coordinate.leftTop[0]!, top: base.top + pos.coordinate.leftTop[1]!, bottom: base.top + pos.coordinate.leftBottom[1]! }
}
function revealCursor() {
  const r = cursorRect()
  const view = canvasEl.value!.getBoundingClientRect()
  if (!r || (r.top >= view.top + 48 && r.bottom <= view.bottom - 48)) return
  canvasEl.value!.scrollBy({ top: r.top - view.top - view.height / 3, behavior: reduceMotion() ? 'auto' : 'smooth' })
}

// ---------- 数据选择弹层 ----------
// 远程数据源：打字快时请求会交叉返回，只认最后一次；请求失败按没有结果显示
let pickerSeq = 0
async function loadPicker() {
  if (!props.search || !picker.field) return
  const seq = ++pickerSeq
  let r: Awaited<ReturnType<PickSearch>>
  try {
    r = await props.search(picker.field, picker.query.trim(), picker.page)
  } catch {
    r = { items: [], total: 0, pageSize: 1 }
  }
  if (seq !== pickerSeq) return
  picker.items = r.items
  picker.pages = Math.max(1, Math.ceil(r.total / r.pageSize))
  picker.index = Math.min(picker.index, Math.max(0, r.items.length - 1))
}
async function openPicker(field: FieldDef) {
  const r = cursorRect()
  if (!r || !props.search) return
  Object.assign(picker, { open: true, field, query: '', page: 0, index: 0 })
  await loadPicker()
  await nextTick()
  // 贴着控件放在下方；放不下就放上方
  const h = pickerEl.value?.offsetHeight ?? 280
  const below = r.bottom + 6
  picker.top = below + h <= window.innerHeight - 8 ? below : Math.max(60, r.top - 6 - h)
  picker.left = Math.min(Math.max(8, r.left - 8), window.innerWidth - 328)
  picker.origin = picker.top < r.top ? 'bottom center' : 'top center'
  setTimeout(() => searchEl.value?.focus({ preventScroll: true }), 50)
}
function closePicker() {
  picker.open = false
}
function choose(item: PickItem | undefined) {
  const f = picker.field
  if (!item || !f) return
  const map = f.fill ?? { [f.key]: 'title' }
  const values = Object.fromEntries(Object.entries(map).map(([key, from]) => [key, String(item.record[from] ?? (from === 'title' ? item.title : ''))]))
  setValues(values)
  snapshots[f.key] = { sourceId: item.id, text: item.title, fields: values, at: new Date().toISOString() }
  status.value = '已编辑'
  closePicker()
}
// 弹层打开时上下键、回车、Esc 归弹层，不让编辑器收到
function onWindowKey(e: KeyboardEvent) {
  if (!picker.open || !['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'ArrowDown') picker.index = Math.max(0, Math.min(picker.items.length - 1, picker.index + 1))
  if (e.key === 'ArrowUp') picker.index = Math.max(0, picker.index - 1)
  if (e.key === 'Enter') choose(picker.items[picker.index])
  if (e.key === 'Escape') closePicker()
}
async function turn(delta: number) {
  picker.page = Math.min(picker.pages - 1, Math.max(0, picker.page + delta))
  await loadPicker()
}
// 输入停 200 毫秒再搜，不是每个字都发一次请求
let searchTimer = 0
function onSearch() {
  picker.page = 0
  picker.index = 0
  clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void loadPicker(), 200)
}

// ---------- 页面设置（格式栏「更多」里）：和导入 Word 换纸张一样，排版选项、页面尺寸、要存的 doc.page 一起换 ----------
function applyPage(next: PageSetup) {
  setPageLayout(next)
  status.value = '已编辑'
  void nextTick(renderHandles)
}
/** 换纸张、页边距、页码、水印：排版选项、页面尺寸、要存的 doc.page 一起换 */
function setPageLayout(next: PageSetup | undefined) {
  layout = layoutOptions(next)
  Object.assign(PAGE, pageSize(next))
  pageSetup.value = next
  const c = cmd()
  c.executePaperDirection(layout.paperDirection === 'horizontal' ? PaperDirection.HORIZONTAL : PaperDirection.VERTICAL)
  c.executePaperSize(layout.width, layout.height)
  c.executeSetPaperMargin([...layout.margins])
  // 页码、水印没有单独的命令，用 updateOptions 换；要带上现在的全部选项，见 updateLayout
  updateLayout({ pageNumber: layout.pageNumber, watermark: layout.watermark })
}
/**
 * canvas-editor 的 updateOptions 会把没传的选项都换回它的默认值（模式、控件颜色、滚动容器、缩放……），
 * 所以总是在现在的全部选项上盖要改的几项再传
 */
function updateLayout(patch: Partial<LayoutOptions>) {
  cmd().executeUpdateOptions({ ...cmd().getOptions(), ...structuredClone(patch) } as never)
}

// ---------- 查找替换 ----------
const findBar = ref<InstanceType<typeof FindBar>>()
// 编辑模式带替换（Ctrl+H 把焦点放到替换框）；填写模式只查找
const find = reactive({ open: false, toReplace: false, left: 0, top: 0, initial: '' })
const canFind = computed(() => mode.value === 'edit' || mode.value === 'fill')
/**
 * 位置不挡格式栏和「下一项」：填写模式放在正文区右上角（格式栏藏着，页面上方那一条是空的）；
 * 编辑模式放在格式栏下面、靠组件右边，盖住检查器上半截，不盖正文
 */
function findPosition() {
  const canvas = canvasEl.value!.getBoundingClientRect()
  if (mode.value !== 'edit') return { left: Math.max(8, canvas.right - 332), top: canvas.top + 12 }
  const bar = root.value!.querySelector('.format-bar')!.getBoundingClientRect()
  return { left: Math.max(8, root.value!.getBoundingClientRect().right - 336), top: bar.bottom + 8 }
}
function openFind(toReplace: boolean) {
  if (!canFind.value) return
  if (find.open) return findBar.value?.focus(toReplace)
  // 选中了一段文字（不跨段）就用它当查找内容
  const selected = cmd().getRangeText().trim()
  Object.assign(find, { open: true, toReplace, ...findPosition(), initial: selected && !selected.includes('\n') ? selected : '' })
}
function closeFind() {
  if (find.open) cmd().executeSearch(null)
  find.open = false
}

// ---------- 大纲：按标题（标题 1～6）跳转，从状态栏往上弹 ----------
const outline = reactive({ open: false, items: [] as { id: string; name: string; depth: number; pageNo: number }[], left: 0, bottom: 0 })
async function toggleOutline(anchor: DOMRect) {
  if (outline.open) return (outline.open = false)
  const items: typeof outline.items = []
  const walk = (list: ICatalogItem[], depth: number) => {
    for (const c of list) {
      items.push({ id: c.id, name: c.name.trim() || '（空标题）', depth, pageNo: c.pageNo })
      walk(c.subCatalog, depth + 1)
    }
  }
  walk((await cmd().getCatalog()) ?? [], 0)
  Object.assign(outline, { open: true, items, left: Math.max(8, anchor.left), bottom: window.innerHeight - anchor.top + 8 })
}
/** 编辑、填写模式把光标放到标题上；盖章、只读（打印模式）光标放不进去，滚到标题所在的页 */
function gotoOutline(item: { id: string; pageNo: number }) {
  outline.open = false
  if (cmd().getOptions().mode !== EditorMode.PRINT) {
    cmd().executeLocationCatalog(item.id)
    revealCursor()
  } else pageCanvases()[item.pageNo]?.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' })
}

// ---------- 缩放 ----------
function zoom(step: -1 | 0 | 1) {
  if (step < 0) cmd().executePageScaleMinus()
  else if (step > 0) cmd().executePageScaleAdd()
  else cmd().executePageScaleRecovery()
}
// 字数：内容变了停一会儿再数
let wordTimer = 0
function countWords() {
  clearTimeout(wordTimer)
  wordTimer = window.setTimeout(async () => {
    if (editor.value) words.value = await cmd().getWordCount()
  }, 400)
}

// ---------- 可编辑区（方案 4.2）----------
// 存在文档里的只有 area.extension = { anchor, editable }；能不能改、底色按当前模式现设（applyPermissions），保存时去掉。
// 可编辑区里只放文字（含上下标）：填写模式提交区域里的文字和样式，服务端按 anchor 换掉（@oe/core 的 applyAreas）
type AreaExtension = { anchor?: string; editable?: boolean } & Record<string, unknown>
type AreaProps = { extension?: AreaExtension; mode?: AreaMode; backgroundColor?: string; hide?: boolean }
type AreaEl = { area?: AreaProps; valueList?: IElement[] }
const AREA_TINT = 'rgba(0, 122, 255, 0.06)'
const TEXT_TYPES = new Set<string | undefined>([undefined, 'text', 'subscript', 'superscript'])
const isTextType = (el: IElement) => TEXT_TYPES.has(el.type)
/** 能放进可编辑区的：文字，不在字段、别的区域、列表、标题、表格里 */
const isPlainText = (el: IElement) => isTextType(el) && !el.controlId && !el.areaId && !el.listId && !el.titleId && !el.tableId
const isEditable = (a: AreaProps | undefined) => a?.extension?.editable === true && typeof a.extension.anchor === 'string' && a.extension.anchor !== ''
/** 区域里只有文字（含上下标），才能当可编辑区 */
const canBeArea = (list: IElement[] | undefined) => (list ?? []).every(isTextType)
/** 填写时能改文字的可编辑区：标成可编辑、没隐藏、里面只有文字（有字段的只能填字段） */
const isTextArea = (e: AreaEl) => isEditable(e.area) && !e.area?.hide && canBeArea(e.valueList)
/** 编辑模式都能改；填写模式只有能改文字的可编辑区能改，别的区域里只有字段能填；盖章、只读都不能改。可编辑区在编辑、填写时带浅底色 */
function areaLook(e: AreaEl): Pick<AreaProps, 'mode' | 'backgroundColor'> {
  if (mode.value === 'edit') return { mode: AreaMode.EDIT, backgroundColor: isTextArea(e) ? AREA_TINT : '' }
  if (mode.value === 'fill') return isTextArea(e) ? { mode: AreaMode.EDIT, backgroundColor: AREA_TINT } : { mode: AreaMode.FORM, backgroundColor: '' }
  return { mode: AreaMode.READONLY, backgroundColor: '' }
}
/** 格式栏「可编辑区」的选区：选中了一段文字（不跨字段、区域、列表、标题，不在表格里）才能设 */
function plainSelection(): IElement[] {
  const c = cmd()
  const range = c.getRange()
  if (range.startIndex === range.endIndex || range.tableId) return []
  const ctx = c.getRangeContext()
  if (!ctx || ctx.isTable || ctx.titleId) return []
  // 选中的元素是压缩过的（只选到半个字段时字段不在里面），选区两头的字另外看：在字段、区域、列表、标题里的不行
  const inside = (el: IElement | undefined) => !!el && (el.type === 'control' || !!el.controlComponent || !!el.areaId || !!el.listType || !!el.level)
  if (inside(ctx.startElement) || inside(ctx.endElement)) return []
  const selected = ctx.selectionElementList
  return selected.length && selected.every(isPlainText) ? selected : []
}
/** 字段允许放在单个表格单元格里；可编辑区仍沿用更严格的选区限制。 */
function canConvertField() {
  const range = cmd().getRange()
  const context = cmd().getRangeContext()
  return range.startIndex !== range.endIndex && !range.isCrossRowCol && !!context?.selectionElementList.length
    && context.selectionElementList.every((el) => isTextType(el) && !el.controlId && !el.controlComponent && !el.areaId)
}
/** 格式栏「可编辑区」：选中文字时把它设成可编辑区；光标在区域里时切换可不可编辑 */
function toggleArea() {
  const c = cmd()
  const cur = c.getAreaValue()
  if (cur) {
    const area = (cur.area ?? {}) as AreaProps
    const on = !isEditable(area)
    // 区域里有字段、图片、表格的不能设成可编辑区（填写时改不了里面的文字），只能取消
    if (on && !canBeArea(cur.value)) return
    const extension = { ...area.extension, anchor: area.extension?.anchor || `area-${uid()}`, editable: on }
    c.executeSetAreaProperties({ id: cur.id, properties: { extension, ...areaLook({ area: { ...area, extension }, valueList: cur.value }) } })
    Object.assign(style, { area: on, canArea: on || canBeArea(cur.value) })
  } else {
    const range = c.getRange()
    const value = plainSelection().map((el) => plain(el))
    if (!value.length) return
    const extension = { anchor: `area-${uid()}`, editable: true }
    c.executeInsertArea({ value, area: { extension, ...areaLook({ area: { extension }, valueList: value }) }, range: { startIndex: range.startIndex, endIndex: range.endIndex } })
    style.area = true
  }
  status.value = '已编辑'
}
/** 区域里的文字整理成提交的样子：上下标类型和样式（按 @oe/core 的 areaStyle 取，和服务端留下的一样）；空的不交 */
function areaRuns(list: IElement[] | undefined): AreaRun[] {
  return (list ?? []).flatMap((v) => {
    const value = String(v.value ?? '').replace(/\u200B/g, '')
    if (!value) return []
    const run: AreaRun = { value, ...areaStyle(v as unknown as Record<string, unknown>) }
    if (v.type === 'subscript' || v.type === 'superscript') run.type = v.type
    return [run]
  })
}
/**
 * 文档里的区域：去掉现设的能不能改和底色（只存 extension）。anchor 重复的（复制粘贴来的区域）按 @oe/core 的 areaAnchors 改名：
 * 存的模板里每个 anchor 不重复；填写时提交的 anchor 和服务端找区域的规则一样。返回能改文字的可编辑区的内容
 */
function cleanAreas(doc: DocData): Record<string, AreaRun[]> {
  const visit = (list: IElement[] | undefined) => {
    for (const e of list ?? []) {
      const a = (e as IElement & AreaEl).area
      if (e.type === 'area' && a) {
        // 复制一份再删，不动传进来的对象
        const copy = { ...a }
        delete copy.mode
        delete copy.backgroundColor
        ;(e as IElement & AreaEl).area = copy
      }
      if (e.valueList) visit(e.valueList)
      for (const tr of e.trList ?? []) for (const td of tr.tdList) visit(td.value)
    }
  }
  visit(doc.header as unknown as IElement[])
  visit(doc.main as unknown as IElement[])
  visit(doc.footer as unknown as IElement[])
  const out: Record<string, AreaRun[]> = {}
  for (const { anchor, el } of areaAnchors(doc)) {
    const e = el as unknown as IElement & AreaEl
    if (e.area?.extension?.anchor !== anchor) e.area!.extension = { ...e.area!.extension, anchor }
    if (isTextArea(e)) out[anchor] = areaRuns(e.valueList)
  }
  return out
}
// 填写模式只提交改过的可编辑区（和打开时、上次保存成功时比）：没改的不交，服务端也就不动它
let areaBaseline = new Map<string, string>()
const rememberAreas = (all: Record<string, AreaRun[]>) => (areaBaseline = new Map(Object.entries(all).map(([k, runs]) => [k, JSON.stringify(runs)])))

// ---------- 主按钮 ----------
// Vue 的响应式代理不能用 structuredClone，先取原对象再做 JSON 拷贝（字段定义和快照都是纯数据）
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(toRaw(v))) as T
// 保存时带上 id（图片、表格、印章）和 controlId（控件）：canvas-editor 默认不存这两个，重新打开会换新的；
// 装文档时它沿用已有的 controlId（验收 6：类型、id、绑定字段都不变）
/** 要保存的内容；all 是所有能改文字的可编辑区（保存成功后记下来，下次只交改过的） */
function collect(): { payload: SavePayload; all: Record<string, AreaRun[]> } {
  const doc = readDoc() as unknown as DocData
  if (pageSetup.value) doc.page = plain(pageSetup.value)
  const all = cleanAreas(doc)
  // 只有填写模式按区域提交；编辑模式交的是整份文档
  const areas = mode.value === 'fill' ? Object.fromEntries(Object.entries(all).filter(([k, runs]) => areaBaseline.get(k) !== JSON.stringify(runs))) : {}
  return { payload: { mode: mode.value, doc, values: { values: readValues(doc), snapshots: plain(snapshots) }, fields: plain(fields), areas }, all }
}
const data = () => collect().payload
/** 从文档里读出字段值：选项类读 code，其他读文字。只读字段定义里有的（循环行里的列不是字段） */
function readValues(doc: DocData): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {}
  const keys = new Set(fields.map((f) => f.key))
  const visit = (list: IElement[]) => {
    for (const e of list) {
      const c = e.control
      if (e.type === 'control' && c?.conceptId && keys.has(c.conceptId) && !(c.conceptId in out)) {
        const text = (c.value ?? []).map((v) => v.value).join('')
        out[c.conceptId] = c.type === 'select' || c.type === 'radio' || c.type === 'checkbox' ? (c.code ?? null) : text || null
      }
      if (e.valueList) visit(e.valueList)
      for (const tr of e.trList ?? []) {
        // 表格循环：循环行按列读成记录（列名是行里控件的 conceptId）；全空的行（只剩空模板时）不算
        const loop = (tr as { extension?: { loop?: string } }).extension?.loop
        if (loop && keys.has(loop)) {
          const rec: Record<string, string> = {}
          for (const td of tr.tdList) for (const x of td.value) if (x.type === 'control' && x.control?.conceptId) rec[x.control.conceptId] = (x.control.value ?? []).map((v) => v.value).join('')
          const rows = (out[loop] ??= []) as Record<string, string>[]
          if (Object.values(rec).some(Boolean)) rows.push(rec)
          continue
        }
        for (const td of tr.tdList) visit(td.value)
      }
    }
  }
  visit(doc.main)
  return out
}
async function primary(publish = false) {
  if (saving.value) return
  if (mode.value === 'view') return canExport.value ? exportFile('pdf') : undefined
  if (mode.value === 'fill') {
    const v = validate()
    if (!v.ok) {
      status.value = v.missing.length ? `${v.missing.length} 项未填` : `${v.invalid.length} 项格式不对`
      return
    }
  }
  // 还没执行的同步先执行掉，保存的文档里同字段一定一致（方案第 12 节第 1 轮第 5 条）
  clearTimeout(syncTimer)
  resyncAll()
  const { payload, all } = collect()
  // 可编辑区有字数上限（服务端也校验），超了不提交，免得已经填的字段一起白填；
  // 编辑模式查所有可编辑区：模板里存了超长的，之后填写的人一改就会被拒
  const checked = mode.value === 'fill' ? (payload.areas ?? {}) : mode.value === 'edit' ? all : {}
  if (Object.values(checked).some((runs) => runs.length > AREA_MAX_RUNS || runs.reduce((n, r) => n + r.value.length, 0) > AREA_MAX_LENGTH)) {
    status.value = '可编辑区太长'
    return
  }
  status.value = '正在保存'
  saving.value = true
  try {
    // 页数按打印模式数（编辑模式有占位文字，页数可能多），服务端导出时交给渲染服务核对（s11）
    payload.pageCount = ((await cmd().getImage({ pixelRatio: 0.1, mode: EditorMode.PRINT })) as string[]).length
    await props.save(payload)
    if (publish) await props.publish!()
    rememberAreas(all)
    status.value = publish ? '已发布' : DONE[mode.value]
    emit('saved', { mode: payload.mode, published: publish })
  } catch (e) {
    status.value = e instanceof Error ? e.message : '保存失败'
    throw e
  } finally {
    saving.value = false
  }
}
// ---------- 打开文件（编辑模式）：Word、HTML、Markdown、纯文本、JSON（files.ts）----------
// Word：宿主传了 importDocx 就交给服务端转换（渲染服务 /convert，会数页数、查字体），否则在浏览器里用同一个插件和补丁转。
// 打开文件就是换掉整篇文档（和打开 Word 一样），换上后显示导入报告
const fileEl = ref<HTMLInputElement>()
const report = shallowRef<ImportResult['report'] | null>(null)
const FORMAT_NAMES: Record<ImportFormat, string> = { docx: 'Word', html: 'HTML', md: 'Markdown', txt: '纯文本', json: 'JSON' }
function pickFile() {
  menu.open = false
  fileEl.value?.click()
}
async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) await importFile(file).catch(() => {})
}
/** 打开文件。不支持的格式、超过大小、内容不对时抛错，状态栏显示原因 */
async function importFile(file: File): Promise<void> {
  const format = importFormatOf(file.name)
  const fail = (text: string) => {
    status.value = text
    throw new Error(text)
  }
  if (mode.value !== 'edit') return fail('编辑模式才能打开文件')
  if (!format) return fail('不支持这种文件')
  if (file.size > IMPORT_LIMIT) return fail('文件超过 20 MB')
  status.value = '正在导入'
  try {
    if (format === 'docx') {
      const r = props.importDocx ? await props.importDocx(file) : await importDocxInBrowser(await file.arrayBuffer())
      return loadDocument(r.doc, r.report)
    }
    const text = await file.text()
    if (format === 'json') {
      const f = parseDocumentJson(text)
      for (const def of f.fields) if (!fieldOf(def.key)) fields.push(def)
      Object.assign(snapshots, f.values?.snapshots)
      return loadDocument(f.doc, summary('json', f.doc))
    }
    const parts = format === 'txt' ? { main: textToElements(text) } : htmlToDoc(format === 'md' ? markdownToHtml(text) : text, innerWidth())
    const doc = { header: [], footer: [], ...parts, page: pageSetup.value } as DocData
    loadDocument(doc, summary(format, doc))
  } catch (e) {
    status.value = '导入失败'
    throw e
  }
}
/** 不是 Word 的文件也给一份简短的导入报告：导了多少字 */
function summary(format: ImportFormat, doc: DocData): ImportResult['report'] {
  const count = (list: IElement[] | undefined): number =>
    (list ?? []).reduce((n, e) => n + String(e.value ?? '').replace(/\s/g, '').length + count(e.valueList) + (e.trList ?? []).reduce((m, tr) => m + tr.tdList.reduce((k, td) => k + count(td.value), 0), 0), 0)
  return { items: [{ kind: 'text', level: 'ok', message: `已打开 ${FORMAT_NAMES[format]} 文件（${count(doc.main)} 字）` }], textExact: true }
}
/** 换上一整篇文档：纸张设置跟着换，印章按文档里的重新挂上 */
function loadDocument(doc: DocData, rep: ImportResult['report'] | null) {
  silently(() => {
    setPageLayout(doc.page ?? pageSetup.value)
    cmd().executeSetValue({ header: doc.header ?? [], main: doc.main, footer: doc.footer ?? [] })
  })
  placed.value = sealsOf(doc.main)
  if (placed.value.length) silently(() => anchorSeals(editor.value!, plain(doc.main.filter((el) => placed.value.some((p) => p.id === el.id)) as unknown as SealElement[])))
  applyPermissions()
  report.value = rep
  rememberAreas(collect().all)
  // 长文档装完要排一阵版，排版引起的内容变化事件不算用户编辑
  quietUntil = performance.now() + 2000
  status.value = '已导入'
}

// ---------- 下载：各格式的文件内容；PDF、Word 宿主接了服务端时走宿主 ----------
// 下载按令牌（actions.download）；不给也能下载。打印同理
const canExport = computed(() => props.actions?.download !== false)
const EXPORTS = computed<{ format: ExportFormat; label: string; hint?: string }[]>(() => [
  { format: 'pdf', label: 'PDF', hint: props.download ? undefined : '图片版' },
  { format: 'docx', label: 'Word' },
  { format: 'html', label: 'HTML' },
  { format: 'txt', label: '纯文本' },
  { format: 'png', label: '图片', hint: '每页一张' },
  ...(mode.value === 'edit' ? [{ format: 'json' as const, label: 'JSON', hint: '文档和字段' }] : []),
])
/** 打印模式（盖章、只读）下有的取值命令取不到控件，先切到编辑模式取完再切回（和 readDoc 一样） */
function inEditMode<T>(fn: () => T): T {
  const m = cmd().getOptions().mode
  if (m !== EditorMode.PRINT) return fn()
  let out!: T
  silently(() => {
    cmd().executeMode(EditorMode.EDIT)
    try {
      out = fn()
    } finally {
      cmd().executeMode(m)
    }
  })
  return out
}
/**
 * 导出 HTML、纯文本和 SDK 的 getText 用的三块内容。有复选、单选控件时按保存的文档在不显示的编辑器里取（勾写成 ☑ ☐，见 docParts），
 * 没有时两种取法结果一样，直接取当前编辑器的，省掉重新排版
 */
function partsOf(kind: 'html' | 'text') {
  const doc = readDoc() as unknown as DocData
  if (hasChoices(doc)) return docParts({ ...doc, page: pageSetup.value ? plain(pageSetup.value) : undefined }, kind)
  return inEditMode(() => (kind === 'html' ? cmd().getHTML() : cmd().getText()))
}
const docTitle = () => props.title ?? '未命名'
/** 打印模式的页面图，按 2 倍出；缩放过的先按比例补回来 */
const pageImages = async () => (await cmd().getImage({ pixelRatio: 2 / scale.value, mode: EditorMode.PRINT })) as string[]
/** 各格式的文件内容（都在浏览器里生成）。SDK 的 export 用它 */
async function fileBlob(format: ExportFormat): Promise<Blob> {
  if (format === 'pdf') return pdfFromImages(await pageImages(), PAGE, docTitle())
  if (format === 'png') return zipImages(await pageImages(), docTitle())
  if (format === 'docx') return exportDocxInBrowser(collect().payload.doc)
  if (format === 'html') return new Blob([htmlDocument(docTitle(), partsOf('html'), pageSetup.value)], { type: MIME.html })
  if (format === 'txt') return new Blob([textDocument(partsOf('text'))], { type: MIME.txt })
  const { doc, fields: defs, values } = collect().payload
  const file: DocumentFile = { format: 'oe-document', version: 1, title: docTitle(), doc, fields: defs, values }
  return new Blob([JSON.stringify(file, null, 1)], { type: MIME.json })
}
/** 下载一种格式。PDF、Word：宿主传了 download 就交给宿主（服务端出，带文字层、核对页数），否则浏览器里生成 */
async function exportFile(format: ExportFormat): Promise<void> {
  menu.open = false
  if (!canExport.value) throw new Error('这个文档不能下载')
  if ((format === 'pdf' || format === 'docx') && props.download) return props.download(format)
  const before = status.value
  status.value = '正在导出'
  try {
    downloadBlob(await fileBlob(format), `${safeName(docTitle())}.${EXTENSION[format]}`)
    status.value = before
  } catch (e) {
    status.value = '导出失败'
    throw e
  }
}
function print() {
  menu.open = false
  if (canPrint.value) void cmd().executePrint()
}
function openMenu() {
  if (menu.open) return (menu.open = false)
  const r = exportBtn.value!.getBoundingClientRect()
  Object.assign(menu, { open: true, left: Math.max(8, r.right - 240), top: r.bottom + 8 })
}

// ---------- 印章 ----------
/** 文档里已有的印章：带 extension.seal 的浮动图片 */
function sealsOf(main: IElement[]): Placed[] {
  const out: Placed[] = []
  for (const el of main as (IElement & { extension?: { seal?: { sealId: string; name: string } } })[]) {
    const seal = el.extension?.seal
    if (el.type === 'image' && seal && el.id && el.imgFloatPosition) {
      const { x, y, pageNo = 0 } = el.imgFloatPosition as { x: number; y: number; pageNo?: number }
      out.push({ id: el.id, sealId: seal.sealId, name: seal.name, src: el.value, pageNo, x, y })
    }
  }
  return out
}
const pageCanvases = () => [...(docEl.value?.querySelectorAll<HTMLCanvasElement>('.ce-page-container canvas') ?? [])]
/** 屏幕坐标 → 第几页、页内坐标。页内坐标按缩放 100% 算（印章存的就是这个），缩放后先除掉比例 */
function pageAt(x: number, y: number) {
  const pages = pageCanvases()
  for (let i = 0; i < pages.length; i++) {
    const r = pages[i]!.getBoundingClientRect()
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { pageNo: i, x: (x - r.left) / scale.value, y: (y - r.top) / scale.value }
  }
  return null
}
/** 盖章层记的章 → 文档里的浮动图片元素（和 @oe/core 的 placeSeal 写法一样） */
const sealElement = (s: Placed): SealElement =>
  ({ id: s.id, type: 'image', value: s.src, width: SEAL_SIZE, height: SEAL_SIZE, imgDisplay: 'float-top', imgFloatPosition: { x: s.x, y: s.y, pageNo: s.pageNo }, extension: { seal: { sealId: s.sealId, name: s.name } } }) as unknown as SealElement
const clampPos = (x: number, y: number) => ({
  x: Math.round(Math.min(Math.max(0, x), PAGE.width - SEAL_SIZE)),
  y: Math.round(Math.min(Math.max(0, y), PAGE.height - SEAL_SIZE)),
})
function dropSeal(sealId: string, clientX: number, clientY: number) {
  const seal = props.seals?.find((s) => s.id === sealId)
  const at = seal && pageAt(clientX, clientY)
  if (!seal || !at) return null
  const { x, y } = clampPos(at.x - SEAL_SIZE / 2, at.y - SEAL_SIZE / 2)
  const id = `seal-${uid()}`
  // 打印模式下插不进元素：同一段同步代码里临时切编辑模式插入再切回，中间不让出主线程，用户的输入进不来
  silently(() => {
    cmd().executeMode(EditorMode.EDIT)
    cmd().executeAppendElementList([
      { id, type: 'image', value: seal.src, width: SEAL_SIZE, height: SEAL_SIZE, imgDisplay: 'float-top', imgFloatPosition: { x, y, pageNo: at.pageNo }, extension: { seal: { sealId, name: seal.name } } } as unknown as IElement,
    ])
    cmd().executeMode(EDITOR_MODE.seal)
  })
  placed.value.push({ id, sealId, name: seal.name, src: seal.src, pageNo: at.pageNo, x, y })
  // 追加在末尾的章会画到最后一页，挂到它自己那一页
  silently(() => anchorSeals(editor.value!, [sealElement(placed.value.at(-1)!)]))
  status.value = '已编辑'
  renderHandles()
  reportSeal({ action: 'place', seal: { id, sealId, name: seal.name, dataURL: seal.src, pageNo: at.pageNo, x, y, width: SEAL_SIZE, height: SEAL_SIZE } })
  return id
}
function moveSeal(id: string, pageNo: number, x: number, y: number) {
  const s = placed.value.find((v) => v.id === id)
  if (!s) return
  const pageChanged = s.pageNo !== pageNo
  Object.assign(s, { pageNo, ...clampPos(x, y) })
  silently(() => {
    // 拖到别的页：在正文里也挪到那一页（删掉重插，位置一起带上）；同一页只改坐标
    if (pageChanged) anchorSeals(editor.value!, [sealElement(s)])
    else cmd().executeUpdateElementById({ id, properties: { imgFloatPosition: { x: s.x, y: s.y, pageNo } } })
  })
  status.value = '已编辑'
  renderHandles()
  reportSeal({ action: 'move', id, pageNo, x: s.x, y: s.y })
}
/**
 * 每次放章、移章、删章都交给宿主（服务端记盖章记录、改文档，方案 4.4）；宿主没接就只改本地文档，保存时一起存。
 * 一个接一个发（服务端每次版本号加 1，后一个要用前一个返回的版本号）；全部发完才显示结果，中间有一个失败就显示「保存失败」
 */
let sealChain: Promise<void> = Promise.resolve()
let sealPending = 0
let sealFailed = false
function reportSeal(op: SealOp) {
  const send = props.onSeal
  if (!send) return
  if (sealPending++ === 0) sealFailed = false
  status.value = '正在保存'
  const settle = (ok: boolean) => {
    if (!ok) sealFailed = true
    if (--sealPending === 0) status.value = sealFailed ? '保存失败' : '已保存'
  }
  sealChain = sealChain.then(() => send(op)).then(
    () => settle(true),
    () => settle(false),
  )
}
function removeSeal(id: string) {
  silently(() => {
    cmd().executeMode(EditorMode.EDIT)
    cmd().executeDeleteElementById({ id })
    cmd().executeMode(EDITOR_MODE[mode.value])
  })
  placed.value = placed.value.filter((s) => s.id !== id)
  status.value = '已编辑'
  renderHandles()
  reportSeal({ action: 'remove', id })
}
function renderHandles() {
  if (mode.value !== 'seal' || !pagesEl.value) return (handles.value = [])
  const origin = pagesEl.value.getBoundingClientRect()
  const pages = pageCanvases()
  const k = scale.value
  handles.value = placed.value.flatMap((s) => {
    const r = pages[s.pageNo]?.getBoundingClientRect()
    return r ? [{ ...s, left: r.left - origin.left + s.x * k, top: r.top - origin.top + s.y * k }] : []
  })
}
function dragHandle(e: PointerEvent, id: string) {
  const el = e.currentTarget as HTMLElement
  e.preventDefault()
  el.setPointerCapture(e.pointerId)
  const start = { x: e.clientX, y: e.clientY }
  dragging.value = id
  const move = (ev: PointerEvent) => (el.style.transform = `translate(${ev.clientX - start.x}px, ${ev.clientY - start.y}px)`)
  const up = (ev: PointerEvent) => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.style.transform = ''
    dragging.value = null
    const box = el.getBoundingClientRect()
    const at = pageAt(box.left + box.width / 2 + (ev.clientX - start.x), box.top + box.height / 2 + (ev.clientY - start.y))
    if (at && (ev.clientX !== start.x || ev.clientY !== start.y)) moveSeal(id, at.pageNo, at.x - SEAL_SIZE / 2, at.y - SEAL_SIZE / 2)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}
function onSealDragStart(e: DragEvent, s: SealOption) {
  e.dataTransfer!.setData('text/plain', s.id)
  e.dataTransfer!.effectAllowed = 'copy'
}
function onDrop(e: DragEvent) {
  dropTarget.value = false
  if (mode.value !== 'seal') return
  e.preventDefault()
  dropSeal(e.dataTransfer!.getData('text/plain'), e.clientX, e.clientY)
}

// ---------- 给宿主的事件和方法（07 第 4 节；SDK 和 iframe 嵌入共用）----------
// change：用户改了内容（停 300 毫秒发一次）；field-change：字段值变了（不管是用户填的、选的，还是宿主 setData），按 key 比对
let changeTimer = 0
const scheduleChange = () => {
  clearTimeout(changeTimer)
  changeTimer = window.setTimeout(() => emit('change'), 300)
}
let lastValues: Record<string, FieldValue> = {}
let diffTimer = 0
function scheduleDiff() {
  clearTimeout(diffTimer)
  diffTimer = window.setTimeout(() => {
    if (!editor.value) return
    const now = readValues(readDoc() as unknown as DocData)
    for (const key of new Set([...Object.keys(lastValues), ...Object.keys(now)]))
      if (JSON.stringify(now[key] ?? null) !== JSON.stringify(lastValues[key] ?? null)) emit('field-change', { key, value: now[key] ?? null, previous: lastValues[key] ?? null })
    lastValues = now
  }, 250)
}
watch(dirty, (d) => emit('dirty-change', d))
watch(
  () => active.value?.conceptId,
  (key) => emit('field-focus', key ? { key, label: fieldOf(key)?.label ?? key } : null),
)

/** 批量操作（和服务端 /operations 同一套操作库）：在副本上执行，全部成功才换上；编辑模式才能用，换上后撤销历史清空 */
function apply(ops: Op[]): BatchResult {
  if (mode.value !== 'edit') throw new Error('编辑模式才能批量操作')
  const r = applyBatch(collect().payload.doc, ops, { fields: plain(fields) })
  if (!r.ok) return r
  silently(() => cmd().executeSetValue({ header: r.data.header ?? [], main: r.data.main, footer: r.data.footer ?? [] }))
  placed.value = sealsOf(r.data.main)
  applyPermissions()
  status.value = '已编辑'
  scheduleDiff()
  return r
}
/** 找第 occurrence 处（从 0 起）文字并选中，滚到能看见；没有返回 false */
function findText(text: string, occurrence = 0): boolean {
  const range = text ? cmd().getKeywordRangeList(text)[occurrence] : undefined
  if (!range) return false
  cmd().executeReplaceRange(range)
  revealCursor()
  return true
}
/** 在光标处插文字（编辑模式；填写模式只能插在字段和可编辑区里，由编辑器管） */
function insertText(text: string) {
  if (mode.value !== 'edit' && mode.value !== 'fill') throw new Error('盖章、只读模式不能插文字')
  if (cmd().getRange().startIndex < 0) cmd().executeSetRange(0, 0)
  cmd().executeInsertElementList([{ value: text }])
}
/** 在光标处插一个字段：先找模板里已有的，再找宿主字段库（带出、计算的依赖一起登记） */
function insertFieldByKey(key: string) {
  if (mode.value !== 'edit') throw new Error('编辑模式才能插字段')
  const own = fieldOf(key)
  if (own) return insertField(own)
  const lib = props.libraryFields?.find((f) => f.key === key)
  if (!lib) throw new Error(`没有字段 ${key}`)
  insertLibraryField(lib)
}
const allTextOf = () => textDocument(partsOf('text'))
const focusEditor = () => docEl.value?.querySelector<HTMLElement>('.ce-inputarea')?.focus({ preventScroll: true })

// ---------- 生命周期 ----------
function onKeydownCapture(e: KeyboardEvent) {
  design.keydown(e)
  if (e.defaultPrevented) return
  const key = e.key.toLowerCase()
  if (!(e.ctrlKey || e.metaKey) || (key !== 'z' && key !== 'y')) return
  // 撤销、重做都由我们来做，不交给编辑器自己的快捷键
  e.preventDefault()
  e.stopPropagation()
  // 盖章、只读模式不让撤销，以服务端盖章记录为准
  if (mode.value === 'seal' || mode.value === 'view') return
  undoRedo(key === 'y' || (key === 'z' && e.shiftKey))
}
function onPointerDown(e: PointerEvent) {
  const t = e.target as Node
  if (design.chooser.open && !(t as Element).closest?.('.field-chooser')) design.cancel()
  if (design.floating.open && !(t as Element).closest?.('.selection-toolbar')) design.floating.open = false
  if (picker.open && !pickerEl.value?.contains(t)) closePicker()
  if (menu.open && !exportBtn.value?.contains(t) && !(t as Element).closest?.('.menu')) menu.open = false
  if (outline.open && !(t as Element).closest?.('.outline-pop, .oe-outline')) outline.open = false
  if (draft.open && !draftEl.value?.contains(t) && !addBtn.value?.contains(t)) draft.open = false
}

onMounted(async () => {
  const accent = getComputedStyle(root.value!).getPropertyValue('--oe-accent').trim() || '#007aff'
  const e = new Editor(docEl.value!, structuredClone(props.doc) as unknown as IElement[], {
    ...(structuredClone(layout) as unknown as IEditorOption),
    // 滚动的是 .canvas，不是整个页面：当前页码（状态栏）和拖选到边上时自动滚动都按它算。一个页面上可能有几个编辑器，按各自的标记找
    scrollContainerSelector: `[data-oe-scroll="${scrollId}"]`,
    marginIndicatorColor: 'transparent',
    rangeColor: accent,
    rangeAlpha: 0.2,
    resizerColor: accent,
    mode: EDITOR_MODE[mode.value],
    cursor: { width: 1, color: accent, dragWidth: 2, dragColor: accent, dragFloatImageDisabled: false },
    control: {
      bracketColor: 'transparent',
      placeholderColor: 'rgba(60, 60, 67, 0.3)',
      activeBackgroundColor: 'rgba(0, 122, 255, 0.12)',
      existValueBackgroundColor: 'rgba(0, 122, 255, 0.06)',
      noValueBackgroundColor: 'rgba(0, 122, 255, 0.06)',
      disabledBackgroundColor: 'rgba(120, 120, 128, 0.08)',
    },
  })
  editor.value = e
  design.register(e)
  e.listener.controlContentChange = (p) => {
    const key = p.control?.conceptId
    if (applying || !key) return
    lastTyped[key] = p.controlId
    const source = p.controlId
    clearTimeout(syncTimer)
    syncTimer = window.setTimeout(() => {
      syncFrom(key, source)
      tick.value++
    }, 0)
  }
  e.listener.contentChange = () => {
    blankRevision.value++
    scheduleDiff()
    if (!applying && performance.now() > quietUntil) {
      status.value = '已编辑'
      scheduleChange()
    }
  }
  e.listener.controlChange = (p) => {
    // 程序挪光标（同步时保持光标位置）引起的，不当成用户点了控件
    if (applying) return
    const key = p.control?.conceptId
    active.value = p.state === 'active' && key ? { conceptId: key, controlId: p.controlId } : null
    const f = key ? fieldOf(key) : undefined
    if (mode.value === 'fill' && active.value && f?.type === 'picker') setTimeout(() => openPicker(f), 0)
    else closePicker()
  }
  e.listener.rangeStyleChange = (s: IRangeStyle) => {
    Object.assign(style, {
      bold: !!s.bold, italic: !!s.italic, underline: !!s.underline, strikeout: !!s.strikeout, type: s.type ?? '', font: s.font, size: s.size,
      color: s.color, highlight: s.highlight, rowFlex: s.rowFlex ?? 'left', rowMargin: s.rowMargin, listType: s.listType ?? '', level: s.level ?? '',
      painter: !!s.painter, undo: !!s.undo, redo: !!s.redo,
    })
    if (mode.value !== 'edit') return
    const area = e.command.getAreaValue()
    const on = isEditable(area?.area as AreaProps | undefined)
    // 光标在区域里：已是可编辑区的能取消，只有文字的能设；不在区域里：选中了一段文字才能设
    Object.assign(style, { area: on, canArea: area ? on || canBeArea(area.value) : plainSelection().length > 0 })
    design.refresh()
  }
  placed.value = sealsOf(props.doc.main)
  // 印章挂到各自那一页（服务端放的章在正文末尾），见 seals.ts
  const docSeals = (props.doc.main as unknown as SealElement[]).filter((el) => placed.value.some((p) => p.id === el.id))
  silently(() => anchorSeals(e, plain(docSeals)))
  applyPermissions()
  rememberAreas(collect().all)
  // 状态栏。这几个用事件总线订阅，不占 listener 上的回调（宿主经 handle.editor 可能要用）
  e.eventBus.on('pageScaleChange', (s) => {
    scale.value = s
    void nextTick(renderHandles)
  })
  e.eventBus.on('intersectionPageNoChange', (n) => (pageNo.value = n))
  e.eventBus.on('pageSizeChange', (n) => (pageCount.value = n))
  e.eventBus.on('contentChange', countWords)
  pageCount.value = Math.max(1, pageCanvases().length)
  countWords()
  docEl.value!.addEventListener('keydown', onKeydownCapture, true)
  root.value!.addEventListener('keydown', onRootKeydown, true)
  window.addEventListener('keydown', onWindowKey, true)
  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', onBeforeUnload)
  await nextTick()
  moveThumb()
  renderHandles()
  lastValues = readValues(readDoc() as unknown as DocData)
  emit('ready')
})
const onResize = () => {
  moveThumb()
  renderHandles()
}
/**
 * 焦点在编辑器里（正文、侧栏、弹层）时的快捷键：保存、查找替换、打印。焦点在宿主页面别处时不拦。
 * 填写模式的保存就是提交（先校验）；打印按令牌的打印权限，没有权限时什么都不做
 */
function onRootKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return
  const key = e.key.toLowerCase()
  const take = () => {
    e.preventDefault()
    e.stopPropagation()
  }
  if (key === 's') {
    take()
    if (mode.value !== 'view') primary().catch(() => {})
  } else if ((key === 'f' || key === 'h') && canFind.value) {
    take()
    openFind(key === 'h')
  } else if (key === 'p') {
    take()
    if (canPrint.value) void cmd().executePrint()
  }
}
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.value || props.confirmLeave === false || mode.value === 'view') return
  e.preventDefault()
  e.returnValue = ''
}
onBeforeUnmount(() => {
  clearTimeout(wordTimer)
  window.removeEventListener('keydown', onWindowKey, true)
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('beforeunload', onBeforeUnload)
  editor.value?.destroy()
})

defineExpose({
  editor,
  setMode,
  // 宿主 setData：选项不认识就报错，不写
  setValues: (values: Record<string, FieldValue>) => setValues(values, true),
  validate,
  getData: data,
  save: primary,
  dropSeal,
  moveSeal,
  locate,
  placed,
  isDirty: () => dirty.value,
  apply,
  find: findText,
  insertText,
  insertField: insertFieldByKey,
  getText: allTextOf,
  exportFile: fileBlob,
  download: exportFile,
  importFile,
  print,
  focus: focusEditor,
})
</script>

<template>
  <div ref="root" class="oe" :data-mode="mode">
    <!-- editor-component：canvas-editor 约定的标记，点这些区域时编辑器不清掉光标、选区和当前控件 -->
    <header class="toolbar" editor-component="component">
      <div class="toolbar-leading">
        <span class="doc-title" :title="title ?? '未命名'">{{ title ?? '未命名' }}</span>
        <span class="doc-status" :class="{ attention }" role="status">{{ status }}</span>
        <!-- 撤销、重做放在左上角（Word、WPS 的快速访问栏也在这里）；走 undoRedo，同字段撤销后仍一致 -->
        <span v-if="mode === 'edit' || mode === 'fill'" class="history" @mousedown.prevent>
          <button type="button" class="icon-button oe-undo" aria-label="撤销" :title="tip('撤销', shortcut('Z'))" :disabled="!style.undo" @click="undoRedo(false)"><OeIcon name="undo" /></button>
          <button type="button" class="icon-button oe-redo" aria-label="重做" :title="tip('重做', shortcut('Y'))" :disabled="!style.redo" @click="undoRedo(true)"><OeIcon name="redo" /></button>
        </span>
      </div>
      <div v-if="shownModes.length > 1" ref="modesEl" class="segmented" role="tablist">
        <span class="segmented-thumb" aria-hidden="true" :style="{ width: `${thumb.width}px`, transform: `translateX(${thumb.x}px)` }"></span>
        <button v-for="m in shownModes" :key="m" type="button" role="tab" :aria-selected="m === mode" :data-mode="m" @click="setMode(m)">
          {{ MODE_NAMES[m] }}
        </button>
      </div>
      <div v-else></div>
      <div class="toolbar-trailing">
        <button v-if="canFind" type="button" class="icon-button oe-find" aria-label="查找" :title="tip(mode === 'edit' ? '查找替换' : '查找', shortcut('F'))" :aria-expanded="find.open" @mousedown.prevent @click="find.open ? closeFind() : openFind(false)"><OeIcon name="search" /></button>
        <button v-if="mode === 'view' && canPrint" type="button" class="icon-button oe-print" aria-label="打印" :title="tip('打印', shortcut('P'))" @click="cmd().executePrint()"><OeIcon name="print" /></button>
        <button v-if="mode === 'edit' || canExport" ref="exportBtn" type="button" class="icon-button oe-export" aria-label="导出" :title="mode === 'edit' ? '打开、下载、打印' : '下载、打印'" :aria-expanded="menu.open" @click.stop="openMenu"><OeIcon name="export" /></button>
        <button v-if="mode !== 'view' || canExport" type="button" class="oe-primary" :class="publish && mode === 'edit' ? 'button-tinted' : 'button-primary'" :disabled="saving" @click="primary()">{{ publish && mode === 'edit' ? '保存草稿' : PRIMARY[mode] }}</button>
        <button v-if="publish && mode === 'edit'" type="button" class="button-primary" :disabled="saving" @click="primary(true)">发布模板</button>
        <button v-if="mode === 'edit' && previewSamples?.length" type="button" class="button-tinted" @click="preview = data().doc">预览</button>
      </div>
    </header>

    <div class="workspace" :class="{ 'template-design': mode === 'edit' && libraryFields, 'has-active-field': !!active }">
      <TemplateFields v-if="mode === 'edit' && libraryFields" :fields="libraryFields" @insert="insertLibraryField">
        <TemplateBlanks v-if="report && editor" :editor="editor" :revision="blankRevision" @select="selectBlank" />
      </TemplateFields>
      <main ref="canvasEl" class="canvas" :data-oe-scroll="scrollId" :class="{ 'drop-target': dropTarget }" @dragover.prevent="dropTarget = mode === 'seal' || (mode === 'edit' && !!libraryFields)" @dragleave="dropTarget = false" @drop.capture="design.drop($event); dropTarget = false" @drop="onDrop" @scroll.passive="renderHandles">
        <FormatBar
          :editor="editor"
          :state="style"
          :active="mode === 'edit'"
          :field-button="!!libraryFields"
          :can-field="design.selection.value"
          :page="pageSetup"
          :content-width="innerWidth"
          @area="toggleArea"
          @field="design.open()"
          @page="applyPage"
          @notice="(text: string) => (status = text)"
        />
        <input ref="fileEl" type="file" :accept="IMPORT_ACCEPT" hidden @change="onFile" />
        <!-- 宽度跟着编辑器（canvas-editor 按纸张和缩放设 .doc 的宽） -->
        <div ref="pagesEl" class="pages">
          <div ref="docEl" class="doc" @mouseup="design.mouseup"></div>
          <div v-if="mode === 'seal'" class="seal-layer">
            <div
              v-for="h in handles"
              :key="h.id"
              class="seal-handle"
              :class="{ dragging: dragging === h.id }"
              :data-id="h.id"
              :style="{ left: `${h.left}px`, top: `${h.top}px`, width: `${SEAL_SIZE * scale}px`, height: `${SEAL_SIZE * scale}px` }"
              @pointerdown="dragHandle($event, h.id)"
            >
              <img :src="h.src" alt="" />
            </div>
          </div>
        </div>
      </main>

      <aside class="inspector" editor-component="component">
        <div v-if="mode === 'edit'" class="inspector-body">
          <section v-if="report" class="section import-report">
            <h2 class="section-title">
              导入报告<button type="button" class="icon-button small" aria-label="关闭导入报告" @click="report = null"><OeIcon name="xmark" /></button>
            </h2>
            <ul class="rows">
              <li v-for="(it, i) in report.items" :key="i" class="report-row" :data-kind="it.kind" :data-level="it.level">
                <OeIcon :name="it.level === 'lost' ? 'exclamation' : 'checkmark'" :class="['report-mark', it.level]" /><span>{{ it.message }}</span>
              </li>
            </ul>
          </section>
          <section class="section">
            <h2 class="section-title">
              字段<button ref="addBtn" type="button" class="icon-button small" aria-label="新建字段" :aria-expanded="draft.open" @mousedown.prevent @click="openDraft"><OeIcon name="plus" /></button>
            </h2>
            <ul class="rows">
              <li v-for="f in fields" :key="f.key" class="row" :data-insert="f.key" @mousedown.prevent @click="inspectField(f)">
                <span>{{ f.label }}</span><span class="row-meta">{{ TYPE_NAMES[f.type] }}</span>
              </li>
            </ul>
          </section>
          <section v-if="active && fieldOf(active.conceptId)" class="section">
            <h2 class="section-title">{{ fieldOf(active.conceptId)!.label }}</h2>
            <div class="field-form field-properties">
              <label>字段名称<input aria-label="字段名称" :value="fieldOf(active.conceptId)!.label" @change="renameField(active.conceptId, ($event.target as HTMLInputElement).value)" /></label>
              <p class="row-meta">类型：{{ TYPE_NAMES[fieldOf(active.conceptId)!.type] }}</p>
              <p v-if="fieldOf(active.conceptId)!.dataSource" class="row-meta">数据源：{{ fieldOf(active.conceptId)!.dataSource!.id }}</p>
              <label v-if="fieldOf(active.conceptId)!.type === 'date'">日期格式<select v-model="fieldOf(active.conceptId)!.format" aria-label="日期格式" @change="applyPermissions(); status = '已编辑'"><option value="yyyy-MM-dd">2026-03-18</option><option value="yyyy年MM月dd日">2026年03月18日</option></select></label>
            </div>
            <div class="segmented small" @mousedown.prevent>
              <button v-for="[p, n] in PERMS" :key="p" type="button" :aria-selected="permOf(active.conceptId) === p" :data-perm="p" @click="setPermission(active.conceptId, p)">{{ n }}</button>
            </div>
          </section>
        </div>
        <div v-else-if="mode === 'fill'" class="inspector-body">
          <div class="progress">
            <span class="progress-count">{{ filledCount }} / {{ fillable.length }}</span>
            <button type="button" class="button-tinted" :disabled="filledCount === fillable.length" @click="nextField">下一项</button>
          </div>
          <div class="progress-track" role="progressbar" aria-label="填写进度" :aria-valuenow="filledCount" aria-valuemin="0" :aria-valuemax="fillable.length">
            <span :style="{ width: `${fillable.length ? (filledCount / fillable.length) * 100 : 100}%` }"></span>
          </div>
          <ul class="rows">
            <li v-for="f in visibleFields" :key="f.key" class="row" :class="{ active: active?.conceptId === f.key, flagged: isFlagged(f) }" :data-locate="f.key" @click="locate(f.key)">
              <span class="row-label">{{ f.label }}<span v-if="permOf(f.key) === 'required'" class="row-tag">必填</span></span>
              <span class="row-value" :class="{ empty: !valueOf(f.key) }">{{ shownOf(f.key) || emptyHint(f) }}</span>
            </li>
          </ul>
        </div>
        <div v-else-if="mode === 'seal'" class="inspector-body">
          <section class="section">
            <h2 class="section-title">印章</h2>
            <div class="seal-grid">
              <div v-for="s in seals ?? []" :key="s.id" class="seal-card" draggable="true" :data-seal="s.id" @dragstart="onSealDragStart($event, s)">
                <img :src="s.src" alt="" /><span>{{ s.name }}</span>
              </div>
            </div>
          </section>
          <section class="section">
            <h2 class="section-title">已盖</h2>
            <ul v-if="placed.length" class="rows">
              <li v-for="s in placed" :key="s.id" class="row">
                <span>{{ s.name }}</span>
                <span class="row-trailing">
                  <span class="row-meta">第 {{ s.pageNo + 1 }} 页</span>
                  <button type="button" class="icon-button small remove" aria-label="移除" @click="removeSeal(s.id)"><OeIcon name="xmark" /></button>
                </span>
              </li>
            </ul>
            <p v-else class="empty-note">无</p>
          </section>
        </div>
      </aside>
    </div>
    <StatusBar :page-no="pageNo" :page-count="pageCount" :words="words" :scale="scale" :outline-open="outline.open" @zoom="zoom" @outline="toggleOutline" />

    <div v-if="mode === 'edit' && design.floating.open" class="popover selection-toolbar" editor-component="component" :style="{ left: `${design.floating.left}px`, top: `${design.floating.top}px` }" @mousedown.prevent>
      <button type="button" class="button-tinted" @click="design.open()">设为字段</button>
      <button type="button" class="button-tinted" :disabled="!style.canArea" @click="toggleArea(); design.floating.open = false">可编辑区</button>
      <button type="button" class="fmt" aria-label="加粗选区" :title="tip('加粗', shortcut('B'))" :aria-pressed="style.bold" @click="cmd().executeBold()"><b>B</b></button>
      <button type="button" class="fmt" aria-label="斜体选区" :title="tip('斜体', shortcut('I'))" :aria-pressed="style.italic" @click="cmd().executeItalic()"><i>I</i></button>
      <button type="button" class="fmt" aria-label="下划线选区" :title="tip('下划线', shortcut('U'))" :aria-pressed="style.underline" @click="cmd().executeUnderline()"><u>U</u></button>
    </div>
    <div v-if="outline.open" class="popover outline-pop" role="navigation" aria-label="大纲" editor-component="component" :style="{ left: `${outline.left}px`, bottom: `${outline.bottom}px`, top: 'auto', transformOrigin: 'bottom left' }">
      <ul v-if="outline.items.length" class="rows outline-rows">
        <li v-for="(it, i) in outline.items" :key="i"><button type="button" class="row" :style="{ paddingLeft: `${8 + it.depth * 16}px` }" @click="gotoOutline(it)"><span>{{ it.name }}</span><span class="row-meta">{{ it.pageNo + 1 }}</span></button></li>
      </ul>
      <p v-else class="empty-note">没有标题</p>
    </div>
    <FindBar
      v-if="find.open && editor"
      ref="findBar"
      :editor="editor"
      :replace="mode === 'edit'"
      :focus-replace="find.toReplace"
      :left="find.left"
      :top="find.top"
      :initial="find.initial"
      @close="find.open = false"
      @edited="status = '已编辑'"
    />
    <div v-if="mode === 'edit' && design.chooser.open" class="popover field-chooser" editor-component="component" :style="{ left: `${design.chooser.left}px`, top: `${design.chooser.top}px` }">
      <div class="field-chooser-title"><span>设为字段</span><button type="button" class="icon-button small" aria-label="关闭字段选择" @click="design.cancel"><OeIcon name="xmark" /></button></div>
      <TemplateFields :fields="libraryFields!" autofocus @insert="design.choose" @query="design.search" @cancel="design.cancel" />
    </div>
    <TemplatePreview v-if="preview" :doc="preview" :fields="plain(fields)" :samples="previewSamples!" @close="preview = undefined" />
    <form
      v-if="draft.open"
      ref="draftEl"
      class="popover field-form"
      editor-component="component"
      :style="{ left: `${draft.left}px`, top: `${draft.top}px`, transformOrigin: 'top right' }"
      @submit.prevent="addField"
      @keydown.esc="draft.open = false"
    >
      <input v-model="draft.label" type="text" placeholder="名称" aria-label="名称" />
      <select v-model="draft.type" aria-label="类型">
        <option v-for="t in NEW_TYPES" :key="t" :value="t">{{ TYPE_NAMES[t] }}</option>
      </select>
      <input v-model="draft.key" type="text" placeholder="键" aria-label="键" spellcheck="false" autocomplete="off" />
      <input v-if="OPTION_TYPES.includes(draft.type)" v-model="draft.options" type="text" placeholder="选项，用顿号分隔" aria-label="选项" />
      <div class="field-form-actions"><button type="submit" class="button-primary" :disabled="!draftOk">添加</button></div>
    </form>

    <div v-if="picker.open" ref="pickerEl" class="popover picker" editor-component="component" :style="{ left: `${picker.left}px`, top: `${picker.top}px`, transformOrigin: picker.origin }">
      <input ref="searchEl" v-model="picker.query" type="search" placeholder="搜索" autocomplete="off" @input="onSearch" />
      <ul class="picker-list" role="listbox">
        <li v-for="(it, i) in picker.items" :key="it.id" role="option" :aria-selected="i === picker.index" @pointermove="picker.index = i" @click="choose(it)">
          <span class="name">{{ it.title }}</span><span v-if="it.subtitle" class="sub">{{ it.subtitle }}</span>
        </li>
        <li v-if="!picker.items.length" class="empty-note">无</li>
      </ul>
      <div class="picker-pager">
        <button type="button" class="icon-button small" aria-label="上一页" :disabled="picker.page === 0" @click="turn(-1)"><OeIcon name="chevronLeft" /></button>
        <span>{{ picker.page + 1 }} / {{ picker.pages }}</span>
        <button type="button" class="icon-button small" aria-label="下一页" :disabled="picker.page >= picker.pages - 1" @click="turn(1)"><OeIcon name="chevronRight" /></button>
      </div>
    </div>
    <div v-if="menu.open" class="popover menu file-menu" role="menu" aria-label="文件" editor-component="component" :style="{ left: `${menu.left}px`, top: `${menu.top}px` }">
      <template v-if="mode === 'edit'">
        <button type="button" role="menuitem" data-import @click="pickFile"><span>打开文件</span><span class="menu-shortcut">Word、HTML、Markdown…</span></button>
        <div v-if="canExport || canPrint" class="menu-divider" role="separator"></div>
      </template>
      <template v-if="canExport">
        <div class="menu-label">下载</div>
        <button v-for="f in EXPORTS" :key="f.format" type="button" role="menuitem" :data-export="f.format" @click="exportFile(f.format).catch(() => {})"><span>{{ f.label }}</span><span v-if="f.hint" class="menu-shortcut">{{ f.hint }}</span></button>
      </template>
      <template v-if="canPrint">
        <div v-if="canExport" class="menu-divider" role="separator"></div>
        <button type="button" role="menuitem" data-print @click="print"><span>打印</span><span class="menu-shortcut">{{ shortcut('P') }}</span></button>
      </template>
    </div>
  </div>
</template>
