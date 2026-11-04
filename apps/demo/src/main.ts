// 演示宿主页：模拟业务系统接入编辑器。
// 地址带 ?doc=<文档 id> 时接真实服务端（server-host.ts；本机用 scripts/stack.ts 起整套环境），否则文档存在 localStorage
import { createEditor, type DocActions, type DocData, type DocValues, type FieldDef, type Mode, type Permission, type RequestFn, type SealOp } from '@oe/web'
import { CUSTOMERS, HOST_TOKEN, queryCustomers } from './customers'
import { DATA_SOURCES, demoSeals } from './sample'
import { SAMPLES } from './samples'
import { showPagesNotice } from './pages'
import { connectServer, connectTemplate, type HostFunctions } from './server-host'
const pages = import.meta.env.MODE === 'pages'
interface Stored {
  doc: DocData
  values: DocValues
  fields: FieldDef[]
}
// 模拟后端按令牌给的模式和元素权限：?mode=fill&perm=contractNo:readonly,partyAAddress:hidden。给了模式就只能用这一个模式
const MODES: Mode[] = ['edit', 'fill', 'seal', 'view']
const PERMS: Permission[] = ['editable', 'readonly', 'required', 'hidden']
const params = new URLSearchParams(location.search)
// 合同范本：?sample=sales|service|lease|nda，不给是采购合同。采购合同沿用原来的存储键（端到端测试按它读写），其他范本各存各的
const sample = SAMPLES.find((s) => s.id === params.get('sample')) ?? SAMPLES[0]!
const KEY = sample.id === 'purchase' ? 'oe-demo-document' : `oe-demo-document:${sample.id}`
const asked = params.get('mode') as Mode | null
const mode = asked && MODES.includes(asked) ? asked : null
const permissions = Object.fromEntries(
  (params.get('perm') ?? '')
    .split(',')
    .map((s) => s.split(':') as [string, Permission])
    .filter(([key, p]) => key && PERMS.includes(p)),
)
// 能不能打印、下载：?actions=print 只能打印，?actions= 都不能；不给都能
const allowed = params.get('actions')?.split(',')
const actions: DocActions = allowed ? { print: allowed.includes('print'), download: allowed.includes('download') } : {}
// 宿主的请求函数：带上宿主自己的登录态（真实宿主里是它的 token / cookie），编辑器的远程数据源都经过这里
const request: RequestFn = async ({ url, method, query, body }) => {
  const u = new URL(url, location.origin)
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v))
  if (pages) {
    if (u.pathname === '/api/customers') return queryCustomers(CUSTOMERS, u.searchParams)
    throw new Error('在线演示不连接后端，请在本地运行完整服务。')
  }
  const res = await fetch(u, {
    method,
    headers: { Authorization: HOST_TOKEN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`请求 ${u.pathname} 失败：${res.status}`)
  return res.json()
}
// 导入 Word：交给渲染服务转换（开发时 vite 把 /convert 代理到本机渲染服务 3200；真实宿主经自己的后端转给服务端）
const importDocx = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const res = await fetch('/convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docx: btoa(bin) }) })
  if (!res.ok) throw new Error(`导入失败：${res.status}`)
  return res.json()
}

// 本地版：文档存在 localStorage；盖章操作只记下来（端到端测试看）
const sealOps: SealOp[] = []
const local: HostFunctions = {
  mode: mode ?? 'edit',
  modes: mode ? [mode] : MODES,
  load: async () => {
    const saved = localStorage.getItem(KEY)
    const s: Stored | null = saved ? JSON.parse(saved) : null
    return { title: sample.title, doc: s?.doc ?? sample.doc(), values: s?.values, fields: s?.fields ?? sample.fields, libraryFields: pages ? sample.fields : undefined, permissions, actions }
  },
  save: async ({ doc, values, fields }) => {
    localStorage.setItem(KEY, JSON.stringify({ doc, values, fields } satisfies Stored))
  },
  onSeal: async (op) => {
    sealOps.push(op)
  },
  download: pages ? undefined : () => {},
}

const el = document.querySelector<HTMLElement>('#app')!
if (pages) showPagesNotice(KEY, SAMPLES, sample.id)
let docId = params.get('doc')
let openingMode = mode ?? 'edit'
const templateId = params.get('template')
try {
  if (pages && (templateId || docId || params.has('fromTemplate'))) throw new Error('此演示仅使用浏览器本地文档，请移除地址中的服务端文档或模板参数后重试。')
  if (params.has('fromTemplate')) {
    const created = await request({ url: '/host/contract', method: 'POST', body: { templateId: params.get('fromTemplate'), versionNo: Number(params.get('version') ?? 1), orderId: 'order-1' } }) as { id: string; permissions: Record<string, Permission> }
    docId = created.id
    Object.assign(permissions, created.permissions)
    openingMode = 'fill'
    params.set('perm', Object.entries(permissions).map(([key, value]) => `${key}:${value}`).join(','))
    params.delete('fromTemplate'); params.delete('version'); params.set('doc', docId); params.set('mode', 'fill')
    history.replaceState(null, '', `?${params}`)
  }
  const host = templateId ? await connectTemplate(templateId) : docId ? await connectServer(docId, openingMode, permissions, actions) : local
  const handle = await createEditor(el, { ...host, seals: demoSeals(), request, dataSources: DATA_SOURCES, importDocx: pages ? undefined : importDocx, previewSamples: sample.preview })
  // 给端到端测试用
  ;(window as unknown as { __oe: unknown }).__oe = handle
} catch (e) {
  // 打不开（服务端没起、令牌签不出来）时页面上只显示原因；再抛出去，控制台和端到端测试能看到
  el.textContent = e instanceof Error ? e.message : String(e)
  throw e
}
;(window as unknown as { __sealOps: SealOp[] }).__sealOps = sealOps
