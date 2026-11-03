// 验收 4、5（前端部分）、7、8 和 9 的前端部分、11 的拖章部分，以及界面规范逐项比对（docs/设计/04-界面规范.md）；
// 最后一组接真实服务端走全流程（验收 4、5、11、14、16）。先构建 apps/demo，再用系统 Chrome 打开。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Browser, type Page } from '@playwright/test'
import { CUSTOMERS, HOST_TOKEN, queryCustomers, type Customer } from '../../apps/demo/src/customers'
import { DEMO_USER, issueToken, type ServerApi } from '../../apps/demo/src/host-backend'
import { FIELDS, sampleDoc } from '../../apps/demo/src/sample'
import { setFieldValues, type DocData } from '../../packages/core/src/index'
import { scanDocx, squeeze, textOf, type ImportReport } from '../../packages/docx/src/index'
import { startRenderer } from '../../apps/renderer/src/app'
import { loadConfig } from '../../apps/renderer/src/config'
import { httpRenderer } from '../../apps/server/src/renderer'
import { startTempServer } from '../../apps/server/src/temp-server'
import { getDocument } from '../../apps/renderer/node_modules/pdfjs-dist/legacy/build/pdf.mjs'
import { serve } from '../helpers/serve'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const demo = path.join(root, 'apps', 'demo')
// 截图默认放 test-results（不进 git）；跑验收时用 OE_EVIDENCE_DIR 指到检查点的证据目录
const evidence = process.env.OE_EVIDENCE_DIR ?? path.join(root, 'test-results', 'screenshots')
let origin = ''
let outDir = ''
let close: () => Promise<void> = async () => {}

// 按顺序跑；某个用例失败时换一个 worker 接着跑后面的，不整批跳过
test.describe.configure({ mode: 'default' })
test.beforeAll(async () => {
  // 产物放到系统临时目录：Node 24.9 的 fs.rmSync 递归删除含中文的路径会让进程崩溃（0xC0000409），
  // vite 清空旧产物时会触发；临时目录是纯 ASCII 路径，而且每次都是空的
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-demo-'))
  const vite = path.join(demo, 'node_modules', 'vite', 'bin', 'vite.js')
  const r = spawnSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: demo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`demo 构建失败（${r.status}）：${r.stderr || r.stdout}`)
  const s = await serve(outDir)
  origin = s.origin
  close = s.close
  fs.mkdirSync(evidence, { recursive: true })
})
test.afterAll(async () => {
  await close()
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true })
})

type Cmd = Record<string, (...a: unknown[]) => unknown>
type Win = {
  __oe: {
    setMode(m: string): Promise<void>
    getData(): { doc: unknown; values: { values: Record<string, unknown>; snapshots?: Record<string, { sourceId: string }> } }
    // 组件 expose 出来的 ref 会被 Vue 自动解包，这里直接就是 canvas-editor 实例
    editor: { command: Cmd }
  }
}
const cmd = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ fn, args }) => (window as unknown as Win).__oe.editor.command[fn]!(...args), { fn, args })
const text = async (page: Page) => ((await cmd(page, 'getText')) as { main: string }).main
const setMode = (page: Page, m: string) => page.evaluate((m) => (window as unknown as Win).__oe.setMode(m), m)
const values = (page: Page) => page.evaluate(() => (window as unknown as Win).__oe.getData().values)
const controlIds = (page: Page, key: string) =>
  page.evaluate((key) => {
    const list = (window as unknown as Win).__oe.editor.command.getControlList!() as { controlId: string; control?: { conceptId?: string } }[]
    return [...new Set(list.filter((e) => e.control?.conceptId === key).map((e) => e.controlId))]
  }, key)
const fieldValues = (page: Page, key: string) =>
  page.evaluate(
    (key) => ((window as unknown as Win).__oe.editor.command.getControlValue!({ conceptId: key }) as { value: string | null }[]).map((v) => v.value),
    key,
  )

const ready = (page: Page) =>
  page.waitForFunction(() => (window as unknown as Win).__oe && document.querySelectorAll('.oe .doc canvas').length > 0)

