import crypto from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { and, eq, max } from 'drizzle-orm'
import { z } from 'zod'
import {
  AREA_MAX_LENGTH,
  AREA_MAX_RUNS,
  applyAreas,
  applyBatch,
  applyFill,
  stripHidden,
  type AreaRun,
  type DocData,
  type DocStatus,
  type DocValues,
  type FieldDef,
  type FieldValue,
  type Op,
  type Permission,
} from '@oe/core'
import type { Config } from './config'
import type { Db } from './db/client'
import { HttpError } from './errors'
import type { RendererClient } from './renderer'
import { apiClient, docToken, document, fieldLibrary, operationLog, sealRecord, template, templateVersion, tokenPermission } from './db/schema'
import type { FileStore } from './storage'
import { hashKey, signToken, verifyToken, type TokenPayload } from './tokens'
import { registerTemplateDrafts } from './template-drafts'
import { withDictionaries } from './dictionaries'

export { HttpError }

export interface AppDeps {
  config: Config
  db: Db
  store: FileStore
  /** 渲染服务（出 PDF / docx、docx 转文档）；不给时这些接口返回 503 */
  renderer?: RendererClient
  /** 测试用插桩：鉴权之后、进事务之前调用（用来模拟「保存在途时权限被改」） */
  hooks?: { afterAuth?: (req: FastifyRequest) => Promise<void> }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** 令牌能不能打印、下载（宿主签发令牌时给，不给都能） */
type Actions = { print: boolean; download: boolean }
type Caller = { kind: 'host'; clientId: string } | { kind: 'token'; token: TokenPayload; perms: Record<string, Permission>; actions: Actions }

// ---------- 入参 ----------
const PERMISSION = z.enum(['editable', 'readonly', 'required', 'hidden'])
const MODE = z.enum(['edit', 'fill', 'seal', 'view'])
const DOC = z.object({ main: z.array(z.any()), header: z.array(z.any()).optional(), footer: z.array(z.any()).optional() }).passthrough()
const FIELD = z
  .object({
    key: z.string().min(1).max(100),
    label: z.string().min(1).max(100),
    type: z.enum(['text', 'number', 'amount', 'date', 'select', 'radio', 'checkbox', 'picker', 'computed', 'image', 'loop']),
    permission: PERMISSION.optional(),
  })
  .passthrough()
// 字段库是外部输入边界，检查所有会被填写器使用的配置。
const LIBRARY_FIELD = FIELD.extend({
  options: z.array(z.object({ code: z.string().min(1), value: z.string() })).optional(),
  dataSource: z.object({ id: z.string().min(1), kind: z.enum(['static', 'dict', 'remote', 'host']) }).optional(),
  fill: z.record(z.string().min(1), z.string().min(1)).optional(),
  format: z.string().optional(),
  computed: z.object({ from: z.string().min(1), fn: z.literal('amountCN') }).optional(),
  loop: z.object({ columns: z.array(z.string().min(1)).min(1), labels: z.array(z.string()).optional() }).optional(),
}).strict()
const LIBRARY_FIELDS = z.array(LIBRARY_FIELD).max(1000).superRefine((fields, ctx) => {
  const keys = new Set<string>()
  for (const [i, field] of fields.entries()) {
    if (keys.has(field.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: '字段 key 重复' })
    keys.add(field.key)
  }
  for (const [i, field] of fields.entries()) {
    for (const key of [...Object.keys(field.fill ?? {}), ...(field.computed ? [field.computed.from] : [])]) {
      if (!keys.has(key)) ctx.addIssue({ code: 'custom', path: [i], message: `引用的字段 ${key} 未登记` })
    }
  }
})
const TEMPLATE_FIELDS = {
  fields: z.array(FIELD).optional(),
  fieldKeys: z.array(z.string().min(1).max(100)).max(1000).optional(),
}
const exclusiveFields = (body: { fields?: unknown; fieldKeys?: unknown }) => !(body.fields && body.fieldKeys)
const FIELD_VALUE: z.ZodType<FieldValue> = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string()), z.array(z.record(z.string(), z.unknown()))])
const VALUES = z.record(z.string(), FIELD_VALUE)
const DICTIONARY = z.array(z.object({ code: z.string().min(1).max(100), value: z.string().min(1).max(200) }).strict()).min(1).max(1000).superRefine((list, ctx) => {
  if (new Set(list.map((item) => item.code)).size !== list.length) ctx.addIssue({ code: 'custom', message: '字典 code 重复' })
})
const ID = z.string().uuid()
/** 编辑器保存时按打印模式数的页数（导出时交给渲染服务核对） */
const PAGE_COUNT = z.number().int().positive().max(10000).optional()
/** 可编辑区：anchor 和内容（一段文字，或一组带样式的文字；每段的类型和样式由 core 的 applyAreas 校验） */
const AREA_ANCHOR = z.string().min(1).max(100)
const AREA_CONTENT = z.union([z.string().max(AREA_MAX_LENGTH), z.array(z.object({ value: z.string().max(AREA_MAX_LENGTH) }).passthrough()).max(AREA_MAX_RUNS)])
const AREA_STATUS = { PERMISSION_DENIED: 403, TARGET_NOT_FOUND: 404, BAD_ARGUMENT: 400 } as const

