// 渲染页：在无头 Chrome 里跑和前端同一个 canvas-editor，出打印模式的页面图、每个字的位置（PDF 文字层用）、docx。
// 页面里不注入任何请求函数，生成文件时不会去调远程接口（方案第 12 节）。
import Editor from '@hufe921/canvas-editor'
import docxPlugin from '@hufe921/canvas-editor-plugin-docx'

let editor = null

// 纸张、页边距、默认字体字号、页码这些影响排版的选项由服务端按 @oe/core 的 layoutOptions 传进来，和前端编辑器同一套
const BASE_OPTIONS = {
  // 和前端一致：控件不画括号；打印模式本来就不画控件底色和占位提示
  control: { bracketColor: 'transparent' },
}

/** 文档里用到的字体：渲染前都要加载完，否则排版用的是替代字体，分页会和屏幕不一致 */
function fontsOf(data, options) {
  const set = new Set([options.defaultFont])
  const visit = (list) => {
    for (const e of list ?? []) {
      if (e.font) set.add(e.font)
      if (e.control?.font) set.add(e.control.font)
      if (e.valueList) visit(e.valueList)
      if (e.control?.value) visit(e.control.value)
      for (const tr of e.trList ?? []) for (const td of tr.tdList ?? []) visit(td.value)
    }
  }
  visit(data.header)
  visit(data.main)
  visit(data.footer)
  return [...set].filter(Boolean)
}

async function load({ doc, options }) {
  editor?.destroy()
  const el = document.querySelector('#editor')
  el.innerHTML = ''
  const opts = { ...BASE_OPTIONS, ...options, mode: 'print' }
  const fonts = fontsOf(doc, opts)
  await Promise.all(fonts.map((f) => document.fonts.load(`16px "${f}"`, '合同').catch(() => [])))
  await document.fonts.ready
  editor = new Editor(el, doc, opts)
  editor.use(docxPlugin)
  await settle(el)
  if (anchorSeals(editor, doc)) await settle(el)
  return { fonts }
}

// 等排版完成：页数稳定两帧
async function settle(el) {
  let last = -1
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => requestAnimationFrame(() => r()))
    const n = el.querySelectorAll('.ce-page-container canvas').length
    if (n === last && n > 0) break
    last = n
  }
}

/**
 * 浮动印章挂到它自己那一页：canvas-editor 把浮动图片画在它在正文里所在的那一页，不看 imgFloatPosition.pageNo
 * （s11 实测：追加在正文末尾的章全画到了最后一页）。先拿掉所有印章，再插到各自那一页正文第一个字前面；
 * 浮动图片不占排版位置，插进去分页不变。和前端 packages/web/src/seals.ts 同一个做法。返回有没有印章
 */