interface Sent {
  url: URL
  type: string
  auth?: string
}
/** setup 在打开页面之前调用（装请求拦截） */
async function open(browser: Browser, colorScheme: 'light' | 'dark' = 'light', query = '', setup?: (page: Page) => Promise<void>) {
  // 每次 browser.newPage() 都是新的浏览器上下文，localStorage 是空的，演示页从样例合同开始
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme })
  await setup?.(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  // 模拟的客户接口（验收 8、9）：没带宿主登录态返回 401。customers 每个页面一份，测试里可以改
  const customers: Customer[] = structuredClone(CUSTOMERS)
  await page.route('**/api/customers**', (route) => {
    const req = route.request()
    if (req.headers()['authorization'] !== HOST_TOKEN) return route.fulfill({ status: 401 })
    return route.fulfill({ json: queryCustomers(customers, new URL(req.url()).searchParams) })
  })
  // 页面发出的接口请求（fetch / xhr），看是不是都经过宿主的 request（带宿主登录态）
  const sent: Sent[] = []
  page.on('request', (r) => {
    if (r.resourceType() === 'fetch' || r.resourceType() === 'xhr') sent.push({ url: new URL(r.url()), type: r.resourceType(), auth: r.headers()['authorization'] })
  })
  await page.goto(`${origin}/${query}`)
  // 启动就出错时（Vue 渲染出错只打到控制台）直接报出错误，不干等超时
  const failed = new Promise((_, reject) => {
    page.on('pageerror', (e) => reject(e))
    page.on('console', (m) => m.type() === 'error' && reject(new Error(m.text())))
  })
  // 页面起来以后的错误由各用例检查 errors，这里不再管
  failed.catch(() => {})
  await Promise.race([ready(page), failed])
  await page.waitForTimeout(400)
  return { page, errors, customers, sent }
}
// 光标放到正文某段文字后面，再用真实键盘输入
async function typeInBody(page: Page, after: string, ch: string) {
  const ranges = (await cmd(page, 'getKeywordRangeList', after)) as { endIndex: number }[]
  await cmd(page, 'executeSetRange', ranges[0]!.endIndex, ranges[0]!.endIndex)
  await page.focus('.oe .ce-inputarea')
  await page.keyboard.type(ch)
  await page.waitForTimeout(150)
}
async function typeInField(page: Page, key: string, s: string, occurrence = 0) {
  const ids = await controlIds(page, key)
  await cmd(page, 'executeLocationControl', ids[occurrence], { position: 'after' })
  await page.focus('.oe .ce-inputarea')
  for (const ch of s) {
    await page.keyboard.type(ch)
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(200)
}
const count = async (page: Page, s: string) => (await text(page)).split(s).length - 1
type SealEl = { extension?: { seal?: unknown }; imgFloatPosition?: { x: number; y: number; pageNo: number } }
/** 文档里第一个印章的页码和页内坐标 */
const sealPosition = (page: Page) =>
  page.evaluate(() => ((window as unknown as Win).__oe.getData().doc as { main: SealEl[] }).main.find((e) => e.extension?.seal)?.imgFloatPosition)
/** 第一个印章（151 × 151）范围里有几个正文的字 */
const charsUnderSeal = (page: Page) =>
  page.evaluate(() => {
    const oe = (window as unknown as Win).__oe
    const at = (oe.getData().doc as { main: SealEl[] }).main.find((e) => e.extension?.seal)!.imgFloatPosition!
    const c = oe.editor.command as unknown as {
      executeSearch(k: string | null, o?: unknown): void
      getKeywordContext(k: string): { endPosition: { pageNo: number; value: string; coordinate: { leftTop: number[] } } }[] | null
    }
    c.executeSearch('\uFFFF', { isRegEnable: true, isIgnoreCase: false })
    const list = c.getKeywordContext('[^\\u200B\\n]') ?? []
    c.executeSearch(null)
    return list.filter(({ endPosition: p }) => {
      const [x, y] = p.coordinate.leftTop as [number, number]
      return p.pageNo === at.pageNo && x >= at.x && x <= at.x + 151 && y >= at.y && y <= at.y + 151
    }).length
  })
/** PDF 每页文字层的文字 */
async function pdfPageTexts(bytes: Uint8Array) {
  const doc = await getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise
  const out: string[] = []
  for (let n = 1; n <= doc.numPages; n++) out.push((await (await doc.getPage(n)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(''))
  return out
}

test('四种模式：编辑能改正文；填写只能改控件；盖章只能放、拖章；只读不能改；保存后刷新还在（验收 4）', async ({ browser }) => {
  const { page, errors } = await open(browser)
  await typeInBody(page, '民法典》', 'X')
  expect(await count(page, 'X')).toBe(1)

  await setMode(page, 'fill')
  await typeInBody(page, '民法典》', 'Y')
  expect(await count(page, 'Y')).toBe(0)
  await typeInField(page, 'contractNo', 'HT01')
  expect((await values(page)).values.contractNo).toBe('HT01')

  await setMode(page, 'seal')
  await typeInBody(page, '民法典》', 'Z')
  expect(await count(page, 'Z')).toBe(0)
  await typeInField(page, 'contractNo', 'S')
  expect((await values(page)).values.contractNo).toBe('HT01')
  await page.dragAndDrop('.oe .seal-card[data-seal="contract"]', '.oe .pages', { targetPosition: { x: 400, y: 500 } })
  await expect(page.locator('.oe .seal-handle')).toHaveCount(1)
  await expect(page.locator('.oe .inspector .row-meta')).toHaveText('第 1 页')
  const h = page.locator('.oe .seal-handle')
  // 拖放会把画布滚到页面中间，章可能在视口外，先滚回来再按住拖
  await h.scrollIntoViewIfNeeded()
  const before = (await h.boundingBox())!
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 60, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  const after = (await h.boundingBox())!
  expect(Math.round(after.x - before.x)).toBe(120)
  expect(Math.round(after.y - before.y)).toBe(60)
  // 章压在字上（验收 11）：章的范围里有正文的字
  const placedAt = await sealPosition(page)
  expect(await charsUnderSeal(page)).toBeGreaterThan(10)
  // 盖章模式撤销快捷键无效，以服务端盖章记录为准
  await page.focus('.oe .ce-inputarea')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(200)
  await expect(page.locator('.oe .seal-handle')).toHaveCount(1)

  await setMode(page, 'view')
  await expect(page.locator('.oe .oe-print')).toBeVisible()
  await typeInBody(page, '民法典》', 'W')
  expect(await count(page, 'W')).toBe(0)
  await typeInField(page, 'contractNo', 'V')
  expect((await values(page)).values.contractNo).toBe('HT01')
  expect(await count(page, 'X')).toBe(1)

  // 保存后刷新：正文、字段值、印章都在（印章靠 id 移动和删除，保存时要带上 id）
  await setMode(page, 'edit')
  await page.click('.oe .oe-primary')
  await expect(page.locator('.oe .doc-status')).toHaveText('已保存')
  await page.reload()
  await ready(page)
  await page.waitForTimeout(400)
  expect(await count(page, 'X')).toBe(1)
  expect((await values(page)).values.contractNo).toBe('HT01')
  await setMode(page, 'seal')
  await expect(page.locator('.oe .seal-handle')).toHaveCount(1)
  await expect(page.locator('.oe .inspector .row-meta')).toHaveText('第 1 页')
  // 刷新后章的页码和坐标和拖完时一样
  expect(await sealPosition(page)).toEqual(placedAt)
  expect(errors).toEqual([])
})

test('盖章操作逐个交给宿主：放章、移章、删章，id 前后一致（验收 11 的前端部分）', async ({ browser }) => {
  const { page, errors } = await open(browser)
  await setMode(page, 'seal')
  await page.dragAndDrop('.oe .seal-card[data-seal="contract"]', '.oe .pages', { targetPosition: { x: 400, y: 500 } })
  const h = page.locator('.oe .seal-handle')
  await expect(h).toHaveCount(1)
  await h.scrollIntoViewIfNeeded()
  const b = (await h.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2 + 40, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  // 编辑器自己也把章画在第 1 页（canvas-editor 按图片在正文里的位置定页，组件把章挂到它那一页，见 seals.ts），不是最后一页
  const redByPage = await page.evaluate(async () => {
    const c = (window as unknown as { __oe: { editor: { command: { getImage(o: unknown): Promise<string[]> } } } }).__oe.editor.command
    const out: number[] = []
    for (const src of await c.getImage({ pixelRatio: 1, mode: 'print' })) {
      const img = new Image()
      await new Promise((r) => ((img.onload = r), (img.src = src)))
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const g = cv.getContext('2d', { willReadFrequently: true })!
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 0, cv.width, cv.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 180 && d[i + 1]! < 90 && d[i + 2]! < 90) n++
      out.push(n)
    }
    return out
  })
  expect(redByPage[0]).toBeGreaterThan(1000)
  expect(redByPage.slice(1).every((n) => n < 100), JSON.stringify(redByPage)).toBe(true)
  await page.click('.oe .inspector [aria-label="移除"]')
  await expect(h).toHaveCount(0)
  type Op = { action: string; id?: string; x?: number; y?: number; pageNo?: number; seal?: { id: string; sealId: string; name: string; dataURL: string; pageNo: number; x: number; y: number; width: number } }
  const ops = (await page.evaluate(() => (window as unknown as { __sealOps: unknown[] }).__sealOps)) as Op[]
  expect(ops.map((o) => o.action)).toEqual(['place', 'move', 'remove'])
  const placed = ops[0]!.seal!
  expect(placed).toMatchObject({ sealId: 'contract', name: '合同专用章', pageNo: 0, width: 151 })
  expect(placed.dataURL).toMatch(/^data:image\/png;base64,/)
  expect([ops[1]!.id, ops[2]!.id]).toEqual([placed.id, placed.id])
  expect([ops[1]!.x! - placed.x, ops[1]!.y! - placed.y]).toEqual([80, 40])
  await expect(page.locator('.oe .doc-status')).toHaveText('已保存')
  expect(errors).toEqual([])
})

test('导入 Word：自制样例导入后正文一字不差，导入报告列出补回的和没保留的项，保存后重新打开还在（验收 3 的前端部分）', async ({ browser }) => {
  test.setTimeout(120_000)
  const renderer = await startRenderer({ ...loadConfig({}), RENDERER_PORT: 0, POOL_SIZE: 1 })
  try {
    const { page, errors } = await open(browser)
    // 演示宿主把 docx 发到 /convert：测试里转给真的渲染服务
    await page.route('**/convert', async (route) => {
      const r = await renderer.app.inject({ method: 'POST', url: '/convert', payload: route.request().postDataJSON() as object })
      await route.fulfill({ status: r.statusCode, contentType: 'application/json', body: r.body })
    })
    await page.click('.oe .toolbar [aria-label="导出"]')
    await expect(page.locator('.oe .menu [data-import]')).toBeVisible()
    await page.setInputFiles('.oe input[type="file"]', path.join(root, 'packages', 'docx', 'src', '__fixtures__', 'sample-contract.docx'))
    const report = page.locator('.oe .import-report')
    await expect(report).toBeVisible({ timeout: 30_000 })
    await expect(report.locator('.report-row').first()).toContainText('一字不差')
    for (const [kind, level] of [['tableHeader', 'fixed'], ['spacing', 'fixed'], ['pageNumber', 'fixed'], ['firstLineIndent', 'lost'], ['numbering', 'lost']])
      await expect(report.locator(`[data-kind="${kind}"][data-level="${level}"]`), `${kind}:${level}`).toHaveCount(1)
    await expect(page.locator('.oe .doc-status')).toHaveText('已导入')
    expect(await count(page, '设备采购合同')).toBe(1)
    // 保存后重新打开：导入的正文和纸张设置都在
    await page.click('.oe .oe-primary')
    await expect(page.locator('.oe .doc-status')).toHaveText('已保存')
    await page.reload()
    await ready(page)
    await page.waitForTimeout(400)
    expect(await count(page, '设备采购合同')).toBe(1)
    const pageSetup = await page.evaluate(() => ((window as unknown as Win).__oe.getData().doc as { page?: unknown }).page)
    expect(pageSetup).toMatchObject({ width: 794, height: 1123, pageNumber: { format: '第 {pageNo} 页 共 {pageCount} 页' } })
    expect(errors).toEqual([])
  } finally {
    await renderer.close()
  }
})

test('真实合同导入：正文完整、损失报告可见，保存重开后文字和纸张设置保留（验收 3）', async ({ browser }) => {
  const source = process.env.OE_REAL_CONTRACT
  test.skip(!source, '通过 OE_REAL_CONTRACT 指定本地真实合同，不把合同正文加入测试仓库')
  test.setTimeout(120_000)
  const scan = await scanDocx(fs.readFileSync(source!))
  const expectedText = squeeze(scan.bodyText)
  const renderer = await startRenderer({ ...loadConfig({}), RENDERER_PORT: 0, POOL_SIZE: 1 })
  try {
    const { page, errors } = await open(browser)
    let importedReport: ImportReport | undefined
    await page.route('**/convert', async (route) => {
      const result = await renderer.app.inject({ method: 'POST', url: '/convert', payload: route.request().postDataJSON() as object })
      expect(result.statusCode).toBe(200)
      importedReport = result.json<{ report: ImportReport }>().report
      await route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body })
    })
    await page.click('.oe .toolbar [aria-label="导出"]')
    await page.setInputFiles('.oe input[type="file"]', source!)
    const report = page.locator('.oe .import-report')
    await expect(report).toBeVisible({ timeout: 30_000 })
    expect(importedReport!.textExact).toBe(true)
    await expect(report.locator('.report-row').first()).toContainText('一字不差')
    for (const item of importedReport!.items.filter((item) => item.level === 'lost'))
      await expect(report.locator(`[data-kind="${item.kind}"][data-level="lost"]`)).toContainText(item.message)
    const importedDoc = await page.evaluate(() => (window as unknown as Win).__oe.getData().doc as DocData)
    expect(squeeze(textOf(importedDoc.main)) === expectedText, '导入后的正文与源文件一致（忽略空白）').toBe(true)
    // getText 包含编辑器生成的自动编号，源 DOCX 的 w:t 不含这些编号；正文单独比对，显示文字在重开前后比对。
    const displayedText = squeeze(await text(page))
    expect(displayedText.length).toBeGreaterThanOrEqual(expectedText.length)
    await page.screenshot({ path: path.join(evidence, 'real-contract-import.png'), fullPage: true })
    await page.click('.oe .oe-primary')
    await expect(page.locator('.oe .doc-status')).toHaveText('已保存')
    await page.reload()
    await ready(page)
    await expect.poll(async () => squeeze(await text(page)) === displayedText).toBe(true)
    const reopenedDoc = await page.evaluate(() => (window as unknown as Win).__oe.getData().doc as DocData)
    expect(squeeze(textOf(reopenedDoc.main)) === expectedText, '保存重开后的正文与源文件一致（忽略空白）').toBe(true)
    expect(reopenedDoc.page).toEqual(importedDoc.page)
    expect(errors).toEqual([])
  } finally {
    await renderer.close()
  }
})

test('同一字段三处：在一处输入另外两处同步，撤销一次后三处仍一致（验收 7）', async ({ browser }) => {
  const { page } = await open(browser)
  expect(await controlIds(page, 'partyA')).toHaveLength(3)
  // 在中间那一处（第一条里）输入
  await typeInField(page, 'partyA', '甲乙丙', 1)
  expect(await fieldValues(page, 'partyA')).toEqual(['甲乙丙', '甲乙丙', '甲乙丙'])
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  const after = await fieldValues(page, 'partyA')
  expect(new Set(after).size).toBe(1)
  expect(after[0]).not.toBe('甲乙丙')
})

test('元素权限：只读的改不了，隐藏的看不到，必填的为空时提交报错（验收 5 的前端部分）', async ({ browser }) => {
  // 模拟后端按令牌给的模式和权限
  const { page, errors } = await open(browser, 'light', '?mode=fill&perm=contractNo:readonly,partyAAddress:hidden,signDate:required')
  // 只给了填写模式，切不到编辑模式绕过权限
  await expect(page.locator('.oe [role="tablist"]')).toHaveCount(0)
  await typeInField(page, 'contractNo', 'A1')
  expect(await fieldValues(page, 'contractNo')).toEqual([null])
  const props = (await page.evaluate(() => {
    const data = (window as unknown as Win).__oe.getData().doc as { main: { control?: { conceptId?: string; hide?: boolean; disabled?: boolean } }[] }
    return data.main.filter((e) => e.control?.conceptId).map((e) => ({ key: e.control!.conceptId, hide: !!e.control!.hide, disabled: !!e.control!.disabled }))
  })) as { key: string; hide: boolean; disabled: boolean }[]
  expect(props.find((p) => p.key === 'contractNo')).toMatchObject({ disabled: true })
  expect(props.find((p) => p.key === 'partyAAddress')).toMatchObject({ hide: true })
  await expect(page.locator('.oe .inspector [data-locate="partyAAddress"]')).toHaveCount(0)
  await page.click('.oe .oe-primary')
  await expect(page.locator('.oe .doc-status')).toHaveText('1 项未填')
  expect(await page.evaluate(() => (window as unknown as { __oe: { validate(): unknown } }).__oe.validate())).toMatchObject({ ok: false, missing: ['signDate'] })
  expect(errors).toEqual([])
})

test('元素：插入占位、下拉、数据选择、表格循环、图片、印章并绑定字段，保存后重新打开类型、id、绑定都不变（验收 6）', async ({ browser }) => {
  const { page, errors } = await open(browser)
  const toEnd = async () => {
    const r = ((await cmd(page, 'getKeywordRangeList', '（以下无正文）')) as { endIndex: number }[])[0]!
    await cmd(page, 'executeSetRange', r.endIndex, r.endIndex)
  }
  // 新建字段：名称、类型、键（下拉再填选项），添加后插到光标处
  const create = async (label: string, type: string, key: string, options?: string) => {
    await toEnd()
    await page.click('.oe .inspector [aria-label="新建字段"]')
    await page.fill('.oe .field-form [aria-label="名称"]', label)
    await page.selectOption('.oe .field-form [aria-label="类型"]', type)
    await page.fill('.oe .field-form [aria-label="键"]', key)
    if (options) await page.fill('.oe .field-form [aria-label="选项"]', options)
    await page.click('.oe .field-form button[type="submit"]')
    await expect(page.locator('.oe .field-form')).toHaveCount(0)
  }
  await create('联系人', 'text', 'contact')
  await create('交货方式', 'select', 'delivery', '送货上门、自提')
  await create('供应商', 'picker', 'vendor')
  for (const key of ['items', 'photo']) {
    await toEnd()
    await page.click(`.oe .inspector [data-insert="${key}"]`)
  }
  await setMode(page, 'seal')
  await page.locator('.oe .pages').scrollIntoViewIfNeeded()
  await page.dragAndDrop('.oe .seal-card[data-seal="official"]', '.oe .pages', { targetPosition: { x: 400, y: 300 } })
  await expect(page.locator('.oe .seal-handle')).toHaveCount(1)
  await setMode(page, 'edit')

  // 每个元素：类型、id、绑定的字段
  const elements = () =>
    page.evaluate(() => {
      type El = { type?: string; id?: string; controlId?: string; control?: { type: string; conceptId?: string }; extension?: { field?: string; seal?: { sealId: string } }; trList?: { extension?: { loop?: string }; pagingRepeat?: boolean }[] }
      const main = ((window as unknown as Win).__oe.getData().doc as { main: El[] }).main
      const out: Record<string, unknown> = {}
      for (const e of main) {
        if (e.type === 'control' && ['contact', 'delivery', 'vendor'].includes(e.control!.conceptId!)) out[e.control!.conceptId!] = { type: e.control!.type, id: e.controlId }
        if (e.type === 'image' && e.extension?.field) out[e.extension.field] = { type: 'image', id: e.id }
        if (e.type === 'image' && e.extension?.seal) out.seal = { type: 'image', id: e.id, sealId: e.extension.seal.sealId }
        if (e.type === 'table' && e.trList?.some((tr) => tr.extension?.loop)) out.items = { type: 'table', id: e.id, loop: e.trList.find((tr) => tr.extension?.loop)!.extension!.loop, header: !!e.trList[0]!.pagingRepeat }
      }
      return out
    })
  const before = await elements()
  expect(before).toMatchObject({
    contact: { type: 'text' },
    delivery: { type: 'select' },
    vendor: { type: 'text' },
    items: { type: 'table', loop: 'items', header: true },
    photo: { type: 'image' },
    seal: { type: 'image', sealId: 'official' },
  })
  for (const v of Object.values(before)) expect((v as { id?: string }).id).toBeTruthy()

  await page.click('.oe .oe-primary')
  await expect(page.locator('.oe .doc-status')).toHaveText('已保存')
  await page.reload()
  await ready(page)
  await page.waitForTimeout(400)
  expect(await elements()).toEqual(before)
  // 新建的字段定义也保存了
  const keys = await page.evaluate(() => ((window as unknown as Win).__oe.getData() as unknown as { fields: { key: string; type: string }[] }).fields.map((f) => `${f.key}:${f.type}`))
  expect(keys).toEqual(expect.arrayContaining(['contact:text', 'delivery:select', 'vendor:picker']))
  expect(errors).toEqual([])
})

test('数据选择：弹层贴着控件，回车选中，带出多个字段并存快照（验收 8、9 的前端部分）', async ({ browser }) => {
  const { page } = await open(browser)
  await setMode(page, 'fill')
  await page.locator('.oe .inspector [data-locate="partyA"]').click()
  await expect(page.locator('.oe .picker')).toBeVisible()
  // 列表是接口返回的，等它出来再按键
  await expect(page.locator('.oe .picker-list li')).toHaveCount(5)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('.oe .picker')).toHaveCount(0)
  const v = await values(page)
  expect(v.values.partyA).toBe('上海浦江重型装备股份有限公司')
  expect(v.values.partyAAddress).toBe('上海市闵行区江川路 1800 号')
  expect(v.values.partyACredit).toBe('91310112MA1K4B2X7Q')
  expect(v.snapshots?.partyA).toMatchObject({ sourceId: 'c2' })
  expect(await fieldValues(page, 'partyA')).toEqual(['上海浦江重型装备股份有限公司', '上海浦江重型装备股份有限公司', '上海浦江重型装备股份有限公司'])
})

