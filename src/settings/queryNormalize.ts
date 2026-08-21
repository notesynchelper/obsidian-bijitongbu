import { OmnivoreSettings } from './index'
import { getQueryFromFilter } from '../util'

/**
 * 一次性归一化已下线的「筛选器 / 自定义查询」设置（2026-08 Phase 2 IA）。
 *
 * 设置页不再提供这两项，同步范围恒为默认（in:all）。存量用户若保存过
 * 非默认的自定义查询，直接改宽范围会让老游标「跳过」此前被查询排除的内容，
 * 所以按旧设置页「更改查询将重置最后同步时间戳」的既有语义重置同步游标，
 * 让下一轮同步做全量补拉。auto-open 是否弹出仍由 firstSyncAutoOpened 控制
 * （老用户在加载阶段已被置 true 抑制，不会因此突然弹笔记）。
 *
 * customQueryNormalized 标记保证只跑一次；E2E harness 需要用自定义查询做
 * 测试隔离时，在 data.json 里预置 customQueryNormalized: true 即可跳过。
 *
 * @returns 是否发生了写操作（调用方据此决定是否持久化）
 */
export function normalizeRetiredQuerySettings(settings: OmnivoreSettings): boolean {
  if (settings.customQueryNormalized) return false

  const defaultQuery = getQueryFromFilter('ALL')
  const hadCustomScope =
    !!settings.customQuery && settings.customQuery !== defaultQuery

  settings.filter = 'ALL'
  settings.customQuery = defaultQuery
  if (hadCustomScope) {
    settings.syncAt = ''
    settings.initialSyncCompleted = false
    settings.deviceSyncCursors = {}
    // 🔴 数据安全：范围拓宽 + 游标清零会触发全量补拉；若阅后即焚还开着，
    // 这轮补拉会把用户整个云端库逐篇永久删除。归一化时强制关掉，
    // 用户需在设置页带确认弹窗地重新开启。
    if (settings.burnAfterReading) {
      settings.burnAfterReading = false
    }
  }
  settings.customQueryNormalized = true
  return true
}
