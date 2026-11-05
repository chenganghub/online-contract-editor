// 批注的数据（docs/设计/08 第 3 节）：列表、按最上面那条归成串、没解决的条数（工具栏上显示）。
// 自己加、改、删的直接改本地的；别人改了服务端推 comments，ContractEditor 收到后 refresh
import { computed, ref } from 'vue'
import type { CommentApi, CommentItem } from './types'

export interface CommentThread extends CommentItem {
  replies: CommentItem[]
}

export function useComments(api: CommentApi | undefined) {
  const items = ref<CommentItem[]>([])
  const error = ref('')
  // 刷新交叉返回时只认最后一次
  let seq = 0
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
  async function refresh() {
    if (!api) return
    const s = ++seq
    try {
      const list = await api.list()
      if (s === seq) {
        items.value = list
        error.value = ''
      }
    } catch (e) {
      if (s === seq) error.value = message(e)
    }
  }
  const threads = computed<CommentThread[]>(() =>
    items.value.filter((c) => !c.parentId).map((c) => ({ ...c, replies: items.value.filter((r) => r.parentId === c.id) })),
  )
  const unresolved = computed(() => threads.value.filter((t) => !t.resolved).length)
  /** 增删改：成功了改本地的；失败的原因放在 error（面板上显示） */
  const guard = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      const r = await fn()
      error.value = ''
      return r
    } catch (e) {
      error.value = message(e)
      return undefined
    }
  }
  return {
    items,
    threads,
    unresolved,
    error,
    refresh,
    add: (c: Parameters<CommentApi['add']>[0]) =>
      guard(async () => {
        const created = await api!.add(c)
        items.value = [...items.value, created]
        return created
      }),
    update: (id: string, patch: { resolved?: boolean; body?: string }) =>
      guard(async () => {
        await api!.update(id, patch)
        items.value = items.value.map((c) => (c.id === id ? { ...c, ...patch } : c))
      }),
    remove: (id: string) =>
      guard(async () => {
        await api!.remove(id)
        items.value = items.value.filter((c) => c.id !== id && c.parentId !== id)
      }),
  }
}
export type CommentStore = ReturnType<typeof useComments>
