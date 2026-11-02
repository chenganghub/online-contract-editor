// docx 里的 XML 结构很规整（Word、WPS、docx 库生成），这里只用最小的文本扫描，不引 XML 解析库。

export const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')

export const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

export interface Span {
  start: number
  end: number
}

/** 按出现顺序列出所有 <tag …>…</tag>（含嵌套在里面的同名元素），先出现的在前 */
export function spans(xml: string, tag: string): Span[] {
  const re = new RegExp(`<${tag}(?=[\\s>/])[^>]*?(/?)>|</${tag}>`, 'g')
  const out: Span[] = []
  const stack: number[] = []
  for (const m of xml.matchAll(re)) {
    if (m[0].startsWith('</')) {
      const start = stack.pop()
      if (start !== undefined) out.push({ start, end: m.index + m[0].length })
    } else if (m[1] === '/') out.push({ start: m.index, end: m.index + m[0].length })
    else stack.push(m.index)
  }
  return out.sort((a, b) => a.start - b.start)
}

/** 直接子元素：在 outer 里找 tag，但跳过嵌在 skip 元素（例如内层表格）里的 */
export function directChildren(xml: string, outer: Span, tag: string, skip: string): Span[] {
  const inner = spans(xml.slice(0, outer.end), skip).filter((s) => s.start > outer.start && s.end < outer.end)
  return spans(xml.slice(0, outer.end), tag).filter(
    (s) => s.start > outer.start && s.end <= outer.end && !inner.some((i) => s.start > i.start && s.end <= i.end),
  )
}

export const attr = (tagXml: string, name: string) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tagXml)
  return m ? decode(m[1]!) : undefined
}

/** 所有 w:t 的文字 */
export const texts = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => decode(m[1]!))
