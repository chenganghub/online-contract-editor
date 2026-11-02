import { defineConfig } from '@playwright/test'

// 用系统 Chrome，不下载浏览器；各区域的测试自己用 helpers/serve.ts 起服务，不用全局 webServer
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { channel: 'chrome', headless: true },
})
