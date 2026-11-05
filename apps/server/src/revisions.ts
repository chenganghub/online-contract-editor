// 版本历史（docs/设计/08 第 3 节「版本对比」）：建文档、编辑模式整份保存、批量操作改了正文、状态变化时存一份快照。
// 同一个人连着编辑（离上一份不到 10 分钟）只留最后一份，换了人、停了 10 分钟以上、状态变了才开新的一版；填写保存不存（字段值在下一份快照里）。
// 宿主和编辑、填写、只读令牌能看（盖章的不用看）；令牌看到的快照按它现在的权限剔除隐藏字段的值，和打开文档时一样
import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { stripHidden, type DocData, type DocValues, type Mode, type Permission } from '@oe/core'
import type { Db } from './db/client'
import { document, documentRevision } from './db/schema'
import { HttpError } from './errors'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** create：建文档；edit：编辑；start、submit、reject、void：开始盖章、提交盖章、驳回、作废；sign：一个签署方签了（t12） */
export type RevisionReason = 'create' | 'edit' | 'start' | 'submit' | 'reject' | 'void' | 'sign'
/** 同一个人两次保存隔多久以内合成一版 */
const MERGE_MS = 10 * 60_000
/** 列表最多给多少版（新的在前） */
const LIST_LIMIT = 200

/** 在改文档的同一个事务里调用（文档行已锁住，同一文档的快照按顺序写） */
export async function recordRevision(
  tx: Tx,
  r: { documentId: string; version: number; reason: RevisionReason; doc: DocData; values: DocValues; operator: string; operatorName: string },
) {
  const at = new Date()
  if (r.reason === 'edit') {
    const [last] = await tx
      .select({ id: documentRevision.id, reason: documentRevision.reason, operator: documentRevision.operator, at: documentRevision.at })
      .from(documentRevision)
      .where(eq(documentRevision.documentId, r.documentId))
      .orderBy(desc(documentRevision.version))
      .limit(1)
    if (last && last.reason === 'edit' && last.operator === r.operator && at.getTime() - last.at.getTime() < MERGE_MS) {
      await tx.update(documentRevision).set({ version: r.version, doc: r.doc, values: r.values, operatorName: r.operatorName, at }).where(eq(documentRevision.id, last.id))
      return
    }
  }
  await tx.insert(documentRevision).values({ id: crypto.randomUUID(), ...r, at })
}

/** 调用方：宿主（mode、perms 都是 null）或文档令牌的模式和字段权限 */
export interface RevisionCaller {
  mode: Mode | null
  perms: Record<string, Permission> | null
}

const ID = z.string().uuid()
const parse = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v)
  if (!r.success) throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || '入参'}：${i.message}`).join('；'))
  return r.data
}

export function registerRevisions(app: FastifyInstance, deps: { db: Db; who: (req: FastifyRequest, documentId: string) => Promise<RevisionCaller> }) {
  const { db, who } = deps
  const allowed = async (req: FastifyRequest, id: string) => {
    const c = await who(req, id)
    if (c.mode === 'seal') throw new HttpError(403, 'MODE_FORBIDDEN', '盖章模式不能看版本历史')
    return c
  }

  // 版本列表（新的在前）：版本号、为什么存的、谁、什么时候。不带文档内容
  app.get<{ Params: { id: string } }>('/api/documents/:id/revisions', async (req) => {
    const id = parse(ID, req.params.id)
    await allowed(req, id)
    const rows = await db
      .select({ version: documentRevision.version, reason: documentRevision.reason, operatorName: documentRevision.operatorName, at: documentRevision.at })
      .from(documentRevision)
      .where(eq(documentRevision.documentId, id))
      .orderBy(desc(documentRevision.version))
      .limit(LIST_LIMIT)
    return { revisions: rows }
  })

  // 一版的内容（版本对比用）
  app.get<{ Params: { id: string; version: string } }>('/api/documents/:id/revisions/:version', async (req) => {
    const id = parse(ID, req.params.id)
    const version = parse(z.coerce.number().int().positive(), req.params.version)
    const c = await allowed(req, id)
    const [row] = await db
      .select()
      .from(documentRevision)
      .where(and(eq(documentRevision.documentId, id), eq(documentRevision.version, version)))
      .limit(1)
    if (!row) throw new HttpError(404, 'NOT_FOUND', `没有第 ${version} 版`)
    const head = { version: row.version, reason: row.reason, operatorName: row.operatorName, at: row.at }
    if (!c.perms) return { ...head, doc: row.doc, values: row.values }
    const [d] = await db.select({ fields: document.fields }).from(document).where(eq(document.id, id)).limit(1)
    if (!d) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    const safe = stripHidden(row.doc, row.values, d.fields, c.perms)
    return { ...head, doc: safe.data, values: safe.values }
  })
}
