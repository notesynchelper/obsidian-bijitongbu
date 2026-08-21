/**
 * 日记双链「写入位置 + 写入顺序」
 *
 * 两个新设置：
 *   1. diaryWritePosition —— 锚点之间（默认，历史行为）/ 文件顶部 / 文件底部
 *   2. diaryLinkOrder     —— 时间降序（新的在前）/ 时间升序（新的在后），仅锚点位置可选
 *
 * 关键点（也是本 spec 的重心）：顺序设置必须真正作用到「一次同步多条」的
 * 【批次内】排列，而不只是决定「整批插在锚点区域的顶部还是底部」。两者一起变才
 * 能让多轮同步后的整体时间轴保持单调；只改一头会拧成
 * 「批次之间降序、批次之内升序」的锯齿。
 */

jest.mock('obsidian', () => {
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
		App: jest.fn(),
		TFile: MockTFile,
		normalizePath: (p: string) => p,
		Notice: jest.fn(),
	}
})

import { TFile as MockTFileType } from 'obsidian'
import {
	DEFAULT_SETTINGS,
	OmnivoreSettings,
	DiaryLinkType,
	DiaryWritePosition,
	DiaryLinkOrder,
} from '../src/settings/index'
import { DiaryLinkProcessor } from '../src/sync/DiaryLinkProcessor'
import type { DailyNoteResolver } from '../src/sync/DailyNoteResolver'

const MockTFile = MockTFileType as unknown as new (path: string) => {
	path: string
	basename: string
	name: string
	extension: string
}

jest.mock('obsidian-daily-notes-interface', () => ({
	getDailyNoteSettings: jest.fn(),
	createDailyNote: jest.fn(),
	appHasDailyNotesPluginLoaded: jest.fn(() => false),
}))

jest.mock('../src/logger', () => ({
	log: jest.fn(),
	logError: jest.fn(),
}))

const DIARY_PATH = 'Daily Notes/2024-01-15.md'
const ANCHOR = 'notehelper-links'
const ANCHOR_TAG = `<!-- ${ANCHOR} -->`

interface FakeVault {
	files: Map<string, string>
	read(file: InstanceType<typeof MockTFile>): Promise<string>
	modify(file: InstanceType<typeof MockTFile>, content: string): Promise<void>
}

function buildVault(initial: Record<string, string> = {}): FakeVault {
	const files = new Map<string, string>(Object.entries(initial))
	return {
		files,
		async read(file: InstanceType<typeof MockTFile>) {
			const v = files.get(file.path)
			if (v === undefined) throw new Error(`file not found: ${file.path}`)
			return v
		},
		async modify(file: InstanceType<typeof MockTFile>, content: string) {
			files.set(file.path, content)
		},
	}
}

function makeDiaryContent(body = ''): string {
	return `# 2024-01-15\n\n${ANCHOR_TAG}${body ? `\n${body}` : ''}\n${ANCHOR_TAG}\n`
}

function buildProcessor(
	overrides: Partial<OmnivoreSettings>,
	vault: FakeVault,
	diaryFile: InstanceType<typeof MockTFile>,
): DiaryLinkProcessor {
	const settings: OmnivoreSettings = {
		...DEFAULT_SETTINGS,
		enableDiaryLinks: true,
		diaryAnchor: ANCHOR,
		diaryLinkPrefix: '- ',
		diaryLinkMaxLength: 0,
		diaryLinkType: DiaryLinkType.ALL,
		...overrides,
	}
	const fakeApp = { vault } as any
	const stubResolver = {
		resolve: jest.fn(async () => ({ file: diaryFile })),
	} as unknown as DailyNoteResolver
	return new DiaryLinkProcessor(fakeApp, settings, stubResolver)
}

/** 同一天内不同时刻的文章（09:00 / 12:00 / 18:00…），标题即"第 n 条" */
function articleAt(hour: number, label: string, id = `item-${label}`): any {
	const iso = `2024-01-15T${String(hour).padStart(2, '0')}:00:00.000Z`
	return {
		id,
		title: label,
		content: '<p>c</p>',
		savedAt: iso,
		updatedAt: iso,
		createdAt: iso,
		url: '',
		slug: '',
		author: null,
		siteName: null,
		siteIcon: null,
		publishedAt: null,
		readAt: null,
		isArchived: false,
		contentReader: 'WEB',
		pageType: 'ARTICLE',
		state: 'SUCCEEDED',
		description: null,
		labels: [],
		highlights: [],
		image: null,
		words: null,
		wordsCount: null,
		readingProgressTopPercent: 0,
		readingProgressPercent: 0,
		readingProgressAnchorIndex: 0,
	}
}

