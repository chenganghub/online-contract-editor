// 演示宿主的后端（开发时是 vite 中间件，见 vite.config.ts；端到端测试里由测试调用）：
// 浏览器带宿主登录态（请求头）来要文档令牌，后端用 API Key 向编辑器服务端签发。API Key 只在后端，浏览器拿不到。
// 真实宿主由后端按流程节点和当前用户决定模式和元素权限；演示页用地址参数模拟（main.ts）
import type { DocActions, FieldDef, Mode, Permission } from '@oe/web'
import { HOST_TOKEN } from './customers'
import { PAY_OPTIONS } from './sample'

/** 宿主后端调编辑器服务端（带 API Key） */
export type ServerApi = (method: string, url: string, body?: unknown) => Promise<{ status: number; json: unknown }>

export interface TokenRequest {
  documentId: string
  mode: Mode
  permissions?: Record<string, Permission>
  actions?: DocActions
  /** 演示用：地址上 ?user= 模拟的用户（真实宿主按自己的登录态定是谁） */
  user?: { id: string; name: string }
  /** 签署令牌绑定的签署方（t12，盖章模式）：服务端核对令牌的用户就是这个签署方绑定的人 */
  signer?: string
}

export const DEMO_USER = 'demo-user'
/** 订单查询及字段映射属于宿主；编辑器收到的仍是约定的 key/values。 */
export async function createFromOrder(api: ServerApi, authorization: string | undefined, req: { templateId: string; versionNo: number; orderId: string }): Promise<{ status: number; json: unknown }> {
  if (authorization !== HOST_TOKEN) return { status: 401, json: { code: 'UNAUTHORIZED', message: '没有登录' } }
  if (typeof req?.templateId !== 'string' || !Number.isInteger(req.versionNo) || req.versionNo < 1 || req.orderId !== 'order-1') return { status: 400, json: { code: 'BAD_REQUEST', message: '要给模板版本和有效订单' } }
  const version = await api('GET', `/api/templates/${encodeURIComponent(req.templateId)}/versions/${req.versionNo}`)
  if (version.status !== 200) return version
  const { fields } = version.json as { fields: FieldDef[] }
  const orderValues = { contractNo: 'CG-2026-001', amount: '5200', items: [{ name: '显示器', model: '27英寸', qty: '2', price: '2600' }] }
  const values = Object.fromEntries(Object.entries(orderValues).filter(([key]) => fields.some((f) => f.key === key)))
  const dictionaries = fields.some((f) => f.dataSource?.id === 'payment-method' && f.dataSource.kind === 'dict') ? { 'payment-method': PAY_OPTIONS } : {}
  const created = await api('POST', '/api/documents', { templateId: req.templateId, versionNo: req.versionNo, bizKey: req.orderId, values, dictionaries })
  return created.status === 200 ? { status: 200, json: { ...(created.json as object), permissions: Object.fromEntries(Object.keys(values).map((key) => [key, 'readonly'])) } } : created
}
/** 各模式要求的文档状态：编辑、填写要在填写中，盖章要在盖章中 */
const NEEDS: Record<Exclude<Mode, 'view'>, string> = { edit: 'filling', fill: 'filling', seal: 'sealing' }

/**
 * POST /host/token：校验宿主登录态，签发文档令牌，返回 { token }。
 * 按文档状态定模式：要盖章而文档还在填写中，先开始盖章（真实宿主在流程走到盖章节点时调）；
 * 文档已经锁定（盖章中、已盖章、已作废）时要编辑或填写，只发只读令牌
 */
export async function issueToken(api: ServerApi, authorization: string | undefined, req: TokenRequest): Promise<{ status: number; json: unknown }> {
  if (authorization !== HOST_TOKEN) return { status: 401, json: { code: 'UNAUTHORIZED', message: '没有登录' } }
  if (typeof req?.documentId !== 'string' || typeof req.mode !== 'string') return { status: 400, json: { code: 'BAD_REQUEST', message: '要给 documentId 和 mode' } }
  const path = `/api/documents/${encodeURIComponent(req.documentId)}`
  const d = await api('GET', path)
  if (d.status !== 200) return d
  const { status, version } = d.json as { status: string; version: number }
  let mode = req.mode
  if (mode === 'seal' && status === 'filling') {
    const s = await api('POST', `${path}/seal-status`, { action: 'start', version })
    if (s.status !== 200) return s
  } else if (mode !== 'view' && status !== NEEDS[mode]) mode = 'view'
  // 演示用户：名字 1～20 个字，不合规的按默认用户
  const user = typeof req.user?.name === 'string' && /^[\p{L}\p{N} _-]{1,20}$/u.test(req.user.name) ? { userId: `demo-${req.user.name}`, userName: req.user.name } : { userId: DEMO_USER }
  const signer = mode === 'seal' && typeof req.signer === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(req.signer) ? { signer: req.signer } : {}
  const t = await api('POST', '/api/tokens', { documentId: req.documentId, mode, ...user, permissions: req.permissions ?? {}, actions: req.actions, ...signer })
  return t.status === 200 ? { status: 200, json: { token: (t.json as { token: string }).token } } : t
}

