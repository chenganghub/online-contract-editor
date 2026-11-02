import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, eq, max } from 'drizzle-orm'
import { z } from 'zod'
import type { DocData, FieldDef } from '@oe/core'
import type { Config } from './config'
import type { Db } from './db/client'
import { fieldLibrary, template, templateDraft, templateEditToken, templateVersion } from './db/schema'
import { HttpError } from './errors'
import { signToken, verifyToken } from './tokens'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Access = { clientId: string } | { tokenId: string }
const ID = z.string().uuid()
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, 'BAD_REQUEST', result.error.issues.map((i) => `${i.path.join('.')}：${i.message}`).join('；'))
  return result.data
}

export function registerTemplateDrafts(app: FastifyInstance, deps: {
  db: Db
  config: Config
  requireHost: (req: FastifyRequest) => Promise<{ clientId: string }>
  docSchema: z.ZodType<DocData>
  fieldsSchema: z.ZodType<FieldDef[]>
}) {
  const { db, config, requireHost } = deps
  const content = z.object({ doc: deps.docSchema, fields: deps.fieldsSchema })
  const saved = content.extend({ version: z.number().int().positive() })

  async function access(req: FastifyRequest, id: string): Promise<Access> {
    const raw = req.headers['x-template-token']
    if (typeof raw !== 'string' || !raw) return requireHost(req)
    const token = verifyToken(config.TOKEN_SECRET, raw)
    if (token === 'invalid' || token === 'expired') throw new HttpError(401, 'TOKEN_INVALID', '模板令牌无效或已过期')
    if (token.scope !== 'template' || token.did !== id) throw new HttpError(403, 'TOKEN_SCOPE', '令牌不属于这个模板草稿')
    return { tokenId: token.tid }
  }

  // 写操作在事务里重新锁定令牌，吊销和保存不会交错。
  async function draftFor(q: Db | Tx, id: string, caller: Access, lock = false) {
    if ('tokenId' in caller) {
      const query = q.select().from(templateEditToken).where(eq(templateEditToken.id, caller.tokenId))
      const [token] = await (lock ? query.for('update') : query)
      if (!token || token.revokedAt || token.expiresAt.getTime() <= Date.now()) throw new HttpError(401, 'TOKEN_REVOKED', '模板令牌已失效')
      if (token.templateId !== id) throw new HttpError(403, 'TOKEN_SCOPE', '令牌不属于这个模板草稿')
    }
    const query = q.select().from(templateDraft).where(eq(templateDraft.templateId, id))
    const [draft] = await (lock ? query.for('update') : query)
    if (!draft) throw new HttpError(404, 'NOT_FOUND', '模板草稿不存在')
    if ('clientId' in caller && caller.clientId !== draft.clientId) throw new HttpError(403, 'TEMPLATE_FORBIDDEN', '不能访问其他宿主的模板草稿')
    return draft
  }

  app.post('/api/templates/drafts', async (req) => {
    const host = await requireHost(req)
    const body = parse(content.extend({ name: z.string().min(1).max(200), createdBy: z.string().min(1).max(100) }), req.body)
    const id = crypto.randomUUID()
    await db.transaction(async (tx) => {
      await tx.insert(template).values({ id, name: body.name, createdBy: body.createdBy })
      await tx.insert(templateDraft).values({ templateId: id, clientId: host.clientId, doc: body.doc, fields: body.fields })
    })
    return { id, version: 1 }
  })

  app.get<{ Params: { id: string } }>('/api/templates/:id/draft', async (req) => {
    const id = parse(ID, req.params.id)
    const draft = await draftFor(db, id, await access(req, id))
    const [t] = await db.select().from(template).where(eq(template.id, id))
    const [library] = await db.select().from(fieldLibrary).where(eq(fieldLibrary.clientId, draft.clientId))
    return { id, title: t!.name, version: draft.version, doc: draft.doc, fields: draft.fields, libraryFields: library?.fields ?? [] }
  })

  app.put<{ Params: { id: string } }>('/api/templates/:id/draft', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await access(req, id)
    const body = parse(saved, req.body)
    return db.transaction(async (tx) => {
      const draft = await draftFor(tx, id, caller, true)
      if (draft.version !== body.version) throw new HttpError(409, 'VERSION_CONFLICT', '模板草稿已更新，请刷新后重试')
      const version = draft.version + 1
      await tx.update(templateDraft).set({ doc: body.doc, fields: body.fields, version }).where(eq(templateDraft.templateId, id))
      return { id, version }
    })
  })

  app.post<{ Params: { id: string } }>('/api/templates/:id/draft/publish', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await access(req, id)
    const body = parse(z.object({ version: z.number().int().positive() }), req.body)
    return db.transaction(async (tx) => {
      const draft = await draftFor(tx, id, caller, true)
      if (draft.version !== body.version) throw new HttpError(409, 'VERSION_CONFLICT', '模板草稿已更新，请刷新后重试')
      // 和旧版发布接口使用同一把模板行锁，版本号不会重复。
      await tx.select().from(template).where(eq(template.id, id)).for('update')
      const [last] = await tx.select({ no: max(templateVersion.versionNo) }).from(templateVersion).where(eq(templateVersion.templateId, id))
      const versionNo = (last?.no ?? 0) + 1
      await tx.insert(templateVersion).values({ id: crypto.randomUUID(), templateId: id, versionNo, doc: draft.doc, fields: draft.fields })
      const version = draft.version + 1
      await tx.update(templateDraft).set({ version }).where(eq(templateDraft.templateId, id))
      return { id, version, versionNo }
    })
  })

  app.post<{ Params: { id: string } }>('/api/templates/:id/edit-tokens', async (req) => {
    const id = parse(ID, req.params.id)
    await draftFor(db, id, await requireHost(req))
    const body = parse(z.object({ userId: z.string().min(1).max(100), ttlSeconds: z.number().int().min(1).max(86400).default(config.TOKEN_TTL_SECONDS) }), req.body)
    const tid = crypto.randomUUID()
    const exp = Date.now() + body.ttlSeconds * 1000
    await db.insert(templateEditToken).values({ id: tid, templateId: id, userId: body.userId, expiresAt: new Date(exp) })
    return { id: tid, token: signToken(config.TOKEN_SECRET, { scope: 'template', tid, did: id, mode: 'edit', uid: body.userId, exp }), expiresAt: new Date(exp).toISOString() }
  })

  app.delete<{ Params: { id: string; tokenId: string } }>('/api/templates/:id/edit-tokens/:tokenId', async (req) => {
    const id = parse(ID, req.params.id)
    await draftFor(db, id, await requireHost(req))
    const tokenId = parse(ID, req.params.tokenId)
    await db.update(templateEditToken).set({ revokedAt: new Date() }).where(and(eq(templateEditToken.id, tokenId), eq(templateEditToken.templateId, id)))
    return { ok: true }
  })

  // 旧的模板版本接口也不能绕过新草稿的宿主归属。
  return async (id: string, clientId: string) => {
    const [draft] = await db.select({ clientId: templateDraft.clientId }).from(templateDraft).where(eq(templateDraft.templateId, id))
    if (draft && draft.clientId !== clientId) throw new HttpError(403, 'TEMPLATE_FORBIDDEN', '不能访问其他宿主的模板')
  }
}
