/**
 * 双写模式（MergeMode.DUAL）的路由隔离：同一条消息同时存在于「合并文件」与「独立笔记」，
 * 两条写入路径的 id 路由绝不能串门。串了就是不可逆的数据损坏：
 *  - 合并追加写进独立笔记 → 两份内容搅混；
 *  - 单篇正文覆写合并文件 → 整天的消息被一条消息顶掉。
 */
import { Item } from '@omnivore-app/api'
import { MergeMode } from '../src/settings'
import { createBloomFilter, bloomAddId } from '../src/compressIds'

const MSG_ID = '550e8400-e29b-41d4-a716-446655440777'

type MockFile = { path: string; basename: string }

const mergeFile: MockFile = { path: 'Synced/同步助手_2026-08-06.md', basename: '同步助手_2026-08-06' }
const standaloneFile: MockFile = { path: 'Synced/同步助手_20260806_文本.md', basename: '同步助手_20260806_文本' }

function makeItem(content = 'msg body'): Item {
	return {
		id: MSG_ID,
		title: '同步助手_20260806_文本',
		savedAt: '2026-08-06T10:00:00.000Z',
		updatedAt: '2026-08-06T10:00:00.000Z',
		content,
		url: 'https://example.com',
		slug: 's',
		labels: [],
		highlights: [],
	} as unknown as Item
}

/** 造一个 vault：合并文件（正文含内联标记）+ 该消息的独立笔记（frontmatter id） */
function makeApp(opts: { mergedHasMarker?: boolean; mergedHasBloom?: boolean } = {}) {
	const { mergedHasMarker = true, mergedHasBloom = false } = opts
	const mergedBody = mergedHasMarker
		? `---\n---\n\n#### 消息\n正文<!--nh:${MSG_ID}-->\n`
		: `---\n---\n\n#### 消息\n正文\n`
	const files = [mergeFile, standaloneFile]
	return {
		vault: {
			getMarkdownFiles: () => files,
			cachedRead: async (f: MockFile) => (f.path === mergeFile.path ? mergedBody : '---\nid: ' + MSG_ID + '\n---\n正文'),
		},
		metadataCache: {
			getFileCache: (f: MockFile) => {
				if (f.path === standaloneFile.path) return { frontmatter: { id: MSG_ID } }
				if (f.path === mergeFile.path && mergedHasBloom) {
					return { frontmatter: { syncedIds: bloomAddId(createBloomFilter(), MSG_ID) } }
				}
				return { frontmatter: {} }
			},
		},
	}
}

const baseSettings = {
	mergeMode: MergeMode.DUAL,
	messageFolder: 'Synced',
	folder: 'Synced',
	burnAfterReading: false,
	enableDiaryLinks: false,
	imageMode: 'disabled',
	diaryLinkType: 'all',
}

async function buildContext(app: unknown) {
	const { SyncContext } = await import('../src/sync/SyncContext')
	const ctx = new SyncContext(app as never, baseSettings as never, null, null)
	await ctx.buildMarkerIndex()
	return ctx
}