/** 文件里所有链接行的显示文字，按出现先后 */
function linkTitlesInFile(content: string): string[] {
	return [...content.matchAll(/\[\[[^\]|]*\|([^\]]*)\]\]/g)].map((m) => m[1])
}

/** 锚点区域内所有链接行的显示文字，按出现先后 */
function linkTitlesInRegion(content: string): string[] {
	const first = content.indexOf(ANCHOR_TAG)
	const second = content.indexOf(ANCHOR_TAG, first + ANCHOR_TAG.length)
	return linkTitlesInFile(content.slice(first + ANCHOR_TAG.length, second))
}

/** 一次同步：把 items 按给定顺序喂进去（模拟收集顺序），跑完 processAll */
async function syncBatch(
	vault: FakeVault,
	diaryFile: InstanceType<typeof MockTFile>,
	overrides: Partial<OmnivoreSettings>,
	items: any[],
) {
	const processor = buildProcessor(overrides, vault, diaryFile)
	for (const it of items) processor.addLink(it, `file-${it.title}`, undefined)
	return processor.processAll()
}

describe('日记双链写入位置 / 写入顺序', () => {
	describe('默认值：零回归', () => {
		it('默认设置 = 锚点之间 + 时间降序', () => {
			expect(DEFAULT_SETTINGS.diaryWritePosition).toBe(DiaryWritePosition.ANCHOR)
			expect(DEFAULT_SETTINGS.diaryLinkOrder).toBe(DiaryLinkOrder.DESC)
		})

		it('默认设置下产物与历史实现逐字节一致（区域顶部插入、无多余空行）', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: makeDiaryContent() })
			const item = articleAt(9, 'A')

			await syncBatch(vault, diaryFile, {}, [item])

			const after = vault.files.get(DIARY_PATH)!
			expect(after).toBe(
				`# 2024-01-15\n\n${ANCHOR_TAG}\n- [[file-A|A]] <!-- notehelper:id:item-A -->\n${ANCHOR_TAG}\n`,
			)
		})

		it('缺少成对锚点仍然跳过（anchorMissing）', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: `# 2024-01-15\n${ANCHOR_TAG}\n` })

			const result = await syncBatch(vault, diaryFile, {}, [articleAt(9, 'A')])

			expect(result.skipped).toBe(1)
			expect(result.skipReasons.anchorMissing).toEqual(['2024-01-15'])
			expect(vault.files.get(DIARY_PATH)).toBe(`# 2024-01-15\n${ANCHOR_TAG}\n`)
		})
	})

	// ---- 重点：一次多条时，批次【内部】也要按顺序设置排 ----
	describe('锚点 + 一次同步多条：批次内排序', () => {
		// 收集顺序故意打乱（12:00 → 09:00 → 18:00），确保断言测的是"按时间排序"，
		// 而不是"恰好保留了收集顺序"。
		const scrambled = () => [articleAt(12, '午'), articleAt(9, '晨'), articleAt(18, '晚')]

		it('降序：批次内新→旧，且整批在区域顶部', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: makeDiaryContent() })

			await syncBatch(
				vault,
				diaryFile,
				{ diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.DESC },
				scrambled(),
			)

			expect(linkTitlesInRegion(vault.files.get(DIARY_PATH)!)).toEqual(['晚', '午', '晨'])
		})

		it('升序：批次内旧→新，且整批在区域底部', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: makeDiaryContent() })

			await syncBatch(
				vault,
				diaryFile,
				{ diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.ASC },
				scrambled(),
			)

			expect(linkTitlesInRegion(vault.files.get(DIARY_PATH)!)).toEqual(['晨', '午', '晚'])
		})

		it('升序不吃掉区域里已有的旧链接，新批次追加在其下方', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: makeDiaryContent() })
			const opts = {
				diaryWritePosition: DiaryWritePosition.ANCHOR,
				diaryLinkOrder: DiaryLinkOrder.ASC,
			}

			await syncBatch(vault, diaryFile, opts, [articleAt(8, '早批A'), articleAt(9, '早批B')])
			await syncBatch(vault, diaryFile, opts, [articleAt(21, '晚批B'), articleAt(20, '晚批A')])

			expect(linkTitlesInRegion(vault.files.get(DIARY_PATH)!)).toEqual([
				'早批A',
				'早批B',
				'晚批A',
				'晚批B',
			])
			// 锚点仍然成对、结构没被打散
			const after = vault.files.get(DIARY_PATH)!
			expect(after.split(ANCHOR_TAG).length - 1).toBe(2)
			expect(after.endsWith(`${ANCHOR_TAG}\n`)).toBe(true)
		})

		it('多轮降序：整体时间轴单调递减（批次之间 + 批次之内都对）', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: makeDiaryContent() })
			const opts = {
				diaryWritePosition: DiaryWritePosition.ANCHOR,
				diaryLinkOrder: DiaryLinkOrder.DESC,
			}

			await syncBatch(vault, diaryFile, opts, [articleAt(9, '早批B'), articleAt(8, '早批A')])
			await syncBatch(vault, diaryFile, opts, [articleAt(20, '晚批A'), articleAt(21, '晚批B')])

			expect(linkTitlesInRegion(vault.files.get(DIARY_PATH)!)).toEqual([
				'晚批B',
				'晚批A',
				'早批B',
				'早批A',
			])
		})

		it('时间相同的多条保持收集顺序（稳定排序，不随机抖动）', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: makeDiaryContent() })
			const same = [
				articleAt(10, '一', 'id-1'),
				articleAt(10, '二', 'id-2'),
				articleAt(10, '三', 'id-3'),
			]

			await syncBatch(
				vault,
				diaryFile,
				{ diaryWritePosition: DiaryWritePosition.ANCHOR, diaryLinkOrder: DiaryLinkOrder.DESC },
				same,
			)

			expect(linkTitlesInRegion(vault.files.get(DIARY_PATH)!)).toEqual(['一', '二', '三'])
		})
	})

	describe('文件顶部', () => {
		it('无前置元数据：整批写在正文最上方，批次内新→旧', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: '# 2024-01-15\n\n今天写点什么。\n' })

			await syncBatch(vault, diaryFile, { diaryWritePosition: DiaryWritePosition.TOP }, [
				articleAt(12, '午'),
				articleAt(9, '晨'),
				articleAt(18, '晚'),
			])

			const after = vault.files.get(DIARY_PATH)!
			expect(linkTitlesInFile(after)).toEqual(['晚', '午', '晨'])
			expect(after.startsWith('- [[file-晚|晚]]')).toBe(true)
			expect(after.endsWith('# 2024-01-15\n\n今天写点什么。\n')).toBe(true)
		})

		it('有前置元数据：插在 --- 之后，属性块不被打散', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({
				[DIARY_PATH]: '---\ntags: [日记]\nmood: 好\n---\n# 2024-01-15\n正文\n',
			})

			await syncBatch(vault, diaryFile, { diaryWritePosition: DiaryWritePosition.TOP }, [
				articleAt(9, '晨'),
				articleAt(18, '晚'),
			])

			expect(vault.files.get(DIARY_PATH)).toBe(
				'---\ntags: [日记]\nmood: 好\n---\n' +
					'- [[file-晚|晚]] <!-- notehelper:id:item-晚 -->\n' +
					'- [[file-晨|晨]] <!-- notehelper:id:item-晨 -->\n' +
					'# 2024-01-15\n正文\n',
			)
		})

		it('顶部模式不需要锚点：无锚点的日记也能写进去', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: '# 2024-01-15\n' })

			const result = await syncBatch(
				vault,
				diaryFile,
				{ diaryWritePosition: DiaryWritePosition.TOP },
				[articleAt(9, 'A')],
			)

			expect(result.success).toBe(1)
			expect(result.skipReasons.anchorMissing).toEqual([])
			expect(vault.files.get(DIARY_PATH)).toContain('[[file-A|A]]')
		})

		it('多轮：新批次压在旧批次之上（整体新→旧）', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: '# 2024-01-15\n' })
			const opts = { diaryWritePosition: DiaryWritePosition.TOP }

			await syncBatch(vault, diaryFile, opts, [articleAt(8, '早批A'), articleAt(9, '早批B')])
			await syncBatch(vault, diaryFile, opts, [articleAt(20, '晚批A'), articleAt(21, '晚批B')])

			expect(linkTitlesInFile(vault.files.get(DIARY_PATH)!)).toEqual([
				'晚批B',
				'晚批A',
				'早批B',
				'早批A',
			])
		})
	})

	describe('文件底部', () => {
		it('整批追加到文件末尾，批次内旧→新', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: '# 2024-01-15\n\n今天写点什么。\n' })

			await syncBatch(vault, diaryFile, { diaryWritePosition: DiaryWritePosition.BOTTOM }, [
				articleAt(12, '午'),
				articleAt(9, '晨'),
				articleAt(18, '晚'),
			])

			expect(vault.files.get(DIARY_PATH)).toBe(
				'# 2024-01-15\n\n今天写点什么。\n' +
					'- [[file-晨|晨]] <!-- notehelper:id:item-晨 -->\n' +
					'- [[file-午|午]] <!-- notehelper:id:item-午 -->\n' +
					'- [[file-晚|晚]] <!-- notehelper:id:item-晚 -->\n',
			)
		})

		it('原文件不以换行结尾时补一个换行，不把链接粘到正文末行', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: '# 2024-01-15\n没有结尾换行' })

			await syncBatch(vault, diaryFile, { diaryWritePosition: DiaryWritePosition.BOTTOM }, [
				articleAt(9, 'A'),
			])

			expect(vault.files.get(DIARY_PATH)).toBe(
				'# 2024-01-15\n没有结尾换行\n- [[file-A|A]] <!-- notehelper:id:item-A -->\n',
			)
		})

		it('多轮：新批次接在旧批次之下（整体旧→新）', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: '# 2024-01-15\n' })
			const opts = { diaryWritePosition: DiaryWritePosition.BOTTOM }

			await syncBatch(vault, diaryFile, opts, [articleAt(9, '早批B'), articleAt(8, '早批A')])
			await syncBatch(vault, diaryFile, opts, [articleAt(21, '晚批B'), articleAt(20, '晚批A')])

			expect(linkTitlesInFile(vault.files.get(DIARY_PATH)!)).toEqual([
				'早批A',
				'早批B',
				'晚批A',
				'晚批B',
			])
		})
	})

	describe('去重不变式在各位置都成立', () => {
		for (const position of [
			DiaryWritePosition.ANCHOR,
			DiaryWritePosition.TOP,
			DiaryWritePosition.BOTTOM,
		]) {
			it(`${position}：同一 item 二次同步不新增第二条`, async () => {
				const diaryFile = new MockTFile(DIARY_PATH)
				const vault = buildVault({ [DIARY_PATH]: makeDiaryContent() })
				const opts = { diaryWritePosition: position }
				const item = articleAt(9, 'A')

				await syncBatch(vault, diaryFile, opts, [item])
				await syncBatch(vault, diaryFile, opts, [item])

				expect(linkTitlesInFile(vault.files.get(DIARY_PATH)!)).toEqual(['A'])
			})
		}

		it('从锚点切到底部：锚点区域里已有的链接不会被再写一遍（去重范围=整文件）', async () => {
			const diaryFile = new MockTFile(DIARY_PATH)
			const vault = buildVault({ [DIARY_PATH]: makeDiaryContent() })
			const older = articleAt(9, '旧')

			await syncBatch(
				vault,
				diaryFile,
				{ diaryWritePosition: DiaryWritePosition.ANCHOR },
				[older],
			)
			// 用户改设置 → 同一条 + 一条新的再同步一次
			await syncBatch(vault, diaryFile, { diaryWritePosition: DiaryWritePosition.BOTTOM }, [
				older,
				articleAt(20, '新'),
			])

			expect(linkTitlesInFile(vault.files.get(DIARY_PATH)!)).toEqual(['旧', '新'])
		})
	})
})