test('远程数据源：按关键字查模拟接口、翻页，选中带出 3 个字段；接口请求都经过宿主注入的 request（验收 8）', async ({ browser }) => {
  const { page, sent, errors } = await open(browser)
  await setMode(page, 'fill')
  await page.locator('.oe .inspector [data-locate="partyA"]').click()
  const list = page.locator('.oe .picker-list li')
  const pager = page.locator('.oe .picker-pager span')
  await expect(list).toHaveCount(5)
  await expect(pager).toHaveText('1 / 3')
  // 翻页：第 2 页从第 6 条开始
  await page.click('.oe .picker [aria-label="下一页"]')
  await expect(pager).toHaveText('2 / 3')
  await expect(list.first()).toContainText('宁波港城模具有限公司')
  // 关键字：地址里有「江苏」的 6 家，2 页，回到第 1 页
  await page.fill('.oe .picker input[type="search"]', '江苏')
  await expect(pager).toHaveText('1 / 2')
  await expect(list).toHaveCount(5)
  await expect(list.first()).toContainText('苏州工业园区精工机械有限公司')
  await page.keyboard.press('Enter')
  await expect(page.locator('.oe .picker')).toHaveCount(0)
  const v = await values(page)
  expect([v.values.partyA, v.values.partyAAddress, v.values.partyACredit]).toEqual(['苏州工业园区精工机械有限公司', '江苏省苏州市工业园区星湖街 328 号', '91320594MA1N3C8Y5P'])
  // 页面发出的接口请求：只有客户接口，每一个都带着宿主的登录态（只有宿主的 request 会带）；关键字、页码、条数都在
  expect(sent.length).toBeGreaterThanOrEqual(3)
  for (const s of sent) {
    expect(s.url.pathname).toBe('/api/customers')
    expect(s.auth).toBe(HOST_TOKEN)
  }
  expect(sent.map((s) => `${s.url.searchParams.get('q')}:${s.url.searchParams.get('page')}:${s.url.searchParams.get('size')}`)).toEqual(expect.arrayContaining([':1:5', ':2:5', '江苏:1:5']))
  expect(errors).toEqual([])
})

