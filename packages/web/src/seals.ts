// 浮动印章挂到它自己那一页。canvas-editor 1.0.6 把浮动图片画在它在正文里所在的那一页，不看 imgFloatPosition.pageNo
// （s11 实测：追加在正文末尾的章全画到了最后一页）。按 id 删掉印章，再插到各自那一页第一个不在控件里的字前面；
// 浮动图片不占排版位置，插进去分页不变。不用 getValue / executeSetValue 整篇重装（打印模式下 getValue 取不到控件，
// 拿它装回会丢控件）。渲染页 apps/renderer/page/render.js 的 anchorSeals 是同一个做法。
import { EditorMode, type IElement } from '@hufe921/canvas-editor'
import type Editor from '@hufe921/canvas-editor'

export type SealElement = IElement & { id: string; imgFloatPosition: { x: number; y: number; pageNo: number } }

/** seals：要挂的印章元素（文档里已有的，按 id 先删掉再插）。返回有没有印章 */
export function anchorSeals(editor: Editor, seals: SealElement[]): boolean {
  if (!seals.length) return false
  const cmd = editor.command
  const mode = cmd.getOptions().mode
  cmd.executeMode(EditorMode.EDIT)
  for (const s of seals) cmd.executeDeleteElementById({ id: s.id })
  // 每页正文（不在表格里）的字：搜索结果不保证按顺序，按页收集、按下标排好，取第一个不在控件里的（插进控件会把控件拆开）
  cmd.executeSearch('\uFFFF', { isRegEnable: true, isIgnoreCase: false })
  const list = cmd.getKeywordContext('[^\\u200B\\n]') ?? []
  cmd.executeSearch(null)
  const byPage = new Map<number, { startIndex: number; endIndex: number }[]>()
  for (const { range, startPosition } of list) if (!range.tableId && startPosition) byPage.set(startPosition.pageNo, [...(byPage.get(startPosition.pageNo) ?? []), range])
  const first = new Map<number, number>()
  for (const pg of new Set(seals.map((s) => s.imgFloatPosition.pageNo))) {
    for (const r of (byPage.get(pg) ?? []).sort((a, b) => a.startIndex - b.startIndex)) {
      cmd.executeSetRange(r.startIndex, r.startIndex + 1)
      const el = cmd.getRangeContext()?.selectionElementList?.[0]
      if (el && !el.controlId) {
        first.set(pg, r.startIndex)
        break
      }
    }
  }
  // 从后往前插，前面的下标不受影响；那一页没有能插的字（整页是表格或控件）时放到正文末尾
  const at = (s: SealElement) => first.get(s.imgFloatPosition.pageNo) ?? Infinity
  for (const s of [...seals].sort((a, b) => at(b) - at(a))) {
    const i = at(s)
    if (Number.isFinite(i)) {
      cmd.executeSetRange(i, i)
      cmd.executeInsertElementList([s])
    } else cmd.executeAppendElementList([s])
  }
  cmd.executeMode(mode)
  return true
}