const parse = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v)
  if (!r.success) throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || '入参'}：${i.message}`).join('；'))
  return r.data
}

const newId = () => crypto.randomUUID()

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps
  // 文档里带印章图片（base64），放宽请求体上限
  const app = Fastify({ bodyLimit: 20 * 1024 * 1024, logger: false })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ code: err.code, message: err.message, ...err.detail })
    // Fastify 自己抛的 4xx（请求体不是合法 JSON、超过大小等）原样转成统一格式
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : String(err) })
    return reply.status(500).send({ code: 'INTERNAL', message: '服务器内部错误' })
  })

  const rendererOf = () => {
    if (!deps.renderer) throw new HttpError(503, 'RENDERER_UNAVAILABLE', '没有配置渲染服务')
    return deps.renderer
  }

  // ---------- 鉴权 ----------
  async function hostOf(req: FastifyRequest): Promise<Extract<Caller, { kind: 'host' }> | null> {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) return null
    const [row] = await db.select().from(apiClient).where(eq(apiClient.keyHash, hashKey(auth.slice(7)))).limit(1)
    if (!row || row.status !== 'active') throw new HttpError(401, 'UNAUTHORIZED', 'API Key 无效')
    return { kind: 'host', clientId: row.id }
  }
  const requireHost = async (req: FastifyRequest) => {
    const c = await hostOf(req)
    if (!c) throw new HttpError(401, 'UNAUTHORIZED', '缺少 API Key')
    return c
  }
  const permsOf = async (q: Db | Tx, tokenId: string) =>
    Object.fromEntries(
      (await q.select().from(tokenPermission).where(eq(tokenPermission.tokenId, tokenId))).map((p) => [p.fieldKey, p.permission]),
    ) as Record<string, Permission>

  /** 浏览器只用请求头 X-Document-Token；URL 里的令牌一律不认 */
  async function callerFor(req: FastifyRequest, documentId: string): Promise<Caller> {
    const raw = req.headers['x-document-token']
    if (typeof raw === 'string' && raw) {
      const t = verifyToken(config.TOKEN_SECRET, raw)
      if (t === 'invalid') throw new HttpError(401, 'TOKEN_INVALID', '文档令牌无效')
      if (t === 'expired') throw new HttpError(401, 'TOKEN_EXPIRED', '文档令牌已过期')
      if (t.scope) throw new HttpError(403, 'TOKEN_SCOPE', '模板令牌不能访问合同文档')
      if (t.did !== documentId) throw new HttpError(403, 'TOKEN_DOCUMENT_MISMATCH', '文档令牌不属于这个文档')
      const [row] = await db.select().from(docToken).where(eq(docToken.id, t.tid)).limit(1)
      if (!row || row.revokedAt) throw new HttpError(401, 'TOKEN_REVOKED', '文档令牌已吊销')
      return { kind: 'token', token: t, perms: await permsOf(db, t.tid), actions: { print: row.canPrint, download: row.canDownload } }
    }
    const host = await hostOf(req)
    if (!host) throw new HttpError(401, 'UNAUTHORIZED', '缺少文档令牌')
    return host
  }

  /** 事务里锁住令牌行，按服务端当前的权限重新校验；吊销或权限变了整次拒绝 */
  async function lockToken(tx: Tx, caller: Caller): Promise<Record<string, Permission> | null> {
    if (caller.kind === 'host') return null
    const [row] = await tx.select().from(docToken).where(eq(docToken.id, caller.token.tid)).for('update')
    if (!row || row.revokedAt) throw new HttpError(403, 'TOKEN_REVOKED', '文档令牌已吊销，请刷新')
    const perms = await permsOf(tx, caller.token.tid)
    if (JSON.stringify(Object.entries(perms).sort()) !== JSON.stringify(Object.entries(caller.perms).sort()))
      throw new HttpError(403, 'PERMISSION_CHANGED', '字段权限已变更，请刷新后再保存')
    return perms
  }

  async function lockDocument(tx: Tx, id: string, version: number) {
    const [row] = await tx.select().from(document).where(eq(document.id, id)).for('update')
    if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    if (row.status !== 'filling') throw new HttpError(422, 'INVALID_STATUS', `文档状态是 ${row.status}，不能修改`)
    if (row.version !== version) throw new HttpError(409, 'VERSION_CONFLICT', `文档已被别人修改（当前版本 ${row.version}），请刷新`)
    return row
  }

  /**
   * 调用方拿到的文档剔除过隐藏值没有（GET 时按令牌权限和字段默认权限剔除）。剔除过的（s13）：
   * 整份保存（PUT）会把隐藏值清掉，拒绝；填写保存时它按打印模式数的页数是缺了隐藏值的文档的，不存；
   * 它下载时出的是剔除后的文档，页数也可能和存的对不上，不核对
   */
  const seesStripped = (caller: Caller, fields: FieldDef[]) =>
    caller.kind === 'token' && fields.some((f) => (caller.perms[f.key] ?? f.permission ?? 'editable') === 'hidden')

  // ---------- 接口 ----------
  app.get('/api/health', async () => ({ ok: true }))

  // 字段库只允许宿主后端访问，不把 API Key 交给编辑器页面。
  app.get('/api/field-library', async (req) => {
    const caller = await requireHost(req)
    const [row] = await db.select().from(fieldLibrary).where(eq(fieldLibrary.clientId, caller.clientId))
    return row ? { version: row.version, fields: row.fields } : { version: 0, fields: [] }
  })

  app.put('/api/field-library', async (req) => {
    const caller = await requireHost(req)
    const body = parse(z.object({ version: z.number().int().nonnegative(), fields: LIBRARY_FIELDS }).strict(), req.body)
    return db.transaction(async (tx) => {
      // 锁宿主行，同时覆盖首次登记时还没有字段库行的并发场景。
      await tx.select().from(apiClient).where(eq(apiClient.id, caller.clientId)).for('update')
      const [row] = await tx.select().from(fieldLibrary).where(eq(fieldLibrary.clientId, caller.clientId))
      if ((row?.version ?? 0) !== body.version) throw new HttpError(409, 'VERSION_CONFLICT', '字段库已更新，请重新读取')
      const version = body.version + 1
      if (row) await tx.update(fieldLibrary).set({ version, fields: body.fields as FieldDef[] }).where(eq(fieldLibrary.clientId, caller.clientId))
      else await tx.insert(fieldLibrary).values({ clientId: caller.clientId, version, fields: body.fields as FieldDef[] })
      return { version, fields: body.fields }
    })
  })

  async function fieldsFor(clientId: string, body: { fields?: unknown[]; fieldKeys?: string[] }): Promise<FieldDef[]> {
    if (!body.fieldKeys) return (body.fields ?? []) as FieldDef[]
    if (new Set(body.fieldKeys).size !== body.fieldKeys.length) throw new HttpError(400, 'BAD_REQUEST', 'fieldKeys 不能重复')
    const [library] = await db.select().from(fieldLibrary).where(eq(fieldLibrary.clientId, clientId))
    return body.fieldKeys.map((key) => {
      const field = library?.fields.find((f) => f.key === key)
      if (!field) throw new HttpError(400, 'FIELD_NOT_FOUND', `字段库没有字段 ${key}`)
      return field
    })
  }

  const checkTemplateOwner = registerTemplateDrafts(app, { db, config, requireHost, docSchema: DOC, fieldsSchema: LIBRARY_FIELDS })

  // 建模板：传文档 JSON，或者传 docx（base64，经渲染服务转成文档，返回导入报告）
  app.post('/api/templates', async (req) => {
    const caller = await requireHost(req)
    const body = parse(
      z
        .object({
          name: z.string().min(1).max(200),
          category: z.string().max(100).optional(),
          createdBy: z.string().max(100).default('host'),
          doc: DOC.optional(),
          docx: z.string().min(1).max(40 * 1024 * 1024).optional(),
          ...TEMPLATE_FIELDS,
        })
        .refine((b) => !!b.doc !== !!b.docx, '文档 JSON（doc）和 docx 要给且只给一个')
        .refine(exclusiveFields, 'fields 和 fieldKeys 不能同时传'),
      req.body,
    )
    const fields = await fieldsFor(caller.clientId, body)
    let doc = body.doc as DocData | undefined
    let imported: { report: unknown; pageCount: number } | undefined
    if (body.docx) {
      const r = await rendererOf().convert(Buffer.from(body.docx, 'base64'))
      doc = r.doc
      imported = { report: r.report, pageCount: r.pageCount }
    }
    const id = newId()
    await db.transaction(async (tx) => {
      await tx.insert(template).values({ id, name: body.name, category: body.category ?? null, createdBy: body.createdBy })
      await tx.insert(templateVersion).values({ id: newId(), templateId: id, versionNo: 1, doc: doc!, fields })
    })
    return { id, versionNo: 1, ...imported }
  })

  // 发布新版本。版本发布后不可改：没有修改版本的接口，改模板就再发一版
  app.post<{ Params: { id: string } }>('/api/templates/:id/versions', async (req) => {
    const caller = await requireHost(req)
    const id = parse(ID, req.params.id)
    await checkTemplateOwner(id, caller.clientId)
    const body = parse(z.object({ doc: DOC, ...TEMPLATE_FIELDS })
      .refine(exclusiveFields, 'fields 和 fieldKeys 不能同时传')
      .refine((b) => b.fields !== undefined || b.fieldKeys !== undefined, 'fields 和 fieldKeys 必须传一个'), req.body)
    const fields = await fieldsFor(caller.clientId, body)
    const versionNo = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(template).where(eq(template.id, id)).for('update')
      if (!t) throw new HttpError(404, 'NOT_FOUND', '模板不存在')
      const [m] = await tx.select({ v: max(templateVersion.versionNo) }).from(templateVersion).where(eq(templateVersion.templateId, id))
      const no = (m?.v ?? 0) + 1
      await tx.insert(templateVersion).values({ id: newId(), templateId: id, versionNo: no, doc: body.doc as DocData, fields })
      return no
    })
    return { id, versionNo }
  })

  app.get<{ Params: { id: string; no: string } }>('/api/templates/:id/versions/:no', async (req) => {
    const caller = await requireHost(req)
    const id = parse(ID, req.params.id)
    await checkTemplateOwner(id, caller.clientId)
    const no = parse(z.coerce.number().int().positive(), req.params.no)
    const [v] = await db.select().from(templateVersion).where(and(eq(templateVersion.templateId, id), eq(templateVersion.versionNo, no))).limit(1)
    if (!v) throw new HttpError(404, 'NOT_FOUND', '模板版本不存在')
    return { templateId: id, versionNo: v.versionNo, doc: v.doc, fields: v.fields, publishedAt: v.publishedAt }
  })

  app.post('/api/documents', async (req) => {
    const caller = await requireHost(req)
    const body = parse(z.object({ templateId: ID, versionNo: z.number().int().positive(), title: z.string().max(200).optional(), bizKey: z.string().max(100).optional(), values: VALUES.default({}), dictionaries: z.record(z.string().min(1).max(100), DICTIONARY).default({}) }), req.body)
    await checkTemplateOwner(body.templateId, caller.clientId)
    const [v] = await db.select().from(templateVersion).where(and(eq(templateVersion.templateId, body.templateId), eq(templateVersion.versionNo, body.versionNo))).limit(1)
    if (!v) throw new HttpError(404, 'NOT_FOUND', '模板版本不存在')
    const [t] = await db.select().from(template).where(eq(template.id, body.templateId)).limit(1)
    // 宿主后端可信：初始数据可以写任何非计算字段，计算字段由 core 算
    const snapshot = withDictionaries(v.doc, v.fields, body.dictionaries)
    const fields = snapshot.fields
    const patch = Object.fromEntries(Object.entries(body.values).filter(([k]) => fields.find((f) => f.key === k)?.type !== 'computed'))
    const filled = applyFill(snapshot.doc, { values: {} }, patch, fields, Object.fromEntries(fields.map((f) => [f.key, 'editable' as const])))
    if (!filled.ok) throw new HttpError(400, filled.code, filled.error)
    const id = newId()
    await db.insert(document).values({ id, templateVersionId: v.id, bizKey: body.bizKey ?? null, title: body.title ?? t?.name ?? '未命名', doc: filled.data, values: filled.values, fields })
    return { id, version: 1 }
  })

  app.get<{ Params: { id: string } }>('/api/documents/:id', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    const [row] = await db.select().from(document).where(eq(document.id, id)).limit(1)
    if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    const base = { id, title: row.title, status: row.status, version: row.version, fields: row.fields, pageCount: row.pageCount, seals: await validSeals(db, id) }
    if (caller.kind === 'host') return { ...base, mode: 'edit', actions: { print: true, download: true }, doc: row.doc, values: row.values }
    // 隐藏字段的值在服务端剔除，不下发
    const safe = stripHidden(row.doc, row.values, row.fields, caller.perms)
    return { ...base, mode: caller.token.mode, permissions: caller.perms, actions: caller.actions, doc: safe.data, values: safe.values }
  })

  // 编辑模式保存整份文档
  app.put<{ Params: { id: string } }>('/api/documents/:id', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    if (caller.kind === 'token' && caller.token.mode !== 'edit') throw new HttpError(403, 'MODE_FORBIDDEN', '只有编辑模式能保存整份文档')
    const body = parse(
      z.object({ doc: DOC, values: z.object({ values: VALUES }).passthrough().optional(), version: z.number().int().positive(), pageCount: PAGE_COUNT }),
      req.body,
    )
    await deps.hooks?.afterAuth?.(req)
    const version = await db.transaction(async (tx) => {
      await lockToken(tx, caller)
      const row = await lockDocument(tx, id, body.version)
      // 令牌拿到的文档剔除过隐藏值（GET 时按权限清空了）：整份存回去会把隐藏字段的值清掉，拒绝
      if (seesStripped(caller, row.fields)) throw new HttpError(403, 'HIDDEN_FIELDS', '这个令牌有隐藏字段，拿到的文档不全，不能整份保存')
      await tx
        .update(document)
        .set({ doc: body.doc as DocData, values: (body.values as DocValues | undefined) ?? row.values, version: row.version + 1, pageCount: body.pageCount ?? null, updatedAt: new Date() })
        .where(eq(document.id, id))
      return row.version + 1
    })
    return { id, version }
  })

  // 填写模式保存：只提交字段值，服务端按当前权限写进文档
  app.patch<{ Params: { id: string } }>('/api/documents/:id/data', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    if (caller.kind === 'token' && caller.token.mode !== 'fill' && caller.token.mode !== 'edit')
      throw new HttpError(403, 'MODE_FORBIDDEN', `${caller.token.mode} 模式不能改字段`)
    // areas：可编辑区（按 anchor），给一段文字或一组带样式的文字；只有模板里标成可编辑区的能改（方案 4.2、4.7），内容由 core 的 applyAreas 校验
    const body = parse(
      z.object({ patch: VALUES, areas: z.record(AREA_ANCHOR, AREA_CONTENT).optional(), version: z.number().int().positive(), pageCount: PAGE_COUNT }),
      req.body,
    )
    await deps.hooks?.afterAuth?.(req)
    return db.transaction(async (tx) => {
      const locked = await lockToken(tx, caller)
      const row = await lockDocument(tx, id, body.version)
      const perms = locked ?? Object.fromEntries(row.fields.map((f) => [f.key, 'editable' as const]))
      const filled = applyFill(row.doc, row.values, body.patch, row.fields, perms)
      if (!filled.ok) throw new HttpError(filled.code === 'PERMISSION_DENIED' ? 403 : 400, filled.code, filled.error)
      const areas = applyAreas(filled.data, (body.areas ?? {}) as Record<string, string | AreaRun[]>)
      if (!areas.ok) throw new HttpError(AREA_STATUS[areas.code], areas.code, areas.error, { area: areas.area })
      const doc = areas.data
      // 页数：编辑器保存时带（按打印模式数）；宿主直接改值时不知道、看到的文档剔除过隐藏值时数得不对，清空，导出时不核对
      const pageCount = seesStripped(caller, row.fields) ? null : (body.pageCount ?? null)
      await tx.update(document).set({ doc, values: filled.values, version: row.version + 1, pageCount, updatedAt: new Date() }).where(eq(document.id, id))
      const safe = caller.kind === 'token' ? stripHidden(doc, filled.values, row.fields, perms).values : filled.values
      return { id, version: row.version + 1, values: safe }
    })
  })

  // ---------- 出文件（方案 4.9、第 12 节第 1 轮第 3 条；验收 1、15）----------
  const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  const sendFile = (reply: FastifyReply, file: Buffer, format: 'pdf' | 'docx', title: string, headers: Record<string, string | number>) => {
    for (const [k, v] of Object.entries(headers)) reply.header(k, v)
    return reply
      .type(MIME[format])
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${title}.${format}`)}`)
      .send(file)
  }

  // 下载文档：只用已保存的数据。带 ?version= 时版本对不上 409（宿主要的是「已盖章」那一版时用）。令牌调用时按权限剔除隐藏字段的值
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/documents/:id/export', async (req, reply) => {
    const id = parse(ID, req.params.id)
    const q = parse(z.object({ format: z.enum(['pdf', 'docx']).default('pdf'), version: z.coerce.number().int().positive().optional() }), req.query)
    const caller = await callerFor(req, id)
    if (caller.kind === 'token' && !caller.actions.download) throw new HttpError(403, 'ACTION_FORBIDDEN', '这个文档令牌不能下载')
    const [row] = await db.select().from(document).where(eq(document.id, id)).limit(1)
    if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    if (q.version !== undefined && q.version !== row.version) throw new HttpError(409, 'VERSION_CONFLICT', `文档当前是第 ${row.version} 版，不是第 ${q.version} 版`)
    const doc = caller.kind === 'token' ? stripHidden(row.doc, row.values, row.fields, caller.perms).data : row.doc
    const expectedPages = seesStripped(caller, row.fields) ? undefined : (row.pageCount ?? undefined)
    const r = await rendererOf().render({ doc, documentId: id, version: row.version, title: row.title, outputs: [q.format], expectedPages })
    const file = q.format === 'pdf' ? r.pdf : r.docx
    if (!file) throw new HttpError(502, 'RENDER_FAILED', '渲染服务没有返回文件')
    return sendFile(reply, file, q.format, row.title, { 'X-Document-Version': row.version, 'X-Page-Count': r.pageCount })
  })

  // 不建文档，直接用模板版本 + 数据出文件（验收 15）
  app.post('/api/render', async (req, reply) => {
    const caller = await requireHost(req)
    const body = parse(z.object({ templateId: ID, versionNo: z.number().int().positive(), values: VALUES.default({}), title: z.string().max(200).optional(), format: z.enum(['pdf', 'docx']).default('pdf') }), req.body)
    await checkTemplateOwner(body.templateId, caller.clientId)
    const [v] = await db.select().from(templateVersion).where(and(eq(templateVersion.templateId, body.templateId), eq(templateVersion.versionNo, body.versionNo))).limit(1)
    if (!v) throw new HttpError(404, 'NOT_FOUND', '模板版本不存在')
    const patch = Object.fromEntries(Object.entries(body.values).filter(([k]) => v.fields.find((f) => f.key === k)?.type !== 'computed'))
    const filled = applyFill(v.doc, { values: {} }, patch, v.fields, Object.fromEntries(v.fields.map((f) => [f.key, 'editable' as const])))
    if (!filled.ok) throw new HttpError(400, filled.code, filled.error)
    const [t] = await db.select().from(template).where(eq(template.id, body.templateId)).limit(1)
    const title = body.title ?? t?.name ?? '未命名'
    const r = await rendererOf().render({ doc: filled.data, title, outputs: [body.format] })
    const file = body.format === 'pdf' ? r.pdf : r.docx
    if (!file) throw new HttpError(502, 'RENDER_FAILED', '渲染服务没有返回文件')
    return sendFile(reply, file, body.format, title, { 'X-Page-Count': r.pageCount })
  })

  // ---------- 批量操作（方案 4.8；验收 13、14）----------
  // 在文档 JSON 的副本上逐条执行，任何一条失败整批不生效，返回失败的序号和原因。
  // 宿主和编辑模式令牌：除印章外的所有操作；填写模式令牌：只能 setData，按令牌权限（和 PATCH data 同一套）。印章操作走 /seals（有盖章记录和状态机）
  const OPS = z.object({ ops: z.array(z.object({ op: z.string() }).passthrough()).min(1).max(200), version: z.number().int().positive() })
  const SEAL_OPS = new Set(['placeSeal', 'moveSeal', 'removeSeal'])
  app.post<{ Params: { id: string } }>('/api/documents/:id/operations', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    if (caller.kind === 'token' && caller.token.mode !== 'edit' && caller.token.mode !== 'fill') throw new HttpError(403, 'MODE_FORBIDDEN', `${caller.token.mode} 模式不能执行操作`)
    const body = parse(OPS, req.body)
    const ops = body.ops as unknown as Op[]
    const sealAt = ops.findIndex((o) => SEAL_OPS.has(o.op))
    if (sealAt >= 0) throw new HttpError(400, 'BAD_REQUEST', '印章操作走 POST /documents/{id}/seals', { index: sealAt })
    const fillOnly = caller.kind === 'token' && caller.token.mode === 'fill'
    const notData = ops.findIndex((o) => o.op !== 'setData')
    if (fillOnly && notData >= 0) throw new HttpError(403, 'MODE_FORBIDDEN', '填写模式只能改字段值（setData）', { index: notData })
    await deps.hooks?.afterAuth?.(req)
    const operator = caller.kind === 'host' ? `host:${caller.clientId}` : caller.token.uid
    try {
      return await db.transaction(async (tx) => {
        const locked = await lockToken(tx, caller)
        const row = await lockDocument(tx, id, body.version)
        const perms = locked ?? Object.fromEntries(row.fields.map((f) => [f.key, 'editable' as const]))
        let data = row.doc
        let values = row.values
        const created: string[] = []
        for (const [index, op] of ops.entries()) {
          // 入参只校验了 op 名，其余字段由操作库校验；缺字段、类型不对时操作库可能直接抛错，按这一条的入参错误返回，不变成 500
          const bad = (e: unknown) => new HttpError(400, 'BAD_ARGUMENT', `第 ${index + 1} 条：入参不对（${e instanceof Error ? e.message : String(e)}）`, { index })
          if (op.op === 'setData') {
            if (!op.values || typeof op.values !== 'object' || Array.isArray(op.values)) throw bad('setData 要带 values 对象')
            let r: ReturnType<typeof applyFill>
            try {
              r = applyFill(data, values, op.values, row.fields, perms)
            } catch (e) {
              throw bad(e)
            }
            if (!r.ok) throw new HttpError(r.code === 'PERMISSION_DENIED' ? 403 : 422, r.code, `第 ${index + 1} 条：${r.error}`, { index })
            data = r.data
            values = r.values
          } else {
            let r: ReturnType<typeof applyBatch>
            try {
              r = applyBatch(data, [op], { fields: row.fields })
            } catch (e) {
              throw bad(e)
            }
            if (!r.ok) throw new HttpError(422, r.code, `第 ${index + 1} 条：${r.error}`, { index })
            data = r.data
            created.push(...r.created)
          }
        }
        const version = row.version + 1
        const at = new Date()
        // 改了正文或字段，编辑器上次数的页数不再可信
        await tx.update(document).set({ doc: data, values, version, pageCount: null, updatedAt: at }).where(eq(document.id, id))
        await tx.insert(operationLog).values({ id: newId(), documentId: id, ops, result: { ok: true, version, created }, operator, at })
        const safe = caller.kind === 'token' ? stripHidden(data, values, row.fields, perms).values : values
        return { id, version, created, values: safe }
      })
    } catch (e) {
      // 失败也记一笔（事务已回滚，单独写）
      if (e instanceof HttpError && typeof e.detail?.index === 'number')
        await db.insert(operationLog).values({ id: newId(), documentId: id, ops, result: { ok: false, index: e.detail.index, code: e.code, error: e.message }, operator }).catch(() => {})
      throw e
    }
  })

  // ---------- 盖章（方案 4.4、第 12 节第 1 轮第 1 条）----------
  // 状态：填写中 → 盖章中 → 已盖章；驳回：盖章中 / 已盖章 → 填写中（已盖的章作废、从文档里移除）；作废：任意 → 已作废。
  // 每个操作一个事务：锁文档行，校验状态和版本号，写盖章记录、改文档 JSON、版本号加 1、记操作日志。
  const SEAL = z.object({
    id: z.string().min(1).max(100),
    sealId: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    dataURL: z.string().min(1).max(5 * 1024 * 1024),
    pageNo: z.number().int().min(0),
    x: z.number(),
    y: z.number(),
    width: z.number().positive().max(2000),
    height: z.number().positive().max(2000),
  })
  const VERSION = z.number().int().positive()
  const SEAL_ID = z.string().min(1).max(100)
  const SEAL_OP = z.discriminatedUnion('action', [
    z.object({ action: z.literal('place'), version: VERSION, seal: SEAL }),
    z.object({ action: z.literal('move'), version: VERSION, id: SEAL_ID, pageNo: z.number().int().min(0), x: z.number(), y: z.number() }),
    z.object({ action: z.literal('remove'), version: VERSION, id: SEAL_ID }),
  ])
  const STATUS_OP = z.object({ action: z.enum(['start', 'submit', 'reject', 'void']), version: VERSION, reason: z.string().max(500).optional() })
  const FROM: Record<z.infer<typeof STATUS_OP>['action'], DocStatus[]> = { start: ['filling'], submit: ['sealing'], reject: ['sealing', 'sealed'], void: ['filling', 'sealing', 'sealed'] }
  const TO: Record<z.infer<typeof STATUS_OP>['action'], DocStatus> = { start: 'sealing', submit: 'sealed', reject: 'filling', void: 'void' }
  const STATUS_NAMES: Record<DocStatus, string> = { filling: '填写中', sealing: '盖章中', sealed: '已盖章', void: '已作废' }

  const operatorOf = (c: Caller) => (c.kind === 'host' ? `host:${c.clientId}` : c.token.uid)
  const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
  async function validSeals(q: Db | Tx, documentId: string) {
    const rows = await q.select().from(sealRecord).where(and(eq(sealRecord.documentId, documentId), eq(sealRecord.status, 'valid')))
    return rows.map(({ id, sealId, sealName, pageNo, x, y, width, height, operator, at }) => ({ id, sealId, sealName, pageNo, x, y, width, height, operator, at }))
  }
  /** 锁住文档行，再校验状态和版本号（盖章接口用；正文和字段的修改走 lockDocument，只认填写中） */
  /** 锁住文档行，校验状态；before 在状态校验之后、版本号校验之前（放章重试按 id 去重，不管带的版本号）；最后校验版本号 */
  async function lockFor(tx: Tx, id: string, version: number, statuses: DocStatus[], before?: (row: typeof document.$inferSelect) => Promise<unknown>) {
    const [row] = await tx.select().from(document).where(eq(document.id, id)).for('update')
    if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    if (!statuses.includes(row.status)) throw new HttpError(422, 'INVALID_STATUS', `文档${STATUS_NAMES[row.status]}，不能做这个操作`)
    const early = await before?.(row)
    if (early) return { row, early }
    if (row.version !== version) throw new HttpError(409, 'VERSION_CONFLICT', `文档已被别人修改（当前版本 ${row.version}），请刷新`)
    return { row, early: null }
  }

  // 放章、移章、删章：盖章中才行；盖章模式的令牌或宿主
  app.post<{ Params: { id: string } }>('/api/documents/:id/seals', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    if (caller.kind === 'token' && caller.token.mode !== 'seal') throw new HttpError(403, 'MODE_FORBIDDEN', '只有盖章模式能放章、移章')
    const body = parse(SEAL_OP, req.body)
    return db.transaction(async (tx) => {
      await lockToken(tx, caller)
      const { row, early } = await lockFor(tx, id, body.version, ['sealing'], async (r) => {
        if (body.action !== 'place') return null
        // 放章按客户端生成的印章 id 去重：已经放过、还有效就原样返回（双击、重试只生效一次，不管带的版本号）；
        // 已作废的（驳回过）不能再放；印章 id 是全局主键，别的文档用过的也不能用
        const [dup] = await tx.select().from(sealRecord).where(eq(sealRecord.id, body.seal.id)).limit(1)
        if (dup && dup.documentId !== id) throw new HttpError(409, 'SEAL_ID_TAKEN', '印章 id 已被别的文档用过，请换一个')
        if (dup?.status === 'void') throw new HttpError(409, 'SEAL_VOID', '这个印章已作废，请刷新')
        return dup ? { id, version: r.version, status: r.status, seals: await validSeals(tx, id), duplicate: true } : null
      })
      if (early) return early
      const at = new Date()
      const operator = operatorOf(caller)
      let op: Op
      if (body.action === 'place') {
        const s = body.seal
        op = { op: 'placeSeal', seal: { id: s.id, dataURL: s.dataURL, pageNo: s.pageNo, x: s.x, y: s.y, width: s.width, height: s.height, sealId: s.sealId, name: s.name } }
      } else {
        const [rec] = await tx.select().from(sealRecord).where(and(eq(sealRecord.id, body.id), eq(sealRecord.documentId, id), eq(sealRecord.status, 'valid'))).limit(1)
        if (!rec) throw new HttpError(404, 'SEAL_NOT_FOUND', `找不到印章 ${body.id}`)
        op = body.action === 'move' ? { op: 'moveSeal', id: body.id, pageNo: body.pageNo, x: body.x, y: body.y } : { op: 'removeSeal', id: body.id }
      }
      const r = applyBatch(row.doc, [op], { fields: row.fields })
      if (!r.ok) throw new HttpError(r.code === 'TARGET_NOT_FOUND' ? 404 : 400, r.code, r.error)
      if (body.action === 'place') {
        const s = body.seal
        await tx.insert(sealRecord).values({ id: s.id, documentId: id, sealId: s.sealId, sealName: s.name, imageHash: sha256(s.dataURL), pageNo: s.pageNo, x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.width), height: Math.round(s.height), operator, at })
      } else if (body.action === 'move') {
        await tx.update(sealRecord).set({ pageNo: body.pageNo, x: Math.round(body.x), y: Math.round(body.y), operator, at }).where(eq(sealRecord.id, body.id))
      } else await tx.update(sealRecord).set({ status: 'void', operator, at }).where(eq(sealRecord.id, body.id))
      const version = row.version + 1
      await tx.update(document).set({ doc: r.data, version, updatedAt: at }).where(eq(document.id, id))
      // 操作日志不存图片本身，只存哈希
      const logged = body.action === 'place' ? { ...body, seal: { ...body.seal, dataURL: undefined, imageHash: sha256(body.seal.dataURL) } } : body
      await tx.insert(operationLog).values({ id: newId(), documentId: id, ops: logged, result: { ok: true, version }, operator, at })
      return { id, version, status: row.status, seals: await validSeals(tx, id) }
    })
  })

  // 状态迁移：提交盖章（盖章模式的令牌或宿主）；开始盖章、驳回、作废只有宿主（业务流程由宿主决定）
  app.post<{ Params: { id: string } }>('/api/documents/:id/seal-status', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    const body = parse(STATUS_OP, req.body)
    if (caller.kind === 'token' && !(body.action === 'submit' && caller.token.mode === 'seal')) throw new HttpError(403, 'MODE_FORBIDDEN', '文档令牌只能提交盖章')
    return db.transaction(async (tx) => {
      await lockToken(tx, caller)
      const { row } = await lockFor(tx, id, body.version, FROM[body.action])
      const at = new Date()
      const operator = operatorOf(caller)
      let doc = row.doc
      let voided = 0
      if (body.action === 'reject') {
        // 驳回：已盖的章全部作废，并从文档里移除
        const seals = await validSeals(tx, id)
        const r = applyBatch(doc, seals.map((s) => ({ op: 'removeSeal', id: s.id }) as Op), { fields: row.fields })
        if (!r.ok) throw new HttpError(500, 'INTERNAL', `移除印章失败：${r.error}`)
        doc = r.data
        await tx.update(sealRecord).set({ status: 'void', operator, at }).where(and(eq(sealRecord.documentId, id), eq(sealRecord.status, 'valid')))
        voided = seals.length
      }
      const status = TO[body.action]
      const version = row.version + 1
      const lockedAt = status === 'sealing' || status === 'sealed' ? (row.lockedAt ?? at) : status === 'filling' ? null : row.lockedAt
      await tx.update(document).set({ status, doc, version, lockedAt, updatedAt: at }).where(eq(document.id, id))
      await tx.insert(operationLog).values({ id: newId(), documentId: id, ops: body, result: { ok: true, from: row.status, to: status, version, voided }, operator, at })
      return { id, version, status, voided }
    })
  })

  app.post('/api/tokens', async (req) => {
    await requireHost(req)
    const body = parse(
      z.object({
        documentId: ID,
        mode: MODE,
        userId: z.string().min(1).max(100),
        permissions: z.record(z.string(), PERMISSION).default({}),
        // 能不能打印、下载，不给都能
        actions: z.object({ print: z.boolean().optional(), download: z.boolean().optional() }).optional(),
        ttlSeconds: z.number().int().min(1).max(86400).optional(),
      }),
      req.body,
    )
    const [d] = await db.select({ id: document.id }).from(document).where(eq(document.id, body.documentId)).limit(1)
    if (!d) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    const tid = newId()
    const expiresAt = new Date(Date.now() + (body.ttlSeconds ?? config.TOKEN_TTL_SECONDS) * 1000)
    const canPrint = body.actions?.print ?? true
    const canDownload = body.actions?.download ?? true
    await db.transaction(async (tx) => {
      await tx.insert(docToken).values({ id: tid, documentId: body.documentId, mode: body.mode, userId: body.userId, canPrint, canDownload, expiresAt })
      const rows = Object.entries(body.permissions).map(([fieldKey, permission]) => ({ tokenId: tid, fieldKey, permission }))
      if (rows.length) await tx.insert(tokenPermission).values(rows)
    })
    const token = signToken(config.TOKEN_SECRET, { tid, did: body.documentId, mode: body.mode, uid: body.userId, exp: expiresAt.getTime() })
    return { id: tid, token, expiresAt, actions: { print: canPrint, download: canDownload } }
  })

  app.put<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    await requireHost(req)
    const id = parse(ID, req.params.id)
    const body = parse(z.object({ permissions: z.record(z.string(), PERMISSION) }), req.body)
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(docToken).where(eq(docToken.id, id)).for('update')
      if (!row) throw new HttpError(404, 'NOT_FOUND', '令牌不存在')
      await tx.delete(tokenPermission).where(eq(tokenPermission.tokenId, id))
      const rows = Object.entries(body.permissions).map(([fieldKey, permission]) => ({ tokenId: id, fieldKey, permission }))
      if (rows.length) await tx.insert(tokenPermission).values(rows)
    })
    return { id }
  })

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    await requireHost(req)
    const id = parse(ID, req.params.id)
    await db.transaction(async (tx) => {
      const [row] = await tx.select().from(docToken).where(eq(docToken.id, id)).for('update')
      if (!row) throw new HttpError(404, 'NOT_FOUND', '令牌不存在')
      await tx.update(docToken).set({ revokedAt: new Date() }).where(eq(docToken.id, id))
    })
    return { id, revoked: true }
  })

  return app
}
