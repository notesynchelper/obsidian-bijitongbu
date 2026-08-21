import { BurnDeleteTracker } from '../src/sync/BurnDeleteTracker'

const mkRec = (id: string, updatedAt: string) => ({
	id,
	updatedAt,
	filePath: 'f.md',
	originalImageUrls: [],
	originalAttachmentUrls: [],
})

describe('BurnDeleteTracker', () => {
	it('游标真相与删除真相分离：判重命中只进 cursor，不进 delete', () => {
		const t = new BurnDeleteTracker()
		// 新写入
		t.recordDelete(mkRec('a', '2026-06-01T00:00:00Z'))
		// 判重命中（已落地，可推进游标，但没新写、不可删）
		t.recordCursor('b', '2026-06-02T00:00:00Z')

		expect(t.hasCursor('a')).toBe(true)
		expect(t.hasCursor('b')).toBe(true)
		expect(t.hasDelete('a')).toBe(true)
		expect(t.hasDelete('b')).toBe(false) // 关键：判重命中不进删除集
		expect(t.getDeleteRecords().map(r => r.id)).toEqual(['a'])
	})

	it('maxCursorUpdatedAt = 所有已落地 item 的最大 updatedAt', () => {
		const t = new BurnDeleteTracker()
		t.recordDelete(mkRec('a', '2026-06-01T00:00:00Z'))
		t.recordCursor('b', '2026-06-05T00:00:00Z')
		t.recordCursor('c', '2026-06-03T00:00:00Z')
		expect(t.maxCursorUpdatedAt()).toBe('2026-06-05T00:00:00Z')
	})

	it('空 updatedAt 不破坏 max', () => {
		const t = new BurnDeleteTracker()
		t.recordCursor('a', '')
		t.recordCursor('b', '2026-06-01T00:00:00Z')
		expect(t.maxCursorUpdatedAt()).toBe('2026-06-01T00:00:00Z')
	})

	it('recordDelete 同时隐含 recordCursor', () => {
		const t = new BurnDeleteTracker()
		t.recordDelete(mkRec('a', '2026-06-01T00:00:00Z'))
		expect(t.hasCursor('a')).toBe(true)
	})
})
