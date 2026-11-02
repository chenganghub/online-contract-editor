import { Worker } from 'node:worker_threads'
import type { PdfJob } from './pdf-worker'

/** 每个 PDF 起一个 worker 线程拼装；拼完线程就退出 */
export function buildPdfInWorker(job: PdfJob, timeoutMs: number): Promise<{ bytes: Uint8Array; glyphs: number; skipped: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.ts', import.meta.url), { workerData: job })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error(`拼装 PDF 超过 ${timeoutMs} 毫秒`))
    }, timeoutMs)
    worker.once('message', (m: { ok: boolean; bytes?: Uint8Array; glyphs?: number; skipped?: number; error?: string }) => {
      clearTimeout(timer)
      void worker.terminate()
      if (m.ok) resolve({ bytes: m.bytes!, glyphs: m.glyphs!, skipped: m.skipped! })
      else reject(new Error(`拼装 PDF 失败：${m.error}`))
    })
    worker.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}
