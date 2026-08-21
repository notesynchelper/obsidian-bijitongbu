import { Item } from '@omnivore-app/api'
import { stringifyYaml } from 'obsidian'
import { createBloomFilter } from '../src/compressIds'
import { MessageSortOrder } from '../src/settings'
import { MergeBatchItem } from '../src/sync/MergeProcessor'
import { BurnDeleteTracker } from '../src/sync/BurnDeleteTracker'
import { readBurnSyncedIds } from '../src/sync/burnSyncedIds'
import { parseFrontMatterFromContent } from '../src/util'

const W1 = '550e8400-e29b-41d4-a716-446655440001'
const W2 = '550e8400-e29b-41d4-a716-446655440002'

function makeWeChat(id: string, savedAt: string, content: string): Item {
	return {
		id,
		title: '同步助手_20260604_001_文本',
		savedAt,
		updatedAt: savedAt,
		content,
		url: 'https://example.com',
		slug: 's',
		labels: [],
		highlights: [],
		siteName: '企业微信',
	} as unknown as Item
}

function makeCtx(extraSettings: Record<string, unknown> = {}) {
	let fileContent = '---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n'
	const burnTracker = new BurnDeleteTracker()
	return {
		burnTracker,
		imageLocalizer: null,
		settings: {
			messageSortOrder: MessageSortOrder.ASC,
			dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
			wechatMessageTemplate: '---\n#### {{{heading}}}\n## {{{dateSaved}}}\n{{{content}}}',
			sectionSeparator: '',
			sectionSeparatorEnd: '',
			burnAfterReading: true,
			burnAfterReadingEnabledAt: '2026-06-01T00:00:00.000Z',
			deviceSyncCursors: {},
			pendingBurnDeletes: [],
			...extraSettings,
		},
		app: {
			vault: {
				process: jest.fn(async (_f: unknown, fn: (d: string) => string) => {
					fileContent = fn(fileContent)
					return fileContent
				}),
			},
		},
		successTracker: { recordSuccess: jest.fn() },
		diaryLinkProcessor: { addLink: jest.fn() },
		enqueueFileForImageLocalization: jest.fn(async () => {}),
		enqueueFileForAttachmentLocalization: jest.fn(async () => {}),
		addProcessedFile: jest.fn(),
		getFileContent: () => fileContent,
		setFileContent: (c: string) => { fileContent = c },
	}
}

const FILE = { path: 'Synced/merge.md', basename: 'merge' } as unknown as import('obsidian').TFile

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1
}

