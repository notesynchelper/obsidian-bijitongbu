/**
 * 交叉：日记双链「写入位置 / 写入顺序」 × 「无 id」模式
 *   （disableMessageMarkers 消息不写 id / omitFrontmatterId 笔记属性不写 id）
 *
 * 为什么必须交叉测：
 *   MergeProcessor 的 addLink 调用发生在【全批】item 上（src/sync/MergeProcessor.ts
 *   的两个收尾 for 循环遍历 wechatItems / articleItems，**不是**过滤后的
 *   newWechat / liveArticles）。也就是说「无 id」模式下被游标判定为已同步、
 *   合并文件里一个字都没写的 item，照样会被塞进 DiaryLinkProcessor。
 *   于是「日记不重复」这件事完全落在 DiaryLinkProcessor 自己的去重上，
 *   而这次改动动的正是它的去重范围（锚点区域 → 顶部/底部时放大到整个文件）。
 *
 * 本组钉死三件事：
 *   1. 「无 id」两个开关**不影响**日记里的 <!-- notehelper:id:… --> 标记 —— 它们
 *      的语义分别是「合并消息不写 <!--nh:id-->」「笔记属性不写 id/syncedIds」，
 *      都不覆盖日记文件。日记标记是日记去重的唯一可靠依据（见
 *      diaryLinkRepeatSync.spec.ts：纯串匹配会因标题/正文微变翻车），
 *      若哪天顺手把它也一起去掉，本组会红。
 *   2. 游标已覆盖的二次同步：合并文件逐字节不变，**日记也不新增第二条** ——
 *      三种写入位置（锚点/顶部/底部）都成立。
 *   3. 「无 id」开着时，一次多条的批次内升序/降序仍然按设置生效。
 */

jest.mock('obsidian', () => {
	const actual = jest.requireActual('obsidian')
	class MockTFile {
		path: string
		basename: string
		name: string
		extension = 'md'
		constructor(path: string) {
			this.path = path
			this.name = path.split('/').pop() || ''
			this.basename = this.name.replace(/\.md$/, '')
		}
	}
	return {
		...actual,
		TFile: MockTFile,
		normalizePath: (p: string) => p,
		Notice: jest.fn(),
	}
})

jest.mock('obsidian-daily-notes-interface', () => ({
	getDailyNoteSettings: jest.fn(),
	createDailyNote: jest.fn(),
	appHasDailyNotesPluginLoaded: jest.fn(() => false),
}))

