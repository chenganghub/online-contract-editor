// 演示用的合同范本（docs/设计/07 第 5 节）：采购（sample.ts 里原有的）、销售、技术服务、房屋租赁、保密协议。
// 条款是示例，不构成法律意见；字段、带出、循环表、可编辑区、计算字段的写法和宿主接入时一样。
import { fieldElement, type DocData, type FieldDef, type PreviewSample } from '@oe/web'
import { FIELDS, PAY_OPTIONS, sampleDoc } from './sample'

export interface Sample {
  id: string
  title: string
  fields: FieldDef[]
  doc: () => DocData
  /** 模板设计里「预览」用的样例单据 */
  preview: PreviewSample[]
}

type Part =
  | string
  | { f: string }
  | { area: string; text: string }
  | { loop: string }
  | { image: string }
  | { title: string }
  | { h: string }
  | { sign: string; date: string; label: string }
  | { when: { field: string; in: string[] }; text: string }
type El = Record<string, unknown>

/** 选项：显示文字 → code（getData 返回的是 code，宿主按 code 存） */
const opts = (map: Record<string, string>) => Object.entries(map).map(([value, code]) => ({ value, code }))
const customer = (key: string, fill: Record<string, string>): FieldDef => ({ key, label: '', type: 'picker', dataSource: { id: 'customer', kind: 'remote' }, fill })

/** 字段 → 控件元素（和 @oe/web 的 fieldElement 同一个写法：conceptId 是字段 key，不带前后缀） */
function control(f: FieldDef): El {
  const base = { value: null, placeholder: f.label, conceptId: f.key, prefix: '', postfix: '' }
  if (f.type === 'select' || f.type === 'radio' || f.type === 'checkbox') return { type: 'control', value: '', control: { ...base, type: f.type, code: null, valueSets: f.options ?? [] } }
  if (f.type === 'date') return { type: 'control', value: '', control: { ...base, type: 'date', dateFormat: f.format ?? 'yyyy年MM月dd日' } }
  if (f.type === 'computed') return { type: 'control', value: '', control: { ...base, type: 'text', disabled: true } }
  return { type: 'control', value: '', control: { ...base, type: 'text' } }
}
/** 表格循环：表头跨页重复，循环行按数据一条一行（正文宽 554） */
function loopTable(f: FieldDef): El {
  const cols = f.loop!.columns
  const labels = cols.map((c, i) => f.loop!.labels?.[i] ?? c)
  const width = Math.floor(554 / cols.length)
  const cell = (value: unknown[]) => ({ colspan: 1, rowspan: 1, value })
  return {
    type: 'table',
    value: '',
    colgroup: cols.map(() => ({ width })),
    trList: [
      { height: 40, pagingRepeat: true, tdList: labels.map((l) => cell([{ value: l, bold: true }])) },
      { height: 40, extension: { loop: f.key }, tdList: cols.map((c, i) => cell([{ type: 'control', value: '', control: { value: null, placeholder: labels[i], conceptId: c, prefix: '', postfix: '', type: 'text' } }])) },
    ],
  }
}
/** 图片字段：没有值时是浅灰底写字段名的占位图（在浏览器里画） */
function imageField(f: FieldDef): El {
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 300
  const g = c.getContext('2d')!
  g.fillStyle = '#f2f2f7'
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#8e8e93'
  g.font = '28px "Microsoft YaHei", sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(f.label, c.width / 2, c.height / 2)
  return { type: 'image', value: c.toDataURL('image/png'), width: 320, height: 150, extension: { field: f.key } }
}

/**
 * 按顺序拼正文：字符串是一段（自动换段），{f} 是字段，{h} 是条款标题，{area} 是可编辑区。
 * 表格和区域在编辑器里自己另起一行，前面不再加换行（加了会多一个空行）；图片是行内的，前面要换行
 */
