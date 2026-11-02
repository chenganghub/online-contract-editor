// 页面池：一个常驻的无头 Chrome，几个已经打开渲染页的标签。一个标签同时只做一个请求，多的排队。
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { HttpError } from './errors'

export interface Slot {
  page: Page
  uses: number
}

interface Waiter {
  resolve: (s: Slot) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export class PagePool {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private idle: Slot[] = []
  private busy = 0
  private waiters: Waiter[] = []
  private starting: Promise<void> | null = null
  private closed = false

  constructor(private readonly cfg: { chromePath: string; size: number; pageUrl: string; recycleAfter: number }) {}

  async start(): Promise<void> {
    this.starting ??= this.launch().finally(() => (this.starting = null))
    return this.starting
  }

  private async launch() {
    this.browser = await chromium.launch({ executablePath: this.cfg.chromePath, headless: true })
    // Chrome 崩了：丢掉所有标签，下一个请求进来时重新拉起
    this.browser.on('disconnected', () => {
      this.browser = null
      this.context = null
      this.idle = []
    })
    // docx 插件导出时会触发下载；不接收下载，Blob 照样拿得到
    this.context = await this.browser.newContext({ acceptDownloads: false, viewport: { width: 1200, height: 900 } })
    const slots = await Promise.all(Array.from({ length: this.cfg.size }, () => this.open()))
    this.idle.push(...slots)
  }

  private async open(): Promise<Slot> {
    const page = await this.context!.newPage()
    await page.goto(this.cfg.pageUrl)
    await page.waitForFunction(() => (window as unknown as { __renderer?: { ready?: boolean } }).__renderer?.ready === true)
    return { page, uses: 0 }
  }

  async acquire(timeoutMs: number): Promise<Slot> {
    if (this.closed) throw new HttpError(503, 'RENDERER_CLOSED', '渲染服务已关闭')
    if (!this.browser) await this.start()
    const slot = this.idle.pop()
    if (slot) {
      this.busy++
      return slot
    }
    return new Promise<Slot>((resolve, reject) => {
      const w: Waiter = {
        resolve: (s) => {
          this.busy++
          resolve(s)
        },
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w)
          reject(new HttpError(503, 'QUEUE_TIMEOUT', `渲染排队超过 ${timeoutMs} 毫秒`))
        }, timeoutMs),
      }
      this.waiters.push(w)
    })
  }

  /** 用完还回来；出过错、用满次数的标签先重建再还 */
  async release(slot: Slot, opts: { broken?: boolean } = {}): Promise<void> {
    this.busy--
    slot.uses++
    let next: Slot | null = slot
    if (opts.broken || slot.uses >= this.cfg.recycleAfter || slot.page.isClosed()) {
      await slot.page.close().catch(() => {})
      next = this.browser && this.context ? await this.open().catch(() => null) : null
    }
    if (!next || this.closed) return
    const w = this.waiters.shift()
    if (w) {
      clearTimeout(w.timer)
      w.resolve(next)
    } else this.idle.push(next)
  }

  stats() {
    return { size: this.cfg.size, idle: this.idle.length, busy: this.busy, queued: this.waiters.length }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const w of this.waiters) {
      clearTimeout(w.timer)
      w.reject(new HttpError(503, 'RENDERER_CLOSED', '渲染服务已关闭'))
    }
    this.waiters = []
    await this.browser?.close().catch(() => {})
  }
}
