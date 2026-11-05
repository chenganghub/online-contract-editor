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
  // 签署（t12）：最终 PDF 的签名证书（PKCS#12 文件和口令，只放环境变量）；不给就用存储目录里自签的测试证书（无法律效力）
  SIGN_P12_PATH: z.string().optional(),
  SIGN_P12_PASSWORD: z.string().default(''),
  // 签署日期按哪个时区写
  SIGN_TIMEZONE: z.string().default('Asia/Shanghai'),
  // 在反向代理后面时设成 true，证据链里记 X-Forwarded-For 给的客户端 IP（不在代理后面时别开，客户端能伪造这个头）
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env)
  if (!r.success) throw new Error(`配置不对：${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`)
  return r.data
}
