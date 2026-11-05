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
  areaAnchors,
  areaRuns,
  stripHidden,
  traceChanges,
  checkFormulas,
  applyConditions,
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
import { Hub, sees, type Subscriber } from './realtime'
import { registerComments } from './comments'
import { recordRevision, registerRevisions } from './revisions'

export { HttpError }

export interface AppDeps {
  config: Config
  db: Db
  store: FileStore
  /** 渲染服务（出 PDF / docx、docx 转文档）；不给时这些接口返回 503 */
  renderer?: RendererClient
  /** 测试用插桩：鉴权之后、进事务之前调用（用来模拟「保存在途时权限被改」） */
  hooks?: { afterAuth?: (req: FastifyRequest) => Promise<void> }
  /** 文档事件的分发（多人编辑，08 第 3 节）；不给就在本进程里分发 */
  hub?: Hub
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** 令牌能不能打印、下载（宿主签发令牌时给，不给都能） */
type Actions = { print: boolean; download: boolean }
type Caller = { kind: 'host'; clientId: string } | { kind: 'token'; token: TokenPayload; perms: Record<string, Permission>; actions: Actions }

// ---------- 入参 ----------
const PERMISSION = z.enum(['editable', 'readonly', 'required', 'hidden'])
const MODE = z.enum(['edit', 'fill', 'seal', 'view'])
const DOC = z.object({ main: z.array(z.any()), header: z.array(z.any()).optional(), footer: z.array(z.any()).optional() }).passthrough()
// 计算字段：金额大写，或者公式（core 的 formula.ts；写法、引用、循环引用由 formulaIssues 查）
const COMPUTED = z.union([
  z.object({ fn: z.literal('amountCN'), from: z.string().min(1) }).strict(),
  z.object({ fn: z.literal('formula'), expr: z.string().min(1).max(500), digits: z.number().int().min(0).max(6).optional() }).strict(),
])
// formulas：循环表行内计算的列 → 同一行别的列的公式
const LOOP = z.object({ columns: z.array(z.string().min(1)).min(1), labels: z.array(z.string()).optional(), formulas: z.record(z.string().min(1), z.string().min(1).max(500)).optional() })
// 校验规则（core 的 rules.ts）：字数、常用格式、数值范围；不收自定义正则
const RULES = z
  .object({
    minLength: z.number().int().min(0).max(100000).optional(),
    maxLength: z.number().int().min(1).max(100000).optional(),
    pattern: z.enum(['mobile', 'idCard', 'creditCode', 'email']).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict()
  .refine((r) => (r.minLength ?? 0) <= (r.maxLength ?? Infinity) && (r.min ?? -Infinity) <= (r.max ?? Infinity), '下限不能大于上限')
const FIELD = z
  .object({
    key: z.string().min(1).max(100),
    label: z.string().min(1).max(100),
    type: z.enum(['text', 'number', 'amount', 'date', 'select', 'radio', 'checkbox', 'picker', 'computed', 'image', 'loop', 'signature', 'signDate']),
    permission: PERMISSION.optional(),
    computed: COMPUTED.optional(),
    loop: LOOP.optional(),
    rules: RULES.optional(),
  })
  .passthrough()
/** 一组字段里公式的问题（写法、引用的字段、循环引用），模板和字段库都查 */
const formulaIssues = (fields: z.infer<typeof FIELD>[], ctx: z.RefinementCtx) => {
  for (const issue of checkFormulas(fields as FieldDef[])) ctx.addIssue({ code: 'custom', path: [fields.findIndex((f) => f.key === issue.key)], message: `字段 ${issue.key}：${issue.error}` })
}
// 字段库是外部输入边界，检查所有会被填写器使用的配置。
const LIBRARY_FIELD = FIELD.extend({
  options: z.array(z.object({ code: z.string().min(1), value: z.string() })).optional(),
  dataSource: z.object({ id: z.string().min(1), kind: z.enum(['static', 'dict', 'remote', 'host']) }).optional(),
  fill: z.record(z.string().min(1), z.string().min(1)).optional(),
  format: z.string().optional(),
  // 签名区、签署日期绑定的签署方角色（core 的 SIGNER_ROLES：a、b、c、d）
  signer: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
}).strict()
const LIBRARY_FIELDS = z.array(LIBRARY_FIELD).max(1000).superRefine((fields, ctx) => {
  const keys = new Set<string>()
  for (const [i, field] of fields.entries()) {
    if (keys.has(field.key)) ctx.addIssue({ code: 'custom', path: [i, 'key'], message: '字段 key 重复' })
    keys.add(field.key)
  }
  for (const [i, field] of fields.entries()) {
    for (const key of Object.keys(field.fill ?? {})) {
      if (!keys.has(key)) ctx.addIssue({ code: 'custom', path: [i], message: `引用的字段 ${key} 未登记` })
    }
    if (field.computed?.fn === 'amountCN' && !keys.has(field.computed.from)) ctx.addIssue({ code: 'custom', path: [i], message: `引用的字段 ${field.computed.from} 未登记` })
  }
  formulaIssues(fields, ctx)
})
const TEMPLATE_FIELDS = {
  fields: z.array(FIELD).superRefine(formulaIssues).optional(),
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
  const hub = deps.hub ?? new Hub()
  // 文档里带印章图片（base64），放宽请求体上限
  const app = Fastify({ bodyLimit: 20 * 1024 * 1024, logger: false })
  // 事件流是长连接：关服务前先关掉，不然一直等
  app.addHook('preClose', async () => hub.closeAll())

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

  /**
   * 锁住文档行，校验状态（填写中）和版本号。merge（多人编辑，08 第 3 节；请求里带了 base 才合并）：基准版本落后也行，
   * 只要正文在基准版本之后没被整份改过（bodyVersion ≤ 基准）；正文改过、版本号比现在的还新，都是 409
   */
  async function lockDocument(tx: Tx, id: string, version: number, merge = false) {
    const [row] = await tx.select().from(document).where(eq(document.id, id)).for('update')
    if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    if (row.status !== 'filling') throw new HttpError(422, 'INVALID_STATUS', `文档状态是 ${row.status}，不能修改`)
    const mergeable = merge && version < row.version && row.bodyVersion <= version
    if (row.version !== version && !mergeable) throw new HttpError(409, 'VERSION_CONFLICT', `文档已被别人修改（当前版本 ${row.version}），请刷新`)
    return row
  }

  /** 前后两份字段值里变了的 key（含跟着变的计算字段） */
  const changedKeys = (before: DocValues['values'], after: DocValues['values']) =>
    [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
  type FieldVersions = NonNullable<typeof document.$inferSelect.fieldVersions>
  /** 记下这些字段（area: 开头的是可编辑区）在哪一版被谁、经哪条事件流连接改的 */
  const bumpFields = (prev: FieldVersions | null, keys: string[], v: number, caller: Caller, conn?: string) => {
    const out = { ...(prev ?? {}) }
    for (const k of keys) out[k] = { v, by: operatorOf(caller), name: nameOf(caller), ...(conn ? { conn } : {}) }
    return out
  }
  /**
   * 多人编辑的冲突检查（08 第 3 节）：base 是客户端看到的每个字段的版本。字段在那之后被别人（别的连接）改过，就是冲突；
   * 自己这条连接改的不算（客户端不一定知道自己上次保存后的版本号）。value 给现在的值，可编辑区给带样式的文字
   */
  function conflictsOf(row: typeof document.$inferSelect, keys: string[], base: Record<string, number>, conn: string | undefined) {
    return keys.flatMap((k) => {
      const f = row.fieldVersions?.[k]
      if (!f || f.v <= (base[k] ?? 0) || (conn && f.conn === conn)) return []
      const value = k.startsWith('area:') ? areaRuns(areaAnchors(row.doc).find((a) => a.anchor === k.slice(5))?.el.valueList) : (row.values.values[k] ?? null)
      return [{ key: k, value, by: f.name ?? f.by, version: f.v }]
    })
  }
  /** 推字段值给其他连接：每个连接只拿到它看得到的字段；except 是发起保存的那条连接 */
  const publishFields = (id: string, version: number, changed: Record<string, FieldValue>, areas: Record<string, unknown> | undefined, caller: Caller, except?: string) => {
    if (!Object.keys(changed).length && !Object.keys(areas ?? {}).length) return
    const by = { userId: operatorOf(caller), name: nameOf(caller) }
    hub.publish(
      id,
      'fields',
      (s) => {
        const values = Object.fromEntries(Object.entries(changed).filter(([k]) => sees(s, k)))
        if (!Object.keys(values).length && !Object.keys(areas ?? {}).length) return null
        return { version, values, ...(areas && Object.keys(areas).length ? { areas } : {}), by }
      },
      except,
    )
  }

  /**
   * 调用方拿到的文档剔除过隐藏值没有（GET 时按令牌权限和字段默认权限剔除）。剔除过的（s13）：
   * 整份保存（PUT）会把隐藏值清掉，拒绝；填写保存时它按打印模式数的页数是缺了隐藏值的文档的，不存；
   * 它下载时出的是剔除后的文档，页数也可能和存的对不上，不核对
   */
  const seesStripped = (caller: Caller, fields: FieldDef[]) =>
    caller.kind === 'token' && fields.some((f) => (caller.perms[f.key] ?? f.permission ?? 'editable') === 'hidden')

  /** 显示用的名字：令牌签发时给的，没给用 userId；宿主是「宿主」 */
  const nameOf = (c: Caller) => (c.kind === 'host' ? '宿主' : (c.token.un ?? c.token.uid))

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
  // 批注（08 第 3 节）：宿主和各模式的文档令牌都能看
  registerComments(app, {
    db,
    hub,
    who: async (req, id) => {
      const c = await callerFor(req, id)
      return { userId: operatorOf(c), name: nameOf(c), mode: c.kind === 'host' ? null : c.token.mode }
    },
  })
  // 版本历史（08 第 3 节）：令牌看到的快照按它的字段权限剔除隐藏值
  registerRevisions(app, {
    db,
    who: async (req, id) => {
      const c = await callerFor(req, id)
      return c.kind === 'host' ? { mode: null, perms: null } : { mode: c.token.mode, perms: c.perms }
    },
  })

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
    await db.transaction(async (tx) => {
      await tx.insert(document).values({ id, templateVersionId: v.id, bizKey: body.bizKey ?? null, title: body.title ?? t?.name ?? '未命名', doc: filled.data, values: filled.values, fields })
      // 第一版：版本对比时能和最初的样子比
      await recordRevision(tx, { documentId: id, version: 1, reason: 'create', doc: filled.data, values: filled.values, operator: operatorOf(caller), operatorName: nameOf(caller) })
    })
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

  // ---------- 多人编辑（08 第 3 节）：事件流和在场 ----------
  // GET .../events：text/event-stream。先发 hello（自己的连接 id、版本、状态），之后有 presence、fields、doc、lock、status、comments 这些事件；
  // 25 秒一个心跳注释，令牌过期时服务端断开（客户端重连时重新鉴权）
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/documents/:id/events', async (req, reply) => {
    const id = parse(ID, req.params.id)
    // since：客户端已经有的版本号（重连时用），hello 里补发这之后的改动
    const q = parse(z.object({ since: z.coerce.number().int().nonnegative().optional() }), req.query)
    const caller = await callerFor(req, id)
    // 字段定义先取（推送按它的默认权限剔除隐藏字段，进频道前就要有）；文档的其他内容进频道之后再取，中间别人保存的不会漏
    const [head] = await db.select({ fields: document.fields }).from(document).where(eq(document.id, id)).limit(1)
    if (!head) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    raw.write('retry: 3000\n\n')
    let open = true
    // hello 发出去之前收到的推送先攒着，hello 之后按顺序发
    let pending: string[] | null = []
    const write = (event: string, data: unknown) => {
      if (!open) return
      const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      if (pending) pending.push(line)
      else raw.write(line)
    }
    const sub: Subscriber = {
      conn: newId(),
      documentId: id,
      userId: operatorOf(caller),
      name: nameOf(caller),
      mode: caller.kind === 'token' ? caller.token.mode : 'edit',
      field: null,
      tokenId: caller.kind === 'token' ? caller.token.tid : null,
      perms: caller.kind === 'token' ? caller.perms : null,
      defaults: Object.fromEntries(head.fields.map((f) => [f.key, f.permission ?? 'editable'])),
      send: write,
      end: () => {
        if (open) raw.end()
      },
    }
    hub.add(sub)
    const ping = setInterval(() => open && raw.write(': ping\n\n'), 25_000)
    const expire = caller.kind === 'token' ? setTimeout(() => sub.end(), Math.max(0, caller.token.exp - Date.now())) : undefined
    const done = () => {
      if (!open) return
      open = false
      clearInterval(ping)
      clearTimeout(expire)
      hub.remove(sub)
      // 这条连接拿着编辑锁就放掉（关了标签页、断网），别人马上能编辑；断线重连的同一个人会重新拿
      void db
        .update(document)
        .set(clearLock)
        .where(and(eq(document.id, id), eq(document.editLockConn, sub.conn)))
        .then((r) => {
          if (r[0].affectedRows) publishLock(id, null)
        })
        .catch(() => {})
    }
    raw.on('close', done)
    req.raw.on('close', done)
    const [row] = await db.select().from(document).where(eq(document.id, id)).limit(1)
    if (!row || !open) return sub.end()
    const lock = row.editLockUser && row.editLockExpires && row.editLockExpires.getTime() > Date.now() ? { userId: row.editLockUser, name: row.editLockName ?? row.editLockUser, conn: row.editLockConn ?? undefined, expiresAt: row.editLockExpires } : null
    raw.write(`event: hello\ndata: ${JSON.stringify({ conn: sub.conn, userId: sub.userId, name: sub.name, version: row.version, status: row.status, lock, ...(q.since !== undefined && q.since < row.version ? { changes: changesSince(row, q.since, sub) } : {}) })}\n\n`)
    for (const line of pending ?? []) raw.write(line)
    pending = null
    hub.presence(id)
  })

  /** 重连补发：since 之后别人改过的字段（这个连接看得到的）、可编辑区，正文有没有整份改过 */
  function changesSince(row: typeof document.$inferSelect, since: number, sub: Subscriber) {
    const later = Object.entries(row.fieldVersions ?? {}).filter(([k, f]) => f.v > since && (k.startsWith('area:') || sees(sub, k)))
    const areas = Object.fromEntries(
      areaAnchors(row.doc)
        .filter((a) => later.some(([k]) => k === `area:${a.anchor}`))
        .map((a) => [a.anchor, areaRuns(a.el.valueList)]),
    )
    return {
      values: Object.fromEntries(later.filter(([k]) => !k.startsWith('area:')).map(([k]) => [k, row.values.values[k] ?? null])),
      areas,
      versions: Object.fromEntries(later.map(([k, f]) => [k, f.v])),
      body: row.bodyVersion > since,
    }
  }

  // ---------- 正文编辑锁（08 第 3 节）：编辑模式同一时间只有一条连接能改正文 ----------
  // 锁挂在事件流连接上：拿锁、续约要带自己的连接 id；连接断了锁就放掉；120 秒没续约算过期（后台标签页的定时器会被浏览器放慢）。
  // 同一个人的连接断了、换了新连接（断线重连）可以直接接过来
  const LOCK_TTL_MS = 120_000
  type DocRow = typeof document.$inferSelect
  const lockOf = (row: DocRow) =>
    row.editLockUser && row.editLockConn && row.editLockExpires && row.editLockExpires.getTime() > Date.now()
      ? { userId: row.editLockUser, name: row.editLockName ?? row.editLockUser, conn: row.editLockConn, expiresAt: row.editLockExpires }
      : null
  /** 这条连接能不能用这把锁：锁空着、过期了、就是它的，或者是同一个人、原来那条连接已经断了 */
  const lockFree = (row: DocRow, conn: string, userId: string) => {
    const lock = lockOf(row)
    return !lock || lock.conn === conn || (lock.userId === userId && !hub.get(row.id, lock.conn))
  }
  const publishLock = (id: string, lock: ReturnType<typeof lockOf>) => hub.publish(id, 'lock', () => ({ lock }))
  const clearLock = { editLockUser: null, editLockName: null, editLockConn: null, editLockExpires: null }

  app.post<{ Params: { id: string } }>('/api/documents/:id/lock', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    if (caller.kind === 'token' && caller.token.mode !== 'edit') throw new HttpError(403, 'MODE_FORBIDDEN', '只有编辑模式能拿编辑锁')
    // to：交出编辑权时直接交给这条连接（它请求过编辑）
    const body = parse(z.object({ conn: z.string().uuid(), action: z.enum(['acquire', 'release', 'request']), to: z.string().uuid().optional() }), req.body)
    const me = operatorOf(caller)
    const sub = hub.get(id, body.conn)
    if (!sub || sub.userId !== me || sub.tokenId !== (caller.kind === 'token' ? caller.token.tid : null)) throw new HttpError(404, 'CONNECTION_NOT_FOUND', '事件流连接不存在，请刷新')
    const target = body.to ? hub.get(id, body.to) : undefined
    if (body.to && (!target || target.mode !== 'edit')) throw new HttpError(404, 'CONNECTION_NOT_FOUND', '要交给的人已经离开')
    const r = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(document).where(eq(document.id, id)).for('update')
      if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
      const before = lockOf(row)
      if (body.action === 'request') return { ok: !!before && before.conn !== body.conn, lock: before, changed: false }
      if (body.action === 'acquire') {
        if (row.status !== 'filling') throw new HttpError(422, 'INVALID_STATUS', `文档${STATUS_NAMES[row.status]}，不能编辑`)
        if (!lockFree(row, body.conn, me)) return { ok: false, lock: before, changed: false }
        const lock = { editLockUser: me, editLockName: nameOf(caller), editLockConn: body.conn, editLockExpires: new Date(Date.now() + LOCK_TTL_MS) }
        await tx.update(document).set(lock).where(eq(document.id, id))
        return { ok: true, lock: lockOf({ ...row, ...lock }), changed: before?.conn !== body.conn }
      }
      // release：只能放自己的；带 to 时直接交给它
      if (!before || !lockFree(row, body.conn, me)) return { ok: false, lock: before, changed: false }
      const next = target ? { editLockUser: target.userId, editLockName: target.name, editLockConn: target.conn, editLockExpires: new Date(Date.now() + LOCK_TTL_MS) } : clearLock
      await tx.update(document).set(next).where(eq(document.id, id))
      return { ok: true, lock: target ? lockOf({ ...row, ...next }) : null, changed: true }
    })
    if (r.changed) publishLock(id, r.lock)
    // 请求编辑：只告诉拿着锁的那条连接
    if (body.action === 'request' && r.ok && r.lock) hub.publish(id, 'lock-request', (s) => (s.conn === r.lock!.conn ? { from: { userId: me, name: nameOf(caller), conn: body.conn } } : null))
    return { ok: r.ok, lock: r.lock }
  })

  // 告诉别人自己在哪个字段（null：不在字段里）。只能改自己这条连接的
  app.post<{ Params: { id: string } }>('/api/documents/:id/presence', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    const body = parse(z.object({ conn: z.string().uuid(), field: z.string().min(1).max(100).nullable() }), req.body)
    const sub = hub.get(id, body.conn)
    const mine = sub && sub.userId === operatorOf(caller) && sub.tokenId === (caller.kind === 'token' ? caller.token.tid : null)
    if (!sub || !mine) throw new HttpError(404, 'CONNECTION_NOT_FOUND', '事件流连接不存在，请刷新')
    hub.setField(sub, body.field)
    return { ok: true }
  })

  // 编辑模式保存整份文档
  app.put<{ Params: { id: string } }>('/api/documents/:id', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    if (caller.kind === 'token' && caller.token.mode !== 'edit') throw new HttpError(403, 'MODE_FORBIDDEN', '只有编辑模式能保存整份文档')
    // base、conn 和 PATCH 一样（多人编辑才带）：base 里是编辑器这次改了的字段和可编辑区，其余的以服务端为准
    const body = parse(
      z.object({
        doc: DOC,
        values: z.object({ values: VALUES }).passthrough().optional(),
        version: z.number().int().positive(),
        pageCount: PAGE_COUNT,
        base: z.record(z.string().min(1).max(110), z.number().int().nonnegative()).optional(),
        conn: z.string().uuid().optional(),
      }),
      req.body,
    )
    await deps.hooks?.afterAuth?.(req)
    const saved = await db.transaction(async (tx) => {
      await lockToken(tx, caller)
      // 编辑正文的同时别人可能在填字段：基准版本之后正文没被别人整份保存过就能存，期间别人保存的字段值合并进来（08 第 3 节）
      const row = await lockDocument(tx, id, body.version, !!body.base)
      // 令牌拿到的文档剔除过隐藏值（GET 时按权限清空了）：整份存回去会把隐藏字段的值清掉，拒绝
      if (seesStripped(caller, row.fields)) throw new HttpError(403, 'HIDDEN_FIELDS', '这个令牌有隐藏字段，拿到的文档不全，不能整份保存')
      // 别人拿着编辑锁时不能整份保存（没人拿锁时照旧：不用多人编辑的宿主不受影响）
      const lock = lockOf(row)
      if (lock && !(body.conn && lockFree(row, body.conn, operatorOf(caller)))) throw new HttpError(423, 'LOCKED', `${lock.name}正在编辑，不能保存`, { lock })
      if (body.base) {
        const conflicts = conflictsOf(row, Object.keys(body.base), body.base, body.conn)
        if (conflicts.length) throw new HttpError(409, 'FIELD_CONFLICT', `${conflicts.map((c) => c.by).join('、')}刚改过 ${conflicts.length} 项，这次没有保存`, { conflicts, version: row.version })
      }
      let doc = body.doc as DocData
      let values = (body.values as DocValues | undefined) ?? row.values
      const merged = row.version !== body.version
      if (merged) {
        // 编辑器没改、别人在它的基准版本之后改过的字段和可编辑区：用服务端的
        const later = Object.entries(row.fieldVersions ?? {}).filter(([k, f]) => f.v > body.version && !(k in body.base!)).map(([k]) => k)
        const all = Object.fromEntries(row.fields.map((f) => [f.key, 'editable' as const]))
        // 一个一个写：正文里删掉了的字段写不进去就跳过（值仍在数据 JSON 里）；计算字段跟着来源字段重算
        for (const k of later.filter((k) => !k.startsWith('area:'))) {
          const r = applyFill(doc, values, { [k]: row.values.values[k] ?? null }, row.fields, all)
          if (r.ok) ({ data: doc, values } = r)
        }
        const areaKeys = later.filter((k) => k.startsWith('area:')).map((k) => k.slice(5))
        const current = Object.fromEntries(areaAnchors(row.doc).filter((a) => areaKeys.includes(a.anchor)).map((a) => [a.anchor, areaRuns(a.el.valueList)]))
        for (const [anchor, runs] of Object.entries(current)) {
          const r = applyAreas(doc, { [anchor]: runs })
          if (r.ok) doc = r.data
        }
      }
      // 条件条款按存下的字段值重算显示不显示（宿主自己拼的文档也对）
      doc = applyConditions(doc, values.values)
      const version = row.version + 1
      // 这次改了哪些字段、可编辑区：记版本（别人填写时按它查冲突）
      const before = new Map(areaAnchors(row.doc).map((a) => [a.anchor, JSON.stringify(areaRuns(a.el.valueList))]))
      const areaKeys = areaAnchors(doc).filter((a) => before.get(a.anchor) !== JSON.stringify(areaRuns(a.el.valueList))).map((a) => `area:${a.anchor}`)
      const fieldVersions = bumpFields(row.fieldVersions, [...changedKeys(row.values.values, values.values), ...areaKeys], version, caller, body.conn)
      // 拿着锁的保存顺带续约
      const renew = lock ? { editLockExpires: new Date(Date.now() + LOCK_TTL_MS) } : {}
      await tx
        .update(document)
        .set({ doc, values, version, bodyVersion: version, fieldVersions, pageCount: merged ? null : (body.pageCount ?? null), ...renew, updatedAt: new Date() })
        .where(eq(document.id, id))
      await recordRevision(tx, { documentId: id, version, reason: 'edit', doc, values, operator: operatorOf(caller), operatorName: nameOf(caller) })
      return { version, merged }
    })
    // 别人那边的正文要换成这一版（编辑器收到后重新装文档，08 第 3 节）
    hub.publish(id, 'doc', () => ({ version: saved.version, by: { userId: operatorOf(caller), name: nameOf(caller) } }), body.conn)
    return { id, version: saved.version, ...(saved.merged ? { merged: true } : {}) }
  })

  // 填写模式保存：只提交字段值，服务端按当前权限写进文档
  app.patch<{ Params: { id: string } }>('/api/documents/:id/data', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await callerFor(req, id)
    if (caller.kind === 'token' && caller.token.mode !== 'fill' && caller.token.mode !== 'edit')
      throw new HttpError(403, 'MODE_FORBIDDEN', `${caller.token.mode} 模式不能改字段`)
    // areas：可编辑区（按 anchor），给一段文字或一组带样式的文字；只有模板里标成可编辑区的能改（方案 4.2、4.7），内容由 core 的 applyAreas 校验
    // 多人编辑（08 第 3 节）：base 是每个提交的字段（可编辑区是 area:anchor）客户端看到的版本，带了 base 就按字段合并，
    // 别人在那之后改过的字段整次拒绝（409 FIELD_CONFLICT，带现在的值和改的人）；conn 是发起保存的事件流连接，推送时不推回给它
    const body = parse(
      z.object({
        patch: VALUES,
        areas: z.record(AREA_ANCHOR, AREA_CONTENT).optional(),
        version: z.number().int().positive(),
        pageCount: PAGE_COUNT,
        base: z.record(z.string().min(1).max(110), z.number().int().nonnegative()).optional(),
        conn: z.string().uuid().optional(),
      }),
      req.body,
    )
    await deps.hooks?.afterAuth?.(req)
    const saved = await db.transaction(async (tx) => {
      const locked = await lockToken(tx, caller)
      const row = await lockDocument(tx, id, body.version, !!body.base)
      const merged = row.version !== body.version
      const areaPatch = (body.areas ?? {}) as Record<string, string | AreaRun[]>
      if (body.base) {
        const conflicts = conflictsOf(row, [...Object.keys(body.patch), ...Object.keys(areaPatch).map((a) => `area:${a}`)], body.base, body.conn)
        if (conflicts.length) throw new HttpError(409, 'FIELD_CONFLICT', `${conflicts.map((c) => c.by).join('、')}刚改过 ${conflicts.length} 项，这次没有保存`, { conflicts, version: row.version })
      }
      const perms = locked ?? Object.fromEntries(row.fields.map((f) => [f.key, 'editable' as const]))
      const filled = applyFill(row.doc, row.values, body.patch, row.fields, perms)
      if (!filled.ok) throw new HttpError(filled.code === 'PERMISSION_DENIED' ? 403 : 400, filled.code, filled.error)
      const areas = applyAreas(filled.data, areaPatch)
      if (!areas.ok) throw new HttpError(AREA_STATUS[areas.code], areas.code, areas.error, { area: areas.area })
      const doc = areas.data
      const version = row.version + 1
      const keys = changedKeys(row.values.values, filled.values.values)
      const fieldVersions = bumpFields(row.fieldVersions, [...keys, ...Object.keys(areaPatch).map((a) => `area:${a}`)], version, caller, body.conn)
      // 页数：编辑器保存时带（按打印模式数）；合并了别人的改动、宿主直接改值、看到的文档剔除过隐藏值时数得不对，清空，导出时不核对
      const pageCount = merged || seesStripped(caller, row.fields) ? null : (body.pageCount ?? null)
      await tx.update(document).set({ doc, values: filled.values, version, pageCount, fieldVersions, updatedAt: new Date() }).where(eq(document.id, id))
      const safe = caller.kind === 'token' ? stripHidden(doc, filled.values, row.fields, perms).values : filled.values
      return { response: { id, version, values: safe, ...(merged ? { merged: true } : {}) }, changed: Object.fromEntries(keys.map((k) => [k, filled.values.values[k] ?? null])) }
    })
    publishFields(id, saved.response.version, saved.changed, body.areas, caller, body.conn)
    return saved.response
  })

  // ---------- 出文件（方案 4.9、第 12 节第 1 轮第 3 条；验收 1、15；07 第 2 节加 html、txt）----------
  const MIME = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    html: 'text/html; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
  }
  type FileFormat = keyof typeof MIME
  const FORMAT = z.enum(['pdf', 'docx', 'html', 'txt'])
  const sendFile = (reply: FastifyReply, file: Buffer, format: FileFormat, title: string, headers: Record<string, string | number>) => {
    for (const [k, v] of Object.entries(headers)) reply.header(k, v)
    return reply
      .type(MIME[format])
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${title}.${format}`)}`)
      .send(file)
  }
  /** 渲染结果里取那一种格式的文件 */
  const fileOf = (r: Awaited<ReturnType<RendererClient['render']>>, format: FileFormat): Buffer => {
    const file = format === 'pdf' ? r.pdf : format === 'docx' ? r.docx : format === 'html' ? (r.html === undefined ? undefined : Buffer.from(r.html, 'utf8')) : r.txt === undefined ? undefined : Buffer.from(r.txt, 'utf8')
    if (!file) throw new HttpError(502, 'RENDER_FAILED', '渲染服务没有返回文件')
    return file
  }
  /** PDF、Word 和编辑器保存时的页数核对；HTML、文本不分页，不核对 */
  const paged = (format: FileFormat) => format === 'pdf' || format === 'docx'

  // 下载文档：只用已保存的数据。带 ?version= 时版本对不上 409（宿主要的是「已盖章」那一版时用）。令牌调用时按权限剔除隐藏字段的值
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/documents/:id/export', async (req, reply) => {
    const id = parse(ID, req.params.id)
    const q = parse(z.object({ format: FORMAT.default('pdf'), version: z.coerce.number().int().positive().optional() }), req.query)
    const caller = await callerFor(req, id)
    if (caller.kind === 'token' && !caller.actions.download) throw new HttpError(403, 'ACTION_FORBIDDEN', '这个文档令牌不能下载')
    const [row] = await db.select().from(document).where(eq(document.id, id)).limit(1)
    if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    if (q.version !== undefined && q.version !== row.version) throw new HttpError(409, 'VERSION_CONFLICT', `文档当前是第 ${row.version} 版，不是第 ${q.version} 版`)
    const doc = caller.kind === 'token' ? stripHidden(row.doc, row.values, row.fields, caller.perms).data : row.doc
    const expectedPages = seesStripped(caller, row.fields) || !paged(q.format) ? undefined : (row.pageCount ?? undefined)
    const r = await rendererOf().render({ doc, documentId: id, version: row.version, title: row.title, outputs: [q.format], expectedPages })
    return sendFile(reply, fileOf(r, q.format), q.format, row.title, { 'X-Document-Version': row.version, 'X-Page-Count': r.pageCount })
  })

  // 不建文档，直接用模板版本 + 数据出文件（验收 15）
  app.post('/api/render', async (req, reply) => {
    const caller = await requireHost(req)
    const body = parse(z.object({ templateId: ID, versionNo: z.number().int().positive(), values: VALUES.default({}), title: z.string().max(200).optional(), format: FORMAT.default('pdf') }), req.body)
    await checkTemplateOwner(body.templateId, caller.clientId)
    const [v] = await db.select().from(templateVersion).where(and(eq(templateVersion.templateId, body.templateId), eq(templateVersion.versionNo, body.versionNo))).limit(1)
    if (!v) throw new HttpError(404, 'NOT_FOUND', '模板版本不存在')
    const patch = Object.fromEntries(Object.entries(body.values).filter(([k]) => v.fields.find((f) => f.key === k)?.type !== 'computed'))
    const filled = applyFill(v.doc, { values: {} }, patch, v.fields, Object.fromEntries(v.fields.map((f) => [f.key, 'editable' as const])))
    if (!filled.ok) throw new HttpError(400, filled.code, filled.error)
    const [t] = await db.select().from(template).where(eq(template.id, body.templateId)).limit(1)
    const title = body.title ?? t?.name ?? '未命名'
    const r = await rendererOf().render({ doc: filled.data, title, outputs: [body.format] })
    return sendFile(reply, fileOf(r, body.format), body.format, title, { 'X-Page-Count': r.pageCount })
  })

  // 格式转换（07 第 2 节）：不落库，宿主后端用。docx → 编辑器文档 JSON + 导入报告（to=json），
  // 或 docx / 文档 JSON → pdf、docx、html、txt。docx 和 doc 给且只给一个
  app.post('/api/convert', async (req, reply) => {
    await requireHost(req)
    const body = parse(
      z
        .object({
          docx: z.string().min(1).max(15 * 1024 * 1024).optional(),
          doc: DOC.optional(),
          to: z.enum(['json', 'pdf', 'docx', 'html', 'txt']),
          title: z.string().min(1).max(200).default('文档'),
        })
        .refine((b) => !!b.doc !== !!b.docx, 'docx（base64）和 doc（文档 JSON）要给且只给一个')
        .refine((b) => !(b.doc && b.to === 'json'), '文档 JSON 不用再转成 JSON'),
      req.body,
    )
    let doc = body.doc as DocData | undefined
    if (body.docx) {
      const r = await rendererOf().convert(Buffer.from(body.docx, 'base64'))
      if (body.to === 'json') return { doc: r.doc, report: r.report, pageCount: r.pageCount }
      doc = r.doc
    }
    const format = body.to as FileFormat
    const r = await rendererOf().render({ doc: doc!, title: body.title, outputs: [format] })
    return sendFile(reply, fileOf(r, format), format, body.title, { 'X-Page-Count': r.pageCount })
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
      const r = await db.transaction(async (tx) => {
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
        // 插进来、改过的条款里可能有条件条款：按现在的值重算显示不显示
        data = applyConditions(data, values.values)
        const version = row.version + 1
        const at = new Date()
        // 只有 setData 是改字段；别的操作改了正文（多人编辑时别人要重新装文档）
        const bodyChanged = ops.some((o) => o.op !== 'setData')
        const keys = changedKeys(row.values.values, values.values)
        const fieldVersions = bumpFields(row.fieldVersions, keys, version, caller)
        // 改了正文或字段，编辑器上次数的页数不再可信
        await tx.update(document).set({ doc: data, values, version, pageCount: null, fieldVersions, ...(bodyChanged ? { bodyVersion: version } : {}), updatedAt: at }).where(eq(document.id, id))
        await tx.insert(operationLog).values({ id: newId(), documentId: id, ops, result: { ok: true, version, created }, operator, at })
        // 改了正文的和编辑模式保存一样存一版；只改字段值的不存
        if (bodyChanged) await recordRevision(tx, { documentId: id, version, reason: 'edit', doc: data, values, operator, operatorName: nameOf(caller) })
        const safe = caller.kind === 'token' ? stripHidden(data, values, row.fields, perms).values : values
        return { response: { id, version, created, values: safe }, bodyChanged, changed: Object.fromEntries(keys.map((k) => [k, values.values[k] ?? null])) }
      })
      if (r.bodyChanged) hub.publish(id, 'doc', () => ({ version: r.response.version, by: { userId: operatorOf(caller), name: nameOf(caller) } }))
      else publishFields(id, r.response.version, r.changed, undefined, caller)
      return r.response
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
    const result = await db.transaction(async (tx) => {
      await lockToken(tx, caller)
      const { row } = await lockFor(tx, id, body.version, FROM[body.action])
      // 开始盖章后正文就定了：还有没接受、拒绝的修订时不能开始（盖的是哪一版说不清）
      const pending = body.action === 'start' ? traceChanges(row.doc).length : 0
      if (pending) throw new HttpError(422, 'PENDING_REVISIONS', `还有 ${pending} 处修订没有接受或拒绝，处理完再开始盖章`)
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
      // 离开填写中（开始盖章、作废）正文就不能改了：编辑锁一起放掉
      const unlock = status !== 'filling' ? clearLock : {}
      await tx.update(document).set({ status, doc, version, lockedAt, ...unlock, updatedAt: at }).where(eq(document.id, id))
      await tx.insert(operationLog).values({ id: newId(), documentId: id, ops: body, result: { ok: true, from: row.status, to: status, version, voided }, operator, at })
      await recordRevision(tx, { documentId: id, version, reason: body.action, doc, values: row.values, operator, operatorName: nameOf(caller) })
      return { id, version, status, voided }
    })
    // 状态变了（开始盖章、提交、驳回、作废）：打开着的人都要知道，编辑、填写的要变只读；编辑锁已经放掉
    hub.publish(id, 'status', () => ({ status: result.status, version: result.version, by: { userId: operatorOf(caller), name: nameOf(caller) } }))
    if (result.status !== 'filling') publishLock(id, null)
    return result
  })

  app.post('/api/tokens', async (req) => {
    await requireHost(req)
    const body = parse(
      z.object({
        documentId: ID,
        mode: MODE,
        userId: z.string().min(1).max(100),
        // 显示用的名字（在场、批注、编辑锁），不给就显示 userId
        userName: z.string().min(1).max(100).optional(),
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
      await tx.insert(docToken).values({ id: tid, documentId: body.documentId, mode: body.mode, userId: body.userId, userName: body.userName ?? null, canPrint, canDownload, expiresAt })
      const rows = Object.entries(body.permissions).map(([fieldKey, permission]) => ({ tokenId: tid, fieldKey, permission }))
      if (rows.length) await tx.insert(tokenPermission).values(rows)
    })
    const token = signToken(config.TOKEN_SECRET, { tid, did: body.documentId, mode: body.mode, uid: body.userId, ...(body.userName ? { un: body.userName } : {}), exp: expiresAt.getTime() })
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
    // 事件流按旧权限推字段值：断开，重连时按新权限
    hub.closeToken(id)
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
    hub.closeToken(id)
    return { id, revoked: true }
  })

  return app
}