function build(fields: FieldDef[], parts: Part[], header: string): DocData {
  const field = (key: string) => fields.find((f) => f.key === key)!
  const main: El[] = []
  let first = true
  const para = (value: string, extra: El = {}) => {
    main.push({ value: first ? value : `\n${value}`, ...extra })
    first = false
  }
  for (const p of parts) {
    if (typeof p === 'string') {
      // 「…[key]…」：字符串里方括号中的是字段
      const pieces = p.split(/\[(\w+)\]/)
      pieces.forEach((s, i) => {
        if (i % 2) main.push(control(field(s)))
        else if (i === 0) para(s)
        else if (s) main.push({ value: s })
      })
    } else if ('title' in p) para(p.title, { size: 26, bold: true, rowFlex: 'center' })
    else if ('h' in p) para(p.h, { bold: true })
    else if ('f' in p) main.push(control(field(p.f)))
    else if ('area' in p) main.push({ type: 'area', value: '', area: { extension: { anchor: p.area, editable: true } }, valueList: [{ value: p.text }] })
    // 条件条款：区域上写条件，没满足时隐藏（编辑器打开时按值算）
    else if ('when' in p) main.push({ type: 'area', value: '', area: { extension: { when: p.when }, hide: true }, valueList: [{ value: p.text }] })
    else if ('loop' in p) main.push(loopTable(field(p.loop)))
    else if ('image' in p) {
      para('')
      main.push(imageField(field(p.image)))
    } else if ('sign' in p) {
      // 一行：「代表签名：」签名区「签署日期：」签署日期（签名区用 @oe/web 的 fieldElement，和编辑器插入的一样）
      para(p.label)
      main.push(fieldElement(field(p.sign), 554) as unknown as El)
      main.push({ value: '　签署日期：' })
      main.push(control(field(p.date)))
    }
  }
  return { header: [{ value: header, size: 12, color: '#8e8e93', rowFlex: 'right' }], main, footer: [] } as unknown as DocData
}

const labelled = (fields: FieldDef[], labels: Record<string, string>) => fields.map((f) => ({ ...f, label: labels[f.key] ?? f.label }))

// ---------- 销售合同 ----------
const SALES_FIELDS = labelled(
  [
    { key: 'contractNo', label: '合同编号', type: 'text' },
    customer('buyer', { buyer: 'name', buyerAddress: 'address', buyerCredit: 'creditCode' }),
    { key: 'buyerAddress', label: '买方地址', type: 'text' },
    { key: 'buyerCredit', label: '买方统一社会信用代码', type: 'text' },
    // 公式（t11）：每行金额 = 数量 × 单价，总价 = 金额合计，大写跟着总价
    { key: 'products', label: '产品明细', type: 'loop', loop: { columns: ['name', 'spec', 'qty', 'price', 'amount'], labels: ['产品名称', '规格型号', '数量', '单价（元）', '金额（元）'], formulas: { amount: 'qty * price' } } },
    { key: 'total', label: '合同总价', type: 'computed', computed: { fn: 'formula', expr: 'sum(products.amount)' } },
    { key: 'totalCN', label: '总价大写', type: 'computed', computed: { from: 'total', fn: 'amountCN' } },
    { key: 'deliveryDate', label: '交货日期', type: 'date', format: 'yyyy年MM月dd日' },
    { key: 'deliveryPlace', label: '交货地点', type: 'text' },
    { key: 'payMethod', label: '付款方式', type: 'select', options: PAY_OPTIONS, dataSource: { id: 'payment-method', kind: 'dict' } },
    { key: 'warranty', label: '质保期', type: 'select', options: opts({ 十二个月: 'm12', 二十四个月: 'm24', 三十六个月: 'm36' }) },
    { key: 'signDate', label: '签订日期', type: 'date', format: 'yyyy年MM月dd日' },
  ],
  { buyer: '买方' },
)
const salesDoc = () =>
  build(SALES_FIELDS, [
    { title: '销售合同' },
    '合同编号：[contractNo]',
    '卖方：华东智能装备有限公司',
    '买方：[buyer]',
    '地址：[buyerAddress]',
    '统一社会信用代码：[buyerCredit]',
    '买卖双方根据《中华人民共和国民法典》，经友好协商，就买方向卖方购买下列产品达成如下协议，以资共同遵守。',
    { h: '第一条　产品明细' },
    { loop: 'products' },
    { h: '第二条　合同价款' },
    '合同总价为人民币 [total] 元（大写：[totalCN]），含增值税及运输费用。',
    { h: '第三条　交货' },
    '卖方应于 [deliveryDate] 前将产品交付至 [deliveryPlace]，交货时提供装箱单和产品合格证。',
    { h: '第四条　付款' },
    '付款方式：[payMethod]。买方在收到货物并验收合格后十个工作日内付清货款。',
    // 条件条款（t11）：付款方式选分期付款才出这段
    { when: { field: 'payMethod', in: ['stage'] }, text: '分期付款的，买方于本合同签订后七日内支付合同总价的 30% 作为预付款，验收合格后支付 60%，质保期满后支付剩余 10%。' },
    { h: '第五条　质量保证' },
    '产品质保期为 [warranty]，自验收合格之日起计算。质保期内非人为损坏的，卖方免费维修或更换。',
    { h: '第六条　违约责任' },
    '任何一方违约，应赔偿对方因此遭受的直接损失。卖方逾期交货的，每逾期一日按合同总价的千分之一支付违约金。',
    { h: '第七条　争议解决' },
    '因本合同发生的争议，双方协商解决；协商不成的，提交卖方所在地人民法院诉讼解决。',
    { h: '第八条　补充条款' },
    { area: 'supplement', text: '无。' },
    '（以下无正文）',
    '',
    '卖方（盖章）：华东智能装备有限公司',
    '',
    '买方（盖章）：[buyer]',
    '',
    '签订日期：[signDate]',
  ], '销售合同')

