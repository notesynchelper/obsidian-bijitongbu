import { DateTime } from 'luxon'
import { DATE_FORMAT, parseDateTime } from './util'

/**
 * 调整 syncAt 同步游标：
 * 首次同步未完成时回退 1 天（需要有效 baseFolder）。
 *
 * 不需要回退时原样返回 syncAt，避免把 advanceSyncCursor 写出的毫秒级 ISO
 * cursor 在这里被 DATE_FORMAT 截回秒级 —— 否则 max(updatedAt) 那篇还是会
 * 被下一轮重复拉。
 */
export function adjustSyncCursor(
  syncAt: string,
  folder: string,
  initialSyncCompleted: boolean,
): string {
  if (!syncAt) return ''

  const baseFolder = folder.split('{{{')[0].replace(/\/+$/, '')
  if (initialSyncCompleted || !baseFolder) {
    return syncAt
  }

  const dt = parseDateTime(syncAt).minus({ days: 1 })
  return dt.toFormat(DATE_FORMAT)
}

/**
 * 判断是否应将 initialSyncCompleted 标记为 true
 * 仅在首次同步成功时标记，已标记则不重复写入
 */
export function shouldMarkInitialSyncCompleted(
  successCount: number,
  initialSyncCompleted: boolean
): boolean {
  return successCount > 0 && !initialSyncCompleted
}

/**
 * 基于本轮 max(updatedAt) 推进下一轮同步游标。
 *
 * Why:
 * - 原写法把 maxUpdatedAt 截到秒（DATE_FORMAT）再写回，毫秒 > 0 时
 *   floor < actual，服务器 `updated:<ts>` 过滤器无论 `>=` 还是严格 `>`
 *   都会把 max 那篇再次命中。
 * - 改成 +1s 可以消掉重复，但会丢掉"同秒内、本轮 pagination 没捞到的并发
 *   新文章"（下一轮 cursor 已跨过那整秒）。
 * - 折中：保留毫秒精度并 +1ms —— 服务器 timestamp 精度通常 ≥1ms，
 *   既保证下一轮起点严格大于本轮 max 那篇，又不会把同秒不同 ms 的新文章
 *   永久漏掉。输出 ISO 8601（含时区 + ms），parseDateTime 能解析。
 *
 * 返回 null 表示输入无法解析，调用方应跳过游标更新。
 */
export function advanceSyncCursor(maxUpdatedAt: string): string | null {
  if (!maxUpdatedAt) return null

  let dt = DateTime.fromISO(maxUpdatedAt)
  if (!dt.isValid) {
    dt = parseDateTime(maxUpdatedAt)
  }
  if (!dt.isValid) return null

  return dt.plus({ milliseconds: 1 }).toISO()
}
