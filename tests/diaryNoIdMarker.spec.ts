/**
 * 「日记不写 id」（disableDiaryLinkMarkers）—— 第三个「不写 id」开关
 *
 * 与另外两个（disableMessageMarkers 消息 / omitFrontmatterId 笔记属性）同构，
 * 但作用面是【日记文件】：开启后日记双链末尾不再挂
 * <!-- notehelper:id:… -->，防重复改由「最新同步游标」承担。
 *
 * 为什么开启时必须同时上游标去重（而不是只把标记删掉）：
 *   MergeProcessor / FileProcessor 是对【全批】item 调 addLink 的，不走它们自己
 *   的游标过滤 —— 已同步过的 item 每轮都会再送进来一次。没有标记又不筛游标，
 *   就只剩「整条 wikilink 串匹配」这一道兜底，而它会因标题/正文微变翻车
 *   （diaryLinkRepeatSync.spec.ts 记录的原始 bug）。所以 addLink 里按游标先筛一道。
 *
 * 本组钉住：
 *  1. 开启后新链接无标记；关闭时（默认）照常写标记
 *  2. 游标已覆盖的 item 不再进日记（二次同步不重复）—— 三种写入位置都成立
 *  3. 存量历史标记仍参与去重（开关打开前写过的链接不会重复）
 *  4. burn 优先：阅后即焚开启时本开关不生效，标记照写
 *  5. debugActive 旁路：调试重拉的旧 item 不被游标误杀
 *  6. 关掉开关后恢复写标记（可逆）
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

jest.mock('obsidian-daily-notes-interface', () => ({
	getDailyNoteSettings: jest.fn(),
	createDailyNote: jest.fn(),
	appHasDailyNotesPluginLoaded: jest.fn(() => false),
}))

jest.mock('../src/logger', () => ({
	log: jest.fn(),
	logError: jest.fn(),
}))

import { TFile as MockTFileType } from 'obsidian'
import {
	DEFAULT_SETTINGS,
	OmnivoreSettings,
	DiaryLinkType,
	DiaryWritePosition,
} from '../src/settings/index'
import { DiaryLinkProcessor } from '../src/sync/DiaryLinkProcessor'
import type { DailyNoteResolver } from '../src/sync/DailyNoteResolver'

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
/** 游标：严格早于它的 item 视为「已有设备同步过」 */
const CURSOR = '2026-08-05T12:00:00.000Z'

interface FakeVault {
	files: Map<string, string>
	read(f: { path: string }): Promise<string>
	modify(f: { path: string }, c: string): Promise<void>
}

function buildVault(initial: Record<string, string>): FakeVault {
	const files = new Map(Object.entries(initial))
	return {
		files,
		async read(f) {
			const v = files.get(f.path)
			if (v === undefined) throw new Error(`not found: ${f.path}`)
			return v
		},
		async modify(f, c) {
			files.set(f.path, c)
		},
	}
}

function diaryWithAnchors(body = ''): string {
	return `# ${DAY}\n\n${ANCHOR_TAG}${body ? `\n${body}` : ''}\n${ANCHOR_TAG}\n`
}

function buildProcessor(
	overrides: Partial<OmnivoreSettings>,
	vault: FakeVault,
	diaryFile: InstanceType<typeof MockTFile>,
	debugActive = false,
): DiaryLinkProcessor {
	const settings: OmnivoreSettings = {
		...DEFAULT_SETTINGS,
		enableDiaryLinks: true,
		diaryAnchor: ANCHOR,
		diaryLinkPrefix: '- ',
		diaryLinkMaxLength: 0,
		diaryLinkType: DiaryLinkType.ALL,
		syncAt: CURSOR,
		deviceSyncCursors: {},
		...overrides,
	}
	const stubResolver = {
		resolve: jest.fn(async () => ({ file: diaryFile })),
	} as unknown as DailyNoteResolver
	return new DiaryLinkProcessor({ vault } as never, settings, stubResolver, debugActive)
}

