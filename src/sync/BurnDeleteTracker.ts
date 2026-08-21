import { DateTime } from 'luxon'

/**
 * 阅后即焚：一条「本轮真实新写入、可焚毁」的记录。
 *
 * filePath + 原始远程 URL 用于删除前的「本地化无残留」复查（见 burnResidual.ts）：
 * 只检查该 item 自己的原始 URL 是否仍残留，避免图床接力把本地图片变成
 * 新的远程 userCDN URL 时被误判为本地化失败。
 */
export interface BurnDeleteRecord {
	id: string
	updatedAt: string
	filePath: string
	originalImageUrls: string[]
	originalAttachmentUrls: string[]
}

/**
 * BurnDeleteTracker —— 阅后即焚的两个独立真相源（codex review 阻断点）。
 *
 * 「已在本地、可安全推进游标」与「本轮真实新写入、可焚毁」是两件事：
 *  - 判重命中 / 内容未变的 no-op 写入 → 本地已有该内容 → 应推进游标，但**不应**删云端（没新写）。
 *  - 真实新写入 → 既推进游标，又是删除候选。
 * 合一会在崩溃重放时卡游标（已存在的 item 不进集合 → 若它最高 updatedAt，游标永远卡住重拉）。
 *
 * 因此：cursor 由 recordCursor 驱动（所有本地已落地的 item），
 *       删除由 recordDelete 驱动（仅本轮真实新写入的 item，且 recordDelete 隐含 recordCursor）。
 */
export class BurnDeleteTracker {
	private cursorIds = new Set<string>()
	private cursorMaxUpdatedAt = ''
	private deleteRecords = new Map<string, BurnDeleteRecord>()

	/** item 本地已安全落地（新写入 / 判重命中 / exact-id 已存在）→ 可安全推进游标越过它 */
	recordCursor(id: string, updatedAt: string): void {
		if (!id) return
		this.cursorIds.add(id)
		if (updatedAt && this.isAfter(updatedAt, this.cursorMaxUpdatedAt)) {
			this.cursorMaxUpdatedAt = updatedAt
		}
	}

	/** item 本轮真实新写入 → 删除候选（同时也是本地已落地，隐含 recordCursor） */
	recordDelete(rec: BurnDeleteRecord): void {
		if (!rec.id) return
		this.deleteRecords.set(rec.id, rec)
		this.recordCursor(rec.id, rec.updatedAt)
	}

	/** 游标基准：所有本地已落地 item 的 max(updatedAt)（不含失败/未落盘 item） */
	maxCursorUpdatedAt(): string {
		return this.cursorMaxUpdatedAt
	}

	getDeleteRecords(): BurnDeleteRecord[] {
		return Array.from(this.deleteRecords.values())
	}

	hasCursor(id: string): boolean {
		return this.cursorIds.has(id)
	}

	hasDelete(id: string): boolean {
		return this.deleteRecords.has(id)
	}

	/** a 是否严格晚于 b（b 为空视为最早） */
	private isAfter(a: string, b: string): boolean {
		if (!b) return true
		const ta = DateTime.fromISO(a)
		const tb = DateTime.fromISO(b)
		if (!ta.isValid) return false
		if (!tb.isValid) return true
		return ta > tb
	}
}
