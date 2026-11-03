import { defineConfig } from '@playwright/test'

// 用系统 Chrome，不下载浏览器；各区域的测试自己用 helpers/serve.ts 起服务，不用全局 webServer
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: true,
  // 每个 worker 可能同时启动 MySQL、Vite 和渲染 Chrome，限制并发避免争用本机资源。
  workers: 2,
  reporter: [['list']],
  use: { channel: 'chrome', headless: true },
})
