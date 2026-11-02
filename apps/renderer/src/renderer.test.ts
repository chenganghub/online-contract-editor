// 渲染服务集成测试：真的起服务、拉起系统 Chrome。验收 1（PDF 页数一致、能搜到字）、15（60 秒内出 PDF）的服务端部分。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { applyBatch, type DocData, type FieldDef } from '@oe/core'
import { startRenderer, type Renderer } from './app'
import { loadConfig } from './config'
import { checkFonts, WINDOWS_FONTS } from './fonts'
import fixture from './__fixtures__/contract.json'

const filled = (() => {
  const r = applyBatch(fixture.doc as unknown as DocData, [{ op: 'setData', values: { contractNo: 'HT-2026-0318', partyA: '某某科技有限公司', partyAAddress: '江苏省苏州市工业园区星湖街 328 号', amount: '358600', payMethod: 'stage' } }], {
    fields: fixture.fields as FieldDef[],
  })
  if (!r.ok) throw new Error(r.error)
  return r.data
})()
// 正文复制 3 遍，做一份 9 页左右的长合同
const long: DocData = { ...filled, main: [...filled.main, ...structuredClone(filled.main), ...structuredClone(filled.main)] }

let renderer: Renderer
// 耗时记录：写到 test-results（不进 git），跑验收时用 OE_EVIDENCE_DIR 指到检查点证据目录
const timings: Record<string, unknown> = {}
const evidence = process.env.OE_EVIDENCE_DIR ?? path.resolve('test-results')
const post = (body: unknown) => renderer.app.inject({ method: 'POST', url: '/render', payload: body as object })

async function readPdf(b64: string) {
  const task = getDocument({ data: new Uint8Array(Buffer.from(b64, 'base64')), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const c = await (await doc.getPage(n)).getTextContent()
    pages.push(c.items.map((it) => ('str' in it ? it.str : '')).join(''))
  }
  const meta = await doc.getMetadata()
  await task.destroy()
  return { numPages: doc.numPages, pages, info: meta.info as Record<string, unknown> }
}

beforeAll(async () => {
  renderer = await startRenderer({ ...loadConfig({}), RENDERER_PORT: 0 })
}, 60_000)
afterAll(async () => {
  fs.mkdirSync(evidence, { recursive: true })
  fs.writeFileSync(path.join(evidence, 'renderer-timings.json'), JSON.stringify(timings, null, 1))
  await renderer?.close()
}, 30_000)

describe('渲染服务', () => {
  it('出 PDF 和 docx：PDF 页数等于编辑器页数，文字层能搜到正文、字段值、页眉、页码，带文档 id 和版本号', async () => {
    const res = await post({ doc: filled, documentId: 'doc-1', version: 3, title: '采购合同', outputs: ['pdf', 'docx'] })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    // 打印模式不画空控件的占位文字，样例是 2 页（编辑模式下占位文字占地方，是 3 页）
    expect(body.pageCount).toBeGreaterThanOrEqual(2)
    const pdf = await readPdf(body.pdf)
    expect(pdf.numPages).toBe(body.pageCount)
    const all = pdf.pages.join('\n')
    for (const word of ['违约责任', '某某科技有限公司', '叁拾伍万捌仟陆佰元整', '分期付款', '采购合同', `第1页 / 共${body.pageCount}页`]) expect(all).toContain(word)
    expect(String(pdf.info.Keywords)).toContain('oe-document:doc-1')
    expect(String(pdf.info.Keywords)).toContain('oe-version:3')
    expect(Buffer.from(body.docx, 'base64').subarray(0, 2).toString()).toBe('PK')
    expect(body.unknownFonts).toEqual([])
    timings.short = { pages: body.pageCount, ...body.timings }
  }, 60_000)

  it('期望页数不对：重建页面重试一次，仍不一致返回 409 和两边页数', async () => {
    const res = await post({ doc: filled, expectedPages: 99, outputs: ['pages'] })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'PAGE_COUNT_MISMATCH', expected: 99 })
    expect(res.json().actual).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('期望页数对得上就通过；只要页数时不出 PDF', async () => {
    const first = (await post({ doc: filled, outputs: ['pages'] })).json()
    const res = await post({ doc: filled, expectedPages: first.pageCount, outputs: ['pages'] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ pageCount: first.pageCount, attempts: 1 })
    expect(res.json().pdf).toBeUndefined()
  }, 60_000)

  it('长合同 60 秒内出 PDF（验收 15 的渲染部分）；5 个并发请求都成功', async () => {
    const t0 = performance.now()
    const one = await post({ doc: long, outputs: ['pdf'], pixelRatio: 2 })
    const ms = performance.now() - t0
    expect(one.statusCode).toBe(200)
    expect(ms).toBeLessThan(60_000)
    const pages = one.json().pageCount
    const t1 = performance.now()
    const list = await Promise.all(Array.from({ length: 5 }, () => post({ doc: filled, outputs: ['pdf'] })))
    const wall = performance.now() - t1
    expect(list.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200])
    expect(new Set(list.map((r) => r.json().pageCount)).size).toBe(1)
    timings.long = { pages, wallMs: Math.round(ms), ...one.json().timings }
    timings.concurrent5 = { wallMs: Math.round(wall), perRequestTotalMs: list.map((r) => r.json().timings.totalMs), queueMs: list.map((r) => r.json().timings.queueMs) }
  }, 120_000)

  it('Chrome 崩了：下一个请求自动重新拉起', async () => {
    await (renderer.pool as unknown as { browser: { close(): Promise<void> } }).browser.close()
    const res = await post({ doc: filled, outputs: ['pages'] })
    expect(res.statusCode, res.body).toBe(200)
    expect(renderer.pool.stats()).toMatchObject({ size: 2, busy: 0 })
  }, 60_000)

  it('入参不合法 400', async () => {
    const res = await post({ doc: { main: 'x' } })
    expect(res.statusCode).toBe(400)
  })
})

describe('启动检查和排队', () => {
  it('字体文件缺了不启动', () => {
    expect(() => checkFonts({ ...WINDOWS_FONTS, textLayer: ['C:/Windows/Fonts/没有这个字体.ttf'] })).toThrow('字体文件不存在')
  })

  it('排队超时返回 503', async () => {
    const small = await startRenderer({ ...loadConfig({}), RENDERER_PORT: 0, POOL_SIZE: 1, QUEUE_TIMEOUT_MS: 1 })
    try {
      const list = await Promise.all(Array.from({ length: 3 }, () => small.app.inject({ method: 'POST', url: '/render', payload: { doc: filled, outputs: ['pages'] } })))
      const codes = list.map((r) => r.statusCode)
      expect(codes).toContain(200)
      expect(codes).toContain(503)
      expect(list.find((r) => r.statusCode === 503)!.json().code).toBe('QUEUE_TIMEOUT')
    } finally {
      await small.close()
    }
  }, 60_000)

  it('自定义字体配置文件', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oe-fonts-')), 'fonts.json')
    fs.writeFileSync(file, JSON.stringify({ families: { 黑体: 'C:/Windows/Fonts/simhei.ttf' }, textLayer: ['C:/Windows/Fonts/simhei.ttf'] }))
    expect(() => checkFonts(JSON.parse(fs.readFileSync(file, 'utf8')))).not.toThrow()
  })
})
