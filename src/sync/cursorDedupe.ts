import { DateTime } from 'luxon'
import { OmnivoreSettings } from '../settings'
import { parseDateTime } from '../util'

/**
 * 「无 id」模式的游标去重（disableMessageMarkers / omitFrontmatterId）。
 *
 * 两个开关开启后，笔记里不再有任何机器去重痕迹（<!--nh:id--> 注释符 / frontmatter
 * id / syncedIds），防重复的唯一依据是「最新同步游标」：
 *
 *   item 的 updatedAt 落在【所有设备游标 + 全局 syncAt 的最大值】之前
 *   → 说明已有某台设备同步过它（游标 = 该设备成功轮次的 maxUpdatedAt + 1s）
 *   → 本轮跳过，不再写入。
 *
 * 跨设备成立的前提：deviceSyncCursors 随 data.json 被实时同步方案（Obsidian Sync /
 * 「手机电脑同步」插件）带到各设备。网盘方案延迟大且通常不带插件数据 → 游标失真 →
 * 重复/丢失，所以设置页开启时弹窗明确警告「不能用网盘方案」。
 *
 * ⚠️ 调试模式必须旁路本谓词（SyncContext.debugActive）：调试重拉的近 24h item
 * 全部落在游标之前，不旁路会一条都拉不出来。
 */

/**
 * 游标解析：优先 ISO，回落 legacy `yyyy-MM-dd HH:mm[:ss]`（parseDateTime）。
 * 旧配置的 syncAt / 设备游标可能是 legacy 秒级格式，只认 fromISO 会把它们
 * 当无效丢掉 → 最新游标失真 → 已同步 item 被误判为新（codex P2）。
 */
function parseCursor(value: string): DateTime {
	const iso = DateTime.fromISO(value)
	return iso.isValid ? iso : parseDateTime(value)
}

/** 一组时间串的最新值（无效/空串忽略）；全无效返回 ''。与 burnSyncedIds.minIsoCursor 对偶。 */
export function maxIsoCursor(values: string[]): string {
	let maxStr = ''
	let maxDt: DateTime | null = null
	for (const v of values) {
		if (!v) continue
		const dt = parseCursor(v)
		if (!dt.isValid) continue
		if (!maxDt || dt > maxDt) {
			maxDt = dt
			maxStr = v
		}
	}
	return maxStr
}

/** 所有设备游标 + 全局 syncAt 的最新值。'' = 尚无任何游标（首次同步，一切都算新）。 */
export function latestSyncCursor(
	settings: Pick<OmnivoreSettings, 'syncAt' | 'deviceSyncCursors'>,
): string {
	return maxIsoCursor([
		settings.syncAt || '',
		...Object.values(settings.deviceSyncCursors ?? {}),
	])
}

/**
 * item 是否已被最新游标覆盖（= 某台设备已同步过，应跳过）。
 *
 * 用**严格小于**：游标 = maxUpdatedAt + 1s，已同步 item 恒 < 游标；
 * 恰好等于游标的 item 是游标推进后才出现的新数据，必须写入。
 * 时间取 updatedAt（游标同系），缺失回退 savedAt。
 */
export function isCursorCovered(itemIso: string | undefined, latestCursor: string): boolean {
	if (!latestCursor || !itemIso) return false
	const item = parseCursor(itemIso)
	const cursor = parseCursor(latestCursor)
	if (!item.isValid || !cursor.isValid) return false
	return item < cursor
}
