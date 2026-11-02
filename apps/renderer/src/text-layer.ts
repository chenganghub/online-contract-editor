// 把渲染页取回的逐字位置拼成每页的文字段（K9b 的 buildPages）：
// 一段 = 同一页、同一行、同一单元格、同字号、下标连续的字。表格按第一个字的位置插回正文顺序，复制出来的文字顺序接近阅读顺序。

export interface CharPos {
  cell: string
  tr: number
  td: number
  i: number
  v: string
  pg: number
  ri: number
  x: number
  y: number
  r: number
  lh: number
  asc: number
  size: number
}

export interface PageNumberPos {
  pg: number
  base: number
  size: number
  chars: { v: string; x: number; r: number }[]
}

export interface ZoneOption {
  disabled?: boolean
  disabledPages?: number[]
}

export interface Positions {
  body: CharPos[]
  header: CharPos[]
  footer: CharPos[]
  pageNumbers: PageNumberPos[]
  options: { width: number; height: number; header?: ZoneOption; footer?: ZoneOption }
}

export interface TextRun {
  zone: string
  pg: number
  size: number
  /** 基线的 y（编辑器像素，页内） */
  base: number
  chars: { v: string; x: number; r: number }[]
  text: string
}

const rd = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

export function buildPages(pos: Positions, pageCount: number): TextRun[][] {
  type Run = TextRun & { key: string; lastI: number }
  const runKey = (c: CharPos) => `${c.pg}|${c.cell}|${c.ri}|${c.size}|${rd(c.y + c.asc)}`
  const main = pos.body.filter((c) => !c.cell).sort((p, q) => p.i - q.i)
  const tables = new Map<string, CharPos[]>()
  for (const c of pos.body.filter((c) => c.cell)) {
    const tid = c.cell.split(':')[0]!
    if (!tables.has(tid)) tables.set(tid, [])
    tables.get(tid)!.push(c)
  }
  const blocks = [...tables.values()]
    .map((list) => {
      list.sort((p, q) => p.tr - q.tr || p.td - q.td || p.i - q.i)
      const start = list.reduce((m, c) => (c.pg < m.pg || (c.pg === m.pg && c.y < m.y) ? c : m), list[0]!)
      return { start, list }
    })
    .sort((p, q) => p.start.pg - q.start.pg || p.start.y - q.start.y)
  const ordered: CharPos[] = []
  let k = 0
  const before = (s: CharPos, c: CharPos) => s.pg < c.pg || (s.pg === c.pg && s.y < c.y)
  for (const c of main) {
    while (k < blocks.length && before(blocks[k]!.start, c)) ordered.push(...blocks[k++]!.list)
    ordered.push(c)
  }
  while (k < blocks.length) ordered.push(...blocks[k++]!.list)

  const toRuns = (list: CharPos[], zone?: string): Run[] => {
    const runs: Run[] = []
    for (const c of list) {
      const last = runs.at(-1)
      if (last && last.key === runKey(c) && c.i === last.lastI + 1) {
        last.chars.push({ v: c.v, x: c.x, r: c.r })
        last.lastI = c.i
      } else
        runs.push({ key: runKey(c), lastI: c.i, zone: zone ?? (c.cell ? 'table' : 'main'), pg: c.pg, size: c.size, base: c.y + c.asc, chars: [{ v: c.v, x: c.x, r: c.r }], text: '' })
    }
    return runs
  }
  const pages: TextRun[][] = Array.from({ length: pageCount }, () => [])
  // 页眉页脚每页画法相同：取到的位置都在第 0 页，复制到每一页（跳过禁用的页）
  const copyZone = (chars: CharPos[], zone: string, opt?: ZoneOption) => {
    if (!chars.length || opt?.disabled) return
    const runs = toRuns(chars, zone)
    for (let pg = 0; pg < pageCount; pg++) {
      if (opt?.disabledPages?.includes(pg)) continue
      for (const r of runs) pages[pg]!.push({ ...r, pg })
    }
  }
  copyZone(pos.header, 'header', pos.options.header)
  for (const r of toRuns(ordered)) pages[r.pg]?.push(r)
  copyZone(pos.footer, 'footer', pos.options.footer)
  for (const p of pos.pageNumbers) pages[p.pg]?.push({ zone: 'pageNumber', pg: p.pg, size: p.size, base: p.base, chars: p.chars, text: '' })
  for (const list of pages) for (const r of list) r.text = r.chars.map((c) => c.v).join('')
  return pages.map((list) => list.map(({ zone, pg, size, base, chars, text }) => ({ zone, pg, size, base, chars, text })))
}
