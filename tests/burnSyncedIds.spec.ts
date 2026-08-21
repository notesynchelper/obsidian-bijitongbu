import { createBloomFilter, bloomAddId } from '../src/compressIds'
import {
	readBurnSyncedIds,
	isBurnSeen,
	addBurnSyncedId,
	pruneBurnSyncedIds,
	minIsoCursor,
} from '../src/sync/burnSyncedIds'

const OLD_ID = '6ba7b810-9dad-11d1-80b4-00c04fd43001'
const NEW_ID = '6ba7b810-9dad-11d1-80b4-00c04fd43002'
const ENABLED_AT = '2026-06-04T00:00:00.000Z'

describe('burnSyncedIds.readBurnSyncedIds', () => {
	it('非数组/缺字段安全降级为空', () => {
		expect(readBurnSyncedIds(undefined)).toEqual([])
		expect(readBurnSyncedIds({})).toEqual([])
		expect(readBurnSyncedIds({ burnSyncedIds: 'x' })).toEqual([])
	})
	it('读出带 savedAt/updatedAt 的记录，缺字段补空串', () => {
		const fm = { burnSyncedIds: [{ id: NEW_ID, savedAt: 's', updatedAt: 'u' }, { id: OLD_ID }, { bad: 1 }] }
		expect(readBurnSyncedIds(fm)).toEqual([
			{ id: NEW_ID, savedAt: 's', updatedAt: 'u' },
			{ id: OLD_ID, savedAt: '', updatedAt: '' },
		])
	})
})

describe('burnSyncedIds.isBurnSeen', () => {
	it('精确数组命中 → seen', () => {
		const records = [{ id: NEW_ID, savedAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z' }]
		expect(isBurnSeen(records, '', NEW_ID, '2026-06-10T00:00:00Z', ENABLED_AT)).toBe(true)
	})
	it('新内容（savedAt >= enabledAt）只看精确数组，不回退 Bloom（杜绝假阳性丢消息）', () => {
		const legacyBloom = bloomAddId(createBloomFilter(), NEW_ID) // 即使 Bloom 命中
		expect(isBurnSeen([], legacyBloom, NEW_ID, '2026-06-10T00:00:00Z', ENABLED_AT)).toBe(false)
	})
	it('老内容（savedAt < enabledAt）回退 legacy Bloom', () => {
		const legacyBloom = bloomAddId(createBloomFilter(), OLD_ID)
		expect(isBurnSeen([], legacyBloom, OLD_ID, '2026-05-01T00:00:00Z', ENABLED_AT)).toBe(true)
		// 老内容但不在 Bloom → 未 seen（用空 Bloom 避免 Bloom 假阳性干扰——这恰是我们改精确数组的原因）
		expect(isBurnSeen([], createBloomFilter(), NEW_ID, '2026-05-01T00:00:00Z', ENABLED_AT)).toBe(false)
	})
})

describe('burnSyncedIds.addBurnSyncedId', () => {
	it('追加；重复幂等', () => {
		let recs = addBurnSyncedId([], NEW_ID, 's', 'u')
		expect(recs).toHaveLength(1)
		recs = addBurnSyncedId(recs, NEW_ID, 's', 'u')
		expect(recs).toHaveLength(1)
	})
})

describe('burnSyncedIds.pruneBurnSyncedIds', () => {
	const recs = [
		{ id: OLD_ID, savedAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' },
		{ id: NEW_ID, savedAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z' },
	]
	it('裁掉 updatedAt < minDeviceCursor 的；保留更新的', () => {
		const out = pruneBurnSyncedIds(recs, '2026-06-01T00:00:00Z', new Set())
		expect(out.map(r => r.id)).toEqual([NEW_ID])
	})
	it('pending 里的 id 永不裁', () => {
		const out = pruneBurnSyncedIds(recs, '2026-06-01T00:00:00Z', new Set([OLD_ID]))
		expect(out.map(r => r.id).sort()).toEqual([OLD_ID, NEW_ID].sort())
	})
	it('minDeviceCursor 为空 → 不裁剪', () => {
		expect(pruneBurnSyncedIds(recs, '', new Set())).toHaveLength(2)
	})
})

describe('burnSyncedIds.minIsoCursor', () => {
	it('按真实时间取最早（不做字符串字面比较）', () => {
		// 字面比较会选第一个（'...01T23' < '...02T00'），但真实时间第二个更早。
		const a = '2026-06-01T23:00:00.000+00:00' // = 06-01T23:00Z
		const b = '2026-06-02T00:30:00.000+08:00' // = 06-01T16:30Z（更早）
		expect(minIsoCursor([a, b])).toBe(b)
	})
	it('空集合返回空串', () => {
		expect(minIsoCursor([])).toBe('')
		expect(minIsoCursor(['', 'not-a-date'])).toBe('')
	})
})
