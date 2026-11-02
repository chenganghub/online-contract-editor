// 演示用的样例合同、字段定义、客户数据、印章。合同正文是内容，字体和颜色按合同习惯，不受界面规范限制。
import type { DataSourceDef, DocData, FieldDef, SealOption } from '@oe/web'

export const PAY_OPTIONS = [
  { value: '一次性付款', code: 'once' },
  { value: '分期付款', code: 'stage' },
]

export const FIELDS: FieldDef[] = [
  { key: 'contractNo', label: '合同编号', type: 'text' },
  { key: 'partyA', label: '甲方', type: 'picker', dataSource: { id: 'customer', kind: 'remote' }, fill: { partyA: 'name', partyAAddress: 'address', partyACredit: 'creditCode' } },
  { key: 'partyAAddress', label: '甲方地址', type: 'text' },
  { key: 'partyACredit', label: '统一社会信用代码', type: 'text' },
  { key: 'amount', label: '合同金额', type: 'amount' },
  { key: 'amountCN', label: '金额大写', type: 'computed', computed: { from: 'amount', fn: 'amountCN' } },
  { key: 'payMethod', label: '付款方式', type: 'select', options: PAY_OPTIONS, dataSource: { id: 'payment-method', kind: 'dict' } },
  { key: 'signDate', label: '签订日期', type: 'date', format: 'yyyy年MM月dd日' },
  { key: 'items', label: '设备清单', type: 'loop', loop: { columns: ['name', 'model', 'qty', 'price'], labels: ['品名', '型号', '数量', '单价（元）'] } },
  { key: 'photo', label: '设备照片', type: 'image' },
]

const control = (key: string) => {
  const f = FIELDS.find((x) => x.key === key)!
  const base = { value: null, placeholder: f.label, conceptId: f.key, prefix: '', postfix: '' }
  if (f.type === 'select') return { type: 'control', value: '', control: { ...base, type: 'select', code: null, valueSets: PAY_OPTIONS } }
  if (f.type === 'date') return { type: 'control', value: '', control: { ...base, type: 'date', dateFormat: f.format } }
  if (f.type === 'computed') return { type: 'control', value: '', control: { ...base, type: 'text', disabled: true } }
  return { type: 'control', value: '', control: { ...base, type: 'text' } }
}
const p = (value: string, extra: Record<string, unknown> = {}) => ({ value, ...extra })
const heading = (value: string) => p(`\n${value}`, { bold: true })

export function sampleDoc(): DocData {
  return {
    header: [{ value: '采购合同', size: 12, color: '#8e8e93', rowFlex: 'right' }],
    main: [
      p('采购合同', { size: 26, bold: true, rowFlex: 'center' }),
      p('\n合同编号：'), control('contractNo'),
      p('\n甲方（采购方）：'), control('partyA'),
      p('\n地址：'), control('partyAAddress'),
      p('\n统一社会信用代码：'), control('partyACredit'),
      p('\n乙方（供应方）：华东智能装备有限公司'),
      p('\n地址：江苏省苏州市吴中区东吴北路 88 号'),
      p('\n根据《中华人民共和国民法典》及相关法律法规，甲乙双方经平等协商，就甲方向乙方采购设备事宜达成如下协议，以资共同遵守。'),
      heading('第一条　采购标的'),
      p('\n乙方向甲方'), control('partyA'), p('提供数控加工设备一批，品名、规格、数量详见附件《设备清单》。设备应为全新、未使用过的合格产品，符合国家标准和行业标准。'),
      heading('第二条　合同价款'),
      p('\n合同总价为人民币 '), control('amount'), p(' 元（大写：'), control('amountCN'), p('），为含税价，包括设备价款、包装、运输、保险、安装调试及培训费用。'),
      heading('第三条　付款方式'),
      p('\n付款方式：'), control('payMethod'), p('。甲方在设备验收合格并收到乙方开具的增值税专用发票后十五个工作日内付款。'),
      heading('第四条　交货与验收'),
      p('\n乙方应于合同生效后三十日内将设备运至甲方指定地点，并在到货后五个工作日内完成安装调试。甲方应在安装调试完成后十个工作日内组织验收，验收不合格的，乙方应在七日内更换或修复。'),
      heading('第五条　质量保证'),
      p('\n设备质量保证期为验收合格之日起十二个月。质保期内因设备本身质量问题造成的故障，乙方应在接到通知后二十四小时内响应，四十八小时内到场维修，费用由乙方承担。'),
      heading('第六条　违约责任'),
      p('\n乙方逾期交货的，每逾期一日，应按合同总价的千分之一向甲方支付违约金；逾期超过三十日的，甲方有权解除合同。甲方逾期付款的，每逾期一日，应按逾期金额的千分之一向乙方支付违约金。'),
      heading('第七条　争议解决'),
      p('\n因本合同引起的或与本合同有关的任何争议，双方应友好协商解决；协商不成的，任何一方均可向甲方所在地有管辖权的人民法院提起诉讼。'),
      heading('第八条　其他'),
      p('\n本合同一式肆份，甲乙双方各执贰份，具有同等法律效力。本合同自双方法定代表人或授权代表签字并加盖公章或合同专用章之日起生效。'),
      heading('第九条　补充条款'),
      // 可编辑区：填写模式里能改这一段（方案 4.2）
      p('\n'),
      { type: 'area', value: '', area: { extension: { anchor: 'supplement', editable: true } }, valueList: [p('双方无其他约定。')] },
      p('\n（以下无正文）'),
      p('\n\n甲方（盖章）：'), control('partyA'),
      p('\n\n乙方（盖章）：华东智能装备有限公司'),
      p('\n\n签订日期：'), control('signDate'),
    ],
    footer: [],
  } as unknown as DocData
}

/** 数据源：客户走远程接口（经宿主注入的 request，见 main.ts 和 customers.ts） */
export const DATA_SOURCES: Record<string, DataSourceDef> = {
  customer: { kind: 'remote', url: '/api/customers', list: 'data.list', total: 'data.total', id: 'id', title: 'name', subtitle: 'address', pageSize: 5 },
}

/** 演示用的印章图片（真实场景由宿主提供） */
function drawSeal(id: string, name: string): SealOption {
  const size = 151
  const c = document.createElement('canvas')
  c.width = c.height = size * 2
  const g = c.getContext('2d')!
  g.scale(2, 2)
  g.strokeStyle = g.fillStyle = 'rgb(214, 36, 36)'
  g.lineWidth = 4.5
  g.beginPath()
  g.arc(size / 2, size / 2, 70, 0, Math.PI * 2)
  g.stroke()
  g.beginPath()
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 9 : 22
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    g.lineTo(size / 2 + r * Math.cos(a), 74 + r * Math.sin(a))
  }
  g.closePath()
  g.fill()
  g.font = 'bold 16px SimSun, serif'
  g.textAlign = 'center'
  g.fillText(name, size / 2, 120)
  const text = '华东智能装备有限公司'
  g.font = 'bold 17px SimSun, serif'
  const span = Math.PI * 1.25
  for (let i = 0; i < text.length; i++) {
    const a = -Math.PI / 2 - span / 2 + (span * (i + 0.5)) / text.length
    g.save()
    g.translate(size / 2 + 54 * Math.cos(a), size / 2 + 54 * Math.sin(a))
    g.rotate(a + Math.PI / 2)
    g.fillText(text[i]!, 0, 6)
    g.restore()
  }
  return { id, name, src: c.toDataURL('image/png') }
}
export const demoSeals = () => [drawSeal('contract', '合同专用章'), drawSeal('official', '公章')]