// ---------- 技术服务合同 ----------
const SERVICE_FIELDS = labelled(
  [
    { key: 'contractNo', label: '合同编号', type: 'text' },
    customer('client', { client: 'name', clientAddress: 'address' }),
    { key: 'clientAddress', label: '委托方地址', type: 'text' },
    { key: 'project', label: '项目名称', type: 'text' },
    { key: 'startDate', label: '服务开始日期', type: 'date', format: 'yyyy年MM月dd日' },
    { key: 'endDate', label: '服务结束日期', type: 'date', format: 'yyyy年MM月dd日' },
    { key: 'fee', label: '服务费', type: 'amount' },
    { key: 'feeCN', label: '服务费大写', type: 'computed', computed: { from: 'fee', fn: 'amountCN' } },
    { key: 'milestones', label: '付款节点', type: 'loop', loop: { columns: ['stage', 'ratio', 'money'], labels: ['付款节点', '比例', '金额（元）'] } },
    { key: 'acceptance', label: '验收方式', type: 'radio', options: opts({ 书面验收: 'written', 系统上线运行满一个月视为验收: 'online' }) },
    { key: 'signDate', label: '签订日期', type: 'date', format: 'yyyy年MM月dd日' },
  ],
  { client: '委托方' },
)
const serviceDoc = () =>
  build(SERVICE_FIELDS, [
    { title: '技术服务合同' },
    '合同编号：[contractNo]',
    '委托方（甲方）：[client]',
    '地址：[clientAddress]',
    '受托方（乙方）：华东智能装备有限公司',
    '甲方委托乙方就 [project] 提供技术服务，双方经协商一致，订立本合同。',
    { h: '第一条　服务内容' },
    { area: 'scope', text: '系统部署、数据迁移、操作培训及上线后三个月的运行维护支持，具体以双方确认的需求说明书为准。' },
    { h: '第二条　服务期限' },
    '自 [startDate] 起至 [endDate] 止。',
    { h: '第三条　服务费用及支付' },
    '服务费总额为人民币 [fee] 元（大写：[feeCN]），按下列节点支付：',
    { loop: 'milestones' },
    { h: '第四条　验收' },
    '验收方式：[acceptance]。乙方完成服务后书面通知甲方，甲方应在五个工作日内完成验收或提出书面整改意见。',
    { h: '第五条　知识产权与保密' },
    '乙方为本项目开发的成果，其知识产权归甲方所有。双方对履行本合同知悉的对方商业秘密负有保密义务，保密义务不因合同终止而终止。',
    { h: '第六条　违约责任' },
    '甲方逾期付款的，每逾期一日按应付金额的万分之五支付违约金；乙方逾期完成服务的，每逾期一日按服务费总额的万分之五支付违约金。',
    { h: '第七条　其他' },
    '本合同一式贰份，双方各执壹份，自双方盖章之日起生效。',
    '（以下无正文）',
    '',
    '甲方（盖章）：[client]',
    '',
    '乙方（盖章）：华东智能装备有限公司',
    '',
    '签订日期：[signDate]',
  ], '技术服务合同')

