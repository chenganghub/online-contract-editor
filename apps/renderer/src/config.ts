import { z } from 'zod'

const schema = z.object({
  // 只监听本机：渲染服务只给 apps/server 调，不对外
  RENDERER_HOST: z.string().default('127.0.0.1'),
  RENDERER_PORT: z.coerce.number().int().min(0).default(3200),
  CHROME_PATH: z.string().default('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
  POOL_SIZE: z.coerce.number().int().min(1).max(16).default(2),
  /** 字体配置 JSON 文件；不填用 Windows 系统字体 */
  FONT_CONFIG: z.string().optional(),
  /** 单次渲染限时，超时或页数不一致重试一次（方案第 12 节第 2 轮第 3 条） */
  ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  TOTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(55_000),
  /** 页面池排队上限，超过返回 503 */
  QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** 每个页面处理这么多次后重建，防内存涨 */
  RECYCLE_AFTER: z.coerce.number().int().positive().default(200),
})

export type RendererConfig = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RendererConfig {
  const r = schema.safeParse(env)
  if (!r.success) throw new Error(`配置不对：${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`)
  return r.data
}
