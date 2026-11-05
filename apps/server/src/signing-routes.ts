// 签署的接口（docs/设计/08 第 5 节，t12；做法和规则见 signing.ts）：
// PUT/GET /documents/{id}/signers 签署方；POST /documents/{id}/intents 宿主登记意愿认证凭据；POST /documents/{id}/sign 签、拒签；
// GET /documents/{id}/signing-report 签署报告（JSON、PDF）；GET/POST /documents/{id}/signed-file 最终 PDF；POST /verify 验签
import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { setFieldValues, stripHidden, type FieldValue } from '@oe/core'
import type { Caller } from './app'
import { document, operationLog, sealRecord, signIntent, signer } from './db/schema'
import { HttpError } from './errors'
import { sha256 } from './evidence'
import type { Hub } from './realtime'
import { recordRevision } from './revisions'
import { checkCoverage, clearSigning, evidence, finalize, formatDate, pdfSignerOf, roleName, signerView, signersOf, turnOf, voidSeals, type SigningDeps, type Tx } from './signing'
import { registerSigningReports } from './signing-report'

export interface SigningRouteDeps extends SigningDeps {
  hub: Hub
  callerFor: (req: FastifyRequest, documentId: string) => Promise<Caller>
  requireHost: (req: FastifyRequest) => Promise<Extract<Caller, { kind: 'host' }>>
  lockToken: (tx: Tx, caller: Caller) => Promise<unknown>
}

