// 文件导入导出（docs/设计/07-文档能力与系统对接.md 第 2 节），都在浏览器里做，不依赖服务端。
// Word 用和渲染服务同一个 docx 插件、同一套补丁（@oe/docx）；插件、pdf-lib、jszip 按需加载，不进首屏。
// 宿主接了服务端时，PDF、Word 仍优先走宿主（服务端会核对页数、带文字层），见 ContractEditor 的 exportFile。
import Editor, { EditorMode, getElementListByHTML, type IEditorOption, type IElement } from '@hufe921/canvas-editor'
import { choicesAsText, layoutOptions, type DocData, type DocParts, type DocValues, type FieldDef } from '@oe/core'
import { FONTS } from './formats'
import type { ImportResult } from './types'

export type ExportFormat = 'pdf' | 'docx' | 'html' | 'txt' | 'png' | 'json'
export type ImportFormat = 'docx' | 'html' | 'md' | 'txt' | 'json'

export const MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  png: 'application/zip',
  json: 'application/json;charset=utf-8',
}
/** 下载时的扩展名：图片是每页一张打成的 zip */
export const EXTENSION: Record<ExportFormat, string> = { pdf: 'pdf', docx: 'docx', html: 'html', txt: 'txt', png: 'zip', json: 'json' }
export const IMPORT_ACCEPT = '.docx,.html,.htm,.md,.markdown,.txt,.json'
/** 导入文件的大小上限：和服务端请求体上限（20 MB）一致，免得导进来存不了 */
export const IMPORT_LIMIT = 20 * 1024 * 1024

export function importFormatOf(name: string): ImportFormat | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'docx') return 'docx'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'markdown') return 'md'
  if (ext === 'txt') return 'txt'
  if (ext === 'json') return 'json'
  return null
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
/** 文件名里不能有的字符（Windows 保留的符号、控制字符）换成下划线 */
export const safeName = (title: string) =>
  [...title].map((ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? '_' : ch)).join('').trim() || '文档'

// ---------- HTML 导入：先在不执行脚本的文档里清洗，再交给 canvas-editor 解析 ----------
// canvas-editor 解析 HTML 时把内容挂到页面上算样式，<img onerror> 这类属性会执行，所以只留白名单里的标签和属性
const KEEP_TAGS = new Set([
  'p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'sup', 'sub', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col', 'img', 'a', 'hr', 'font', 'blockquote',
  'pre', 'code', 'section', 'article', 'header', 'main', 'footer', 'label', 'center', 'small', 'big', 'mark',
])
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'video', 'audio', 'link', 'meta', 'title', 'head', 'noscript', 'template', 'svg', 'math', 'form', 'input', 'button', 'select', 'textarea', 'canvas'])
const KEEP_ATTRS = new Set(['style', 'colspan', 'rowspan', 'width', 'height', 'src', 'href', 'align', 'color', 'face', 'size'])
const safeUrl = (v: string, img: boolean) => (img ? /^(data:image\/(png|jpe?g|gif|webp|bmp);base64,|https?:)/i : /^(https?:|mailto:)/i).test(v.trim())

export function sanitizeHtml(html: string): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      const tag = child.tagName.toLowerCase()
      if (DROP_TAGS.has(tag)) {
        child.remove()
        continue
      }
      walk(child)
      if (!KEEP_TAGS.has(tag)) {
        // 不认识的标签去掉，里面的内容留下
        child.replaceWith(...child.childNodes)
        continue
      }
      for (const { name, value } of [...child.attributes]) {
        const n = name.toLowerCase()
        const ok = KEEP_ATTRS.has(n) && (n !== 'src' || safeUrl(value, true)) && (n !== 'href' || safeUrl(value, false)) && (n !== 'style' || !/url\s*\(|expression\s*\(/i.test(value))
        if (!ok) child.removeAttribute(name)
      }
    }
  }
  walk(doc.body)
  // canvas-editor 把 h1～h6 换成 div 再取字号，标题会变成正文大小：里面包一层带字号、加粗的 span（和「样式」设标题时一样大）
  for (const h of doc.body.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const span = doc.createElement('span')
    span.setAttribute('style', `font-size:${h.style.fontSize || `${TITLE_SIZES[Number(h.tagName[1]) - 1]}px`};font-weight:${h.style.fontWeight || 'bold'}`)
    span.append(...h.childNodes)
    h.append(span)
  }
  return doc
}
/** canvas-editor 标题 1～6 的默认字号（options.title） */
const TITLE_SIZES = [26, 24, 22, 20, 18, 16]