function article(iso: string, label: string, id = `id-${label}`): any {
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

const FRESH = '2026-08-05T18:00:00.000Z' // 晚于游标 = 新
const COVERED = '2026-08-05T09:00:00.000Z' // 早于游标 = 已同步过

function markerCount(body: string): number {
	return (body.match(/<!-- notehelper:id:[^\s>]+ -->/g) || []).length
}
function linkTitles(body: string): string[] {
	return [...body.matchAll(/\[\[[^\]|]*\|([^\]]*)\]\]/g)].map(m => m[1])
}

async function sync(
	vault: FakeVault,
	file: InstanceType<typeof MockTFile>,
	overrides: Partial<OmnivoreSettings>,
	items: any[],
	debugActive = false,
) {
	const p = buildProcessor(overrides, vault, file, debugActive)
	for (const it of items) p.addLink(it, `file-${it.title}`, undefined)
	return p.processAll()
}

const ON = { disableDiaryLinkMarkers: true }

describe('日记不写 id（disableDiaryLinkMarkers）', () => {
	it('默认关：新链接照常带 notehelper:id 标记', async () => {
		const f = new MockTFile(DIARY_PATH)
		const v = buildVault({ [DIARY_PATH]: diaryWithAnchors() })
		expect(DEFAULT_SETTINGS.disableDiaryLinkMarkers).toBe(false)

		await sync(v, f, {}, [article(FRESH, 'A')])

		expect(markerCount(v.files.get(DIARY_PATH)!)).toBe(1)
	})

	it('开启：新链接干干净净，一个隐藏注释符都没有', async () => {
		const f = new MockTFile(DIARY_PATH)
		const v = buildVault({ [DIARY_PATH]: diaryWithAnchors() })

		await sync(v, f, ON, [article(FRESH, 'A'), article(FRESH, 'B')])

		const body = v.files.get(DIARY_PATH)!
		expect(markerCount(body)).toBe(0)
		expect(linkTitles(body).sort()).toEqual(['A', 'B'])
		// 除了日记本来就有的两个锚点，不许多出任何注释
		expect((body.match(/<!--[\s\S]*?-->/g) || []).length).toBe(2)
	})

	describe('无标记时靠游标防重复（三种写入位置）', () => {
		const positions: Array<[string, DiaryWritePosition, string]> = [
			['锚点之间', DiaryWritePosition.ANCHOR, diaryWithAnchors()],
			['文件顶部', DiaryWritePosition.TOP, `# ${DAY}\n\n正文\n`],
			['文件底部', DiaryWritePosition.BOTTOM, `# ${DAY}\n\n正文\n`],
		]

		for (const [name, position, initial] of positions) {
			it(`${name}：游标已覆盖的 item 不进日记`, async () => {
				const f = new MockTFile(DIARY_PATH)
				const v = buildVault({ [DIARY_PATH]: initial })

				await sync(v, f, { ...ON, diaryWritePosition: position }, [
					article(COVERED, '旧'),
					article(FRESH, '新'),
				])

				expect(linkTitles(v.files.get(DIARY_PATH)!)).toEqual(['新'])
			})

			it(`${name}：二次同步（游标推进后）不新增第二条`, async () => {
				const f = new MockTFile(DIARY_PATH)
				const v = buildVault({ [DIARY_PATH]: initial })
				const opts = { ...ON, diaryWritePosition: position }
				const item = article(FRESH, 'A')

				await sync(v, f, opts, [item])
				const afterFirst = v.files.get(DIARY_PATH)!
				expect(linkTitles(afterFirst)).toEqual(['A'])

				// 下一轮：游标推到该 item 之后
				await sync(v, f, { ...opts, syncAt: '2026-08-05T23:00:00.000Z' }, [item])

				expect(v.files.get(DIARY_PATH)).toBe(afterFirst)
			})
		}
	})

	it('存量历史标记仍参与去重（开关打开前写过的链接不会重复）', async () => {
		const f = new MockTFile(DIARY_PATH)
		const legacy = article(FRESH, 'A')
		// 模拟：开关打开【前】写下的一条（带标记）
		const v = buildVault({
			[DIARY_PATH]: diaryWithAnchors(
				`- [[file-A|A]] <!-- notehelper:id:${legacy.id} -->`,
			),
		})

		// 开关打开后又收到同一条（且它还没被游标覆盖，只能靠标记拦）
		await sync(v, f, ON, [legacy])

		const body = v.files.get(DIARY_PATH)!
		expect(linkTitles(body)).toEqual(['A'])
		expect(markerCount(body)).toBe(1) // 历史那一条，没被清掉
	})

	it('串匹配兜底：无标记的同一条链接不会被写第二遍', async () => {
		const f = new MockTFile(DIARY_PATH)
		const v = buildVault({ [DIARY_PATH]: diaryWithAnchors() })
		const item = article(FRESH, 'A')

		// 同一轮游标下重复送两次（游标拦不住，只能靠串匹配）
		await sync(v, f, ON, [item])
		await sync(v, f, ON, [item])

		expect(linkTitles(v.files.get(DIARY_PATH)!)).toEqual(['A'])
	})

	it('burn 优先：阅后即焚开启时本设置不生效，标记照写、游标不筛', async () => {
		const f = new MockTFile(DIARY_PATH)
		const v = buildVault({ [DIARY_PATH]: diaryWithAnchors() })

		await sync(v, f, { ...ON, burnAfterReading: true }, [
			article(COVERED, '旧'),
			article(FRESH, '新'),
		])

		const body = v.files.get(DIARY_PATH)!
		expect(markerCount(body)).toBe(2)
		expect(linkTitles(body).sort()).toEqual(['新', '旧'].sort())
	})

	it('debugActive 旁路：调试重拉的旧 item 不被游标误杀', async () => {
		const f = new MockTFile(DIARY_PATH)
		const v = buildVault({ [DIARY_PATH]: diaryWithAnchors() })

		await sync(v, f, ON, [article(COVERED, '旧')], true)

		expect(linkTitles(v.files.get(DIARY_PATH)!)).toEqual(['旧'])
	})

	it('可逆：关掉开关后恢复写标记', async () => {
		const f = new MockTFile(DIARY_PATH)
		const v = buildVault({ [DIARY_PATH]: diaryWithAnchors() })

		await sync(v, f, ON, [article(FRESH, 'A')])
		expect(markerCount(v.files.get(DIARY_PATH)!)).toBe(0)

		await sync(v, f, {}, [article(FRESH, 'B')])
		const body = v.files.get(DIARY_PATH)!
		expect(markerCount(body)).toBe(1) // 只有 B 那条带标记
		expect(linkTitles(body).sort()).toEqual(['A', 'B'])
	})

	it('无游标（首次同步）时一切照写，不会被误筛空', async () => {
		const f = new MockTFile(DIARY_PATH)
		const v = buildVault({ [DIARY_PATH]: diaryWithAnchors() })

		await sync(v, f, { ...ON, syncAt: '', deviceSyncCursors: {} }, [
			article(COVERED, '旧'),
			article(FRESH, '新'),
		])

		expect(linkTitles(v.files.get(DIARY_PATH)!).sort()).toEqual(['新', '旧'].sort())
	})

	it('写入顺序设置在无标记模式下照常生效', async () => {
		const f = new MockTFile(DIARY_PATH)
		const v = buildVault({ [DIARY_PATH]: diaryWithAnchors() })

		await sync(v, f, ON, [
			article('2026-08-05T15:00:00.000Z', '午'),
			article('2026-08-05T13:00:00.000Z', '晨'),
			article('2026-08-05T19:00:00.000Z', '晚'),
		])

		expect(linkTitles(v.files.get(DIARY_PATH)!)).toEqual(['晚', '午', '晨'])
	})
})
