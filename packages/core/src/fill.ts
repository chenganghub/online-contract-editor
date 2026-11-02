// 按权限处理文档：下发前剔除隐藏值；填写模式保存时只接受可编辑字段和可编辑区。
import { OpError } from './errors'
import { setFieldValues } from './fields'
import { clone, controlLocs, elAt, walkDoc, type Doc, type El } from './model'
import { canonicalize, isText } from './text'
import type { AreaRun, AreaStyle, DocData, DocValues, FieldDef, FieldValue, FillResult, Permission } from './types'

const permOf = (f: FieldDef | undefined, key: string, perms: Record<string, Permission>): Permission =>
  perms[key] ?? f?.permission ?? 'editable'

/** 隐藏字段：文档里的控件保留、值清空，数据 JSON 里的值和快照删掉；隐藏的区域内容清空 */
export function stripHidden(
  data: DocData,
  values: DocValues,
  fields: FieldDef[],
  perms: Record<string, Permission>,
): { data: DocData; values: DocValues } {
  const doc = clone(data) as unknown as Doc
  const out: DocValues = clone(values)
  const defs = new Map(fields.map((f) => [f.key, f]))
  const keys = new Set([...fields.map((f) => f.key), ...Object.keys(perms)])
  const hidden = [...keys].filter((k) => permOf(defs.get(k), k, perms) === 'hidden')
  for (const key of hidden) {
    for (const l of controlLocs(doc)) {
      const c = elAt(l).control!
      if (c.conceptId !== key) continue
      c.value = []
      if (c.code !== undefined) c.code = null
    }
    delete out.values[key]
    if (out.snapshots) delete out.snapshots[key]
  }
  for (const l of walkDoc(doc)) {
    const el = elAt(l)
    if (el.type === 'area' && el.area?.hide) el.valueList = []
  }
  return { data: doc as unknown as DocData, values: out }
}

/** 可编辑区（方案 4.2）：区域元素的 area.extension 里 editable 为 true、anchor 是非空的键。填写模式里只能改它的文字 */
const isEditableArea = (el: El) => {
  const ext = el.type === 'area' ? el.area?.extension : undefined
  return ext?.editable === true && typeof ext.anchor === 'string' && ext.anchor !== ''
}

/** 一个可编辑区最多多少字 */
export const AREA_MAX_LENGTH = 20000
/** 一个可编辑区最多分几段（样式不同的文字算不同的段） */
export const AREA_MAX_RUNS = 2000

