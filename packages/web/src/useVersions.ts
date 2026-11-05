// 版本历史的数据（docs/设计/08 第 3 节）：列表（新的在前）和取过的版本内容（版本存下后不再变，按版本号缓存）。
// 面板在 VersionsPanel.vue，对比在 ComparePane.vue
import { ref } from 'vue'
import type { DocData } from '@oe/core'
import type { RevisionApi, RevisionItem } from './types'

export function useVersions(api: RevisionApi | undefined) {
  const items = ref<RevisionItem[]>([])
  const error = ref('')
  const docs = new Map<number, Promise<DocData>>()
  // 刷新交叉返回时只认最后一次
  let seq = 0
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
      if (s === seq) error.value = e instanceof Error ? e.message : String(e)
    }
  }
  /** 一版的内容；取失败的不缓存，下次再取 */
  function docOf(version: number): Promise<DocData> {
    let p = docs.get(version)
    if (!p) {
      p = api!.get(version).then((r) => r.doc)
      p.catch(() => docs.delete(version))
      docs.set(version, p)
    }
    return p
  }
  return { items, error, refresh, docOf }
}
export type VersionStore = ReturnType<typeof useVersions>
