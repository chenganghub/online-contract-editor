// 段落。插件导入的正文里，换行写在每段末尾、带的是本段的属性；canvas-editor 却把换行当下一段的开头，
// 下一段的对齐、行距、段间距从这个换行上取，于是每段的对齐都错成了上一段的（K7 导入截图：「合同编号」居中、「甲方」右对齐）。
// 这里把换行单独拆出来、改成下一段的属性，再按文字把 docx 的段落和编辑器的段落对上，补段前段后间距。
import { squeeze, TEXT_TYPES, type El } from './model'
import type { ParaInfo } from './scan'

const isPlain = (el: El) => el.type === undefined || el.type === 'text'
const isBreak = (el: El | undefined) => !!el && isPlain(el) && el.value === '\n'
// canvas-editor 的段落属性（EDITOR_ROW_ATTR），加上决定换行本身高度的字体、字号
const ROW_KEYS = ['rowFlex', 'rowMargin', 'spacingBefore', 'spacingAfter', 'font', 'size', 'bold'] as const

/** 文字元素按换行拆开，每个换行单独一个元素；标题、列表里面也拆 */
export function splitBreaks(list: El[]): El[] {
  const out: El[] = []
  for (const el of list) {
    if (el.valueList && (el.type === 'title' || el.type === 'list')) el.valueList = splitBreaks(el.valueList)
    if (!isPlain(el) || el.value === '\n' || !el.value.includes('\n')) out.push(el)
    else for (const part of el.value.split(/(\n)/)) if (part) out.push({ ...el, value: part })
  }
  return out
}

/** 后面那一段的属性从哪个元素取：标题取第一个字；表格、列表、分页符自己另起一行，不管 */
function sourceOf(next: El | undefined): El | undefined {
  if (!next) return undefined
  if (next.type === 'title') return next.valueList?.[0]
  return isPlain(next) || next.type === 'image' || next.type === 'tab' || TEXT_TYPES.has(next.type) ? next : undefined
}

/** 每个换行改成它后面那一段的段落属性。从前往后改，取的总是下一个元素原来的属性。返回改了几个换行 */
export function fixBreaks(list: El[]): number {
  let n = 0
  for (let i = 0; i < list.length; i++) {
    const el = list[i]!
    if (!isBreak(el)) continue
    const src = sourceOf(list[i + 1])
    if (!src) continue
    let changed = false
    for (const k of ROW_KEYS) {
      if (el[k] === src[k]) continue
      if (src[k] === undefined) delete el[k]
      else el[k] = src[k]
      changed = true
    }
    if (changed) n++
  }
  return n
}

export interface EditorPara {
  /** 去空白后的文字 */
  text: string
  /** 这一段的元素（含开头的换行、标题里的字、列表项） */
  els: El[]
}

/** 编辑器的段落：换行开始新的一段，列表每项一段；表格、分页符隔开前后，表格里的段落另算 */
export function paragraphsOf(list: El[]): EditorPara[] {
  const out: EditorPara[] = []
  let cur: EditorPara = { text: '', els: [] }
  const flush = () => {
    if (cur.els.length) out.push({ text: squeeze(cur.text), els: cur.els })
    cur = { text: '', els: [] }
  }
  const add = (el: El) => {
    if (isBreak(el) && !el.listWrap) flush()
    cur.els.push(el)
    if (TEXT_TYPES.has(el.type) && el.value !== '\n') cur.text += el.value
  }
  for (const el of list) {
    if (el.type === 'table' || el.type === 'pageBreak') flush()
    else if (el.type === 'list') {
      flush()
      for (const v of el.valueList ?? []) add(v)
      flush()
    } else if (el.type === 'title') for (const v of el.valueList ?? []) add(v)
    else add(el)
  }
  flush()
  return out
}

/**
 * 按文字把 docx 段落和编辑器段落对上（顺序一致，中间允许有对不上的），把段前段后间距写到对上的段落的每个元素上
 * （和编辑器自己的「段前距」命令一样）。空段只和编辑器当前位置的空段对。
 */
export function applySpacing(docx: ParaInfo[], editor: EditorPara[]): { applied: number; wanted: number } {
  const WINDOW = 20
  let j = 0
  let applied = 0
  let wanted = 0
  for (const d of docx) {
    const want = d.before > 0 || d.after > 0
    if (want) wanted++
    let k = -1
    if (d.text) {
      for (let x = j; x < Math.min(editor.length, j + WINDOW); x++)
        if (editor[x]!.text === d.text) {
          k = x
          break
        }
    } else if (editor[j]?.text === '') k = j
    if (k < 0) continue
    j = k + 1
    if (!want) continue
    for (const el of editor[k]!.els) {
      if (d.before > 0) el.spacingBefore = d.before
      if (d.after > 0) el.spacingAfter = d.after
    }
    applied++
  }
  return { applied, wanted }
}