function anchorSeals(ed, doc) {
  const cmd = ed.command
  // 印章取自传进来的文档（按 id 删掉再插）；不用 getValue / executeSetValue 整篇重装：打印模式下 getValue 取不到控件，装回会丢控件
  const seals = (doc.main ?? []).filter((e) => e.type === 'image' && e.extension?.seal && e.imgFloatPosition && e.id)
  if (!seals.length) return false
  const mode = cmd.getOptions().mode
  cmd.executeMode('edit')
  for (const s of seals) cmd.executeDeleteElementById({ id: s.id })
  // 每页正文（不在表格里）第一个字在正文里的下标
  cmd.executeSearch('\uFFFF', { isRegEnable: true, isIgnoreCase: false })
  const list = cmd.getKeywordContext('[^\\u200B\\n]') || []
  cmd.executeSearch(null)
  // 搜索结果不保证按顺序：按页收集、按下标排好，取第一个不在控件里的字（插进控件会把控件拆开）
  const byPage = new Map()
  for (const { range, startPosition } of list) if (!range.tableId && startPosition) byPage.set(startPosition.pageNo, [...(byPage.get(startPosition.pageNo) ?? []), range])
  const first = new Map()
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
  const at = (s) => first.get(s.imgFloatPosition.pageNo) ?? Infinity
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

/** 打印模式页面图；页数以图的张数为准（K8：pageSizeChange 事件紧接着读会拿到旧值） */
const images = (pixelRatio) => editor.command.getImage({ pixelRatio, mode: 'print' })

// ---------- 每个字的位置（K9b 的做法，只用公开接口） ----------
function collectBody() {
  const cmd = editor.command
  // 只为打开正则选项，这个关键词不匹配任何字
  cmd.executeSearch('\uFFFF', { isRegEnable: true, isIgnoreCase: false })
  const list = cmd.getKeywordContext('[^\\u200B\\n]') || []
  cmd.executeSearch(null)
  const seen = new Set()
  const chars = []
  for (const { range, endPosition: p } of list) {
    if (!p || !p.value || p.value === '\u200B' || p.value === '\n') continue
    const cell = range.tableId ? `${range.tableId}:${range.startTrIndex}:${range.startTdIndex}` : ''
    const key = `${cell}#${range.endIndex}`
    if (seen.has(key)) continue
    seen.add(key)
    chars.push({
      cell,
      tr: range.startTrIndex ?? -1,
      td: range.startTdIndex ?? -1,
      i: range.endIndex,
      v: p.value,
      pg: p.pageNo,
      ri: p.rowIndex,
      x: p.coordinate.leftTop[0],
      y: p.coordinate.leftTop[1],
      r: p.coordinate.rightTop[0],
      lh: p.lineHeight,
      asc: p.ascent,
      size: p.metrics.height,
    })
  }
  return chars
}

// 页眉、页脚：切到该区，逐字定位取光标位置。每页画法相同，位置的页码都是 0
function collectZone(zone) {
  const cmd = editor.command
  cmd.executeSetZone(zone)
  cmd.executeSetRange(0, 0)
  const chars = []
  if (cmd.getRangeContext()?.zone === zone) {
    for (let i = 0; i < 5000; i++) {
      cmd.executeSetRange(i, i)
      const p = cmd.getCursorPosition()
      if (!p) break
      if (p.value && p.value !== '\u200B' && p.value !== '\n')
        chars.push({ cell: zone, tr: -1, td: -1, i, v: p.value, pg: p.pageNo, ri: p.rowIndex, x: p.coordinate.leftTop[0], y: p.coordinate.leftTop[1], r: p.coordinate.rightTop[0], lh: p.lineHeight, asc: p.ascent, size: p.metrics.height })
    }
  }
  cmd.executeSetZone('main')
  return chars
}

/** 页面实际的宽高和页边距：横放时编辑器交换宽高、页边距转 90°（选项里存的是竖放的值） */
function pageBox(o) {
  if (o.paperDirection !== 'horizontal') return { width: o.width, height: o.height, margins: o.margins }
  const m = o.margins
  return { width: o.height, height: o.width, margins: [m[1], m[2], m[3], m[0]] }
}

// 页码：库不把页码当元素，按 pageNumber 选项复刻库的画法
function collectPageNumbers(pageCount) {
  const o = editor.command.getOptions()
  const box = pageBox(o)
  const p = o.pageNumber
  if (p.disabled) return []
  const g = document.createElement('canvas').getContext('2d')
  g.font = `${p.size}px ${p.font}`
  const out = []
  for (let n = 0; n < pageCount; n++) {
    if (n < p.fromPageNo) continue
    const text = p.format.replace('{pageNo}', String(n + p.startPageNo - p.fromPageNo)).replace('{pageCount}', String(pageCount - p.fromPageNo))
    const list = [...text]
    const m = g.measureText(text)
    const x0 = p.rowFlex === 'center' ? (box.width - m.width) / 2 : p.rowFlex === 'right' ? box.width - m.width - box.margins[1] : box.margins[3]
    const at = (k) => x0 + g.measureText(list.slice(0, k).join('')).width
    out.push({ pg: n, base: box.height - p.bottom, size: p.size, chars: list.map((v, k) => ({ v, x: at(k), r: at(k + 1) })) })
  }
  return out
}

function positions(pageCount) {
  const o = editor.command.getOptions()
  const box = pageBox(o)
  return {
    body: collectBody(),
    header: o.header?.disabled ? [] : collectZone('header'),
    footer: o.footer?.disabled ? [] : collectZone('footer'),
    pageNumbers: collectPageNumbers(pageCount),
    options: { width: box.width, height: box.height, header: o.header, footer: o.footer },
  }
}

async function docx() {
  const blob = await editor.command.executeExportDocx({ fileName: 'document' })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** 用插件导入 docx：另开一个编辑器，不动渲染用的那个。只返回插件的结果（文档 JSON 和它设的选项），补丁在 Node 里打 */
async function importDocx(b64, options) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const holder = document.createElement('div')
  document.body.appendChild(holder)
  const ed = new Editor(holder, { main: [] }, { ...BASE_OPTIONS, ...options })
  try {
    ed.use(docxPlugin)
    await ed.command.executeImportDocx({ arrayBuffer: bin.buffer })
    const { data } = ed.command.getValue()
    const o = ed.command.getOptions()
    return { data, options: { width: o.width, height: o.height, paperDirection: o.paperDirection, margins: o.margins, defaultFont: o.defaultFont, defaultSize: o.defaultSize } }
  } finally {
    ed.destroy()
    holder.remove()
  }
}

window.__renderer = { load, images, positions, docx, importDocx, ready: true }
