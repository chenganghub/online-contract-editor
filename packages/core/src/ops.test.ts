import { describe, expect, it } from 'vitest'
import { applyBatch } from './ops'
import type { El } from './model'
import type { DocData, Op } from './types'
import { contractDoc, contractFields } from './__fixtures__/contract'

const ctx = { fields: contractFields }
const main = (d: DocData) => d.main as unknown as El[]
const text = (list: El[]): string =>
  list
    .map((e) => (e.type === 'control' ? (e.control?.value ?? []).map((v) => v.value).join('') : e.valueList ? text(e.valueList) : e.type === 'table' ? '' : e.value))
    .join('')
const controls = (d: DocData, key: string): El[] => {
  const out: El[] = []
  const visit = (list: El[]) => {
    for (const e of list) {
      if (e.type === 'control' && e.control?.conceptId === key) out.push(e)
      if (e.valueList) visit(e.valueList)
      for (const tr of e.trList ?? []) for (const td of tr.tdList) visit(td.value)
    }
  }
  visit(main(d))
  return out
}
const values = (d: DocData, key: string) => controls(d, key).map((e) => (e.control?.value ?? []).map((v) => v.value).join(''))
const ok = (data: DocData, ops: Op[]) => {
  const r = applyBatch(data, ops, ctx)
  if (!r.ok) throw new Error(r.error)
  return r
}
const ctrl = (conceptId: string) => ({ type: 'control', value: '', control: { type: 'text', value: null, conceptId, prefix: '', postfix: '' } })
const asEls = (v: unknown) => v as Op extends { elements: infer E } ? E : never

describe('applyBatch 定位和操作', () => {
  it('把下划线空位换成控件：控件带上前一个字的段落属性，值统一成空数组', () => {
    const r = ok(contractDoc(), [{ op: 'replace', target: { text: '________' }, with: asEls([ctrl('partyA')]) }])
    expect(text(main(r.data))).toContain('甲方：\n乙方')
    expect(controls(r.data, 'partyA')).toHaveLength(2)
    expect(controls(r.data, 'partyA')[0]!.control!.value).toEqual([])
  })

  it('setData：同字段多处一起写，下拉按 code 或显示文字，计算字段跟着算', () => {
    const d = contractDoc()
    const once = ok(d, [{ op: 'replace', target: { text: '________' }, with: asEls([ctrl('partyA')]) }]).data
    const r = ok(once, [{ op: 'setData', values: { partyA: '某某科技有限公司', payMethod: '分期付款', amount: '358600' } }])
    expect(values(r.data, 'partyA')).toEqual(['某某科技有限公司', '某某科技有限公司'])
    expect(controls(r.data, 'payMethod')[0]!.control!.code).toBe('stage')
    expect(values(r.data, 'payMethod')).toEqual(['分期付款'])
    expect(values(r.data, 'amountCN')).toEqual(['叁拾伍万捌仟陆佰元整'])
  })

  it('setData 表格循环：按数组生成行，表头保留，再写一次会重新生成', () => {
    const rows = [
      { name: '数控车床', qty: 2 },
      { name: '立式加工中心', qty: 1 },
      { name: '三坐标测量机', qty: 1 },
    ]
    const r1 = ok(contractDoc(), [{ op: 'setData', values: { items: rows } }])
    const table = main(r1.data).find((e) => e.type === 'table')!
    expect(table.trList).toHaveLength(5)
    expect(table.trList![0]!.pagingRepeat).toBe(true)
    expect(values(r1.data, 'name')).toEqual(['数控车床', '立式加工中心', '三坐标测量机'])
    const r2 = ok(r1.data, [{ op: 'setData', values: { items: rows.slice(0, 1) } }])
    expect(main(r2.data).find((e) => e.type === 'table')!.trList).toHaveLength(3)
    const r3 = ok(r2.data, [{ op: 'setData', values: { items: [] } }])
    expect(main(r3.data).find((e) => e.type === 'table')!.trList).toHaveLength(3)
    expect(values(r3.data, 'name')).toEqual([''])
  })

  it('text 定位能跨样式不同的相邻文字，也能找到表格单元格里的字', () => {
    const r = ok(contractDoc(), [
      { op: 'setText', target: { text: '争议，双方协商' }, text: '因本合同引起的争议，提交上海仲裁委员会仲裁。' },
      { op: 'replace', target: { text: '________', occurrence: 1 }, with: asEls([{ value: '叁拾伍万元整' }]) },
    ])
    const all = text(main(r.data))
    expect(all).toContain('\n因本合同引起的争议，提交上海仲裁委员会仲裁。\n合计金额：')
    expect(all).not.toContain('双方协商解决')
    const table = main(r.data).find((e) => e.type === 'table')!
    expect(text(table.trList![2]!.tdList[0]!.value)).toBe('合计（大写）：叁拾伍万元整')
  })

  it('insert、update、remove 按字段、锚点、表格单元格、id 定位', () => {
    const r = ok(contractDoc(), [
      { op: 'insert', target: { field: 'contractNo' }, position: 'after', elements: asEls([{ value: '（手写无效）' }]) },
      { op: 'update', target: { field: 'payMethod' }, properties: { disabled: true } },
      { op: 'setText', target: { anchor: 'extra' }, text: '补充条款：质保期延长到 24 个月' },
      { op: 'setText', target: { table: { id: 'goods', row: 2, col: 1 } }, text: '含税' },
      { op: 'update', target: { text: '采购合同' }, properties: { italic: true } },
      { op: 'remove', target: { id: 'goods' } },
    ])
    const all = text(main(r.data))
    expect(all).toContain('合同编号：（手写无效）')
    expect(controls(r.data, 'payMethod')[0]!.control!.disabled).toBe(true)
    expect(all).toContain('补充条款：质保期延长到 24 个月')
    expect(main(r.data).some((e) => e.type === 'table')).toBe(false)
    expect(main(r.data)[0]).toMatchObject({ value: '采购合同', italic: true, bold: true })
  })

  it('印章：放、移、删；同一个 id 重复放只生效一次', () => {
    const seal = { id: 'seal-1', dataURL: 'data:image/png;base64,AAAA', pageNo: 0, x: 400, y: 600, width: 151, height: 151 }
    const r = ok(contractDoc(), [
      { op: 'placeSeal', seal },
      { op: 'placeSeal', seal },
      { op: 'moveSeal', id: 'seal-1', pageNo: 0, x: 300, y: 500 },
    ])
    const seals = main(r.data).filter((e) => e.type === 'image')
    expect(seals).toHaveLength(1)
    expect(seals[0]).toMatchObject({ id: 'seal-1', imgDisplay: 'float-top', imgFloatPosition: { x: 300, y: 500, pageNo: 0 } })
    expect(r.created).toEqual(['seal-1', 'seal-1'])
    const gone = ok(r.data, [{ op: 'removeSeal', id: 'seal-1' }])
    expect(main(gone.data).some((e) => e.type === 'image')).toBe(false)
  })
})

