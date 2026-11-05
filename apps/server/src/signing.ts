// 签署闭环（docs/设计/08 第 5 节，t12）：签署方和顺序、按签署方签（手写签名填进签名区，签署日期由服务端按服务器时间写）、
// 意愿认证凭据、拒签、证据链（evidence.ts）、全部签完出带数字签名的最终 PDF（pdf-sign.ts）、签署报告、验签。
// 文档状态沿用盖章的：填写中 → 盖章中（签署中）→ 已盖章（已签署）。设了签署方的文档不能直接「提交盖章」，要每个签署方签完；
// 没设签署方的文档照旧（盖章模式放章、提交）。路由在 signing-routes.ts
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyRequest } from 'fastify'
import { and, asc, eq } from 'drizzle-orm'
import { applyBatch, setFieldValues, SIGNER_ROLES, type DocData, type DocValues, type FieldDef, type FieldValue, type Op } from '@oe/core'
import type { Caller } from './app'
import type { Config } from './config'
import type { Db } from './db/client'
import { document, sealRecord, signEvidence, signedFile, signer } from './db/schema'
import { HttpError } from './errors'
import { appendEvidence, docHashOf, type EvidenceAction } from './evidence'
import { p12PdfSigner, testPdfSigner, type PdfSigner } from './pdf-sign'
import type { RendererClient } from './renderer'
import type { FileStore } from './storage'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type DocRow = typeof document.$inferSelect
export type SignerRow = typeof signer.$inferSelect

export interface SigningDeps {
  db: Db
  config: Config
  store: FileStore
  renderer: () => RendererClient
  /** 最终 PDF 的签名接口；不给就按配置（SIGN_P12_PATH，没有就用测试证书） */
  pdfSigner?: PdfSigner
  operatorOf: (c: Caller) => string
  nameOf: (c: Caller) => string
}

export const roleName = (key: string) => SIGNER_ROLES.find((r) => r.key === key)?.label ?? key
const newId = () => crypto.randomUUID()

/** 签署方，按顺序 */
export const signersOf = (q: Db | Tx, documentId: string) => q.select().from(signer).where(eq(signer.documentId, documentId)).orderBy(asc(signer.orderNo), asc(signer.key))
/** 现在轮到的：还没签的里顺序最小的那一批（顺序一样的同时签） */
export function turnOf(list: SignerRow[]): SignerRow[] {
  const waiting = list.filter((s) => s.status === 'waiting')
  const first = Math.min(...waiting.map((s) => s.orderNo))
  return waiting.filter((s) => s.orderNo === first)
}
/** 签名区、签署日期绑定的签署方都要有人签，不然签不完 */
export function checkCoverage(fields: FieldDef[], keys: Set<string>) {
  const missing = fields.find((f) => (f.type === 'signature' || f.type === 'signDate') && f.signer && !keys.has(f.signer))
  if (missing) throw new HttpError(400, 'SIGNER_MISSING', `「${missing.label}」绑定的${roleName(missing.signer!)}没有设签署方`)
}
/** 签署方给外面看的样子：宿主看得到绑定的用户和意愿认证凭据号，令牌只看得到方式 */
export const signerView = (s: SignerRow, host: boolean) => ({
  key: s.key,
  role: roleName(s.key),
  name: s.name,
  kind: s.kind,
  order: s.orderNo,
  intentRequired: s.intentRequired,
  status: s.status,
  signedAt: s.signedAt,
  intentMethod: s.intentMethod,
  rejectReason: s.rejectReason,
  ...(host ? { userId: s.userId, intentProof: s.intentProof } : {}),
})

/** 签署日期的写法：按字段的日期格式（yyyy年MM月dd日、yyyy-MM-dd，可带 HH:mm:ss），按配置的时区 */
export function formatDate(at: Date, format: string | undefined, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  return (format ?? 'yyyy年MM月dd日').replace('yyyy', parts.year!).replace('MM', parts.month!).replace('dd', parts.day!).replace('HH', parts.hour!).replace('mm', parts.minute!).replace('ss', parts.second!)
}

