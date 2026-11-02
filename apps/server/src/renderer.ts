// 调渲染服务（apps/renderer，只监听本机）：出 PDF / docx、docx 转文档。生成文件时只用已保存的数据，渲染页里不调远程接口（方案 4.5、4.9）
import type { DocData } from '@oe/core'
import { HttpError } from './errors'

export interface RenderRequest {
  doc: DocData
  documentId?: string
  version?: number
  title?: string
  outputs: ('pdf' | 'docx' | 'pages')[]
  /** 编辑器保存时按打印模式数的页数；给了渲染服务就核对，不一致重试一次，仍不一致 409 */
  expectedPages?: number
  pixelRatio?: number
}
export interface RenderResponse {
  pageCount: number
  pdf?: Buffer
  docx?: Buffer
  timings?: Record<string, number>
}
export interface ConvertResponse {
  doc: DocData
  report: { items: unknown[]; textExact: boolean }
  pageCount: number
}
export interface RendererClient {
  render(req: RenderRequest): Promise<RenderResponse>
  convert(docx: Buffer): Promise<ConvertResponse>
}

/** 渲染服务的错误转成本服务的：页数不一致 409、渲染服务忙或超时 503、入参不对 422，其他 502 */
function mapStatus(status: number): number {
  if (status === 409) return 409
  if (status === 503) return 503
  if (status === 400 || status === 422) return 422
  return 502
}

export function httpRenderer(baseUrl: string, timeoutMs: number): RendererClient {
  async function post<T>(path: string, body: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(new URL(path, baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new HttpError(503, 'RENDERER_UNAVAILABLE', `渲染服务不可用：${e instanceof Error ? e.message : String(e)}`)
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const { code, message, ...detail } = json
      throw new HttpError(mapStatus(res.status), typeof code === 'string' ? code : 'RENDER_FAILED', typeof message === 'string' ? message : `渲染服务返回 ${res.status}`, detail)
    }
    return json as T
  }
  return {
    async render(req) {
      const r = await post<{ pageCount: number; pdf?: string; docx?: string; timings?: Record<string, number> }>('/render', req)
      return { pageCount: r.pageCount, pdf: r.pdf ? Buffer.from(r.pdf, 'base64') : undefined, docx: r.docx ? Buffer.from(r.docx, 'base64') : undefined, timings: r.timings }
    },
    convert: (docx) => post<ConvertResponse>('/convert', { docx: docx.toString('base64') }),
  }
}
