import { DateTime } from 'luxon'
import { bloomHasId } from '../compressIds'

/**
 * 阅后即焚：合并文件 frontmatter 里的「非 lossy 精确去重记录」。
 *
 * 取代会假阳性静默丢消息的 Bloom（仅 burn 模式）。带 savedAt + updatedAt：
 *  - updatedAt 用于裁剪（设备游标是 updatedAt 系，savedAt << updatedAt 时按 savedAt 会过早裁剪）。
 *  - savedAt 用于 legacy 阈值比对（早于 burn 启用时刻的旧内容回退查 Bloom）。
 */
export interface BurnSyncedRecord {
	id: string
	savedAt: string
	updatedAt: string
}

function isoBefore(a: string, b: string): boolean {
	if (!a || !b) return false
	const ta = DateTime.fromISO(a)
	const tb = DateTime.fromISO(b)
	if (!ta.isValid || !tb.isValid) return false
	return ta < tb
}

/** 从 frontmatter 读 burnSyncedIds 精确数组（容错：非数组/缺字段都安全降级）。 */
export function readBurnSyncedIds(
	frontmatter: Record<string, unknown> | null | undefined,
): BurnSyncedRecord[] {
	const v = frontmatter?.burnSyncedIds
	if (!Array.isArray(v)) return []
	const out: BurnSyncedRecord[] = []
	for (const r of v) {
		if (r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string') {
			const rec = r as { id: string; savedAt?: unknown; updatedAt?: unknown }
			out.push({
				id: rec.id,
				savedAt: typeof rec.savedAt === 'string' ? rec.savedAt : '',
				updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : '',
			})
		}
	}
	return out
}

/**
 * burn 模式判重：
 *  - 精确数组命中 → seen（零假阳性，永不静默丢新消息）。
 *  - 否则，若 item 早于 burn 启用时刻（savedAt < enabledAt），回退查 legacy Bloom（接受其假阳性，
 *    仅作用于 burn 启用前早已同步的旧消息）。
 */
export function isBurnSeen(
	records: BurnSyncedRecord[],
	legacyBloom: string,
	id: string,
	savedAt: string,
	enabledAt: string,
): boolean {
	if (records.some((r) => r.id === id)) return true
	if (legacyBloom && enabledAt && savedAt && isoBefore(savedAt, enabledAt) && bloomHasId(legacyBloom, id)) {
		return true
	}
	return false
}

/** 追加一条精确记录（已存在则原样返回，幂等）。 */
export function addBurnSyncedId(
	records: BurnSyncedRecord[],
	id: string,
	savedAt: string,
	updatedAt: string,
): BurnSyncedRecord[] {
	if (records.some((r) => r.id === id)) return records
	return [...records, { id, savedAt, updatedAt }]
}

/** 多个设备游标里取「时间最早」的那个（按真实时间比较，不做字符串字面比较——
 *  toISO() 带时区偏移，字面比较会错）。空集合返回 ''（=不裁剪，保守保留）。 */
export function minIsoCursor(values: string[]): string {
	let minStr = ''
	let minDt: DateTime | null = null
	for (const v of values) {
		if (!v) continue
		const dt = DateTime.fromISO(v)
		if (!dt.isValid) continue
		if (!minDt || dt < minDt) {
			minDt = dt
			minStr = v
		}
	}
	return minStr
}

/**
 * 有界裁剪：仅裁掉「所有设备游标都已越过（updatedAt < minDeviceCursor）且不在 pending」的记录。
 *  - 必须按 updatedAt（设备游标系），不能按 savedAt。
 *  - pending 里的 id 永不裁（可能因删除失败/本地化失败被回退重拉）。
 */
export function pruneBurnSyncedIds(
	records: BurnSyncedRecord[],
	minDeviceCursorISO: string,
	pendingIds: Set<string>,
): BurnSyncedRecord[] {
	if (!minDeviceCursorISO) return records
	return records.filter((r) => {
		if (pendingIds.has(r.id)) return true
		if (r.updatedAt && isoBefore(r.updatedAt, minDeviceCursorISO)) return false
		return true
	})
}