const ID = z.string().uuid()
const VERSION = z.number().int().positive()
export const SIGNER_KEY = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
const parse = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v)
  if (!r.success) throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || '入参'}：${i.message}`).join('；'))
  return r.data
}
const newId = () => crypto.randomUUID()
const PNG = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** 一个签名图片最大多少字节（解码后） */
const MAX_SIGNATURE = 1024 * 1024
const STATUS_NAMES: Record<string, string> = { filling: '还在填写中', sealing: '签署中', sealed: '已签署', void: '已作废' }

const SIGNERS = z.object({
  signers: z
    .array(
      z.object({
        key: SIGNER_KEY,
        name: z.string().trim().min(1).max(100),
        kind: z.enum(['person', 'org']).default('person'),
        userId: z.string().min(1).max(100),
        order: z.number().int().min(1).max(20).default(1),
        intent: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(20),
  deadline: z.iso.datetime({ offset: true }).nullable().optional(),
})
const SIGN_OP = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sign'), version: VERSION, signatures: z.record(z.string(), z.string().max(1_500_000)).default({}), intent: ID.optional() }),
  z.object({ action: z.literal('reject'), version: VERSION, reason: z.string().trim().min(1).max(500) }),
])

export function registerSigning(app: FastifyInstance, deps: SigningRouteDeps) {
  const { db, hub } = deps
  const signerOf = pdfSignerOf(deps)
  const lockRow = async (tx: Tx, id: string) => {
    const [row] = await tx.select().from(document).where(eq(document.id, id)).for('update')
    if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    return row
  }
  const by = (c: Caller) => ({ userId: deps.operatorOf(c), name: deps.nameOf(c) })

  // 设签署方（宿主，开始签署之前）：整组替换；签名区、签署日期绑定的签署方都要有
  app.put<{ Params: { id: string } }>('/api/documents/:id/signers', async (req) => {
    const caller = await deps.requireHost(req)
    const id = parse(ID, req.params.id)
    const body = parse(SIGNERS, req.body)
    const keys = new Set(body.signers.map((s) => s.key))
    if (keys.size !== body.signers.length) throw new HttpError(400, 'BAD_REQUEST', '签署方的 key 重复了')
    return db.transaction(async (tx) => {
      const row = await lockRow(tx, id)
      if (row.status !== 'filling') throw new HttpError(422, 'INVALID_STATUS', '签署方要在开始签署前设')
      checkCoverage(row.fields, keys)
      const at = new Date()
      const deadline = body.deadline ? new Date(body.deadline) : null
      await tx.delete(signer).where(eq(signer.documentId, id))
      await tx.insert(signer).values(body.signers.map((s) => ({ id: newId(), documentId: id, key: s.key, name: s.name, kind: s.kind, userId: s.userId, orderNo: s.order, intentRequired: s.intent })))
      await tx.update(document).set({ signDeadline: deadline, updatedAt: at }).where(eq(document.id, id))
      await evidence(deps, tx, req, caller, { documentId: id, action: 'signers', doc: row.doc, values: row.values, at, detail: { signers: body.signers.map((s) => ({ key: s.key, name: s.name, kind: s.kind, order: s.order, intent: s.intent })), deadline: deadline?.toISOString() ?? null } })
      return { deadline, signers: (await signersOf(tx, id)).map((s) => signerView(s, true)) }
    })
  })

  // 签署方和进度：宿主和这份文档的令牌都能看；turn 是现在轮到的，me 是令牌绑定的签署方
  app.get<{ Params: { id: string } }>('/api/documents/:id/signers', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await deps.callerFor(req, id)
    const [row] = await db.select({ status: document.status, deadline: document.signDeadline }).from(document).where(eq(document.id, id)).limit(1)
    if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    const list = await signersOf(db, id)
    return {
      status: row.status,
      deadline: row.deadline,
      signers: list.map((s) => signerView(s, caller.kind === 'host')),
      turn: row.status === 'sealing' ? turnOf(list).map((s) => s.key) : [],
      me: caller.kind === 'token' ? (caller.token.sg ?? null) : null,
    }
  })

  // 意愿认证凭据（宿主）：宿主自己做完短信验证码、人脸、口令等之后登记，返回凭据 id；签署方签的时候带上，用一次，最多 10 分钟
  app.post<{ Params: { id: string } }>('/api/documents/:id/intents', async (req) => {
    const caller = await deps.requireHost(req)
    const id = parse(ID, req.params.id)
    const body = parse(z.object({ signer: SIGNER_KEY, method: z.enum(['sms', 'face', 'password', 'cert', 'other']), proof: z.string().trim().min(1).max(200), ttlSeconds: z.number().int().min(30).max(600).default(600) }), req.body)
    return db.transaction(async (tx) => {
      const row = await lockRow(tx, id)
      if (row.status !== 'sealing') throw new HttpError(422, 'INVALID_STATUS', `文档${STATUS_NAMES[row.status]}，不用意愿认证`)
      const [s] = await tx.select().from(signer).where(and(eq(signer.documentId, id), eq(signer.key, body.signer))).limit(1)
      if (!s) throw new HttpError(404, 'SIGNER_NOT_FOUND', `没有签署方 ${body.signer}`)
      if (s.status !== 'waiting') throw new HttpError(409, 'ALREADY_SIGNED', `${roleName(s.key)}已经签过了`)
      const at = new Date()
      const rec = { id: newId(), documentId: id, signerKey: s.key, method: body.method, proof: body.proof, expiresAt: new Date(at.getTime() + body.ttlSeconds * 1000), createdAt: at }
      await tx.insert(signIntent).values(rec)
      await evidence(deps, tx, req, caller, { documentId: id, action: 'intent', signerKey: s.key, doc: row.doc, values: row.values, at, detail: { intentId: rec.id, method: rec.method, proof: rec.proof } })
      return { id: rec.id, expiresAt: rec.expiresAt }
    })
  })

  // 签、拒签（绑定了签署方的签署令牌）
  app.post<{ Params: { id: string } }>('/api/documents/:id/sign', async (req) => {
    const id = parse(ID, req.params.id)
    const caller = await deps.callerFor(req, id)
    if (caller.kind !== 'token' || caller.token.mode !== 'seal' || !caller.token.sg) throw new HttpError(403, 'NOT_SIGNER', '只有绑定了签署方的签署令牌能签、拒签')
    const token = caller.token
    const key = token.sg!
    const body = parse(SIGN_OP, req.body)
    const result = await db.transaction(async (tx) => {
      await deps.lockToken(tx, caller)
      const row = await lockRow(tx, id)
      if (row.status !== 'sealing') throw new HttpError(422, 'INVALID_STATUS', `文档${STATUS_NAMES[row.status]}，不能签`)
      if (row.version !== body.version) throw new HttpError(409, 'VERSION_CONFLICT', `文档已被别人修改（当前版本 ${row.version}），请刷新`)
      const list = await signersOf(tx, id)
      const me = list.find((s) => s.key === key)
      if (!me) throw new HttpError(404, 'SIGNER_NOT_FOUND', `没有签署方 ${key}`)
      if (me.userId !== token.uid) throw new HttpError(403, 'SIGNER_USER_MISMATCH', '令牌的用户和签署方绑定的用户不一样')
      if (me.status === 'signed') throw new HttpError(409, 'ALREADY_SIGNED', '已经签过了')
      const at = new Date()
      const operator = deps.operatorOf(caller)
      const operatorName = deps.nameOf(caller)
      const version = row.version + 1

      if (body.action === 'reject') {
        // 拒签：已签的作废（签名、签署日期清掉，章作废），退回填写；签署方都回到待签，拒签的这一方记原因
        const doc = await voidSeals(tx, id, row.doc, row.fields, operator, at)
        const cleared = clearSigning(doc, row.values, row.fields)
        await tx.update(signer).set({ status: 'waiting', signedAt: null, intentMethod: null, intentProof: null, rejectReason: null }).where(eq(signer.documentId, id))
        await tx.update(signer).set({ status: 'rejected', rejectReason: body.reason }).where(eq(signer.id, me.id))
        await tx.update(document).set({ doc: cleared.doc, values: cleared.values, version, status: 'filling', lockedAt: null, pageCount: null, updatedAt: at }).where(eq(document.id, id))
        await evidence(deps, tx, req, caller, { documentId: id, action: 'reject', signerKey: key, doc: cleared.doc, values: cleared.values, at, detail: { reason: body.reason } })
        await recordRevision(tx, { documentId: id, version, reason: 'reject', doc: cleared.doc, values: cleared.values, operator, operatorName })
        await tx.insert(operationLog).values({ id: newId(), documentId: id, ops: { action: 'reject-sign', signer: key, reason: body.reason }, result: { ok: true, version, status: 'filling' }, operator, at })
        return { version, status: 'filling' as const, ...cleared, fields: row.fields }
      }

      if (row.signDeadline && row.signDeadline.getTime() <= at.getTime()) throw new HttpError(422, 'SIGN_EXPIRED', '已过签署截止时间')
      const turn = turnOf(list)
      if (!turn.some((s) => s.key === key)) throw new HttpError(422, 'NOT_YOUR_TURN', `还没轮到你：先等${turn.map((s) => `${roleName(s.key)}（${s.name}）`).join('、')}签`)
      // 签名：这一方的每个签名区都要签，别人的不能签；PNG、不超过 1 MB
      const mine = row.fields.filter((f) => f.type === 'signature' && f.signer === key)
      const extra = Object.keys(body.signatures).find((k) => !mine.some((f) => f.key === k))
      if (extra) throw new HttpError(403, 'NOT_YOUR_FIELD', `「${row.fields.find((f) => f.key === extra)?.label ?? extra}」不是你的签名区`)
      const missing = mine.find((f) => !body.signatures[f.key])
      if (missing) throw new HttpError(400, 'SIGNATURE_MISSING', `「${missing.label}」还没签`)
      for (const f of mine) {
        const m = PNG.exec(body.signatures[f.key]!)
        const bytes = m ? Buffer.from(m[1]!, 'base64') : null
        if (!bytes || bytes.length > MAX_SIGNATURE || !bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new HttpError(400, 'BAD_SIGNATURE', `「${f.label}」的签名要是 PNG 图片，不超过 1 MB`)
      }
      const seals = await tx.select().from(sealRecord).where(and(eq(sealRecord.documentId, id), eq(sealRecord.status, 'valid'), eq(sealRecord.signerKey, key)))
      if (!mine.length && !seals.length) throw new HttpError(422, 'NOTHING_TO_SIGN', '先盖章或签名再确认')
      // 意愿认证：宿主登记过的凭据，属于这一方、没用过、没过期，用掉
      let intent: typeof signIntent.$inferSelect | null = null
      if (me.intentRequired) {
        if (!body.intent) throw new HttpError(403, 'INTENT_REQUIRED', '签之前要先做意愿认证')
        const [it] = await tx.select().from(signIntent).where(and(eq(signIntent.id, body.intent), eq(signIntent.documentId, id), eq(signIntent.signerKey, key))).for('update')
        if (!it || it.usedAt || it.expiresAt.getTime() <= at.getTime()) throw new HttpError(403, 'INTENT_INVALID', '意愿认证已失效，请重新验证')
        await tx.update(signIntent).set({ usedAt: at }).where(eq(signIntent.id, it.id))
        intent = it
      }
      // 写签名、签署日期（服务器时间）
      const dates = row.fields.filter((f) => f.type === 'signDate' && f.signer === key)
      const writes: Record<string, FieldValue> = { ...body.signatures, ...Object.fromEntries(dates.map((f) => [f.key, formatDate(at, f.format, deps.config.SIGN_TIMEZONE)])) }
      const doc = structuredClone(row.doc)
      const written = Object.keys(writes).length ? setFieldValues(doc as unknown as Parameters<typeof setFieldValues>[0], writes, row.fields, row.values.values) : {}
      const values = { ...row.values, values: { ...row.values.values, ...written } }
      const status = list.some((s) => s.status === 'waiting' && s.key !== key) ? ('sealing' as const) : ('sealed' as const)
      await tx.update(document).set({ doc, values, version, status, pageCount: null, updatedAt: at }).where(eq(document.id, id))
      await tx.update(signer).set({ status: 'signed', signedAt: at, intentMethod: intent?.method ?? null, intentProof: intent?.proof ?? null }).where(eq(signer.id, me.id))
      await evidence(deps, tx, req, caller, {
        documentId: id,
        action: 'sign',
        signerKey: key,
        doc,
        values,
        at,
        detail: {
          signatures: Object.fromEntries(mine.map((f) => [f.key, sha256(body.signatures[f.key]!)])),
          dates: Object.fromEntries(dates.map((f) => [f.key, writes[f.key]])),
          seals: seals.map((s) => ({ id: s.id, name: s.sealName, imageHash: s.imageHash, pageNo: s.pageNo })),
          intent: intent ? { id: intent.id, method: intent.method, proof: intent.proof } : null,
        },
      })
      await recordRevision(tx, { documentId: id, version, reason: 'sign', doc, values, operator, operatorName })
      await tx.insert(operationLog).values({ id: newId(), documentId: id, ops: { action: 'sign', signer: key }, result: { ok: true, version, status }, operator, at })
      return { version, status, doc, values, fields: row.fields }
    })
    // 打开着的人：签署进度变了；签完、拒签时状态也变了
    hub.publish(id, 'signing', () => ({ version: result.version, status: result.status, signer: key, action: body.action, by: by(caller) }))
    if (result.status !== 'sealing') hub.publish(id, 'status', () => ({ status: result.status, version: result.version, by: by(caller) }))
    // 签完了出最终文件；出不来（渲染服务不在）不影响签署结果，宿主可以之后再调 POST …/signed-file
    let file: { sha256: string; size: number; pageCount: number } | null = null
    let fileError: string | undefined
    if (result.status === 'sealed')
      await finalize(deps, signerOf, id).then(
        (f) => (file = { sha256: f.sha256, size: f.size, pageCount: f.pageCount }),
        (e: unknown) => (fileError = e instanceof Error ? e.message : String(e)),
      )
    const safe = stripHidden(result.doc, result.values, result.fields, caller.perms)
    return { version: result.version, status: result.status, file, ...(fileError ? { fileError } : {}), doc: safe.data, values: safe.values }
  })

  registerSigningReports(app, { ...deps, signerOf })
}