describe('SyncContext：合并文件 / 独立笔记两套 id 路由互不串门', () => {
	it('内联标记的合并文件 → findMergeFileById 命中它，findStandaloneFileById 命中独立笔记', async () => {
		const ctx = await buildContext(makeApp())
		expect(ctx.findMergeFileById(MSG_ID)?.path).toBe(mergeFile.path)
		expect(ctx.findStandaloneFileById(MSG_ID)?.path).toBe(standaloneFile.path)
	})

	it('Bloom(syncedIds) 的合并文件同样只被 findMergeFileById 命中', async () => {
		const ctx = await buildContext(makeApp({ mergedHasMarker: false, mergedHasBloom: true }))
		expect(ctx.findMergeFileById(MSG_ID)?.path).toBe(mergeFile.path)
		// 独立查找绝不走 Bloom（假阳性会把单篇正文写进合并文件）
		expect(ctx.findStandaloneFileById(MSG_ID)?.path).toBe(standaloneFile.path)
	})

	it('合并文件不带任何机器标记（无 id 模式）→ merge 查找返回空，交给按路径新建，绝不误命中独立笔记', async () => {
		const ctx = await buildContext(makeApp({ mergedHasMarker: false }))
		expect(ctx.findMergeFileById(MSG_ID)).toBeUndefined()
		expect(ctx.findStandaloneFileById(MSG_ID)?.path).toBe(standaloneFile.path)
	})

	it('exactOnly（阅后即焚）不查 Bloom：假阳性会把新消息追进别人的合并文件并据此删云端', async () => {
		// 合并文件只有 Bloom（无标记 / 无 burnSyncedIds 精确记录）
		const ctx = await buildContext(makeApp({ mergedHasMarker: false, mergedHasBloom: true }))
		expect(ctx.findMergeFileById(MSG_ID)?.path).toBe(mergeFile.path)   // 非 burn：允许 Bloom
		expect(ctx.findMergeFileById(MSG_ID, true)).toBeUndefined()        // burn：只认精确
	})

	it('markMergeFile 登记的本轮目标也算合并文件（新建的按天文件不在启动索引里）', async () => {
		const ctx = await buildContext(makeApp())
		const fresh = { path: 'Synced/同步助手_2026-08-07.md', basename: '同步助手_2026-08-07' }
		expect(ctx.isMergeFilePath(fresh.path)).toBe(false)
		ctx.markMergeFile(fresh as never)
		expect(ctx.isMergeFilePath(fresh.path)).toBe(true)
	})
})

/** FileProcessor 的双写副本：只认独立笔记、不登记 burn 删除候选、不重复打日记双链 */
function makeFpCtx(
	indexed: { standalone?: MockFile; any?: MockFile },
	existingContent = 'old',
	opts: { mergeFilePaths?: string[]; fileAtPath?: MockFile | null } = {},
) {
	const diaryLinks: string[] = []
	const burnDeletes: string[] = []
	const successes: string[] = []
	const modified: Array<[string, string]> = []
	const created: string[] = []
	const mergePaths = new Set(opts.mergeFilePaths ?? [mergeFile.path])
	return {
		burnTracker: {
			recordCursor: () => {},
			recordDelete: (r: { id: string }) => { burnDeletes.push(r.id) },
		},
		imageLocalizer: null,
		attachmentLocalizer: null,
		settings: { burnAfterReading: true, omitFrontmatterId: false },
		successTracker: { recordSuccess: (id: string) => { successes.push(id) } },
		diaryLinkProcessor: { addLink: (i: Item) => { diaryLinks.push(i.id) } },
		findStandaloneFileById: () => indexed.standalone,
		findFileByExactId: () => indexed.any,
		findFileById: () => indexed.any,
		isMergeFilePath: (p: string) => mergePaths.has(p),
		enqueueFileForImageLocalization: async () => {},
		enqueueFileForAttachmentLocalization: async () => {},
		addProcessedFile: () => {},
		app: {
			vault: {
				getAbstractFileByPath: (p: string) =>
					(opts.fileAtPath && opts.fileAtPath.path === p ? opts.fileAtPath : null),
				read: async () => existingContent,
				create: async (p: string): Promise<MockFile> => { created.push(p); return { path: p, basename: 'x' } },
				modify: async (f: MockFile, c: string) => { modified.push([f.path, c]) },
			},
		},
		_diaryLinks: diaryLinks,
		_burnDeletes: burnDeletes,
		_successes: successes,
		_modified: modified,
		_created: created,
	}
}

