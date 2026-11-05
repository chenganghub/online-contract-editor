// 批注（docs/设计/08 第 3 节）：单独存，不进文档 JSON、不进导出。按引用的原文和第几处定位，原文改了编辑器提示「原文已修改」。
// 编辑、填写、只读的人能加、回复、解决；改、删只有自己的（宿主都能）；作废的文档不能再改批注。改了推 comments，打开着的人重新取
import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, asc, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import type { Mode } from '@oe/core'
import type { Db } from './db/client'
import { comment, document } from './db/schema'
import { HttpError } from './errors'
import type { Hub } from './realtime'

/** 调用方：宿主（mode 为 null，什么都能做）或者文档令牌的模式 */
export interface CommentCaller {
  userId: string
  name: string
  mode: Mode | null
}

const ID = z.string().uuid()
const parse = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v)
  if (!r.success) throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || '入参'}：${i.message}`).join('；'))
  return r.data
}
const view = (c: typeof comment.$inferSelect) => ({
  id: c.id,
  parentId: c.parentId,
  quote: c.quote,
  occurrence: c.occurrence,
  body: c.body,
  authorId: c.authorId,
  authorName: c.authorName,
  resolved: c.resolved,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
})

export function registerComments(app: FastifyInstance, deps: { db: Db; hub: Hub; who: (req: FastifyRequest, documentId: string) => Promise<CommentCaller> }) {
  const { db, hub, who } = deps
  const publish = (id: string, c: CommentCaller, conn?: string) => hub.publish(id, 'comments', () => ({ by: { userId: c.userId, name: c.name } }), conn)
  /** 能写批注：盖章模式不能（只盖章）；作废的文档不能 */
  async function writable(id: string, c: CommentCaller) {
    if (c.mode === 'seal') throw new HttpError(403, 'MODE_FORBIDDEN', '盖章模式不能加批注')
    const [d] = await db.select({ status: document.status }).from(document).where(eq(document.id, id)).limit(1)
    if (!d) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    if (d.status === 'void') throw new HttpError(422, 'INVALID_STATUS', '文档已作废，不能改批注')
  }
  async function own(id: string, cid: string, c: CommentCaller, author: boolean) {
    const [row] = await db.select().from(comment).where(and(eq(comment.id, cid), eq(comment.documentId, id))).limit(1)
    if (!row) throw new HttpError(404, 'NOT_FOUND', '批注不存在')
    if (author && c.mode !== null && row.authorId !== c.userId) throw new HttpError(403, 'NOT_AUTHOR', '只能改、删自己的批注')
    return row
  }

  app.get<{ Params: { id: string } }>('/api/documents/:id/comments', async (req) => {
    const id = parse(ID, req.params.id)
    await who(req, id)
    const rows = await db.select().from(comment).where(eq(comment.documentId, id)).orderBy(asc(comment.createdAt))
    return { comments: rows.map(view) }
  })

  app.post<{ Params: { id: string } }>('/api/documents/:id/comments', async (req) => {
    const id = parse(ID, req.params.id)
    const c = await who(req, id)
    const body = parse(
      z.object({
        body: z.string().trim().min(1).max(2000),
        quote: z.string().min(1).max(500).optional(),
        occurrence: z.number().int().min(0).max(100000).optional(),
        parentId: ID.optional(),
        conn: z.string().uuid().optional(),
      }),
      req.body,
    )
    await writable(id, c)
    // 回复挂在最上面那条下面（不嵌套），回复不带引用
    let parentId: string | null = null
    if (body.parentId) {
      const parent = await own(id, body.parentId, c, false)
      parentId = parent.parentId ?? parent.id
    }
    const at = new Date()
    const row = {
      id: crypto.randomUUID(),
      documentId: id,
      parentId,
      quote: parentId ? null : (body.quote ?? null),
      occurrence: parentId || body.quote === undefined ? null : (body.occurrence ?? 0),
      body: body.body,
      authorId: c.userId,
      authorName: c.name,
      resolved: false,
      createdAt: at,
      updatedAt: at,
    }
    await db.insert(comment).values(row)
    publish(id, c, body.conn)
    return view(row)
  })

  // resolved：解决、重新打开（只对最上面那条；谁都能）；body：改内容（只能改自己的）
  app.patch<{ Params: { id: string; cid: string } }>('/api/documents/:id/comments/:cid', async (req) => {
    const id = parse(ID, req.params.id)
    const cid = parse(ID, req.params.cid)
    const c = await who(req, id)
    const body = parse(z.object({ resolved: z.boolean().optional(), body: z.string().trim().min(1).max(2000).optional(), conn: z.string().uuid().optional() }), req.body)
    await writable(id, c)
    const row = await own(id, cid, c, body.body !== undefined)
    if (body.resolved !== undefined && row.parentId) throw new HttpError(400, 'BAD_REQUEST', '回复不能单独解决，解决最上面那条')
    await db
      .update(comment)
      .set({ ...(body.resolved !== undefined ? { resolved: body.resolved } : {}), ...(body.body !== undefined ? { body: body.body } : {}), updatedAt: new Date() })
      .where(eq(comment.id, cid))
    publish(id, c, body.conn)
    return { id: cid }
  })

  // 删：只能删自己的；删最上面那条时回复一起删
  app.delete<{ Params: { id: string; cid: string }; Querystring: Record<string, string> }>('/api/documents/:id/comments/:cid', async (req) => {
    const id = parse(ID, req.params.id)
    const cid = parse(ID, req.params.cid)
    const conn = parse(z.object({ conn: z.string().uuid().optional() }), req.query).conn
    const c = await who(req, id)
    await writable(id, c)
    await own(id, cid, c, true)
    await db.delete(comment).where(and(eq(comment.documentId, id), or(eq(comment.id, cid), eq(comment.parentId, cid))))
    publish(id, c, conn)
    return { id: cid, deleted: true }
  })
}