// 编辑器每次装文档都会重新生成的 id，比较前去掉
const RANDOM_IDS = new Set(['id', 'controlId', 'titleId', 'tableId', 'trId', 'tdId', 'listId', 'areaId', 'hyperlinkId', 'dateId', 'groupIds'])
const norm = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !RANDOM_IDS.has(k)).map(([k, x]) => [k, norm(x)])) : v

test('表格循环：30 条数据生成 30 行、跨页、表头每页重复，和 @oe/core 生成的一致（验收 10 的前端部分）', async ({ browser }) => {
  const { page, errors } = await open(browser)
  const at = ((await cmd(page, 'getKeywordRangeList', '（以下无正文）')) as { endIndex: number }[])[0]!
  await cmd(page, 'executeSetRange', at.endIndex, at.endIndex)
  await page.click('.oe .inspector [data-insert="items"]')
  await page.waitForTimeout(200)
  const pagesBefore = await page.locator('.oe .doc canvas').count()
  const before = (await page.evaluate(() => (window as unknown as Win).__oe.getData().doc)) as DocData
  const rows = Array.from({ length: 30 }, (_, i) => ({ name: `数控车床 ${i + 1} 号`, model: `CK61-${i + 1}`, qty: (i % 3) + 1, price: 120000 + i * 100 }))
  await page.evaluate((rows) => (window as unknown as { __oe: { setData(v: unknown): void } }).__oe.setData({ items: rows }), rows)
  await page.waitForTimeout(400)

  type Tr = { pagingRepeat?: boolean; extension?: { loop?: string; index?: number }; tdList: { value: { controlId?: string; control?: { conceptId?: string } }[] }[] }
  const after = (await page.evaluate(() => (window as unknown as Win).__oe.getData())) as unknown as { doc: { main: { type?: string; trList?: Tr[] }[] }; values: { values: Record<string, unknown> } }
  const table = after.doc.main.find((e) => e.type === 'table' && e.trList?.some((tr) => tr.extension?.loop === 'items'))!
  expect(table.trList).toHaveLength(31)
  expect(table.trList![0]!.pagingRepeat).toBe(true)
  expect(table.trList!.slice(1).map((tr) => tr.extension)).toEqual(rows.map((_, i) => ({ loop: 'items', index: i })))
  expect(after.values.values.items).toHaveLength(30)
  expect((after.values.values.items as unknown[])[29]).toEqual({ name: '数控车床 30 号', model: 'CK61-30', qty: '3', price: '122900' })
  // 每行的控件各有自己的 controlId（不沿用模板行的）
  const ids = table.trList!.slice(1).map((tr) => tr.tdList[0]!.value.find((x) => x.control)?.controlId)
  expect(new Set(ids).size).toBe(30)
  // 跨页
  expect(await page.locator('.oe .doc canvas').count()).toBeGreaterThan(pagesBefore)
  // 表头每页重复：编辑器只是把表头行再画一遍（不是元素，搜不到），所以比像素：表开始那页表头那一条，在下一页顶部附近能找到一模一样的
  const repeat = await page.evaluate(async () => {
    type Pos = { pageNo: number; lineHeight: number; coordinate: { leftTop: number[]; rightTop: number[] } }
    const c = (window as unknown as { __oe: { editor: { command: Record<string, (...a: unknown[]) => unknown> } } }).__oe.editor.command
    const hit = (c.getKeywordContext!('单价（元）') as { startPosition: Pos; endPosition: Pos }[])[0]!
    const p = hit.startPosition
    const imgs = (await c.getImage!({ pixelRatio: 1 })) as string[]
    const canvasOf = async (src: string) => {
      const img = new Image()
      await new Promise((r) => ((img.onload = r), (img.src = src)))
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const g = cv.getContext('2d', { willReadFrequently: true })!
      g.drawImage(img, 0, 0)
      return g
    }
    const x = Math.floor(p.coordinate.leftTop[0]!) - 2
    const w = Math.ceil(hit.endPosition.coordinate.rightTop[0]! - p.coordinate.leftTop[0]!) + 4
    const y = Math.floor(p.coordinate.leftTop[1]!)
    const h = Math.ceil(p.lineHeight)
    const ref = (await canvasOf(imgs[p.pageNo]!)).getImageData(x, y, w, h).data
    const next = await canvasOf(imgs[p.pageNo + 1]!)
    for (let yy = 0; yy < 400; yy++) {
      const d = next.getImageData(x, yy, w, h).data
      let diff = 0
      for (let i = 0; i < d.length; i += 4) diff += Math.abs(d[i]! - ref[i]!)
      if (diff / (w * h) < 1) return { found: true, page: p.pageNo, y: yy }
    }
    return { found: false, page: p.pageNo, y: -1 }
  })
  expect(repeat.found, JSON.stringify(repeat)).toBe(true)

  // 同样的输入在 Node 里用 @oe/core 生成，装进编辑器后和浏览器里生成的相同
  const byCore = structuredClone(before)
  setFieldValues(byCore, { items: rows }, FIELDS)
  const other = await open(browser)
  await other.page.evaluate((s) => localStorage.setItem('oe-demo-document', s), JSON.stringify({ doc: byCore, values: { values: {} }, fields: FIELDS }))
  await other.page.reload()
  await ready(other.page)
  await other.page.waitForTimeout(400)
  const coreDoc = await other.page.evaluate(() => (window as unknown as Win).__oe.getData().doc)
  expect(norm(coreDoc)).toEqual(norm(after.doc))
  expect(errors).toEqual([])
})

