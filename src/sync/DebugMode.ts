import { DEFAULT_SETTINGS, OmnivoreSettings } from '../settings'

/**
 * 调试模式（Debug Mode）纯逻辑。
 *
 * 场景：用户「收到公众号推送的成功提醒，但 Obsidian 里看不到笔记」。多半是自定义
 * folder/filename 模板把笔记落到了没料到的位置，或同步游标已越过、再同步拉不到近期内容。
 *
 * 调试模式（仅手动同步生效）把本轮同步的行为改成：
 *  1. 位置/文件名/分节字段用 DEFAULT_SETTINGS 默认值（写到「默认设置的位置」）。
 *  2. 强制关闭阅后即焚（诊断绝不能删云端数据）。
 *  3. 时间窗口固定近 24h（见 resolveDebugSyncAt）。
 * 且**不落盘覆盖用户配置**——覆盖只发生在这里返回的内存副本 `effectiveSettings`，持久化的
 * settings 原封不动，关掉调试即彻底复原。
 *
 * 副作用（打开 leaf、跳过游标写回、禁用跨库 ID 路由）留在 main.ts / SyncContext，
 * 由 real-obsidian e2e 覆盖；本文件只放可单测的纯函数。
 */

/**
 * 调试模式覆盖的「位置 / 文件名 / 分节」字段：一律替换为 DEFAULT_SETTINGS 同名默认值。
 * 只含决定「笔记落在哪、叫什么名、分节标记」的字段——不含 mergeMode / customQuery（用户筛选/形态
 * 意图，非「位置」）、不含内容模板、不含图片/附件文件夹。
 */
export const DEBUG_OVERRIDE_KEYS = [
  'folder',
  'folderDateFormat',
  'messageFolder',
  'filename',
  'filenameDateFormat',
  'singleFileName',
  'singleFileDateFormat',
  'sectionSeparator',
  'sectionSeparatorEnd',
] as const

/** 调试模式默认时间窗口：近 24 小时。生产固定值，测试可用 settings.debugWindowMs 覆盖。 */
export const DEBUG_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 解析本轮同步生效的设置。
 * - debugActive=false：原样返回**同一引用**（零开销、零风险，非调试路径完全不变）。
 * - debugActive=true：返回浅拷贝，位置字段替换为默认值 + 强制 burnAfterReading=false。
 *
 * 只改顶层字符串/布尔字段；嵌套对象（deviceSyncCursors / pendingBurnDeletes 等）按引用共享，
 * 但同步流程对它们的持久写入都走 this.settings（不经此副本），故浅拷贝安全。
 */
export function resolveEffectiveSyncSettings(
  settings: OmnivoreSettings,
  debugActive: boolean,
): OmnivoreSettings {
  if (!debugActive) return settings
  const eff: OmnivoreSettings = { ...settings }
  for (const key of DEBUG_OVERRIDE_KEYS) {
    ;(eff as unknown as Record<string, unknown>)[key] = (DEFAULT_SETTINGS as unknown as Record<
      string,
      unknown
    >)[key]
  }
  // 诊断绝不删数据：调试模式强制关闭阅后即焚，本轮不收集删除候选、不删云端、不写 pendingBurnDeletes。
  eff.burnAfterReading = false
  return eff
}

/**
 * 解析调试模式的同步起点（ISO）：now - 窗口。
 * 优先用测试覆盖值 debugWindowMs（有限正数），否则用生产固定值 DEBUG_WINDOW_MS=24h。
 * 只接受有限正数覆盖，其它一律回退默认，避免 NaN/负值/0 把窗口弄坏。
 */
export function resolveDebugSyncAt(nowMs: number, overrideMs?: number): string {
  const win =
    typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0
      ? overrideMs
      : DEBUG_WINDOW_MS
  return new Date(nowMs - win).toISOString()
}
