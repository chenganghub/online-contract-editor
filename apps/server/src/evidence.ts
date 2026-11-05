// 签署证据链（docs/设计/08 第 5 节，t12）：签署过程每一步一条，记谁、什么时候、IP、设备、当时的文档哈希和细节。
// 每条的 hash = SHA-256(上一条的 hash + 这一条内容的规范 JSON)，第一条的上一条是 64 个 0：改了、删了、插了哪一条，往后的都对不上。
// 规范 JSON：对象的键按码点排序（MySQL 的 JSON 列取出来键的顺序会变，排过序算出来才一样）
import crypto from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { DocData, DocValues } from '@oe/core'
import type { Db } from './db/client'
import { signEvidence } from './db/schema'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export const ZERO_HASH = '0'.repeat(64)
export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex')
/** 键排好序的 JSON */
export const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  )
/** 文档哈希：正文 JSON 和字段值一起 */
export const docHashOf = (doc: DocData, values: DocValues) => sha256(canonical({ doc, values }))

/** 签署过程里的一步 */
export type EvidenceAction = 'signers' | 'start' | 'view' | 'intent' | 'sign' | 'reject' | 'revoke' | 'void' | 'complete'
export interface EvidenceInput {
  documentId: string
  action: EvidenceAction
  signerKey: string | null
  operator: string
  operatorName: string
  ip: string | null
  userAgent: string | null
  docHash: string
  detail: Record<string, unknown>
  at: Date
}
type Row = typeof signEvidence.$inferSelect
/** 一条参与哈希的内容（时间用 ISO 字符串，毫秒精度，和库里的 datetime(3) 一样） */
const content = (e: Omit<Row, 'id' | 'documentId' | 'prevHash' | 'hash'>) => ({
  seq: e.seq,
  action: e.action,
  signerKey: e.signerKey,
  operator: e.operator,
  operatorName: e.operatorName,
  ip: e.ip,
  userAgent: e.userAgent,
  docHash: e.docHash,
  detail: e.detail,
  at: e.at.toISOString(),
})

/** 追加一条。要在锁住文档行（select … for update）的事务里调，同一文档的证据按顺序写 */
export async function appendEvidence(tx: Tx, e: EvidenceInput) {
  const [last] = await tx.select({ seq: signEvidence.seq, hash: signEvidence.hash }).from(signEvidence).where(eq(signEvidence.documentId, e.documentId)).orderBy(desc(signEvidence.seq)).limit(1)
  const seq = (last?.seq ?? 0) + 1
  const prevHash = last?.hash ?? ZERO_HASH
  const at = new Date(Math.floor(e.at.getTime()))
  const row = { seq, action: e.action, signerKey: e.signerKey, operator: e.operator, operatorName: e.operatorName, ip: e.ip, userAgent: e.userAgent, docHash: e.docHash, detail: e.detail, at }
  const hash = sha256(prevHash + canonical(content(row)))
  await tx.insert(signEvidence).values({ id: crypto.randomUUID(), documentId: e.documentId, ...row, prevHash, hash })
  return hash
}

/** 按顺序取出一个文档的证据，重算哈希链：哪一条对不上（被改、被删）就是 broken 的那一条 */
export async function evidenceOf(q: Db | Tx, documentId: string) {
  const rows = await q.select().from(signEvidence).where(eq(signEvidence.documentId, documentId)).orderBy(signEvidence.seq)
  let prev = ZERO_HASH
  let broken: number | null = null
  for (const [i, r] of rows.entries()) {
    const ok = r.seq === i + 1 && r.prevHash === prev && r.hash === sha256(prev + canonical(content(r)))
    if (!ok && broken === null) broken = r.seq
    prev = r.hash
  }
  return { rows, valid: broken === null, broken, head: rows.at(-1)?.hash ?? null }
}
