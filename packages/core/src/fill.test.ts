import { describe, expect, it } from 'vitest'
import { AREA_MAX_LENGTH, AREA_MAX_RUNS, applyAreas, applyFill, areaAnchors, areaStyle, stripHidden } from './fill'
import type { El } from './model'
import type { DocData, DocValues } from './types'
import { contractDoc, contractFields } from './__fixtures__/contract'

const valueOf = (d: DocData, key: string) => {
  const out: string[] = []
  const visit = (list: El[]) => {
    for (const e of list) {
      if (e.type === 'control' && e.control?.conceptId === key) out.push((e.control.value ?? []).map((v) => v.value).join(''))
      if (e.valueList) visit(e.valueList)
      for (const tr of e.trList ?? []) for (const td of tr.tdList) visit(td.value)
    }
  }
  visit(d.main as unknown as El[])
  return out
}
const empty: DocValues = { values: {} }

describe('applyFill', () => {
  it('可编辑字段写进文档和数据 JSON，计算字段跟着算', () => {
    const r = applyFill(contractDoc(), empty, { partyA: '某某科技', amount: '1001' }, contractFields, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(valueOf(r.data, 'partyA')).toEqual(['某某科技'])
    expect(valueOf(r.data, 'amountCN')).toEqual(['壹仟零壹元整'])
    expect(r.values.values).toMatchObject({ partyA: '某某科技', amount: '1001', amountCN: '壹仟零壹元整' })
  })

  it('有一个字段不可写就整次拒绝：只读、隐藏、计算字段', () => {
    const doc = contractDoc()
    for (const [patch, perms] of [
      [{ partyA: 'x', payMethod: 'once' }, { payMethod: 'readonly' }],
      [{ partyA: 'x' }, { partyA: 'hidden' }],
      [{ amountCN: '壹元整' }, {}],
    ] as const) {
      const r = applyFill(doc, empty, patch, contractFields, perms)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('PERMISSION_DENIED')
    }
  })

  it('必填字段可以写；模板里没有的字段和不合法的值返回对应错误', () => {
    expect(applyFill(contractDoc(), empty, { partyA: 'x' }, contractFields, { partyA: 'required' }).ok).toBe(true)
    expect(applyFill(contractDoc(), empty, { noSuch: 'x' }, contractFields, {})).toMatchObject({ ok: false, code: 'FIELD_NOT_FOUND', field: 'noSuch' })
    expect(applyFill(contractDoc(), empty, { payMethod: '货到付款' }, contractFields, {})).toMatchObject({ ok: false, code: 'VALUE_NOT_IN_OPTIONS', field: 'payMethod' })
  })
})

describe('stripHidden', () => {
  it('隐藏字段：控件保留、值清空，数据 JSON 和快照里也删掉；其他字段不动', () => {
    const filled = applyFill(contractDoc(), empty, { partyA: '某某科技', contractNo: 'HT-1' }, contractFields, {})
    if (!filled.ok) throw new Error(filled.error)
    const values: DocValues = { ...filled.values, snapshots: { partyA: { sourceId: 'c1', text: '某某科技', fields: {}, at: '2026-11-01' } } }
    const r = stripHidden(filled.data, values, contractFields, { partyA: 'hidden' })
    expect(valueOf(r.data, 'partyA')).toEqual([''])
    expect(valueOf(r.data, 'contractNo')).toEqual(['HT-1'])
    expect(r.values.values.partyA).toBeUndefined()
    expect(r.values.snapshots?.partyA).toBeUndefined()
    expect(r.values.values.contractNo).toBe('HT-1')
    // 原文档不变
    expect(valueOf(filled.data, 'partyA')).toEqual(['某某科技'])
  })

  it('文档 JSON 里表格的行、单元格不是对象时跳过，不报错', () => {
    const doc = { main: [{ type: 'table', value: '', trList: [null, { tdList: [null, { value: 'x' }, { value: [{ value: '甲' }] }] }] }] } as unknown as DocData
    expect(() => stripHidden(doc, empty, contractFields, { partyA: 'hidden' })).not.toThrow()
  })

  it('隐藏的区域内容清空', () => {
    const doc = contractDoc()
    const area = (doc.main as unknown as El[]).find((e) => e.type === 'area')!
    area.area = { ...area.area, hide: true }
    const r = stripHidden(doc, empty, contractFields, {})
    expect((r.data.main as unknown as El[]).find((e) => e.type === 'area')!.valueList).toEqual([])
  })
})

describe('applyAreas', () => {
  const withArea = (area: Record<string, unknown>, valueList: El[] = [{ value: '补充条款：无', bold: true, size: 14 } as El]) => {
    const doc = contractDoc()
    const el = (doc.main as unknown as El[]).find((e) => e.type === 'area')!
    el.area = area as El['area']
    el.valueList = valueList
    return doc
  }
  const areaOf = (d: DocData) => (d.main as unknown as El[]).find((e) => e.type === 'area')!

  it('可编辑区按 anchor 整段换成新文字，沿用第一个字的样式；不改原文档', () => {
    const doc = withArea({ extension: { anchor: 'extra', editable: true } })
    const r = applyAreas(doc, { extra: '补充条款：甲方负责卸货。\n乙方负责安装。' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(areaOf(r.data).valueList).toEqual([{ value: '补充条款：甲方负责卸货。\n乙方负责安装。', bold: true, size: 14 }])
    expect(areaOf(doc).valueList).toEqual([{ value: '补充条款：无', bold: true, size: 14 }])
  })

  it('给一组带样式的文字：样式按白名单保留（粗体、颜色、上标），别的属性丢掉', () => {
    const doc = withArea({ extension: { anchor: 'extra', editable: true } }, [{ value: '补充：' } as El, { value: 'm', type: 'superscript' } as El])
    const r = applyAreas(doc, { extra: [{ value: '补充条款：', bold: true }, { value: '甲方负责卸货', color: '#ff0000', controlId: 'x', extension: { a: 1 } } as never, { value: '2', type: 'superscript' }] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(areaOf(r.data).valueList).toEqual([{ value: '补充条款：', bold: true }, { value: '甲方负责卸货', color: '#ff0000' }, { value: '2', type: 'superscript' }])
  })

  it('样式类型不对、超出范围的丢掉；段前段后、对齐留下', () => {
    const doc = withArea({ extension: { anchor: 'extra', editable: true } })
    const bad = { size: 1e9, bold: 'yes', rowMargin: -1, rowFlex: 'evil', color: 'red;\nx', highlight: 'x'.repeat(41), font: 'x'.repeat(51), spacingBefore: Number.NaN }
    const good = { size: 14, bold: true, rowMargin: 1.5, rowFlex: 'center', color: 'rgb(255, 0, 0)', highlight: '#FFFF00', font: '宋体', spacingBefore: 8, spacingAfter: 0 }
    const r = applyAreas(doc, { extra: [{ value: '甲', ...bad } as never, { value: '乙', ...good } as never] })
    if (!r.ok) throw new Error(r.error)
    expect(areaOf(r.data).valueList).toEqual([{ value: '甲' }, { value: '乙', ...good }])
    // 字体名会写进 docx 的属性：带引号、尖括号、控制字符的不收
    for (const font of ['宋体"/><w:b', "a'b", 'a&b', 'a\u0007b']) expect(areaStyle({ font, size: 14 })).toEqual({ size: 14 })
    expect(areaStyle({ font: 'Times New Roman' })).toEqual({ font: 'Times New Roman' })
  })

  it('存进去的和编辑器 getValue() 一样：空文字去掉、相邻同样式的合并；清空就是空区域', () => {
    const editable = { extension: { anchor: 'extra', editable: true } }
    const r = applyAreas(withArea(editable), { extra: [{ value: '甲', bold: true }, { value: '' }, { value: '乙', bold: true }, { value: '丙' }] })
    if (!r.ok) throw new Error(r.error)
    expect(areaOf(r.data).valueList).toEqual([{ value: '甲乙', bold: true }, { value: '丙' }])
    for (const extra of ['', [], [{ value: '' }]]) {
      const cleared = applyAreas(withArea(editable), { extra })
      if (!cleared.ok) throw new Error(cleared.error)
      expect(areaOf(cleared.data).valueList).toEqual([])
    }
  })

  it('没有要改的区域时原样返回，不拷贝文档；同一个 anchor 有几处时后面的按顺序叫 anchor-2…（和编辑器一样）', () => {
    const doc = withArea({ extension: { anchor: 'extra', editable: true } })
    const same = applyAreas(doc, {})
    expect(same.ok && same.data).toBe(doc)
    const main = doc.main as unknown as El[]
    main.push(structuredClone(areaOf(doc)), structuredClone(areaOf(doc)))
    // 文档里已经有叫 extra-2 的：重复的第二个跳过它叫 extra-3
    main[main.length - 1]!.area = { extension: { anchor: 'extra-2', editable: true } }
    expect(areaAnchors(doc).map((a) => a.anchor)).toEqual(['extra', 'extra-3', 'extra-2'])
    const r = applyAreas(doc, { extra: '一', 'extra-3': '二', 'extra-2': '三' })
    if (!r.ok) throw new Error(r.error)
    const areas = (r.data.main as unknown as El[]).filter((e) => e.type === 'area')
    expect(areas.map((a) => a.valueList![0]!.value)).toEqual(['一', '二', '三'])
    // 只改名不落库：存的文档里 anchor 不变
    expect(areas.map((a) => a.area?.extension?.anchor)).toEqual(['extra', 'extra', 'extra-2'])
  })

  it('找不到、不是可编辑区、隐藏的、模板里有字段的、提交的不是文字的、太长的都整次拒绝', () => {
    const editable = { extension: { anchor: 'extra', editable: true } }
    expect(applyAreas(withArea(editable), { nope: 'x' })).toMatchObject({ ok: false, code: 'TARGET_NOT_FOUND', area: 'nope' })
    expect(applyAreas(withArea({ extension: { anchor: 'extra' } }), { extra: 'x' })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' })
    expect(applyAreas(withArea({ extension: { anchor: '', editable: true } }), { '': 'x' })).toMatchObject({ ok: false, code: 'TARGET_NOT_FOUND' })
    expect(applyAreas(withArea({ ...editable, hide: true }), { extra: 'x' })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' })
    const control = { type: 'control', value: '', control: { type: 'text', conceptId: 'partyA', value: [] } } as unknown as El
    expect(applyAreas(withArea(editable, [{ value: '甲方：' }, control]), { extra: 'x' })).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(applyAreas(withArea(editable), { extra: [{ value: 'a' }, { value: '', type: 'image' } as never] })).toMatchObject({ ok: false, code: 'BAD_ARGUMENT', error: expect.stringContaining('第 2 段') })
    expect(applyAreas(withArea(editable), { extra: 'x'.repeat(AREA_MAX_LENGTH + 1) })).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(applyAreas(withArea(editable), { extra: [{ value: 'x'.repeat(AREA_MAX_LENGTH) }, { value: 'y' }] })).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(applyAreas(withArea(editable), { extra: Array.from({ length: AREA_MAX_RUNS + 1 }, () => ({ value: 'a' })) })).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
  })

  it('存库的区域内容不是元素数组时不报 500：不是数组当空区域，里面有不是元素的整次拒绝', () => {
    const editable = { extension: { anchor: 'extra', editable: true } }
    const r = applyAreas(withArea(editable, 'oops' as never), { extra: '新' })
    if (!r.ok) throw new Error(r.error)
    expect(areaOf(r.data).valueList).toEqual([{ value: '新' }])
    expect(applyAreas(withArea(editable, ['a', null] as never), { extra: '新' })).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
  })
})
