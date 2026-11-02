import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().startsWith('mysql://'),
  PORT: z.coerce.number().int().positive().default(3100),
  HOST: z.string().default('127.0.0.1'),
  STORAGE_DIR: z.string().default('./storage'),
  // 文档令牌的 HMAC 密钥，至少 32 个字符，只放环境变量
  TOKEN_SECRET: z.string().min(32),
  TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  // 渲染服务（apps/renderer）的地址，只在本机；调它的总超时（它自己单次 25 秒、总共 55 秒）
  RENDERER_URL: z.string().url().default('http://127.0.0.1:3200'),
  RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env)
  if (!r.success) throw new Error(`配置不对：${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`)
  return r.data
}
