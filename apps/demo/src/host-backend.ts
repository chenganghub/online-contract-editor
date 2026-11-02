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
  const t = await api('POST', '/api/tokens', { documentId: req.documentId, mode, userId: DEMO_USER, permissions: req.permissions ?? {}, actions: req.actions })
  return t.status === 200 ? { status: 200, json: { token: (t.json as { token: string }).token } } : t
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