jest.mock('../src/logger', () => ({
	log: jest.fn(),
	logError: jest.fn(),
	Logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { Item } from '@omnivore-app/api'
import { TFile as MockTFileType } from 'obsidian'
import {
	DEFAULT_SETTINGS,
	MessageSortOrder,
	DiaryLinkType,
	DiaryWritePosition,
	DiaryLinkOrder,
} from '../src/settings'
import { DiaryLinkProcessor } from '../src/sync/DiaryLinkProcessor'
import type { DailyNoteResolver } from '../src/sync/DailyNoteResolver'
import type { MergeBatchItem } from '../src/sync/MergeProcessor'

const MockTFile = MockTFileType as unknown as new (path: string) => {
	path: string
	basename: string
	name: string
	extension: string
}

const DAY = '2026-08-05'
const DIARY_PATH = `Daily Notes/${DAY}.md`
const ANCHOR = 'notehelper-links'
const ANCHOR_TAG = `<!-- ${ANCHOR} -->`
/** 游标：早于它的 item 视为「已有设备同步过」 */
const CURSOR = '2026-08-05T08:00:00.000Z'

const DIARY_MARKER_RE = /<!-- notehelper:id:([^\s>]+) -->/g
const MERGE_MARKER_RE = /<!--nh:([0-9a-zA-Z-]+)-->/g

let uuidCounter = 200
function nextUuid(): string {
	return `c1d2e3f4-0000-4000-8000-0000000${String(uuidCounter++).padStart(5, '0')}`
}

function makeWeChatItem(savedAt: string, tag: string): Item {
	return {
		id: nextUuid(),
		title: '同步助手_20260805_001_文本',
		savedAt,
		updatedAt: savedAt,
		content: `<p>${tag}</p>`,
		url: 'https://example.com',
		slug: 's',
		labels: [],
		highlights: [],
		siteName: '企业微信',
	} as unknown as Item
}

function makeArticleItem(savedAt: string, tag: string): Item {
	return {
		id: nextUuid(),
		title: tag,
		savedAt,
		updatedAt: savedAt,
		content: `<p>article ${tag}</p>`,
		url: 'https://example.com/a',
		slug: 'a',
		labels: [],
		highlights: [],
		siteName: 'blog',
	} as unknown as Item
}

// --- 日记侧：内存 vault + 真 DiaryLinkProcessor ---
function makeDiary(initial: string) {
	const files = new Map<string, string>([[DIARY_PATH, initial]])
	const diaryFile = new MockTFile(DIARY_PATH)
	const vault = {
		async read(file: { path: string }) {
			const v = files.get(file.path)
			if (v === undefined) throw new Error(`not found: ${file.path}`)
			return v
		},
		async modify(file: { path: string }, content: string) {
			files.set(file.path, content)
		},
	}
	return {
		files,
		diaryFile,
		vault,
		get body() {
			return files.get(DIARY_PATH)!
		},
		reset(content: string) {
			files.set(DIARY_PATH, content)
		},
	}
}

function diaryWithAnchors(): string {
	return `---\ntags: [日记]\n---\n\n# ${DAY}\n\n${ANCHOR_TAG}\n${ANCHOR_TAG}\n\n## 随手记\n`
}
function diaryNoAnchors(): string {
	return `---\ntags: [日记]\n---\n\n# ${DAY}\n\n## 随手记\n`
}

/** 合并侧 SyncContext mock，diaryLinkProcessor 换成【真】实现 */
function makeCtx(
	settings: Record<string, unknown>,
	diary: ReturnType<typeof makeDiary>,
) {
	let fileContent = ''
	const merged = {
		settings: {
			...DEFAULT_SETTINGS,
			messageSortOrder: MessageSortOrder.DESC,
			dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
			wechatMessageTemplate: '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}',
			sectionSeparator: '',
			sectionSeparatorEnd: '',
			// 日记双链：默认锚点 + 降序，具体 case 再覆盖
			enableDiaryLinks: true,
			diaryAnchor: ANCHOR,
			diaryLinkPrefix: '- ',
			diaryLinkMaxLength: 0,
			diaryLinkType: DiaryLinkType.ALL,
			diaryWritePosition: DiaryWritePosition.ANCHOR,
			diaryLinkOrder: DiaryLinkOrder.DESC,
			// 游标（「无 id」模式的去重依据）
			syncAt: CURSOR,
			deviceSyncCursors: {},
			...settings,
		},
		app: {
			vault: {
				// 合并文件（MergeProcessor 用 process）
				process: jest.fn(async (_file: unknown, fn: (data: string) => string) => {
					fileContent = fn(fileContent)
					return fileContent
				}),
				// 日记文件（DiaryLinkProcessor 用 read/modify）
				read: diary.vault.read,
				modify: diary.vault.modify,
			},
		},
		successTracker: { recordSuccess: jest.fn() },
		enqueueFileForImageLocalization: jest.fn(async () => {}),
		enqueueFileForAttachmentLocalization: jest.fn(async () => {}),
		addProcessedFile: jest.fn(),
		imageLocalizer: null,
		getFileContent: () => fileContent,
		setFileContent: (c: string) => { fileContent = c },
	}
	const stubResolver = {
		resolve: jest.fn(async () => ({ file: diary.diaryFile })),
	} as unknown as DailyNoteResolver
	const diaryProcessor = new DiaryLinkProcessor(
		merged.app as never,
		merged.settings as never,
		stubResolver,
	)
	return { ...merged, diaryLinkProcessor: diaryProcessor }
}

const MERGE_FILE = {
	path: `笔记同步助手/${DAY}/同步助手_${DAY}.md`,
	basename: `同步助手_${DAY}`,
} as never

async function newMergeProcessor(ctx: unknown) {
	const { MergeProcessor } = await import('../src/sync/MergeProcessor')
	return new MergeProcessor(ctx as never)
}

/** 跑一轮完整的「合并写入 + 日记双链落盘」 */
async function runRound(ctx: ReturnType<typeof makeCtx>, items: Item[]) {
	const processor = await newMergeProcessor(ctx)
	const batch: MergeBatchItem[] = items.map(item => ({ item, content: '' }))
	await processor.processBatch(batch, MERGE_FILE)
	const result = await ctx.diaryLinkProcessor.processAll()
	ctx.diaryLinkProcessor.reset()
	return result
}

function diaryLinkTitles(body: string): string[] {
	return [...body.matchAll(/\[\[[^\]|]*(?:#[^\]|]*)?\|([^\]]*)\]\]/g)].map(m => m[1])
}
function diaryMarkerIds(body: string): string[] {
	return [...body.matchAll(DIARY_MARKER_RE)].map(m => m[1])
}
function mergeMarkerIds(body: string): string[] {
	return [...body.matchAll(MERGE_MARKER_RE)].map(m => m[1])
}

const NO_ID_MODES: Array<[string, Record<string, unknown>]> = [
	['消息不写 id', { disableMessageMarkers: true }],
	['笔记属性不写 id', { omitFrontmatterId: true }],
	['两个开关都开', { disableMessageMarkers: true, omitFrontmatterId: true }],
]

const POSITIONS: Array<[string, Record<string, unknown>, (b: string) => string]> = [
	[
		'锚点之间',
		{ diaryWritePosition: DiaryWritePosition.ANCHOR },
		diaryWithAnchors,
	],
	['文件顶部', { diaryWritePosition: DiaryWritePosition.TOP }, diaryNoAnchors],
	['文件底部', { diaryWritePosition: DiaryWritePosition.BOTTOM }, diaryNoAnchors],
]

describe('日记写入位置/顺序 × 「无 id」模式 交叉', () => {
	describe('日记标记不受「无 id」两个开关影响（它们只管合并文件 / 笔记属性）', () => {
		for (const [modeName, modeSettings] of NO_ID_MODES) {
			it(`${modeName}：合并文件无 <!--nh:id-->，但日记仍写 <!-- notehelper:id: -->`, async () => {
				const diary = makeDiary(diaryWithAnchors())
				const ctx = makeCtx(modeSettings, diary)
				// 全部晚于游标 = 真新消息，合并文件会写
				const items = [
					makeWeChatItem('2026-08-05T09:00:00.000Z', '消息甲'),
					makeWeChatItem('2026-08-05T10:00:00.000Z', '消息乙'),
				]
				await runRound(ctx, items)

				// 合并侧：noMarkers 时不写内联标记；仅 omitId 时标记仍在（既有契约）
				if (modeSettings.disableMessageMarkers) {
					expect(mergeMarkerIds(ctx.getFileContent())).toHaveLength(0)
				}
				// 日记侧：标记必须在 —— 它是日记去重的唯一可靠依据
				expect(diaryMarkerIds(diary.body).sort()).toEqual(items.map(i => i.id).sort())
			})
		}

		it('对照组：「无 id」全关时日记标记同样在（说明开关本就与日记无关）', async () => {
			const diary = makeDiary(diaryWithAnchors())
			const ctx = makeCtx({}, diary)
			const items = [makeWeChatItem('2026-08-05T09:00:00.000Z', '消息甲')]
			await runRound(ctx, items)
			expect(diaryMarkerIds(diary.body)).toEqual([items[0].id])
		})
	})

	describe('游标已覆盖的二次同步：合并文件不动，日记也不新增', () => {
		// addLink 遍历的是全批 item（不是过滤后的），所以这一条完全靠日记自己的去重兜住
		for (const [modeName, modeSettings] of NO_ID_MODES) {
			for (const [posName, posSettings, initial] of POSITIONS) {
				it(`${modeName} × ${posName}`, async () => {
					const diary = makeDiary(initial(''))
					const ctx = makeCtx({ ...modeSettings, ...posSettings }, diary)
					const items = [
						makeWeChatItem('2026-08-05T09:00:00.000Z', '消息甲'),
						makeArticleItem('2026-08-05T10:00:00.000Z', '文章乙'),
					]

					await runRound(ctx, items)
					const afterFirst = diary.body
					const countMsg = (s: string, needle: string) => s.split(needle).length - 1
					const msgAfterFirst = countMsg(ctx.getFileContent(), '消息甲')
					const artAfterFirst = countMsg(ctx.getFileContent(), '文章乙')
					expect(diaryLinkTitles(afterFirst)).toHaveLength(2)

					// 第二轮：游标推到两条之后 → 合并侧判定「已同步」，
					// 但 addLink 仍会被调用（全批遍历）
					ctx.settings.syncAt = '2026-08-05T23:00:00.000Z'
					await runRound(ctx, items)

					// 合并侧：消息正文/文章正文都没被重复追加。
					// ⚠️ 这里刻意**不**做整份逐字节比对：MergeProcessor 在「首轮之后的第一次
					// 空轮」会把空 frontmatter 后多余的空行归一掉一次（107→105B），之后恒定不变。
					// 实测是一次性归一、不逐轮蚕食，属既有行为，与本次日记改动无关。
					const merged = ctx.getFileContent()
					expect(countMsg(merged, '消息甲')).toBe(msgAfterFirst)
					expect(countMsg(merged, '文章乙')).toBe(artAfterFirst)
					// 日记侧：逐字节不变（本次改动真正要守的不变式）
					expect(diary.body).toBe(afterFirst)
					expect(diaryLinkTitles(diary.body)).toHaveLength(2)
				})
			}
		}
	})

	describe('「无 id」开着时，一次多条的批次内顺序仍按设置', () => {
		const scrambled = (): Item[] => [
			makeArticleItem('2026-08-05T12:00:00.000Z', '午'),
			makeArticleItem('2026-08-05T09:00:00.000Z', '晨'),
			makeArticleItem('2026-08-05T18:00:00.000Z', '晚'),
		]
		const bothOn = { disableMessageMarkers: true, omitFrontmatterId: true }

		it('锚点 + 降序 → 区域内 晚→午→晨', async () => {
			const diary = makeDiary(diaryWithAnchors())
			const ctx = makeCtx(
				{ ...bothOn, diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.DESC },
				diary,
			)
			await runRound(ctx, scrambled())
			expect(diaryLinkTitles(diary.body)).toEqual(['晚', '午', '晨'])
		})

		it('锚点 + 升序 → 区域内 晨→午→晚', async () => {
			const diary = makeDiary(diaryWithAnchors())
			const ctx = makeCtx(
				{ ...bothOn, diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.ASC },
				diary,
			)
			await runRound(ctx, scrambled())
			expect(diaryLinkTitles(diary.body)).toEqual(['晨', '午', '晚'])
		})

		it('文件顶部 → 晚→午→晨，且前置元数据不被打散', async () => {
			const diary = makeDiary(diaryNoAnchors())
			const ctx = makeCtx({ ...bothOn, diaryWritePosition: DiaryWritePosition.TOP }, diary)
			await runRound(ctx, scrambled())
			expect(diaryLinkTitles(diary.body)).toEqual(['晚', '午', '晨'])
			expect(diary.body.startsWith('---\ntags: [日记]\n---\n')).toBe(true)
		})

		it('文件底部 → 晨→午→晚，且链接在正文之后', async () => {
			const diary = makeDiary(diaryNoAnchors())
			const ctx = makeCtx({ ...bothOn, diaryWritePosition: DiaryWritePosition.BOTTOM }, diary)
			await runRound(ctx, scrambled())
			expect(diaryLinkTitles(diary.body)).toEqual(['晨', '午', '晚'])
			expect(diary.body.indexOf('[[')).toBeGreaterThan(diary.body.indexOf('## 随手记'))
		})
	})

	describe('「无 id」下合并侧跳过、日记侧首次补写（日记落后于合并的追赶场景）', () => {
		// 真实场景：第一轮日记文件还不存在（fileNotFound 被跳过），用户后来建了日记；
		// 此时合并侧那条消息早被游标覆盖、一个字不写，但 addLink 仍会送来 →
		// 日记应当把它补上，而不是因为「合并侧跳过」就永远缺这一条。
		for (const [posName, posSettings, initial] of POSITIONS) {
			it(`${posName}：合并跳过的 item 仍能补进日记`, async () => {
				const diary = makeDiary(initial(''))
				const ctx = makeCtx(
					{ disableMessageMarkers: true, omitFrontmatterId: true, ...posSettings },
					diary,
				)
				// 游标已经在两条之后 → 合并侧全跳过
				ctx.settings.syncAt = '2026-08-05T23:00:00.000Z'
				const items = [
					makeWeChatItem('2026-08-05T09:00:00.000Z', '消息甲'),
					makeArticleItem('2026-08-05T10:00:00.000Z', '文章乙'),
				]
				await runRound(ctx, items)

				expect(diaryLinkTitles(diary.body)).toHaveLength(2)
				expect(diaryMarkerIds(diary.body).sort()).toEqual(items.map(i => i.id).sort())
			})
		}
	})
})
