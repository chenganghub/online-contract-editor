// 签署报告、最终文件、验签（docs/设计/08 第 5 节，t12）。
// 报告：签署方、时间、意愿认证、证据链（重算哈希链看有没有被改）、最终文件哈希和证书；JSON 给宿主，PDF 经渲染服务出。
// 令牌看到的报告里别人的 IP 去掉最后一段，意愿认证凭据号、令牌 id 去掉（宿主都看得到）
import type { FastifyInstance, FastifyReply } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DocData } from '@oe/core'
import { document, signedFile } from './db/schema'
import { HttpError } from './errors'
import { evidenceOf } from './evidence'
import { verifyPdf, type PdfSigner } from './pdf-sign'
import { finalize, formatDate, roleName, signerView, signersOf } from './signing'
import type { SigningRouteDeps } from './signing-routes'

const ID = z.string().uuid()
const parse = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v)
  if (!r.success) throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.') || '入参'}：${i.message}`).join('；'))
  return r.data
}
export const EVIDENCE_NAMES: Record<string, string> = { signers: '设签署方', start: '开始签署', view: '查看', intent: '意愿认证', sign: '签署', reject: '拒签', revoke: '撤回', void: '作废', complete: '生成最终文件' }
export const INTENT_NAMES: Record<string, string> = { sms: '短信验证码', face: '人脸识别', password: '签署密码', cert: '数字证书', other: '其他' }
const STATUS_NAMES: Record<string, string> = { filling: '填写中', sealing: '签署中', sealed: '已签署', void: '已作废' }

/** IPv4（含 ::ffff: 开头的）去掉最后一段，IPv6 只留前三组 */
const maskIp = (ip: string | null) => (!ip ? null : /\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.replace(/\.\d+$/, '.*') : `${ip.split(':').slice(0, 3).join(':')}:*`)
const scrub = (detail: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(detail)
      .filter(([k]) => k !== 'proof' && k !== 'tokenId')
      .map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? scrub(v as Record<string, unknown>) : v]),
  )

async function reportOf(deps: SigningRouteDeps, id: string, host: boolean) {
  const [row] = await deps.db.select().from(document).where(eq(document.id, id)).limit(1)
  if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
  const list = await signersOf(deps.db, id)
  const chain = await evidenceOf(deps.db, id)
  const [file] = await deps.db.select().from(signedFile).where(eq(signedFile.documentId, id)).orderBy(desc(signedFile.version)).limit(1)
  return {
    document: { id, title: row.title, status: row.status, version: row.version, deadline: row.signDeadline },
    signers: list.map((s) => signerView(s, host)),
    evidence: chain.rows.map((r) => ({
      seq: r.seq,
      action: r.action,
      signer: r.signerKey,
      operatorName: r.operatorName,
      ...(host ? { operator: r.operator } : {}),
      ip: host ? r.ip : maskIp(r.ip),
      userAgent: r.userAgent,
      docHash: r.docHash,
      detail: host ? r.detail : scrub(r.detail),
      at: r.at,
      prevHash: r.prevHash,
      hash: r.hash,
    })),
    chain: { valid: chain.valid, broken: chain.broken, count: chain.rows.length, head: chain.head },
    file: file ? { version: file.version, sha256: file.sha256, size: file.size, pageCount: file.pageCount, at: file.at, cert: { subject: file.certSubject, serial: file.certSerial, test: file.testCert } } : null,
    generatedAt: new Date(),
  }
}
type Report = Awaited<ReturnType<typeof reportOf>>

/** 报告排成文档（canvas-editor 的元素），交给渲染服务出 PDF */
function reportDoc(r: Report, timeZone: string): DocData {
  const t = (d: Date | string | null) => (d ? formatDate(new Date(d), 'yyyy-MM-dd HH:mm:ss', timeZone) : '')
  const main: Record<string, unknown>[] = []
  const p = (value: string, style: Record<string, unknown> = {}) => main.push({ value: `${value}\n`, ...style })
  const gray = { size: 11, color: '#6e6e73' }
  p('签署报告', { size: 24, bold: true, rowFlex: 'center' })
  p(`合同：${r.document.title}`)
  p(`文档编号：${r.document.id}\u3000第 ${r.document.version} 版\u3000${STATUS_NAMES[r.document.status] ?? r.document.status}`)
  if (r.file) {
    p(`最终文件 SHA-256：${r.file.sha256}`, gray)
    p(`签名证书：${r.file.cert.subject}\u3000序列号 ${r.file.cert.serial}${r.file.cert.test ? '（测试证书，无法律效力）' : ''}`)
  }
  p('签署方', { size: 16, bold: true })
  for (const s of r.signers)
    p(`${s.order}. ${s.role} ${s.name}（${s.kind === 'org' ? '企业' : '个人'}）\u3000${s.status === 'signed' ? `已签 ${t(s.signedAt)}` : s.status === 'rejected' ? `拒签：${s.rejectReason ?? ''}` : '待签'}${s.intentMethod ? `\u3000意愿认证：${INTENT_NAMES[s.intentMethod] ?? s.intentMethod}` : ''}`)
  p(`证据链（${r.chain.count} 条，${r.chain.valid ? '哈希链完整' : `从第 ${r.chain.broken} 条起对不上`}）`, { size: 16, bold: true })
  for (const e of r.evidence) {
    p(`${e.seq}. ${t(e.at)}\u3000${EVIDENCE_NAMES[e.action] ?? e.action}${e.signer ? `（${roleName(e.signer)}）` : ''}\u3000${e.operatorName}${e.ip ? `\u3000IP ${e.ip}` : ''}`)
    p(`文档哈希 ${e.docHash}\u3000本条哈希 ${e.hash}${e.userAgent ? `\u3000设备 ${e.userAgent.slice(0, 80)}` : ''}`, gray)
  }
  p(`生成时间：${t(r.generatedAt)}`, gray)
  return { main } as unknown as DocData
}

