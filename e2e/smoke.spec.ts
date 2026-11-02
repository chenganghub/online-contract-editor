import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { serve } from './helpers/serve'

test('系统 Chrome 能打开本地页面', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-smoke-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>冒烟</title>')
  const server = await serve(dir)
  try {
    await page.goto(`${server.origin}/`)
    await expect(page).toHaveTitle('冒烟')
  } finally {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