describe('FileProcessor：dualStandaloneCopy 副本的三条不变量', () => {
	it('绝不写进合并文件：即使通用索引指向合并文件，也只按 standalone 索引路由', async () => {
		// 通用索引（findFileById/ExactId）指向合并文件 —— 这正是双写下会发生的情况
		const ctx = makeFpCtx({ any: mergeFile, standalone: undefined })
		const { FileProcessor } = await import('../src/sync/FileProcessor')
		const p = new FileProcessor(ctx as never)
		await p.process(makeItem(), standaloneFile.path, 'new body', 'Synced', '同步助手_20260806_文本', {
			dualStandaloneCopy: true,
		})
		// 合并文件一个字节都不能被改
		expect(ctx._modified.find(([path]) => path === mergeFile.path)).toBeUndefined()
		expect(ctx._created).toEqual([standaloneFile.path])
	})

	it('不登记阅后即焚删除候选（避免顶掉合并副本那条记录）、不重复打日记双链、不记成功', async () => {
		const ctx = makeFpCtx({ standalone: standaloneFile })
		const { FileProcessor } = await import('../src/sync/FileProcessor')
		const p = new FileProcessor(ctx as never)
		await p.process(makeItem(), standaloneFile.path, 'new body', 'Synced', '同步助手_20260806_文本', {
			dualStandaloneCopy: true,
		})
		expect(ctx._modified.length).toBe(1)          // 独立笔记照常更新
		expect(ctx._burnDeletes).toEqual([])          // 但不进删除候选
		expect(ctx._diaryLinks).toEqual([])           // 也不重复打链接
		// 成功=可推进游标，主真相是合并副本；这里记了会让合并失败时游标越过该条（codex P1）
		expect(ctx._successes).toEqual([])
	})

	it('新建独立副本同样不记成功（合并落盘失败时游标不得越过该条）', async () => {
		const ctx = makeFpCtx({})
		const { FileProcessor } = await import('../src/sync/FileProcessor')
		const p = new FileProcessor(ctx as never)
		await p.process(makeItem(), standaloneFile.path, 'new body', 'Synced', '同步助手_20260806_文本', {
			dualStandaloneCopy: true,
		})
		expect(ctx._created).toEqual([standaloneFile.path])
		expect(ctx._successes).toEqual([])
	})

	it('非双写路径（普通单文件模式）行为不变：仍记成功 + 删除候选 + 日记双链', async () => {
		const ctx = makeFpCtx({ any: standaloneFile })
		const { FileProcessor } = await import('../src/sync/FileProcessor')
		const p = new FileProcessor(ctx as never)
		await p.process(makeItem(), standaloneFile.path, 'new body', 'Synced', '同步助手_20260806_文本')
		expect(ctx._successes).toEqual([MSG_ID])
		expect(ctx._burnDeletes).toEqual([MSG_ID])
		expect(ctx._diaryLinks).toEqual([MSG_ID])
	})
})

describe('FileProcessor：任何单篇写入都不许覆写合并文件（模式切换后的历史 vault）', () => {
	it('通用索引命中合并文件（双写→不合并 切换后的存量）→ 退回独立笔记，绝不整份覆写 digest', async () => {
		// 非双写调用（mergeMode 已切回 NONE），但 marker 索引把 id 指向了合并文件
		const ctx = makeFpCtx({ any: mergeFile, standalone: standaloneFile })
		const { FileProcessor } = await import('../src/sync/FileProcessor')
		const p = new FileProcessor(ctx as never)
		await p.process(makeItem(), standaloneFile.path, 'new body', 'Synced', '同步助手_20260806_文本')
		expect(ctx._modified.map(([path]) => path)).toEqual([standaloneFile.path])
		expect(ctx._modified.find(([path]) => path === mergeFile.path)).toBeUndefined()
	})

	it('目标路径上坐着合并文件 → 改写编号文件，不原地覆盖', async () => {
		// 索引全空 → 走路径分支；而该路径上正是一个合并文件（须是真 TFile 实例才走 existing 分支）
		const { TFile } = await import('obsidian')
		const mergeTFile = Object.assign(new TFile(), mergeFile)
		const ctx = makeFpCtx({}, 'digest 正文', { fileAtPath: mergeTFile })
		const { FileProcessor } = await import('../src/sync/FileProcessor')
		const p = new FileProcessor(ctx as never)
		await p.process(makeItem(), mergeFile.path, 'new body', 'Synced', '同步助手_2026-08-06')
		expect(ctx._modified).toEqual([])                                   // 合并文件零改动
		expect(ctx._created).toEqual(['Synced/同步助手_2026-08-06 2.md'])   // 落到编号文件
	})
})