const sendPdf = (reply: FastifyReply, file: Buffer, name: string) =>
  reply.type('application/pdf').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`).send(file)

export function registerSigningReports(app: FastifyInstance, deps: SigningRouteDeps & { signerOf: () => Promise<PdfSigner> }) {
  const { db } = deps

  // 签署报告：宿主和这份文档的令牌；?format=pdf 出 PDF（要能下载的令牌）
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/documents/:id/signing-report', async (req, reply) => {
    const id = parse(ID, req.params.id)
    const q = parse(z.object({ format: z.enum(['json', 'pdf']).default('json') }), req.query)
    const caller = await deps.callerFor(req, id)
    const r = await reportOf(deps, id, caller.kind === 'host')
    if (q.format === 'json') return r
    if (caller.kind === 'token' && !caller.actions.download) throw new HttpError(403, 'ACTION_FORBIDDEN', '这个文档令牌不能下载')
    const out = await deps.renderer().render({ doc: reportDoc(r, deps.config.SIGN_TIMEZONE), title: `${r.document.title} 签署报告`, outputs: ['pdf'] })
    if (!out.pdf) throw new HttpError(502, 'RENDER_FAILED', '渲染服务没有返回 PDF')
    return sendPdf(reply, out.pdf, `${r.document.title}签署报告.pdf`)
  })

  // 最终文件（带数字签名的 PDF，原样给，验签按文件哈希认）：宿主和能下载的令牌
  app.get<{ Params: { id: string } }>('/api/documents/:id/signed-file', async (req, reply) => {
    const id = parse(ID, req.params.id)
    const caller = await deps.callerFor(req, id)
    if (caller.kind === 'token' && !caller.actions.download) throw new HttpError(403, 'ACTION_FORBIDDEN', '这个文档令牌不能下载')
    const [row] = await db.select({ title: document.title, version: document.version, status: document.status }).from(document).where(eq(document.id, id)).limit(1)
    if (!row) throw new HttpError(404, 'NOT_FOUND', '文档不存在')
    const [file] = row.status === 'sealed' ? await db.select().from(signedFile).where(eq(signedFile.documentId, id)).orderBy(desc(signedFile.version)).limit(1) : []
    if (!file) throw new HttpError(404, 'SIGNED_FILE_NOT_FOUND', row.status === 'sealed' ? '最终文件还没生成' : '还没签署完成')
    reply.header('X-Document-Version', file.version).header('X-File-Sha256', file.sha256)
    return sendPdf(reply, await deps.store.get(file.sha256), `${row.title}（已签署）.pdf`)
  })

  // 重新出最终文件（宿主）：签完时渲染服务不在、出失败了用
  app.post<{ Params: { id: string } }>('/api/documents/:id/signed-file', async (req) => {
    await deps.requireHost(req)
    const id = parse(ID, req.params.id)
    const f = await finalize(deps, deps.signerOf, id)
    return { version: f.version, sha256: f.sha256, size: f.size, pageCount: f.pageCount, cert: { subject: f.certSubject, serial: f.certSerial, test: f.testCert } }
  })

  // 验签（宿主）：上传 PDF（base64），核对每个数字签名；文件哈希是本系统出过的最终文件时，带上是哪份合同、谁签的
  app.post('/api/verify', async (req) => {
    await deps.requireHost(req)
    const body = parse(z.object({ pdf: z.string().min(1).max(20_000_000) }), req.body)
    const pdf = Buffer.from(body.pdf, 'base64')
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'BAD_REQUEST', '不是 PDF 文件')
    const result = verifyPdf(pdf)
    const ours = (await deps.signerOf()).cert
    const [f] = await db.select().from(signedFile).where(eq(signedFile.sha256, result.sha256)).limit(1)
    let known = null
    if (f) {
      const [d] = await db.select({ title: document.title, status: document.status }).from(document).where(eq(document.id, f.documentId)).limit(1)
      const list = await signersOf(db, f.documentId)
      known = { documentId: f.documentId, title: d?.title ?? null, status: d?.status ?? null, version: f.version, signedAt: f.at, testCert: f.testCert, signers: list.map((s) => ({ role: roleName(s.key), name: s.name, status: s.status, signedAt: s.signedAt })) }
    }
    return { sha256: result.sha256, signatures: result.signatures.map((s) => ({ ...s, testCert: !!s.cert && s.cert.serial === ours.serial && ours.test })), known }
  })
}
