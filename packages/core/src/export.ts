// 文档导出成 HTML、纯文本时的外壳，浏览器（packages/web）和渲染服务共用，两边下载的文件一样。
// 内容来自 canvas-editor 的 getHTML / getText（页眉、正文、页脚三块）
import { layoutOptions } from './layout'
import { clone, elAt, walkDoc, type Ctrl, type Doc } from './model'
import { CONTEXT_ATTRS, CONTROL_STYLE_ATTRS, pick } from './text'
import type { DocData, PageSetup } from './types'

/** 复选、单选控件写成字：选中的 ☑、没选的 ☐，选项之间空一格（纸面合同的写法，单选也用方框） */
export function choiceText(control: Ctrl): string {
  const codes = String(control.code ?? '').split(',')
  return (control.valueSets ?? []).map((s) => `${codes.includes(s.code) ? '☑' : '☐'}${s.value}`).join(' ')
}

// 控件里的字自己的样式（canvas-editor 画选项文字用的）
const RUN_STYLE = ['font', 'size', 'bold', 'italic', 'underline', 'strikeout', 'color', 'highlight'] as const

/**
 * 导出 Word、HTML、纯文本用的副本：复选、单选控件换成普通文字（☑空调 ☐网络）。
 * canvas-editor 的 getHTML / getText 只写选项文字、不写选了哪个，打印模式下 docx 插件拿到的也只有选项文字，导出来就成了「月付季付年付」。
 * PDF、页面图照原文档画，本来就有勾。隐藏的控件写成空文字。不改传进来的文档
 */
export function choicesAsText(doc: DocData): DocData {
  const out = clone(doc)
  for (const loc of [...walkDoc(out as unknown as Doc)]) {
    const el = elAt(loc)
    const c = el.control
    if (el.type !== 'control' || !c || (c.type !== 'checkbox' && c.type !== 'radio')) continue
    const first = Array.isArray(c.value) ? c.value[0] : undefined
    loc.list[loc.index] = { ...pick(first, RUN_STYLE), ...pick(c, CONTROL_STYLE_ATTRS), ...pick(el, CONTEXT_ATTRS), value: c.hide ? '' : choiceText(c) }
  }
  return out
}

/** 文档里有没有复选、单选控件（没有时 choicesAsText 不改内容，导出可以直接用编辑器里的） */
export const hasChoices = (doc: DocData): boolean =>
  [...walkDoc(doc as unknown as Doc)].some((loc) => {
    const el = elAt(loc)
    return el.type === 'control' && (el.control?.type === 'checkbox' || el.control?.type === 'radio')
  })

export interface DocParts {
  header: string
  main: string
  footer: string
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 一份能直接打开的 HTML：按纸张宽度排，字体字号用编辑器的默认值。header / main / footer 三块，导入时按它分开还原 */
export function htmlDocument(title: string, parts: DocParts, page?: PageSetup): string {
  const o = layoutOptions(page)
  const width = o.paperDirection === 'horizontal' ? o.height : o.width
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="generator" content="online-contract-editor">
<title>${esc(title)}</title>
<style>
body { box-sizing: border-box; max-width: ${width}px; margin: 0 auto; padding: 48px 72px; font-family: "${esc(o.defaultFont)}", serif; font-size: ${o.defaultSize}px; line-height: 1.75; color: #000; }
header, footer { color: #8e8e93; font-size: 12px; }
table { border-collapse: collapse; } td, th { border: 1px solid #000; padding: 4px 6px; }
</style>
</head>
<body>
<header>${parts.header}</header>
<main>${parts.main}</main>
<footer>${parts.footer}</footer>
</body>
</html>
`
}

/** 纯文本：页眉、正文、页脚之间空一行，空的那块不要 */
export const textDocument = (parts: DocParts): string =>
  [parts.header, parts.main, parts.footer]
    .map((s) => s.replace(/\u200B/g, ''))
    .filter((s) => s.trim())
    .join('\n\n')