/** HTML 转编辑器元素；我们自己导出的 HTML 有 header / main / footer 三块，分开还原 */
export function htmlToDoc(html: string, innerWidth: number): Pick<DocData, 'header' | 'main' | 'footer'> {
  const doc = sanitizeHtml(html)
  const part = (sel: string) => doc.body.querySelector(`:scope > ${sel}`)
  const parse = (el: Element | null) => (el ? getElementListByHTML(el.innerHTML, { innerWidth }) : [])
  const main = part('main')
  if (main) return { header: parse(part('header')), main: parse(main), footer: parse(part('footer')) }
  return { main: getElementListByHTML(doc.body.innerHTML, { innerWidth }) }
}

// ---------- Markdown：标题、段落、加粗斜体删除线、行内代码、列表、表格、分隔线、引用。先转义再拼 HTML ----------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// 只认星号的加粗、斜体：合同里常有「甲方：____ 乙方：____」这种下划线空白，按下划线认强调会把空白吃掉
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\s][^*]*)\*/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
}
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const t = line.trim()
    const heading = /^(#{1,6})\s+(.*)$/.exec(t)
    const bullet = /^[-*+]\s+(.*)$/.exec(t)
    const ordered = /^\d+[.)]\s+(.*)$/.exec(t)
    if (bullet || ordered) {
      const kind = bullet ? 'ul' : 'ol'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline((bullet ?? ordered)![1]!)}</li>`)
      continue
    }
    closeList()
    if (!t) continue
    if (heading) out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`)
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) out.push('<hr>')
    else if (t.startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const head = cells(t)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!))
      i--
      const tr = (r: string[], tag: string) => `<tr>${r.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`
      out.push(`<table border="1">${tr(head, 'th')}${rows.map((r) => tr(r, 'td')).join('')}</table>`)
    } else out.push(`<p>${inline(t.replace(/^>\s?/, ''))}</p>`)
  }
  closeList()
  return out.join('\n')
}