describe('applyBatch 错误和原子性', () => {
  it('第 2 条找不到位置：整批不生效，返回第 2 条的错误，传入的文档不变', () => {
    const d = contractDoc()
    const before = JSON.stringify(d)
    const r = applyBatch(
      d,
      [
        { op: 'setData', values: { contractNo: 'HT-001' } },
        { op: 'replace', target: { text: '这句话在合同里不存在' }, with: [] },
        { op: 'update', target: { field: 'payMethod' }, properties: { disabled: true } },
      ],
      ctx,
    )
    expect(r).toMatchObject({ ok: false, index: 1, code: 'TARGET_NOT_FOUND' })
    expect(JSON.stringify(d)).toBe(before)
  })

  it.each<[string, Op, string]>([
    ['字段不存在', { op: 'setData', values: { noSuch: 'x' } }, 'FIELD_NOT_FOUND'],
    ['下拉没有这个选项', { op: 'setData', values: { payMethod: '货到付款' } }, 'VALUE_NOT_IN_OPTIONS'],
    ['第 99 处', { op: 'remove', target: { text: '甲方', occurrence: 99 } }, 'OCCURRENCE_OUT_OF_RANGE'],
    ['整段替换会删掉段里的控件', { op: 'setText', target: { text: '付款方式' }, text: '新付款条款' }, 'PARAGRAPH_HAS_ELEMENTS'],
    ['印章页码不合法', { op: 'placeSeal', seal: { id: 's', dataURL: 'data:image/png;base64,A', pageNo: -1, x: 0, y: 0, width: 1, height: 1 } }, 'BAD_ARGUMENT'],
    ['改值放进 properties', { op: 'update', target: { field: 'partyA' }, properties: { value: 'x' } }, 'BAD_ARGUMENT'],
    ['锚点不存在', { op: 'setText', target: { anchor: 'nope' }, text: 'x' }, 'TARGET_NOT_FOUND'],
    ['表格单元格不存在', { op: 'remove', target: { table: { id: 'goods', row: 9, col: 0 } } }, 'TARGET_NOT_FOUND'],
    ['新文字带换行', { op: 'setText', target: { text: '争议' }, text: '一\n二' }, 'BAD_ARGUMENT'],
  ])('%s → %s', (_name, op, code) => {
    const r = applyBatch(contractDoc(), [op], ctx)
    expect(r).toMatchObject({ ok: false, index: 0, code })
  })
})
