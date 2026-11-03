import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { serve } from '../helpers/serve'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let outDir = ''
let origin = ''
let close: () => Promise<void>

test.beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-pages-'))
  const demo = path.join(root, 'apps/demo')
  const result = spawnSync(process.execPath, [path.join(demo, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'pages', '--outDir', path.join(outDir, 'online-contract-editor'), '--logLevel', 'error'], { cwd: demo, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  const server = await serve(outDir)
  origin = server.origin
  close = server.close
})
test.afterAll(async () => {
  await close()
  fs.rmSync(outDir, { recursive: true, force: true })
})

test('Pages 子目录无后端：客户联填、模式切换、保存重开和重置', async ({ page }) => {
  const errors: string[] = []
  const requests: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('request', (r) => requests.push(new URL(r.url()).pathname))
  // 使用具体 index.html，测试静态服务不补目录索引；相对资源路径与 Pages 目录入口一致。
  await page.goto(`${origin}/online-contract-editor/index.html`)
  await page.waitForFunction(() => !!(window as unknown as { __oe: unknown }).__oe)
  await expect(page.getByLabel('在线演示说明')).toContainText('保存仅在当前浏览器')
  await expect(page.locator('.template-design')).toBeVisible()
  await expect(page.getByRole('button', { name: '导出', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: '填写', exact: true }).click()
  await page.locator('.oe .inspector [data-locate="partyA"]').click()
  await expect(page.getByText('苏州工业园区精工机械有限公司', { exact: true })).toBeVisible()
  await page.getByText('苏州工业园区精工机械有限公司', { exact: true }).click()
  await page.evaluate(async () => {
    const editor = (window as unknown as { __oe: { setData(values: Record<string, string>): void; save(): Promise<void> } }).__oe
    editor.setData({ amount: '5200' })
    await editor.save()
  })
  await page.reload()
  await page.waitForFunction(() => !!(window as unknown as { __oe: unknown }).__oe)
  const values = await page.evaluate(() => (window as unknown as { __oe: { getData(): { values: { values: Record<string, unknown> } } } }).__oe.getData().values.values)
  expect(values.amount).toBe('5200')
  expect(values.partyAAddress).toBe('江苏省苏州市工业园区星湖街 328 号')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '重置样例' }).click()
  await page.waitForFunction(() => localStorage.getItem('oe-demo-document') === null)
  expect(requests.filter((url) => /^\/(api|host|convert)(\/|$)/.test(url))).toEqual([])
  expect(errors).toEqual([])
})