/** 证据里的调用方：谁、IP、设备 */
export function whoOf(deps: SigningDeps, req: FastifyRequest, caller: Caller) {
  const ua = req.headers['user-agent']
  return { operator: deps.operatorOf(caller), operatorName: deps.nameOf(caller), ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null }
}
export async function evidence(deps: SigningDeps, tx: Tx, req: FastifyRequest | null, caller: Caller | null, e: { documentId: string; action: EvidenceAction; signerKey?: string | null; doc: DocData; values: DocValues; detail?: Record<string, unknown>; at: Date }) {
  const who = req && caller ? whoOf(deps, req, caller) : { operator: 'system', operatorName: '系统', ip: null, userAgent: null }
  return appendEvidence(tx, { documentId: e.documentId, action: e.action, signerKey: e.signerKey ?? null, ...who, docHash: docHashOf(e.doc, e.values), detail: e.detail ?? {}, at: e.at })
}

/** 清掉签名区、签署日期（拒签、撤回后退回填写）：签名区换回占位图，签署日期清空 */
export function clearSigning(doc: DocData, values: DocValues, fields: FieldDef[]): { doc: DocData; values: DocValues } {
  const keys = fields.filter((f) => f.type === 'signature' || f.type === 'signDate').map((f) => f.key)
  if (!keys.length) return { doc, values }
  const next = structuredClone(doc)
  const cleared: Record<string, FieldValue> = Object.fromEntries(keys.map((k) => [k, null]))
  const written = setFieldValues(next as unknown as Parameters<typeof setFieldValues>[0], cleared, fields, values.values)
  return { doc: next, values: { ...values, values: { ...values.values, ...written } } }
}
/** 去掉文档里所有有效的章，盖章记录作废 */
export async function voidSeals(tx: Tx, documentId: string, doc: DocData, fields: FieldDef[], operator: string, at: Date) {
  const seals = await tx.select({ id: sealRecord.id }).from(sealRecord).where(and(eq(sealRecord.documentId, documentId), eq(sealRecord.status, 'valid')))
  if (!seals.length) return doc
  const r = applyBatch(doc, seals.map((s) => ({ op: 'removeSeal', id: s.id }) as Op), { fields })
  if (!r.ok) throw new HttpError(500, 'INTERNAL', `移除印章失败：${r.error}`)
  await tx.update(sealRecord).set({ status: 'void', operator, at }).where(and(eq(sealRecord.documentId, documentId), eq(sealRecord.status, 'valid')))
  return r.data
}

/** 签名证书：第一次用时准备（读 PKCS#12，或生成测试证书） */
export function pdfSignerOf(deps: SigningDeps): () => Promise<PdfSigner> {
  let pending: Promise<PdfSigner> | null = null
  return () =>
    (pending ??= deps.pdfSigner
      ? Promise.resolve(deps.pdfSigner)
      : deps.config.SIGN_P12_PATH
        ? fs.readFile(deps.config.SIGN_P12_PATH).then((p12) => p12PdfSigner(p12, deps.config.SIGN_P12_PASSWORD))
        : testPdfSigner(path.join(deps.config.STORAGE_DIR, 'signing')))
}

/**
 * 出最终文件：签完的那一版渲染成 PDF、做数字签名、存进文件存储，记一条 complete 证据（带文件哈希和证书）。
 * 已经出过就直接返回。渲染要几秒，不放在签署的事务里；渲染期间文档又变了（作废）就不存
 */