// ---------- 房屋租赁合同 ----------
const LEASE_FIELDS = labelled(
  [
    { key: 'lessor', label: '出租方', type: 'text' },
    customer('lessee', { lessee: 'name' }),
    { key: 'address', label: '房屋地址', type: 'text' },
    { key: 'floorArea', label: '建筑面积', type: 'number' },
    { key: 'usage', label: '房屋用途', type: 'select', options: opts({ 办公: 'office', 仓储: 'storage', 商业: 'retail' }) },
    { key: 'facilities', label: '配套设施', type: 'checkbox', options: opts({ 空调: 'ac', 网络: 'network', 停车位: 'parking', 办公家具: 'furniture' }) },
    { key: 'photo', label: '房屋照片', type: 'image' },
    { key: 'startDate', label: '租赁起始日', type: 'date', format: 'yyyy年MM月dd日' },
    { key: 'endDate', label: '租赁截止日', type: 'date', format: 'yyyy年MM月dd日' },
    { key: 'rent', label: '月租金', type: 'amount' },
    { key: 'rentCN', label: '月租金大写', type: 'computed', computed: { from: 'rent', fn: 'amountCN' } },
    { key: 'payCycle', label: '付款周期', type: 'radio', options: opts({ 月付: 'monthly', 季付: 'quarterly', 年付: 'yearly' }) },
    { key: 'deposit', label: '押金', type: 'amount' },
    { key: 'signDate', label: '签订日期', type: 'date', format: 'yyyy年MM月dd日' },
  ],
  { lessee: '承租方' },
)
const leaseDoc = () =>
  build(LEASE_FIELDS, [
    { title: '房屋租赁合同' },
    '出租方（甲方）：[lessor]',
    '承租方（乙方）：[lessee]',
    '根据《中华人民共和国民法典》及有关规定，甲乙双方就房屋租赁事宜达成如下协议。',
    { h: '第一条　房屋基本情况' },
    '房屋坐落于 [address]，建筑面积 [floorArea] 平方米，用途为 [usage]。',
    '配套设施：[facilities]',
    '房屋现状照片：',
    { image: 'photo' },
    { h: '第二条　租赁期限' },
    '租赁期自 [startDate] 起至 [endDate] 止。',
    { h: '第三条　租金及押金' },
    '月租金为人民币 [rent] 元（大写：[rentCN]），付款周期为：[payCycle]，乙方应在每期开始前五日内支付。押金为人民币 [deposit] 元，租赁期满乙方结清费用并交还房屋后，甲方无息退还。',
    { h: '第四条　双方义务' },
    '甲方保证房屋权属清楚，负责房屋主体结构的维修。乙方应合理使用房屋，未经甲方书面同意不得转租或改变房屋用途。',
    { h: '第五条　合同解除' },
    '乙方拖欠租金超过三十日的，甲方有权解除合同，押金不予退还。',
    { h: '第六条　补充条款' },
    { area: 'supplement', text: '无。' },
    '（以下无正文）',
    '',
    '甲方（签章）：[lessor]',
    '',
    '乙方（签章）：[lessee]',
    '',
    '签订日期：[signDate]',
  ], '房屋租赁合同')

// ---------- 保密协议 ----------
const NDA_FIELDS = labelled(
  [
    customer('partyA', { partyA: 'name', partyAAddress: 'address' }),
    { key: 'partyAAddress', label: '甲方地址', type: 'text' },
    { key: 'partyB', label: '乙方', type: 'text' },
    // 校验规则（t11）：格式不对的填写时标出、提交不了，服务端也拒
    { key: 'partyBCredit', label: '乙方统一社会信用代码', type: 'text', rules: { pattern: 'creditCode' } },
    { key: 'contactPhone', label: '乙方联系电话', type: 'text', rules: { pattern: 'mobile' } },
    { key: 'term', label: '保密期限', type: 'select', options: opts({ 二年: 'y2', 三年: 'y3', 五年: 'y5' }) },
    { key: 'penalty', label: '违约金', type: 'amount', rules: { min: 0, max: 10000000 } },
    { key: 'penaltyCN', label: '违约金大写', type: 'computed', computed: { from: 'penalty', fn: 'amountCN' } },
    { key: 'signDate', label: '签订日期', type: 'date', format: 'yyyy年MM月dd日' },
    // 签名区、签署日期：签署时写（t12），填写时只读
    { key: 'signA', label: '甲方代表签名', type: 'signature', signer: 'a' },
    { key: 'signDateA', label: '甲方签署日期', type: 'signDate', signer: 'a', format: 'yyyy年MM月dd日' },
    { key: 'signB', label: '乙方代表签名', type: 'signature', signer: 'b' },
    { key: 'signDateB', label: '乙方签署日期', type: 'signDate', signer: 'b', format: 'yyyy年MM月dd日' },
  ],
  { partyA: '甲方' },
)
const ndaDoc = () =>
  build(NDA_FIELDS, [
    { title: '保密协议' },
    '甲方：[partyA]',
    '地址：[partyAAddress]',
    '乙方：[partyB]',
    '统一社会信用代码：[partyBCredit]',
    '联系电话：[contactPhone]',
    '鉴于双方正在进行业务合作，为保护双方的商业秘密，经协商一致，订立本协议。',
    { h: '第一条　保密信息' },
    { area: 'scope', text: '本协议所称保密信息，是指一方向另一方披露的、未公开的技术信息和经营信息，包括但不限于设计图纸、报价、客户名单和合同条款。' },
    { h: '第二条　保密义务' },
    '接收方应仅为合作目的使用保密信息，不得向第三方披露，并采取不低于保护自身保密信息的措施。',
    { h: '第三条　保密期限' },
    '保密期限为 [term]，自本协议签订之日起计算；双方合作结束后，保密义务继续有效至期限届满。',
    { h: '第四条　违约责任' },
    '违反本协议的一方应向对方支付违约金人民币 [penalty] 元（大写：[penaltyCN]）；违约金不足以弥补损失的，还应赔偿实际损失。',
    { h: '第五条　其他' },
    '本协议一式贰份，双方各执壹份，自双方签字盖章之日起生效。',
    '（以下无正文）',
    '',
    '甲方（盖章）：[partyA]',
    { sign: 'signA', date: 'signDateA', label: '代表签名：' },
    '',
    '乙方（盖章）：[partyB]',
    { sign: 'signB', date: 'signDateB', label: '代表签名：' },
    '',
    '签订日期：[signDate]',
  ], '保密协议')

