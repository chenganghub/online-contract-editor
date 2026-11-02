import { describe, expect, it } from 'vitest'
import { buildPages, type CharPos, type Positions } from './text-layer'

const ch = (v: string, i: number, x: number, extra: Partial<CharPos> = {}): CharPos => ({
  cell: '',
  tr: -1,
  td: -1,
  i,
  v,
  pg: 0,
  ri: 0,
  x,
  y: 100,
  r: x + 16,
  lh: 24,
  asc: 14,
  size: 16,
  ...extra,
})

describe('buildPages', () => {
  it('同一行连续的字拼成一段；表格按第一个字的位置插回正文；页眉复制到每页、页码接在最后', () => {
    const pos: Positions = {
      body: [
        ch('甲', 1, 120),
        ch('方', 2, 136),
        // 换行：下一行
        ch('乙', 3, 120, { ri: 1, y: 140 }),
        // 表格在两行正文之间（y = 120）
        ch('品', 0, 130, { cell: 't1:0:0', tr: 0, td: 0, y: 120 }),
        ch('名', 1, 146, { cell: 't1:0:0', tr: 0, td: 0, y: 120 }),
        // 第 2 页
        ch('丙', 4, 120, { pg: 1, y: 100 }),
      ],
      header: [ch('采', 0, 600, { cell: 'header', y: 30 }), ch('购', 1, 616, { cell: 'header', y: 30 })],
      footer: [],
      pageNumbers: [
        { pg: 0, base: 1060, size: 12, chars: [{ v: '1', x: 397, r: 404 }] },
        { pg: 1, base: 1060, size: 12, chars: [{ v: '2', x: 397, r: 404 }] },
      ],
      options: { width: 794, height: 1123, header: {}, footer: {} },
    }
    const pages = buildPages(pos, 2)
    expect(pages[0]!.map((r) => `${r.zone}:${r.text}`)).toEqual(['header:采购', 'main:甲方', 'table:品名', 'main:乙', 'pageNumber:1'])
    expect(pages[1]!.map((r) => `${r.zone}:${r.text}`)).toEqual(['header:采购', 'main:丙', 'pageNumber:2'])
    expect(pages[0]![1]!.base).toBe(114)
  })

  it('页眉在禁用的页上不出现', () => {
    const pos: Positions = {
      body: [],
      header: [ch('采', 0, 600, { cell: 'header' })],
      footer: [],
      pageNumbers: [],
      options: { width: 794, height: 1123, header: { disabledPages: [0] } },
    }
    const pages = buildPages(pos, 2)
    expect(pages[0]).toEqual([])
    expect(pages[1]!.map((r) => r.text)).toEqual(['采'])
  })
})
