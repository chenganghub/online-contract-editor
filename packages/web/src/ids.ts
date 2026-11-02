/**
 * 随机 id（uuid v4 的格式），用作区域、印章等的 id，不当密钥用。crypto.randomUUID 只在 https 和 localhost 下有，
 * 公司内网用 http 部署时没有，这时用 getRandomValues（http 下也有）拼；连 crypto 都没有的老环境用 Math.random
 */
export function uid(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