/** 第一份是原来的采购合同（端到端测试按它写的）；地址上 ?sample=<id> 选范本 */
export const SAMPLES: Sample[] = [
  {
    id: 'purchase',
    title: '采购合同',
    fields: FIELDS,
    doc: sampleDoc,
    preview: [
      { id: 'order-1', label: '采购单 001', values: { partyA: '上海示例客户', partyAAddress: '上海市浦东新区', partyACredit: '913100000000000001', amount: '5200', payMethod: 'once', signDate: '2026-03-18', items: [{ name: '显示器', model: '27英寸', qty: '2', price: '2600' }] } },
      { id: 'order-2', label: '采购单 002', values: { partyA: '杭州示例客户', partyAAddress: '杭州市西湖区', partyACredit: '913300000000000002', amount: '800', payMethod: 'stage', signDate: '2026-04-01', items: [{ name: '键盘', model: '标准版', qty: '4', price: '200' }] } },
    ],
  },
  {
    id: 'sales',
    title: '销售合同',
    fields: SALES_FIELDS,
    doc: salesDoc,
    preview: [
      { id: 'so-001', label: '销售订单 SO-001', values: { contractNo: 'XS-2026-001', buyer: '南京长江智能制造有限公司', buyerAddress: '江苏省南京市江宁区天元东路 22 号', buyerCredit: '91320115MA1P2Q3R4S', products: [{ name: '立式加工中心', spec: 'VMC-850', qty: '2', price: '326000' }, { name: '刀库', spec: '24 刀位', qty: '2', price: '18000' }], deliveryDate: '2026年12月20日', deliveryPlace: '买方南京江宁工厂', payMethod: 'stage', warranty: 'm24', signDate: '2026年11月05日' } },
    ],
  },
  {
    id: 'service',
    title: '技术服务合同',
    fields: SERVICE_FIELDS,
    doc: serviceDoc,
    preview: [
      { id: 'pj-001', label: '项目 PJ-001', values: { contractNo: 'FW-2026-018', client: '杭州数控科技有限公司', clientAddress: '浙江省杭州市滨江区江南大道 3888 号', project: '设备联网与生产数据平台', startDate: '2026年11月10日', endDate: '2027年02月28日', fee: '360000', milestones: [{ stage: '合同签订后', ratio: '30%', money: '108000' }, { stage: '系统上线', ratio: '50%', money: '180000' }, { stage: '验收合格', ratio: '20%', money: '72000' }], acceptance: 'written', signDate: '2026年11月05日' } },
    ],
  },
  {
    id: 'lease',
    title: '房屋租赁合同',
    fields: LEASE_FIELDS,
    doc: leaseDoc,
    preview: [
      { id: 'zl-001', label: '租赁申请 ZL-001', values: { lessor: '苏州高新科技园管理有限公司', lessee: '无锡太湖精密部件有限公司', address: '江苏省苏州市高新区科灵路 78 号 3 号楼 501 室', floorArea: '320', usage: 'office', facilities: ['ac', 'network', 'parking'], startDate: '2027年01月01日', endDate: '2029年12月31日', rent: '28800', payCycle: 'quarterly', deposit: '57600', signDate: '2026年11月05日' } },
    ],
  },
  {
    id: 'nda',
    title: '保密协议',
    fields: NDA_FIELDS,
    doc: ndaDoc,
    preview: [
      { id: 'hz-001', label: '合作项目 HZ-001', values: { partyA: '上海浦江重型装备股份有限公司', partyAAddress: '上海市闵行区江川路 1800 号', partyB: '华东智能装备有限公司', term: 'y3', penalty: '500000', signDate: '2026年11月05日' } },
    ],
  },
]