export async function finalize(deps: SigningDeps, signerOf: () => Promise<PdfSigner>, documentId: string) {
  const { db } = deps
  const [row] = await db.select().from(document).where(eq(document.id, documentId)).limit(1)
  if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
  if (row.status !== 'sealed') throw new HttpError(422, 'INVALID_STATUS', '还没签完，没有最终文件')
  const [have] = await db.select().from(signedFile).where(and(eq(signedFile.documentId, documentId), eq(signedFile.version, row.version))).limit(1)
  if (have) return have
  const list = await signersOf(db, documentId)
  if (!list.length) throw new HttpError(422, 'NO_SIGNERS', '这份文档没有设签署方，不出带数字签名的最终文件')
  const r = await deps.renderer().render({ doc: row.doc, documentId, version: row.version, title: row.title, outputs: ['pdf'] })
  if (!r.pdf) throw new HttpError(502, 'RENDER_FAILED', '渲染服务没有返回 PDF')
  const pdfSigner = await signerOf()
  const at = new Date()
  const signed = await pdfSigner.sign(r.pdf, { reason: `签署完成：${list.map((s) => `${roleName(s.key)} ${s.name}`).join('、')}`, location: '在线合同编辑器', contactInfo: '', signingTime: at })
  const stored = await deps.store.put(signed)
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(document).where(eq(document.id, documentId)).for('update')
    if (!locked || locked.status !== 'sealed' || locked.version !== row.version) throw new HttpError(409, 'VERSION_CONFLICT', '出最终文件的时候文档变了')
    const [dup] = await tx.select().from(signedFile).where(and(eq(signedFile.documentId, documentId), eq(signedFile.version, row.version))).limit(1)
    if (dup) return dup
    const rec = { id: newId(), documentId, version: row.version, sha256: stored.sha256, size: stored.size, pageCount: r.pageCount, certSubject: pdfSigner.cert.subject, certSerial: pdfSigner.cert.serial, testCert: pdfSigner.cert.test, at }
    await tx.insert(signedFile).values(rec)
    await evidence(deps, tx, null, null, { documentId, action: 'complete', doc: row.doc, values: row.values, detail: { file: stored.sha256, size: stored.size, pageCount: r.pageCount, cert: { subject: pdfSigner.cert.subject, serial: pdfSigner.cert.serial, test: pdfSigner.cert.test } }, at })
    return rec
  })
}

// ---------- 给 app.ts 里已有接口用的 ----------

/**
 * 盖章状态变化（POST /seal-status 的事务里调）：设了签署方的文档开始签署时查签署方、截止时间，记证据；
 * 宿主撤回（reject）时清掉签名、签署日期，签署方回到待签；签完的不能撤回；不能直接提交（要按签署方签）。没设签署方的原样返回
 */
export async function onSealStatus(
  deps: SigningDeps,
  tx: Tx,
  req: FastifyRequest,
  caller: Caller,
  e: { row: DocRow; action: 'start' | 'submit' | 'reject' | 'void'; reason?: string; doc: DocData; values: DocValues; at: Date },
): Promise<{ doc: DocData; values: DocValues }> {
  const list = await signersOf(tx, e.row.id)
  if (!list.length) return { doc: e.doc, values: e.values }
  const base = { documentId: e.row.id, at: e.at }
  if (e.action === 'submit') throw new HttpError(422, 'USE_SIGNING', '这份文档设了签署方，要每个签署方签完，不能直接提交')
  if (e.action === 'start') {
    checkCoverage(e.row.fields, new Set(list.map((s) => s.key)))
    if (e.row.signDeadline && e.row.signDeadline.getTime() <= e.at.getTime()) throw new HttpError(422, 'SIGN_EXPIRED', '已过签署截止时间，改了截止时间再开始')
    await tx.update(signer).set({ status: 'waiting', signedAt: null, intentMethod: null, intentProof: null, rejectReason: null }).where(eq(signer.documentId, e.row.id))
    await evidence(deps, tx, req, caller, { ...base, action: 'start', doc: e.doc, values: e.values, detail: { signers: list.map((s) => ({ key: s.key, name: s.name, order: s.orderNo })) } })
    return { doc: e.doc, values: e.values }
  }
  if (e.action === 'reject') {
    if (e.row.status === 'sealed') throw new HttpError(422, 'SIGNED_FINAL', '已经签署完成，不能退回，只能作废')
    const cleared = clearSigning(e.doc, e.values, e.row.fields)
    await tx.update(signer).set({ status: 'waiting', signedAt: null, intentMethod: null, intentProof: null }).where(eq(signer.documentId, e.row.id))
    await evidence(deps, tx, req, caller, { ...base, action: 'revoke', doc: cleared.doc, values: cleared.values, detail: e.reason ? { reason: e.reason } : {} })
    return cleared
  }
  await evidence(deps, tx, req, caller, { ...base, action: 'void', doc: e.doc, values: e.values, detail: e.reason ? { reason: e.reason } : {} })
  return { doc: e.doc, values: e.values }
}