test('快照：选中后接口里这条记录改了，重新打开仍是选中时的值（验收 9 的前端部分）', async ({ browser }) => {
  const { page, customers } = await open(browser)
  await setMode(page, 'fill')
  await page.locator('.oe .inspector [data-locate="partyA"]').click()
  await expect(page.locator('.oe .picker-list li')).toHaveCount(5)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.click('.oe .oe-primary')
  await expect(page.locator('.oe .doc-status')).toHaveText('已提交')
  // 接口里这家公司改名、搬家
  Object.assign(customers.find((c) => c.id === 'c2')!, { name: '浦江重工集团有限公司', address: '上海市浦东新区世纪大道 100 号' })
  await page.reload()
  await ready(page)
  await page.waitForTimeout(400)
  expect(await fieldValues(page, 'partyA')).toEqual(['上海浦江重型装备股份有限公司', '上海浦江重型装备股份有限公司', '上海浦江重型装备股份有限公司'])
  const v = await values(page)
  expect(v.values.partyAAddress).toBe('上海市闵行区江川路 1800 号')
  expect(v.snapshots?.partyA).toMatchObject({ sourceId: 'c2', text: '上海浦江重型装备股份有限公司' })
  // 存下来的文档（导出、出 PDF 用的就是它，渲染时不调接口）里也是选中时的值
  const stored = await page.evaluate(() => localStorage.getItem('oe-demo-document') ?? '')
  expect(stored).toContain('上海浦江重型装备股份有限公司')
  expect(stored).not.toContain('浦江重工集团有限公司')
})

test('必填：为空时提交报错并定位，填好后才提交（验收 5 的前端部分）', async ({ browser }) => {
  const { page } = await open(browser)
  const ids = await controlIds(page, 'contractNo')
  await cmd(page, 'executeLocationControl', ids[0], { position: 'after' })
  await page.waitForTimeout(200)
  await page.locator('.oe .segmented.small [data-perm="required"]').click()
  await setMode(page, 'fill')
  await page.click('.oe .oe-primary')
  await expect(page.locator('.oe .doc-status')).toHaveText('1 项未填')
  await typeInField(page, 'contractNo', 'HT02')
  await page.click('.oe .oe-primary')
  await expect(page.locator('.oe .doc-status')).toHaveText('已提交')
})

test('可编辑区：填写模式只能改可编辑区和字段，盖章、只读改不了；编辑模式把选中的文字设成可编辑区；保存的文档只存可编辑标记（验收 4）', async ({ browser }) => {
  const { page, errors } = await open(browser)
  type Area = { extension?: { anchor?: string; editable?: boolean } } & Record<string, unknown>
  const areasOf = () =>
    page.evaluate(() => ((window as unknown as Win).__oe.getData().doc as { main: { type?: string; area?: Area }[] }).main.filter((e) => e.type === 'area').map((e) => e.area!))
  // 要提交的可编辑区（只有改过的），每个拼成一段文字
  const areaTexts = () =>
    page.evaluate(() => {
      const areas = (window as unknown as { __oe: { getData(): { areas?: Record<string, { value: string }[]> } } }).__oe.getData().areas ?? {}
      return Object.fromEntries(Object.entries(areas).map(([k, runs]) => [k, runs.map((r) => r.value).join('')]))
    })
  // 样例的第九条是可编辑区；没改的不提交
  await setMode(page, 'fill')
  expect(await areaTexts()).toEqual({})
  await typeInBody(page, '双方无', 'X')
  expect(await count(page, '双方无X其他约定')).toBe(1)
  await typeInBody(page, '民法典》', 'Y')
  expect(await count(page, 'Y')).toBe(0)
  expect(await areaTexts()).toEqual({ supplement: '双方无X其他约定。' })
  for (const m of ['seal', 'view']) {
    await setMode(page, m)
    await typeInBody(page, '双方无', 'Z')
    expect(await count(page, 'Z'), m).toBe(0)
  }
  // 编辑模式：选中第八条那句，设成可编辑区；填写模式里就能改
  await setMode(page, 'edit')
  // getKeywordRangeList 的 startIndex 是第一个字本身，选区从它前一个位置开始才包含第一个字
  const r = ((await cmd(page, 'getKeywordRangeList', '本合同一式肆份')) as { startIndex: number; endIndex: number }[])[0]!
  await cmd(page, 'executeSetRange', r.startIndex - 1, r.endIndex)
  const button = page.locator('.oe .format-bar [aria-label="可编辑区"]')
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  // 光标放进这个区域再点：取消可编辑，填写模式里改不了；再点一次恢复
  const intoArea = async () => {
    const k = ((await cmd(page, 'getKeywordRangeList', '本合同一式肆份')) as { startIndex: number }[])[0]!
    await cmd(page, 'executeSetRange', k.startIndex + 2, k.startIndex + 2)
  }
  await intoArea()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await setMode(page, 'fill')
  await typeInBody(page, '本合同一式肆份', 'V')
  expect(await count(page, '本合同一式肆份V')).toBe(0)
  await setMode(page, 'edit')
  await intoArea()
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await setMode(page, 'fill')
  await typeInBody(page, '本合同一式肆份', 'W')
  expect(await count(page, '本合同一式肆份W')).toBe(1)
  // 保存的文档：区域只带 extension（anchor、editable），不带按模式现设的能不能改和底色；新设的区域里是选中的那句
  const areas = await areasOf()
  expect(areas).toHaveLength(2)
  for (const a of areas) {
    expect(a).not.toHaveProperty('mode')
    expect(a).not.toHaveProperty('backgroundColor')
    expect(a.extension).toMatchObject({ editable: true, anchor: expect.any(String) })
  }
  expect(Object.values(await areaTexts()).sort()).toEqual(['双方无X其他约定。', '本合同一式肆份W'])
  // 选区里有字段的不能设成可编辑区（可编辑区里只放文字）
  await setMode(page, 'edit')
  const f = ((await cmd(page, 'getKeywordRangeList', '合同编号：')) as { startIndex: number; endIndex: number }[])[0]!
  await cmd(page, 'executeSetRange', f.startIndex - 1, f.endIndex + 2)
  await expect(button).toBeDisabled()
  // 只选文字又能设了
  await cmd(page, 'executeSetRange', f.startIndex - 1, f.endIndex)
  await expect(button).toBeEnabled()
  expect(errors).toEqual([])
})