describe('MergeProcessor burn 模式', () => {
	it('同一 id 重复处理两轮 → 只 append 一次（精确去重；命门：删除失败后重拉也不重复）', async () => {
		const ctx = makeCtx()
		const { MergeProcessor } = await import('../src/sync/MergeProcessor')
		const p = new MergeProcessor(ctx as never)

		const items: MergeBatchItem[] = [{ item: makeWeChat(W1, '2026-06-04T10:00:00.000Z', 'msg-one'), content: '' }]
		await p.processBatch(items, FILE)
		await p.processBatch(items, FILE) // 模拟下一轮重拉同一 id

		expect(count(ctx.getFileContent(), '#### ')).toBe(1) // 仍只 1 条消息块
		// 删除集只含一次 W1（第二轮是判重命中，不再进删除集）
		expect(ctx.burnTracker.getDeleteRecords().map(r => r.id)).toEqual([W1])
		// 但游标真相含 W1（两轮都已落地）
		expect(ctx.burnTracker.hasCursor(W1)).toBe(true)
	})

	it('batch[已 seen W1, 新 W2] → 只有 W2 进删除集；两者都进游标集', async () => {
		const ctx = makeCtx()
		// 预置文件已含 W1 的精确记录
		ctx.setFileContent(
			'---\n' +
			stringifyYaml({
				syncedIds: createBloomFilter(),
				burnSyncedIds: [{ id: W1, savedAt: '2026-06-04T09:00:00.000Z', updatedAt: '2026-06-04T09:00:00.000Z' }],
			}) +
			'---\n\n#### x\n## 2026-06-04 09:00:00\nmsg-one'
		)
		const { MergeProcessor } = await import('../src/sync/MergeProcessor')
		const p = new MergeProcessor(ctx as never)

		await p.processBatch([
			{ item: makeWeChat(W1, '2026-06-04T09:00:00.000Z', 'msg-one'), content: '' },
			{ item: makeWeChat(W2, '2026-06-04T10:00:00.000Z', 'msg-two'), content: '' },
		], FILE)

		expect(ctx.burnTracker.hasDelete(W2)).toBe(true)
		expect(ctx.burnTracker.hasDelete(W1)).toBe(false) // seen，不删
		expect(ctx.burnTracker.hasCursor(W1)).toBe(true)
		expect(ctx.burnTracker.hasCursor(W2)).toBe(true)
		expect(count(ctx.getFileContent(), '#### ')).toBe(2) // 共 2 条消息块（W1 未被重复 append）
		expect(ctx.getFileContent().includes('msg-two')).toBe(true)
	})

	it('写 frontmatter：burnSyncedIds 精确数组 + 仍保留 syncedIds Bloom', async () => {
		const ctx = makeCtx()
		const { MergeProcessor } = await import('../src/sync/MergeProcessor')
		const p = new MergeProcessor(ctx as never)
		await p.processBatch([{ item: makeWeChat(W1, '2026-06-04T10:00:00.000Z', 'm'), content: '' }], FILE)

		const fm = parseFrontMatterFromContent(ctx.getFileContent()) as Record<string, unknown>
		expect(typeof fm.syncedIds).toBe('string')
		expect((fm.syncedIds as string).length).toBe(44) // Bloom 仍写
		expect(readBurnSyncedIds(fm).map(r => r.id)).toEqual([W1])
	})

	it('删除记录携带原始远程图片 URL（供删除前残留复查）', async () => {
		const ctx = makeCtx()
		const { MergeProcessor } = await import('../src/sync/MergeProcessor')
		const p = new MergeProcessor(ctx as never)
		await p.processBatch([
			{ item: makeWeChat(W1, '2026-06-04T10:00:00.000Z', '![](https://cdn.example.com/p.jpg)'), content: '' },
		], FILE)

		const rec = ctx.burnTracker.getDeleteRecords().find(r => r.id === W1)!
		expect(rec.filePath).toBe('Synced/merge.md')
		expect(rec.originalImageUrls).toContain('https://cdn.example.com/p.jpg')
	})

	it('非 burn 时期的内联标记，开启 burn 后仍认作已同步（不重复 append、不误标删除）', async () => {
		// 场景（codex P2）：用户先在非 burn 下同步过，文件是「内联标记 + 无 syncedIds」；
		// 之后开启 burn，服务器重取到这条 pre-burn 老消息。
		const ctx = makeCtx() // burnAfterReading: true
		ctx.setFileContent(
			'---\n---\n\n#### x\n## 2026-06-04 09:00:00\nmsg-one\n<!--nh:' + W1 + '-->'
		)
		const { MergeProcessor } = await import('../src/sync/MergeProcessor')
		const p = new MergeProcessor(ctx as never)

		await p.processBatch(
			[{ item: makeWeChat(W1, '2026-06-04T09:00:00.000Z', 'msg-one'), content: '' }],
			FILE,
		)

		// 标记命中 → 不重复 append，仍只有 1 条消息块
		expect(count(ctx.getFileContent(), '#### ')).toBe(1)
		// pre-burn 老消息不进删除集（它靠标记去重，不是本轮新落地）
		expect(ctx.burnTracker.hasDelete(W1)).toBe(false)
	})

	it('burn=off：不写 burnSyncedIds，burnTracker 不被触碰（回归现状）', async () => {
		const ctx = makeCtx({ burnAfterReading: false })
		const { MergeProcessor } = await import('../src/sync/MergeProcessor')
		const p = new MergeProcessor(ctx as never)
		await p.processBatch([{ item: makeWeChat(W1, '2026-06-04T10:00:00.000Z', 'm'), content: '' }], FILE)

		const fm = parseFrontMatterFromContent(ctx.getFileContent()) as Record<string, unknown>
		expect(fm?.burnSyncedIds).toBeUndefined()
		expect(ctx.burnTracker.getDeleteRecords()).toEqual([])
		expect(ctx.burnTracker.hasCursor(W1)).toBe(false)
	})
})