// ---------- 签署（t12）----------
/** 演示的短信验证码：真实宿主发真的短信、做人脸，核对通过后再登记凭据 */
export const DEMO_SMS_CODE = '123456'
const unauthorized = { status: 401, json: { code: 'UNAUTHORIZED', message: '没有登录' } }
/** POST /host/intent：核对验证码，通过后用 API Key 向服务端登记意愿认证凭据（POST …/intents），返回凭据 id */
export async function registerIntent(api: ServerApi, authorization: string | undefined, req: { documentId: string; signer: string; code: string }): Promise<{ status: number; json: unknown }> {
  if (authorization !== HOST_TOKEN) return unauthorized
  if (typeof req?.documentId !== 'string' || typeof req.signer !== 'string') return { status: 400, json: { code: 'BAD_REQUEST', message: '要给 documentId 和 signer' } }
  if (req.code !== DEMO_SMS_CODE) return { status: 403, json: { code: 'BAD_CODE', message: '验证码不对' } }
  const r = await api('POST', `/api/documents/${encodeURIComponent(req.documentId)}/intents`, { signer: req.signer, method: 'sms', proof: `demo-sms-${crypto.randomUUID()}` })
  return r.status === 200 ? { status: 200, json: { intentId: (r.json as { id: string }).id } } : r
}
/** POST /host/verify：把 PDF（base64）转给服务端验签 */
export async function verifyFile(api: ServerApi, authorization: string | undefined, req: { pdf: string }): Promise<{ status: number; json: unknown }> {
  if (authorization !== HOST_TOKEN) return unauthorized
  if (typeof req?.pdf !== 'string') return { status: 400, json: { code: 'BAD_REQUEST', message: '要给 pdf' } }
  return api('POST', '/api/verify', { pdf: req.pdf })
}
/**
 * POST /host/sign-demo：建一份两方按顺序签的演示合同（保密协议；文档由页面按范本拼好交过来，签名区的占位图要在浏览器里画），
 * 设签署方（甲方张三、乙方李四，都是企业，都要意愿认证），开始签署，返回文档 id
 */
export async function createSignDemo(api: ServerApi, authorization: string | undefined, req: { doc: unknown; fields: unknown; values?: Record<string, unknown>; title?: string }): Promise<{ status: number; json: unknown }> {
  if (authorization !== HOST_TOKEN) return unauthorized
  const t = await api('POST', '/api/templates', { name: req?.title ?? '保密协议', doc: req?.doc, fields: req?.fields })
  if (t.status !== 200) return t
  const d = await api('POST', '/api/documents', { templateId: (t.json as { id: string }).id, versionNo: 1, values: req.values ?? {} })
  if (d.status !== 200) return d
  const id = (d.json as { id: string }).id
  const values = req.values ?? {}
  const s = await api('PUT', `/api/documents/${id}/signers`, {
    signers: [
      { key: 'a', name: String(values.partyA ?? '甲方'), kind: 'org', userId: 'demo-张三', order: 1 },
      { key: 'b', name: String(values.partyB ?? '乙方'), kind: 'org', userId: 'demo-李四', order: 2 },
    ],
  })
  if (s.status !== 200) return s
  const start = await api('POST', `/api/documents/${id}/seal-status`, { action: 'start', version: 1 })
  return start.status === 200 ? { status: 200, json: { id } } : start
}

/** 演示用模板设计入口；真实宿主在这里检查财务的模板设计权限。 */
export async function openTemplate(api: ServerApi, authorization: string | undefined, req: { templateId: string }): Promise<{ status: number; json: unknown }> {
  if (authorization !== HOST_TOKEN) return { status: 401, json: { code: 'UNAUTHORIZED', message: '没有登录' } }
  if (typeof req?.templateId !== 'string') return { status: 400, json: { code: 'BAD_REQUEST', message: '要给 templateId' } }
  let id = req.templateId
  if (id === 'new') {
    const created = await api('POST', '/api/templates/drafts', {
      name: '采购合同模板', createdBy: DEMO_USER, fields: [],
      doc: { main: [{ value: '采购合同', size: 24, bold: true }, { value: '\n甲方：' }, { value: '\n乙方：' }, { value: '\n合同金额：' }] },
    })
    if (created.status !== 200) return created
    id = (created.json as { id: string }).id
  }
  const token = await api('POST', `/api/templates/${encodeURIComponent(id)}/edit-tokens`, { userId: DEMO_USER })
  return token.status === 200 ? { status: 200, json: { templateId: id, token: (token.json as { token: string }).token } } : token
}