test('只读模式按权限显示打印、下载：只给打印就没有下载和导出，都不给就都没有（验收 4）', async ({ browser }) => {
  for (const [q, print, download] of [
    ['?mode=view', 1, 1],
    ['?mode=view&actions=print', 1, 0],
    ['?mode=view&actions=', 0, 0],
  ] as const) {
    const { page, errors } = await open(browser, 'light', q)
    await expect(page.locator('.oe .oe-print'), q).toHaveCount(print)
    await expect(page.locator('.oe .oe-primary'), q).toHaveCount(download)
    await expect(page.locator('.oe .oe-export'), q).toHaveCount(download)
    expect(errors).toEqual([])
    await page.close()
  }
})

test('接真实服务端全流程：宿主改值改条款后打开编辑器看到改后的；编辑走 PUT，填写走 PATCH，盖章走 /seals 再提交；盖章后只能只读打开、接口拒绝修改；下载 PDF；只给打印的令牌不能下载；令牌和登录态不进任何地址（验收 4、5、11、14、16）', async ({ browser }) => {
  test.setTimeout(240_000)
  const renderer = await startRenderer({ ...loadConfig({}), RENDERER_PORT: 0, POOL_SIZE: 1 })
  const server = await startTempServer(httpRenderer(renderer.origin, 60_000))
  try {
    // 宿主后端调服务端：API Key 只在这里
    const host: ServerApi = async (method, url, body) => {
      const r = await server.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${server.apiKey}` }, payload: body as object | undefined })
      return { status: r.statusCode, json: r.json() }
    }
    const t = await host('POST', '/api/templates', { name: '采购合同', doc: sampleDoc(), fields: FIELDS })
    expect(t.status, JSON.stringify(t.json)).toBe(200)
    const created = await host('POST', '/api/documents', { templateId: (t.json as { id: string }).id, versionNo: 1, values: { partyAAddress: '上海市闵行区江川路 1800 号' } })
    expect(created.status, JSON.stringify(created.json)).toBe(200)
    const docId = (created.json as { id: string }).id
    type Seal = { sealId: string; sealName: string; pageNo: number; x: number; y: number; operator: string; at: string }
    type Stored = { status: string; version: number; doc: { main: { type?: string; value?: string }[] }; values: { values: Record<string, unknown> }; pageCount: number | null; seals: Seal[] }
    const stored = async () => (await host('GET', `/api/documents/${docId}`)).json as Stored
    const textOf = (s: Stored) => s.doc.main.filter((e) => !e.type || e.type === 'text').map((e) => e.value ?? '').join('')

    // 浏览器这边：/host/token 由测试跑演示宿主的后端（host-backend.ts，和 vite 中间件是同一份代码），/api/documents 原样转给服务端
    const tokens: string[] = []
    const urls: string[] = []
    type Call = { method: string; path: string; status: number; token: boolean; auth: boolean; req: Record<string, unknown> | null; res: string }
    const calls: Call[] = []
    const connect = async (page: Page) => {
      page.on('request', (r) => urls.push(r.url()))
      await page.route('**/host/token', async (route) => {
        const r = await issueToken(host, route.request().headers()['authorization'], route.request().postDataJSON())
        if (r.status === 200) tokens.push((r.json as { token: string }).token)
        await route.fulfill({ status: r.status, json: r.json })
      })
      await page.route('**/api/documents/**', async (route) => {
        const req = route.request()
        const u = new URL(req.url())
        const h = req.headers()
        const r = await server.app.inject({
          method: req.method() as 'GET',
          url: u.pathname + u.search,
          headers: Object.fromEntries(Object.entries(h).filter(([k]) => k === 'x-document-token' || k === 'content-type')),
          payload: req.postDataBuffer() ?? undefined,
        })
        const json = String(r.headers['content-type'] ?? '').startsWith('application/json')
        calls.push({ method: req.method(), path: u.pathname.replace(docId, ':id'), status: r.statusCode, token: !!h['x-document-token'], auth: 'authorization' in h, req: req.postData() ? req.postDataJSON() : null, res: json ? r.body : '' })
        const headers = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !['content-length', 'transfer-encoding', 'connection'].includes(k)).map(([k, v]) => [k, String(v)]))
        await route.fulfill({ status: r.statusCode, headers, body: r.rawPayload })
      })
    }

    // 1. 宿主不打开编辑器，直接改值、改一段条款（验收 14）
    let s = await stored()
    expect((await host('PATCH', `/api/documents/${docId}/data`, { patch: { contractNo: 'HT-2026-0101' }, version: s.version })).status).toBe(200)
    s = await stored()
    const clause = '设备质量保证期为验收合格之日起二十四个月。质保期内因设备本身质量问题造成的故障，乙方应在接到通知后二十四小时内响应，四十八小时内到场维修，费用由乙方承担。'
    const op = await host('POST', `/api/documents/${docId}/operations`, { ops: [{ op: 'setText', target: { text: '质量保证期为验收合格之日起十二个月' }, text: clause }], version: s.version })
    expect(op.status, JSON.stringify(op.json)).toBe(200)

    // 2. 编辑模式（模板作者）：打开就是改后的内容；改正文，保存走 PUT
    const edit = await open(browser, 'light', `?doc=${docId}&mode=edit`, connect)
    await expect(edit.page.locator('.oe [role="tablist"]')).toHaveCount(0)
    expect(await count(edit.page, '二十四个月')).toBe(1)
    expect(await fieldValues(edit.page, 'contractNo')).toEqual(['HT-2026-0101'])
    await typeInBody(edit.page, '民法典》', 'X')
    await edit.page.click('.oe .oe-primary')
    await expect(edit.page.locator('.oe .doc-status')).toHaveText('已保存')
    s = await stored()
    expect(textOf(s)).toContain('民法典》X')
    expect(s.pageCount).toBeGreaterThan(0)
    expect(edit.errors).toEqual([])
    await edit.page.close()

    // 3. 填写模式：只读的改不了；隐藏的服务端不下发、也不会被覆盖；必填的为空不让提交；提交走 PATCH（验收 5）
    let from = calls.length
    const fill = await open(browser, 'light', `?doc=${docId}&mode=fill&perm=contractNo:readonly,partyAAddress:hidden,amount:required`, connect)
    const opened = calls.slice(from).find((c) => c.method === 'GET')!
    expect(opened.res).toContain('HT-2026-0101')
    expect(opened.res).not.toContain('江川路')
    await expect(fill.page.locator('.oe .inspector [data-locate="partyAAddress"]')).toHaveCount(0)
    await typeInField(fill.page, 'contractNo', 'Z')
    expect(await fieldValues(fill.page, 'contractNo')).toEqual(['HT-2026-0101'])
    // 数据选择：选第 2 家（验收 9：之后接口里这家改名，下载的 PDF 里仍是选中时的名字）
    await fill.page.locator('.oe .inspector [data-locate="partyA"]').click()
    await expect(fill.page.locator('.oe .picker-list li')).toHaveCount(5)
    await fill.page.keyboard.press('ArrowDown')
    await fill.page.keyboard.press('Enter')
    await expect(fill.page.locator('.oe .picker')).toHaveCount(0)
    await fill.page.click('.oe .oe-primary')
    await expect(fill.page.locator('.oe .doc-status')).toHaveText('1 项未填')
    await typeInField(fill.page, 'amount', '128000')
    // 可编辑区（第九条）也能改，和字段值一起提交
    await typeInBody(fill.page, '双方无', '另行')
    await fill.page.click('.oe .oe-primary')
    await expect(fill.page.locator('.oe .doc-status')).toHaveText('已提交')
    const patch = calls.slice(from).find((c) => c.method === 'PATCH')!
    expect(patch.status).toBe(200)
    expect(Object.keys(patch.req!.patch as object)).not.toContain('contractNo')
    expect(Object.keys(patch.req!.patch as object)).not.toContain('partyAAddress')
    const sentAreas = patch.req!.areas as Record<string, { value: string }[]>
    expect(Object.keys(sentAreas)).toEqual(['supplement'])
    expect(sentAreas.supplement!.map((r) => r.value).join('')).toBe('双方无另行其他约定。')
    s = await stored()
    const supplement = (s.doc.main as { area?: { extension?: { anchor?: string } }; valueList?: { value: string }[] }[]).find((e) => e.area?.extension?.anchor === 'supplement')
    expect(supplement?.valueList?.map((v) => v.value).join('')).toBe('双方无另行其他约定。')
    expect(s.values.values).toMatchObject({ contractNo: 'HT-2026-0101', partyA: '上海浦江重型装备股份有限公司', partyACredit: '91310112MA1K4B2X7Q', partyAAddress: '上海市闵行区江川路 1800 号' })
    expect(String(s.values.values.amount)).toBe('128000')
    // 接口里这家公司改名
    Object.assign(fill.customers.find((c) => c.id === 'c2')!, { name: '浦江重工集团有限公司' })
    expect(fill.errors).toEqual([])
    await fill.page.close()

    // 4. 盖章：宿主后端发盖章令牌时开始盖章；放章、拖章逐个走 /seals，「完成」走 /seal-status 提交（验收 11）
    from = calls.length
    const seal = await open(browser, 'light', `?doc=${docId}&mode=seal`, connect)
    await seal.page.dragAndDrop('.oe .seal-card[data-seal="contract"]', '.oe .pages', { targetPosition: { x: 400, y: 500 } })
    const h = seal.page.locator('.oe .seal-handle')
    await expect(h).toHaveCount(1)
    await expect(seal.page.locator('.oe .doc-status')).toHaveText('已保存')
    await h.scrollIntoViewIfNeeded()
    const b = (await h.boundingBox())!
    await seal.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await seal.page.mouse.down()
    await seal.page.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2 + 40, { steps: 5 })
    await seal.page.mouse.up()
    // 移章还在途时就点「完成」：提交排在移章后面
    await seal.page.click('.oe .oe-primary')
    await expect(seal.page.locator('.oe .doc-status')).toHaveText('已完成')
    const sealCalls = calls.slice(from).filter((c) => c.method === 'POST')
    expect(sealCalls.map((c) => [c.path, c.req!.action, c.status])).toEqual([
      ['/api/documents/:id/seals', 'place', 200],
      ['/api/documents/:id/seals', 'move', 200],
      ['/api/documents/:id/seal-status', 'submit', 200],
    ])
    s = await stored()
    expect(s.status).toBe('sealed')
    expect(s.seals).toHaveLength(1)
    const placed = sealCalls[0]!.req!.seal as { x: number; y: number }
    expect(s.seals[0]).toMatchObject({ sealId: 'contract', sealName: '合同专用章', pageNo: 0, x: placed.x + 80, y: placed.y + 40, operator: DEMO_USER })
    expect(Date.parse(s.seals[0]!.at)).toBeGreaterThan(0)
    expect(seal.errors).toEqual([])
    await seal.page.close()

    // 5. 盖章以后：要填写也只能只读打开，改不了；绕过界面拿填写、编辑令牌直接调接口被拒绝（验收 11）
    const view = await open(browser, 'light', `?doc=${docId}&mode=fill`, connect)
    await expect(view.page.locator('.oe .oe-primary')).toHaveText('下载')
    await typeInBody(view.page, '民法典》', 'W')
    expect(await count(view.page, 'W')).toBe(0)
    for (const [mode, method, suffix, body] of [
      ['fill', 'PATCH', '/data', { patch: { partyACredit: '91310112MA1K4B2X7Q' } }],
      ['edit', 'PUT', '', { doc: s.doc }],
    ] as const) {
      const tk = await host('POST', '/api/tokens', { documentId: docId, mode, userId: 'someone' })
      const r = await server.app.inject({ method, url: `/api/documents/${docId}${suffix}`, headers: { 'x-document-token': (tk.json as { token: string }).token }, payload: { ...body, version: s.version } })
      expect(r.statusCode, r.body).toBe(422)
    }

    // 6. 只读模式下载 PDF：走 /export，用的是服务端存的那一版（含印章）
    const [download] = await Promise.all([view.page.waitForEvent('download'), view.page.click('.oe .oe-primary')])
    expect(download.suggestedFilename()).toBe('采购合同.pdf')
    const pdf = fs.readFileSync((await download.path())!)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    fs.writeFileSync(path.join(evidence, 's13-flow.pdf'), pdf)
    // PDF 文字层：宿主改的编号和条款、填的金额、选中时的公司名（不是接口里改后的）
    const pdfText = (await pdfPageTexts(pdf)).join('')
    for (const w of ['HT-2026-0101', '二十四个月', '128000', '上海浦江重型装备股份有限公司', '上海市闵行区江川路 1800 号']) expect(pdfText, w).toContain(w)
    expect(pdfText).not.toContain('浦江重工集团有限公司')
    expect(calls.find((c) => c.path.endsWith('/export'))?.status).toBe(200)
    expect(view.errors).toEqual([])
    await view.page.close()

    // 7. 只给打印的令牌：没有下载按钮和导出菜单；拿这个令牌直接调 /export 被拒（验收 4）
    const printOnly = await open(browser, 'light', `?doc=${docId}&mode=view&actions=print`, connect)
    await expect(printOnly.page.locator('.oe .oe-print')).toHaveCount(1)
    await expect(printOnly.page.locator('.oe .oe-primary')).toHaveCount(0)
    await expect(printOnly.page.locator('.oe .oe-export')).toHaveCount(0)
    const denied = await server.app.inject({ method: 'GET', url: `/api/documents/${docId}/export?format=pdf`, headers: { 'x-document-token': tokens.at(-1)! } })
    expect(denied.statusCode, denied.body).toBe(403)
    expect(printOnly.errors).toEqual([])
    await printOnly.page.close()

    // 8. POST /render（验收 15）：同一个模板版本建第二份文档，在编辑器里填编号和金额、提交，宿主下载 PDF；
    //    再用同样的数据调 POST /render。60 秒内返回，两份 PDF 页数相同、每页文字相同
    const tplId = (t.json as { id: string }).id
    const doc2 = ((await host('POST', '/api/documents', { templateId: tplId, versionNo: 1 })).json as { id: string }).id
    const fill2 = await open(browser, 'light', `?doc=${doc2}&mode=fill`, connect)
    await typeInField(fill2.page, 'contractNo', 'HT-2026-0202')
    await typeInField(fill2.page, 'amount', '358600')
    await fill2.page.click('.oe .oe-primary')
    await expect(fill2.page.locator('.oe .doc-status')).toHaveText('已提交')
    expect(fill2.errors).toEqual([])
    await fill2.page.close()
    const asHost = { authorization: `Bearer ${server.apiKey}` }
    const exported = await server.app.inject({ method: 'GET', url: `/api/documents/${doc2}/export?format=pdf`, headers: asHost })
    expect(exported.statusCode, exported.body).toBe(200)
    const t0 = Date.now()
    const rendered = await server.app.inject({ method: 'POST', url: '/api/render', headers: asHost, payload: { templateId: tplId, versionNo: 1, values: { contractNo: 'HT-2026-0202', amount: '358600' }, format: 'pdf' } })
    const renderMs = Date.now() - t0
    expect(rendered.statusCode, rendered.body).toBe(200)
    expect(renderMs).toBeLessThan(60_000)
    const fromEditor = await pdfPageTexts(exported.rawPayload)
    const fromRender = await pdfPageTexts(rendered.rawPayload)
    expect(fromRender).toEqual(fromEditor)
    for (const w of ['HT-2026-0202', '358600', '叁拾伍万捌仟陆佰元整']) expect(fromEditor.join(''), w).toContain(w)
    // 两份 PDF 在相同分辨率下逐页比较图像，覆盖排版、字体、字段、页眉页脚。
    const files = await serve(root)
    const cmp = await browser.newPage()
    let pixelDiff: number[] = []
    try {
      await cmp.goto(`${files.origin}/e2e/render/fixture/index.html`)
      await cmp.waitForFunction(() => (window as unknown as { ready?: boolean }).ready)
      pixelDiff = await cmp.evaluate(
        ([a, b]) => (window as unknown as { pdfPixelDiff(a: string, b: string): Promise<number[]> }).pdfPixelDiff(a, b),
        [Buffer.from(exported.rawPayload).toString('base64'), Buffer.from(rendered.rawPayload).toString('base64')] as const,
      )
    } finally {
      await cmp.close()
      await files.close()
    }
    expect(pixelDiff).toEqual(fromEditor.map(() => 0))
    fs.writeFileSync(path.join(evidence, 's13-render-vs-editor.json'), JSON.stringify({ renderMs, pages: fromEditor.length, samePerPageText: true, pixelDiff, firstChars: fromEditor.map((p) => p.slice(0, 30)) }, null, 1))

    // 9. 令牌和宿主登录态不进任何地址（验收 16）：页面、脚本、接口的地址里都没有；接口请求只带文档令牌请求头，不带宿主登录态
    expect(tokens).toHaveLength(6)
    for (const u of urls) for (const secret of [...tokens, server.apiKey, HOST_TOKEN.slice('Bearer '.length)]) expect(u).not.toContain(secret)
    expect(calls.filter((c) => !c.token || c.auth)).toEqual([])
  } finally {
    await server.stop()
    await renderer.close()
  }
})

// 界面规范逐项比对：颜色只有主色和灰（RGB 三值相差 12 以内算灰）、字体是系统字体栈、尺寸和圆角按规范
for (const scheme of ['light', 'dark'] as const) {
  test(`界面规范比对（${scheme === 'light' ? '浅色' : '深色'}）`, async ({ browser }) => {
    const { page, errors } = await open(browser, scheme)
    const audit = async (name: string) => {
      await page.waitForTimeout(350)
      await page.screenshot({ path: path.join(evidence, `web-${scheme}-${name}.png`) })
      return page.evaluate(() => {
        const rgba = (s: string) => [...s.matchAll(/rgba?\(([^)]+)\)/g)].map((m) => m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number))
        const ok = ([r, g, b, a = 1]: number[]) =>
          a === 0 ||
          Math.max(r!, g!, b!) - Math.min(r!, g!, b!) <= 12 ||
          (Math.abs(r! - 0) <= 12 && Math.abs(g! - 122) <= 12 && b! >= 252) ||
          (Math.abs(r! - 10) <= 12 && Math.abs(g! - 132) <= 12 && b! >= 252)
        const bad: string[] = []
        const fonts: string[] = []
        for (const el of document.querySelectorAll<HTMLElement>('.oe *')) {
          if (el.closest('.doc') || el.tagName === 'IMG' || el.tagName === 'CANVAS') continue
          const r = el.getBoundingClientRect()
          const s = getComputedStyle(el)
          if (!r.width || !r.height || s.visibility === 'hidden' || s.opacity === '0') continue
          for (const v of [s.color, s.backgroundColor, s.boxShadow, s.borderBottomColor]) for (const c of rgba(v)) if (!ok(c)) bad.push(`${el.className} ${v}`)
          if (!s.fontFamily.startsWith('-apple-system')) fonts.push(`${el.tagName}.${el.className}`)
        }
        const q = (sel: string) => document.querySelector<HTMLElement>(sel)
        const box = (sel: string) => q(sel)?.getBoundingClientRect()
        const cs = (sel: string) => (q(sel) ? getComputedStyle(q(sel)!) : null)
        const canvases = [...document.querySelectorAll('.oe .doc .ce-page-container canvas')].map((c) => c.getBoundingClientRect())
        return {
          bad: bad.slice(0, 10),
          fonts: fonts.slice(0, 10),
          toolbarH: box('.oe .toolbar')?.height,
          controlH: box('.oe .oe-primary')?.height,
          primaryRadius: cs('.oe .oe-primary')?.borderRadius,
          segmentedH: box('.oe .segmented')?.height,
          sidebarW: box('.oe .inspector')?.width,
          rowH: box('.oe .row')?.height ?? null,
          rowRadius: cs('.oe .row')?.borderRadius ?? null,
          formatBarH: q('.oe .format-bar')?.offsetParent ? box('.oe .format-bar')?.height : null,
          popover: q('.oe .picker') ? { w: box('.oe .picker')?.width, radius: cs('.oe .picker')?.borderRadius, padding: cs('.oe .picker')?.padding } : null,
          pageGap: canvases[1] ? Math.round(canvases[1].top - canvases[0]!.bottom) : null,
          thumbTransition: cs('.oe .segmented-thumb')?.transition,
          titleFont: cs('.oe .doc-title') ? `${cs('.oe .doc-title')!.fontSize}/${cs('.oe .doc-title')!.fontWeight}` : null,
          statusFont: cs('.oe .doc-status')?.fontSize,
        }
      })
    }
    const edit = await audit('1-edit')
    expect(edit.bad).toEqual([])
    expect(edit.fonts).toEqual([])
    expect(edit).toMatchObject({ toolbarH: 52, controlH: 28, primaryRadius: '999px', segmentedH: 28, sidebarW: 280, rowH: 32, rowRadius: '6px', formatBarH: 36, pageGap: 24, titleFont: '13px/600', statusFont: '11px' })
    expect(edit.thumbTransition).toContain('0.25s cubic-bezier(0.2, 0.8, 0.2, 1)')
    await setMode(page, 'fill')
    await page.locator('.oe .inspector [data-locate="partyA"]').click()
    await expect(page.locator('.oe .picker')).toBeVisible()
    const fill = await audit('2-fill-picker')
    expect(fill.bad).toEqual([])
    expect(fill.popover).toEqual({ w: 320, radius: '12px', padding: '8px' })
    await page.keyboard.press('Enter')
    await setMode(page, 'seal')
    await page.dragAndDrop('.oe .seal-card[data-seal="contract"]', '.oe .pages', { targetPosition: { x: 420, y: 600 } })
    const seal = await audit('3-seal')
    expect(seal.bad).toEqual([])
    await setMode(page, 'view')
    const view = await audit('4-view')
    expect(view.bad).toEqual([])
    // 只读不显示检查器；0.5px 的分隔线在 1 倍屏上画成 1px
    expect(view.sidebarW ?? 0).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })
}
