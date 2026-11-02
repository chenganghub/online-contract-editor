// 单元测试和 e2e 等价性测试共用的样例合同（压缩格式）和字段定义
import type { DocData, FieldDef } from '../types'

const ctrl = (conceptId: string, extra: Record<string, unknown> = {}) => ({
  type: 'control',
  value: '',
  control: { type: 'text', value: null, conceptId, placeholder: conceptId, prefix: '', postfix: '', ...extra },
})
const cell = (value: unknown[]) => ({ colspan: 1, rowspan: 1, value })

export const PAY_OPTIONS = [
  { value: '一次性付款', code: 'once' },
  { value: '分期付款', code: 'stage' },
]

export const contractDoc = (): DocData =>
  ({
    header: [{ value: '采购合同', size: 12 }],
    main: [
      { value: '采购合同', size: 26, bold: true, rowFlex: 'center' },
      { value: '\n合同编号：' },
      ctrl('contractNo'),
      { value: '\n甲方：________\n乙方：华东智能装备有限公司\n付款方式：' },
      ctrl('payMethod', { type: 'select', code: null, valueSets: PAY_OPTIONS }),
      { value: '\n第七条　因本合同引起的争议，' },
      { value: '双方协商解决', bold: true },
      { value: '；协商不成的，向甲方所在地法院起诉。\n合计金额：' },
      ctrl('amount'),
      { value: '元，大写：' },
      ctrl('amountCN', { disabled: true }),
      { value: '\n' },
      {
        type: 'table',
        value: '',
        id: 'goods',
        colgroup: [{ width: 300 }, { width: 254 }],
        trList: [
          { height: 40, pagingRepeat: true, tdList: [cell([{ value: '品名' }]), cell([{ value: '数量' }])] },
          { height: 40, extension: { loop: 'items' }, tdList: [cell([ctrl('name')]), cell([ctrl('qty')])] },
          { height: 40, tdList: [cell([{ value: '合计（大写）：________' }]), cell([{ value: '备注' }])] },
        ],
      },
      { value: '\n甲方（盖章）：' },
      ctrl('partyA'),
      { value: '\n' },
      { type: 'area', value: '', areaId: 'extra', area: { extension: { anchor: 'extra' } }, valueList: [{ value: '补充条款：无' }] },
    ],
    footer: [],
  }) as unknown as DocData

export const contractFields: FieldDef[] = [
  { key: 'contractNo', label: '合同编号', type: 'text' },
  { key: 'partyA', label: '甲方', type: 'text' },
  { key: 'payMethod', label: '付款方式', type: 'select', options: PAY_OPTIONS },
  { key: 'amount', label: '合同金额', type: 'amount' },
  { key: 'amountCN', label: '金额大写', type: 'computed', computed: { from: 'amount', fn: 'amountCN' } },
  { key: 'items', label: '货物清单', type: 'loop', loop: { columns: ['name', 'qty'] } },
]