/**
 * 放章、移章、删章（POST /seals 的事务里调）：设了签署方的文档要用签署令牌，轮到了才能放，只能移、删自己的章，签完就不能动；
 * 返回记在盖章记录上的签署方（宿主放的、没设签署方的是 null）
 */
export async function sealSigner(tx: Tx, caller: Caller, documentId: string, action: 'place' | 'move' | 'remove', owner: string | null): Promise<string | null> {
  const list = await signersOf(tx, documentId)
  if (!list.length || caller.kind === 'host') return action === 'place' ? null : owner
  const key = caller.token.sg
  if (!key) throw new HttpError(403, 'NOT_SIGNER', '这份文档设了签署方，要用签署令牌盖章')
  const me = list.find((s) => s.key === key)
  if (!me) throw new HttpError(404, 'SIGNER_NOT_FOUND', `没有签署方 ${key}`)
  if (me.status !== 'waiting') throw new HttpError(409, 'ALREADY_SIGNED', '已经签过了，章不能再动')
  const turn = turnOf(list)
  if (!turn.some((s) => s.key === key)) throw new HttpError(422, 'NOT_YOUR_TURN', `还没轮到你：先等${turn.map((s) => `${roleName(s.key)}（${s.name}）`).join('、')}签`)
  if (action !== 'place' && owner !== key) throw new HttpError(403, 'NOT_YOUR_SEAL', '只能移、删自己盖的章')
  return key
}

/** 签发签署令牌（POST /tokens）：只有盖章模式能绑；签署方要已经设了，令牌的用户要是签署方绑定的那个人 */
export async function checkTokenSigner(db: Db, documentId: string, mode: string, userId: string, key: string) {
  if (mode !== 'seal') throw new HttpError(400, 'BAD_REQUEST', '只有盖章模式的令牌能绑签署方')
  const [s] = await db.select().from(signer).where(and(eq(signer.documentId, documentId), eq(signer.key, key))).limit(1)
  if (!s) throw new HttpError(404, 'SIGNER_NOT_FOUND', `没有签署方 ${key}，先设签署方`)
  if (s.userId !== userId) throw new HttpError(403, 'SIGNER_USER_MISMATCH', '令牌的用户和签署方绑定的用户不一样')
}

/** 签署方打开了文档（GET /documents/{id}，签署中）：每个签署令牌记一次「查看」 */
export async function noteView(deps: SigningDeps, req: FastifyRequest, caller: Caller, documentId: string) {
  if (caller.kind !== 'token' || !caller.token.sg) return
  const key = caller.token.sg
  const tokenId = caller.token.tid
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(document).where(eq(document.id, documentId)).for('update')
    if (!row || row.status !== 'sealing') return
    const seen = await tx.select({ detail: signEvidence.detail }).from(signEvidence).where(and(eq(signEvidence.documentId, documentId), eq(signEvidence.action, 'view'), eq(signEvidence.signerKey, key)))
    if (seen.some((s) => s.detail.tokenId === tokenId)) return
    await evidence(deps, tx, req, caller, { documentId, action: 'view', signerKey: key, doc: row.doc, values: row.values, detail: { tokenId }, at: new Date() })
  })
}

/** 已签署的文档签好的那份 PDF（下载 PDF 时给它，不重新渲染：验签按文件哈希认）；没有是 null */
export async function signedPdfOf(deps: SigningDeps, documentId: string, version: number): Promise<Buffer | null> {
  const [f] = await deps.db.select().from(signedFile).where(and(eq(signedFile.documentId, documentId), eq(signedFile.version, version))).limit(1)
  return f ? deps.store.get(f.sha256) : null
}
