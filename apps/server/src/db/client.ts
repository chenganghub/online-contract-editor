import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import * as schema from './schema'

export type Db = MySql2Database<typeof schema>

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

/** 连接池 + drizzle；启动时执行迁移 */
export async function openDb(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const pool = mysql.createPool({ uri: url, connectionLimit: 10, timezone: 'Z', dateStrings: false })
  const db = drizzle(pool, { schema, mode: 'default' })
  await migrate(db, { migrationsFolder })
  return { db, close: () => pool.end() }
}
