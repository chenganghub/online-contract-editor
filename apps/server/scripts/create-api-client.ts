// 建一个宿主系统的 API Key：库里只存哈希，Key 只在这里打印一次
// 用法：DATABASE_URL=... npx tsx scripts/create-api-client.ts <名称>
import crypto from 'node:crypto'
import { openDb } from '../src/db/client'
import { apiClient } from '../src/db/schema'
import { hashKey } from '../src/tokens'

const name = process.argv[2]
if (!name || !process.env.DATABASE_URL) {
  console.error('用法：DATABASE_URL=mysql://... npx tsx scripts/create-api-client.ts <名称>')
  process.exit(1)
}
const { db, close } = await openDb(process.env.DATABASE_URL)
const key = `oek_${crypto.randomBytes(24).toString('base64url')}`
await db.insert(apiClient).values({ id: crypto.randomUUID(), name, keyHash: hashKey(key) })
console.log(`已创建 ${name}，API Key（只显示这一次）：${key}`)
await close()
