// 文档令牌：载荷只有令牌 id、文档 id、模式、用户、过期时间；元素权限存在服务端（token_permission），
// 每次请求按服务端当前的权限校验，改权限、吊销立即生效（方案第 12 节第 1、2 轮）。
import crypto from 'node:crypto'
import type { Mode } from '@oe/core'

export interface TokenPayload {
  /** 缺省为文档令牌；模板令牌只允许访问模板草稿。 */
  scope?: 'template'
  tid: string
  did: string
  mode: Mode
  uid: string
  /** 显示用的名字（在场、批注、编辑锁里显示），不给就显示 uid */
  un?: string
  /** 签署令牌绑定的签署方 key（t12，只有盖章模式有）：只能以这个签署方的身份盖章、签、拒签 */
  sg?: string
  /** 过期时间，毫秒时间戳 */
  exp: number
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const mac = (secret: string, body: string) => crypto.createHmac('sha256', secret).update(body).digest()

export function signToken(secret: string, payload: TokenPayload): string {
  const body = b64(JSON.stringify(payload))
  return `${body}.${b64(mac(secret, body))}`
}

/** 只校验签名和过期；吊销、文档 id 由调用方查库核对 */
export function verifyToken(secret: string, token: string, now = Date.now()): TokenPayload | 'invalid' | 'expired' {
  const [body, sig] = token.split('.')
  if (!body || !sig) return 'invalid'
  const expect = mac(secret, body)
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return 'invalid'
  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload
  } catch {
    return 'invalid'
  }
  return payload.exp <= now ? 'expired' : payload
}

export const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex')
