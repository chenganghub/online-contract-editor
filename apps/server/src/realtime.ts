// 文档事件流（docs/设计/08 第 3 节）：每个文档一个频道，在这个进程里分发。
// 浏览器用 fetch 读 text/event-stream（令牌放请求头 X-Document-Token，不进地址）。多实例部署时换成 Redis 发布订阅，实现同样的 publish / 在场。
import type { Mode, Permission } from '@oe/core'

/** 在场的一个连接（同一个人开两个窗口就是两条） */
export interface Viewer {
  conn: string
  userId: string
  name: string
  mode: Mode
  /** 光标所在的字段 key；不在字段里是 null */
  field: string | null
}

export interface Subscriber extends Viewer {
  documentId: string
  /** 令牌连的：令牌 id 和字段权限（推字段值、在场时按它剔除隐藏字段）；宿主连的都是 null */
  tokenId: string | null
  perms: Record<string, Permission> | null
  /** 字段定义里的默认权限（令牌没给的字段按它） */
  defaults: Record<string, Permission>
  send(event: string, data: unknown): void
  /** 关掉这条事件流（令牌吊销、权限变了、服务关闭）；客户端会重连，重连时重新鉴权 */
  end(): void
}

/** 这个连接能不能看到这个字段（隐藏的不推值、不报谁在填） */
export const sees = (s: Subscriber, key: string) => !s.perms || (s.perms[key] ?? s.defaults[key] ?? 'editable') !== 'hidden'

export class Hub {
  private docs = new Map<string, Map<string, Subscriber>>()

  /** 加进频道就开始收推送（不广播在场：调用方发完 hello 再调 presence，别人先看到的在场里才有这条连接的名字） */
  add(s: Subscriber) {
    let subs = this.docs.get(s.documentId)
    if (!subs) this.docs.set(s.documentId, (subs = new Map()))
    subs.set(s.conn, s)
  }

  remove(s: Subscriber) {
    const subs = this.docs.get(s.documentId)
    if (!subs?.delete(s.conn)) return
    if (!subs.size) this.docs.delete(s.documentId)
    this.presence(s.documentId)
  }

  get(documentId: string, conn: string) {
    return this.docs.get(documentId)?.get(conn)
  }

  setField(s: Subscriber, field: string | null) {
    if (s.field === field) return
    s.field = field
    this.presence(s.documentId)
  }

  /** 给文档的每个连接发一条；map 按连接定内容，返回 null 的不发（比如按权限剔除后什么都不剩）。except：不发给这个连接（发起改动的那个） */
  publish(documentId: string, event: string, map: (s: Subscriber) => unknown | null, except?: string) {
    for (const s of this.docs.get(documentId)?.values() ?? []) {
      if (s.conn === except) continue
      const data = map(s)
      if (data === null) continue
      try {
        s.send(event, data)
      } catch {
        // 连接已断：close 事件里会移除
      }
    }
  }

  /** 在场列表：每个连接看到的都是全部连接，别人在隐藏字段里时只显示在场、不显示字段 */
  presence(documentId: string) {
    const all = [...(this.docs.get(documentId)?.values() ?? [])]
    this.publish(documentId, 'presence', (s) => ({
      viewers: all.map((v) => ({ conn: v.conn, userId: v.userId, name: v.name, mode: v.mode, field: v.field && sees(s, v.field) ? v.field : null })),
    }))
  }

  /** 测试、排查用：这个文档现在有几条连接 */
  count(documentId: string) {
    return this.docs.get(documentId)?.size ?? 0
  }

  /** 关掉这个令牌的所有事件流（吊销、改权限后，重连时按新权限） */
  closeToken(tokenId: string) {
    for (const subs of this.docs.values()) for (const s of [...subs.values()]) if (s.tokenId === tokenId) s.end()
  }

  /** 服务关闭时关掉所有事件流，不然 HTTP 服务一直等这些长连接 */
  closeAll() {
    for (const subs of this.docs.values()) for (const s of [...subs.values()]) s.end()
  }
}