const num = (min: number, max: number) => (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const bool = (v: unknown) => typeof v === 'boolean'
const COLOR = /^[#\w(),.% -]{1,40}$/
const color = (v: unknown) => typeof v === 'string' && COLOR.test(v)
const ROW_FLEX = new Set(['left', 'center', 'right', 'alignment', 'justify'])
/** 可编辑区里每段文字能带的样式和取值（键和 AreaRun 一样）：类型不对、超出范围的丢掉。字号、段前段后是 px，行距是倍数 */
const AREA_STYLE: { readonly [K in keyof AreaStyle]-?: (v: unknown) => boolean } = {
  // 字体名会写进 docx 的属性：引号、尖括号、& 这些不收，控制字符也不收
  font: (v) => typeof v === 'string' && v.length > 0 && v.length <= 50 && !/["'<>&;{}\\]|\p{Cc}/u.test(v),
  size: num(1, 200),
  bold: bool,
  italic: bool,
  underline: bool,
  strikeout: bool,
  color,
  highlight: color,
  rowFlex: (v) => typeof v === 'string' && ROW_FLEX.has(v),
  rowMargin: num(0, 10),
  spacingBefore: num(0, 200),
  spacingAfter: num(0, 200),
}

/** 一段文字上合规的样式。编辑器提交前、服务端收到后都按这个取，两边留下的一样 */
export function areaStyle(from: Record<string, unknown>): AreaStyle {
  const out: Record<string, unknown> = {}
  for (const [k, ok] of Object.entries(AREA_STYLE)) if (ok(from[k])) out[k] = from[k]
  return out as AreaStyle
}

/**
 * 文档里带 anchor 的区域，按文档顺序（页眉、正文、页脚）。同一个 anchor 出现多次时（复制粘贴来的区域），
 * 第一个不变，后面的依次叫 anchor-2、anchor-3…（跳过文档里已有的名字）。
 * 编辑器保存模板时按这个改名；填写时编辑器提交、服务端找区域也按这个，几处对得上
 */
export function areaAnchors(data: DocData): { anchor: string; el: El }[] {
  const areas: { anchor: string; el: El }[] = []
  for (const l of walkDoc(data as unknown as Doc)) {
    const el = elAt(l)
    const anchor = el.type === 'area' ? el.area?.extension?.anchor : undefined
    if (typeof anchor === 'string' && anchor) areas.push({ anchor, el })
  }
  const used = new Set(areas.map((a) => a.anchor))
  const seen = new Set<string>()
  return areas.map(({ anchor, el }) => {
    if (!seen.has(anchor)) {
      seen.add(anchor)
      return { anchor, el }
    }
    let k = 2
    while (used.has(`${anchor}-${k}`)) k++
    used.add(`${anchor}-${k}`)
    return { anchor: `${anchor}-${k}`, el }
  })
}

type AreaFail = { ok: false; code: 'TARGET_NOT_FOUND' | 'PERMISSION_DENIED' | 'BAD_ARGUMENT'; area: string; error: string }

/** 提交的一段文字整理成区域里的元素：类型只能是文字（含上下标），样式按 areaStyle 取 */
function areaRun(r: unknown): El | null {
  if (!r || typeof r !== 'object' || typeof (r as El).value !== 'string') return null
  const run = r as El
  if (!isText(run)) return null
  const out: El = { value: run.value }
  if (run.type === 'subscript' || run.type === 'superscript') out.type = run.type
  return Object.assign(out, areaStyle(run))
}

/**
 * 填写模式保存可编辑区：按 anchor 换掉区域里的内容。可以给一段文字（沿用区域第一个字的样式），
 * 也可以给一组带样式的文字（编辑器提交的就是这种，区域里原来的粗体、颜色等不丢）。
 * 区域按 areaAnchors 找（重复的 anchor 按顺序叫 anchor-2…）。存进去的和编辑器 getValue() 一样：空文字去掉，相邻同样式的合并。
 * 找不到、不是可编辑区、隐藏的区域整次拒绝；模板里这个区域有字段、图片等非文字元素时也拒绝（换掉会把它们删掉）
 */
export function applyAreas(data: DocData, areas: Record<string, string | AreaRun[]>): { ok: true; data: DocData } | AreaFail {
  const entries = Object.entries(areas)
  if (!entries.length) return { ok: true, data }
  const doc = clone(data)
  const byAnchor = new Map(areaAnchors(doc).map(({ anchor, el }) => [anchor, el]))
  for (const [anchor, content] of entries) {
    const fail = (code: AreaFail['code'], error: string): AreaFail => ({ ok: false, code, area: anchor, error })
    const el = byAnchor.get(anchor)
    if (!el) return fail('TARGET_NOT_FOUND', `文档里没有可编辑区 ${anchor}`)
    if (!isEditableArea(el) || el.area?.hide) return fail('PERMISSION_DENIED', `区域 ${anchor} 不允许填写`)
    // 存库的文档没有结构校验，valueList 不一定是元素数组
    const list = Array.isArray(el.valueList) ? el.valueList : []
    if (!list.every((e) => !!e && typeof e === 'object' && isText(e))) return fail('BAD_ARGUMENT', `可编辑区 ${anchor} 里有字段或图片，填写时不能改`)
    let runs: El[]
    if (typeof content === 'string') {
      const first = list.find((e) => typeof e.value === 'string' && e.value.replace(/[\u200B\n]/g, ''))
      runs = [{ value: content, ...areaStyle(first ?? {}) }]
    } else if (Array.isArray(content)) {
      if (content.length > AREA_MAX_RUNS) return fail('BAD_ARGUMENT', `可编辑区 ${anchor} 最多分 ${AREA_MAX_RUNS} 段，现在 ${content.length} 段`)
      runs = []
      for (const [i, r] of content.entries()) {
        const run = areaRun(r)
        if (!run) return fail('BAD_ARGUMENT', `可编辑区 ${anchor} 的第 ${i + 1} 段不是文字`)
        runs.push(run)
      }
    } else return fail('BAD_ARGUMENT', `可编辑区 ${anchor} 的内容只能是文字`)
    const length = runs.reduce((n, r) => n + r.value.length, 0)
    if (length > AREA_MAX_LENGTH) return fail('BAD_ARGUMENT', `可编辑区 ${anchor} 最多 ${AREA_MAX_LENGTH} 字，现在 ${length} 字`)
    // 清空了就是 valueList: []，和编辑器 getValue() 给的一样；装回编辑器时它会给区域补一个零宽占位字，照样能点进去
    el.valueList = canonicalize(runs)
  }
  return { ok: true, data: doc }
}

/** 填写模式保存：patch 里只能有可编辑（含必填）字段，有一个不是就整次拒绝 */
export function applyFill(
  data: DocData,
  values: DocValues,
  patch: Record<string, FieldValue>,
  fields: FieldDef[],
  perms: Record<string, Permission>,
): FillResult {
  const defs = new Map(fields.map((f) => [f.key, f]))
  for (const key of Object.keys(patch)) {
    const def = defs.get(key)
    if (!def) return { ok: false, code: 'FIELD_NOT_FOUND', field: key, error: `模板里没有字段 ${key}` }
    const perm = permOf(def, key, perms)
    if (def.type === 'computed' || (perm !== 'editable' && perm !== 'required'))
      return { ok: false, code: 'PERMISSION_DENIED', field: key, error: `字段 ${key} 不允许填写（${def.type === 'computed' ? '计算字段' : perm}）` }
  }
  const doc = clone(data) as unknown as Doc
  try {
    const written = setFieldValues(doc, patch, fields)
    const next: DocValues = clone(values)
    next.values = { ...next.values, ...written }
    return { ok: true, data: doc as unknown as DocData, values: next }
  } catch (e) {
    if (!(e instanceof OpError)) throw e
    const code = e.code === 'VALUE_NOT_IN_OPTIONS' || e.code === 'FIELD_NOT_FOUND' ? e.code : 'BAD_ARGUMENT'
    return { ok: false, code, field: e.field ?? '', error: e.message }
  }
}