/** 纯文本：一行一段 */
export const textToElements = (text: string): IElement[] => [{ value: text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ') }]

// ---------- JSON：文档、字段、值一起，系统之间搬模板和合同用 ----------
export interface DocumentFile {
  format: 'oe-document'
  version: 1
  title?: string
  doc: DocData
  fields: FieldDef[]
  values?: DocValues
}
export function parseDocumentJson(text: string): DocumentFile {
  const raw = JSON.parse(text) as Partial<DocumentFile> & Partial<DocData>
  // 只有文档 JSON（canvas-editor 的 getValue().data 加 page）也认
  const file = raw.format === 'oe-document' ? raw : { format: 'oe-document' as const, version: 1 as const, doc: raw as DocData, fields: [] }
  if (!file.doc || !Array.isArray(file.doc.main)) throw new Error('不是编辑器的文档 JSON')
  if (file.fields !== undefined && !Array.isArray(file.fields)) throw new Error('字段定义不是数组')
  return { ...file, fields: file.fields ?? [] } as DocumentFile
}

// ---------- Word：在不显示的编辑器里用插件导入导出，和渲染页（apps/renderer/page/render.js）同一个做法 ----------
const loadDocxPlugin = async () => (await import('@hufe921/canvas-editor-plugin-docx')).default
function hiddenHolder() {
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none'
  document.body.appendChild(holder)
  return holder
}
const BASE = { control: { bracketColor: 'transparent' } }
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

/** docx → 编辑器文档和导入报告，和渲染服务的 /convert 结果一样（报告里服务器没有的字体也按渲染服务的字体配置判断） */
export async function importDocxInBrowser(bytes: ArrayBuffer): Promise<ImportResult> {
  const [{ scanDocx, patchImported }, plugin] = await Promise.all([import('@oe/docx'), loadDocxPlugin()])
  const scan = await scanDocx(bytes)
  const holder = hiddenHolder()
  const ed = new Editor(holder, { main: [] }, { ...BASE, ...layoutOptions() } as unknown as IEditorOption)
  try {
    ed.use(plugin)
    await ed.command.executeImportDocx({ arrayBuffer: bytes })
    const { data } = ed.command.getValue()
    const o = ed.command.getOptions()
    const patched = patchImported(data as never, scan, { defaultFont: o.defaultFont, defaultSize: o.defaultSize })
    const doc = patched.doc as unknown as DocData
    const known = new Set(FONTS.map((f) => f.value))
    const used = new Set<string>()
    const visit = (list: IElement[] | undefined) => {
      for (const e of list ?? []) {
        if (e.font) used.add(e.font)
        if (e.valueList) visit(e.valueList)
        for (const tr of e.trList ?? []) for (const td of tr.tdList) visit(td.value)
      }
    }
    visit(doc.header)
    visit(doc.main)
    visit(doc.footer)
    const unknown = [...used].filter((f) => !known.has(f))
    if (unknown.length)
      patched.report.items.push({ kind: 'font', level: 'lost', message: `字体 ${unknown.join('、')} 服务器上没有，显示和 PDF 用替代字体，分页可能和 Word 不同`, sample: unknown.join('、') })
    return { doc, report: patched.report as ImportResult['report'] }
  } finally {
    ed.destroy()
    holder.remove()
  }
}

/**
 * 导出 HTML、纯文本用的页眉、正文、页脚：复选、单选控件先写成「☑空调 ☐网络」（choicesAsText），在不显示的编辑器里取，
 * 和渲染服务的做法一样。直接取当前编辑器的话，这两种控件只有选项文字、看不出选了哪个
 */
export function docParts(doc: DocData, kind: 'html' | 'text'): DocParts {
  const holder = hiddenHolder()
  const ed = new Editor(holder, choicesAsText(doc) as never, { ...BASE, ...layoutOptions(doc.page) } as unknown as IEditorOption)
  try {
    return kind === 'html' ? ed.command.getHTML() : ed.command.getText()
  } finally {
    ed.destroy()
    holder.remove()
  }
}

/** 编辑器文档 → docx。区域、列表拆成普通段落再交给插件，导出后修正默认字体、表头、横向、间距（@oe/docx） */
export async function exportDocxInBrowser(doc: DocData): Promise<Blob> {
  const [{ prepareForExport, exportInfo, fixExportedDocx }, plugin] = await Promise.all([import('@oe/docx'), loadDocxPlugin()])
  const o = layoutOptions(doc.page)
  const docxDoc = prepareForExport(doc as never, { defaultSize: o.defaultSize })
  const holder = hiddenHolder()
  const ed = new Editor(holder, docxDoc as never, { ...BASE, ...o, mode: EditorMode.PRINT } as unknown as IEditorOption)
  // 插件导出完会自己建一个 <a download> 点一下，下载的是没修正过的文件；按这次的文件名把那一下拦掉，只用它返回的内容
  const name = `oe-docx-${Math.random().toString(36).slice(2)}`
  const block = (e: MouseEvent) => {
    if (e.target instanceof HTMLAnchorElement && e.target.download === `${name}.docx`) e.preventDefault()
  }
  document.addEventListener('click', block, true)
  try {
    ed.use(plugin)
    await nextFrame()
    const blob = await ed.command.executeExportDocx({ fileName: name })
    const fixed = await fixExportedDocx(await blob.arrayBuffer(), exportInfo(docxDoc, { defaultFont: o.defaultFont, defaultSize: o.defaultSize }))
    return new Blob([fixed.bytes as BlobPart], { type: MIME.docx })
  } finally {
    document.removeEventListener('click', block, true)
    ed.destroy()
    holder.remove()
  }
}

/**
 * 页面图拼成 PDF（图片版，不能选字；正式件用服务端出的带文字层的）。
 * pages：打印模式的页面图；size：每页的宽高（px，缩放 100%），横竖按图片自己的宽高比定
 */
export async function pdfFromImages(pages: string[], size: { width: number; height: number }, title: string): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.setCreator('online-contract-editor')
  for (const url of pages) {
    const img = await pdf.embedPng(url)
    const landscape = img.width > img.height
    const [w, h] = (landscape === size.width > size.height ? [size.width, size.height] : [size.height, size.width]).map((v) => v * 0.75) as [number, number]
    pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h })
  }
  return new Blob([(await pdf.save()) as BlobPart], { type: MIME.pdf })
}

/** 每页一张 PNG，打成 zip */
export async function zipImages(pages: string[], title: string): Promise<Blob> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const width = String(pages.length).length
  pages.forEach((url, i) => zip.file(`${safeName(title)}-${String(i + 1).padStart(width, '0')}.png`, url.slice(url.indexOf(',') + 1), { base64: true }))
  return zip.generateAsync({ type: 'blob', mimeType: MIME.png })
}
