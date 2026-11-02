// 模拟的客户接口：GET /api/customers?q=关键字&page=1&size=5 → { data: { list, total } }。
// 开发时由 vite 中间件提供（vite.config.ts），端到端测试里由 Playwright 拦截请求提供；都要求带宿主的登录态。
export interface Customer {
  id: string
  name: string
  address: string
  creditCode: string
}

export const HOST_TOKEN = 'Bearer demo-host-token'

export const CUSTOMERS: Customer[] = [
  ['苏州工业园区精工机械有限公司', '江苏省苏州市工业园区星湖街 328 号', '91320594MA1N3C8Y5P'],
  ['上海浦江重型装备股份有限公司', '上海市闵行区江川路 1800 号', '91310112MA1K4B2X7Q'],
  ['杭州数控科技有限公司', '浙江省杭州市滨江区江南大道 3888 号', '91330108MA2B1C3D4E'],
  ['南京长江智能制造有限公司', '江苏省南京市江宁区天元东路 22 号', '91320115MA1P2Q3R4S'],
  ['无锡太湖精密部件有限公司', '江苏省无锡市新吴区长江路 7 号', '91320214MA1T2U3V4W'],
  ['宁波港城模具有限公司', '浙江省宁波市北仑区新碶街道 15 号', '91330206MA2X3Y4Z5A'],
  ['合肥科创装备有限公司', '安徽省合肥市高新区望江西路 900 号', '91340100MA2B3C4D5F'],
  ['常州恒力传动设备有限公司', '江苏省常州市武进区湖塘镇 66 号', '91320412MA1G2H3J4K'],
  ['嘉兴同创自动化有限公司', '浙江省嘉兴市南湖区亚太路 500 号', '91330402MA2L3M4N5P'],
  ['南通海达机电有限公司', '江苏省南通市崇川区工农路 111 号', '91320602MA1Q2R3S4T'],
  ['绍兴越城精工有限公司', '浙江省绍兴市越城区解放大道 208 号', '91330602MA2U3V4W5X'],
  ['扬州运河机床有限公司', '江苏省扬州市邗江区文昌西路 56 号', '91321003MA1Y2Z3A4B'],
].map(([name, address, creditCode], i) => ({ id: `c${i + 1}`, name: name!, address: address!, creditCode: creditCode! }))

/** 按查询串查：关键字匹配名称或地址，页码从 1 起 */
export function queryCustomers(list: Customer[], params: URLSearchParams) {
  const q = params.get('q') ?? ''
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1)
  const size = Math.min(50, Math.max(1, Number(params.get('size') ?? 5) || 5))
  const hit = q ? list.filter((c) => c.name.includes(q) || c.address.includes(q)) : list
  return { data: { list: hit.slice((page - 1) * size, page * size), total: hit.length } }
}
