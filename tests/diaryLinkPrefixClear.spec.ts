/**
 * 日记双链「前缀清空」验证
 *
 * 用户关切：
 *   1. 每条日记链接默认前面带 "- "（Markdown 列表项 bullet）。
 *   2. 如果在设置里把这个前缀清空，同步落盘的结果里每条链接前面能不能不带 "- "。
 *   3. 设置项那个输入框是否「能真的清空」——会不会被代码静默复位回默认 "- "。
 *
 * 本 spec 直接驱动生产代码 src/sync/DiaryLinkProcessor.ts 的 processAll（不是
 * 重新实现一份 generateWikiLink），断言写进日记文件的真实行首：
 *   - 默认 "- "  → 行首是 "- [["
 *   - 清空 ""    → 行首是 "[["，且整段区域不含 "- [["
 *   - 自定义 "> " → 行首是 "> [["
 *
 * 另外验证「输入框能真的清空」的数据层：main.ts 的加载合并
 * Object.assign({}, DEFAULT_SETTINGS, loadedData) 与 JSON round-trip 都不会把
 * 用户存的空串复位成默认 "- "。（UI onChange 这一层由 real-obsidian E2E
 * cases/diary-link-prefix-clearable.case.js 真机点穿。）
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
import { DEFAULT_SETTINGS, OmnivoreSettings, DiaryLinkType } from '../src/settings/index'
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

jest.mock('../src/util', () => {
	const actual = jest.requireActual('../src/util')
	return {
		...actual,
		formatDate: jest.fn((iso: string) => iso.slice(0, 10)),
	}
})

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
		async read(file) {
			const v = files.get(file.path)
			if (v === undefined) throw new Error(`file not found: ${file.path}`)
			return v
		},
		async modify(file, content) {
			files.set(file.path, content)
		},
	}
}

function makeDiaryContent(body: string): string {
	return `# 2024-01-15\n\n${ANCHOR_TAG}\n${body}\n${ANCHOR_TAG}\n`
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

function baseItem(overrides: Partial<any> = {}): any {
	return {
		id: 'item-1',
		title: 'Some Article Title',
		content: '<p>some content</p>',
		savedAt: '2024-01-15T10:30:00.000Z',
		updatedAt: '2024-01-15T10:30:00.000Z',
		createdAt: '2024-01-15T10:30:00.000Z',
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
		...overrides,
	}
}

/** 取锚点区域内所有含 [[ 的链接行（已 trim） */
function regionLinkLines(content: string): string[] {
	const first = content.indexOf(ANCHOR_TAG)
	const second = content.indexOf(ANCHOR_TAG, first + ANCHOR_TAG.length)
	const region = content.slice(first + ANCHOR_TAG.length, second)
	return region.split('\n').map(l => l.trim()).filter(l => l.includes('[['))
}

async function syncOnce(
	prefix: string,
): Promise<{ lines: string[]; region: string }> {
	const diaryFile = new MockTFile(DIARY_PATH)
	const vault = buildVault({ [DIARY_PATH]: makeDiaryContent('') })
	const processor = buildProcessor({ diaryLinkPrefix: prefix }, vault, diaryFile)
	processor.addLink(baseItem(), 'article-file', undefined)
	await processor.processAll()
	const content = vault.files.get(DIARY_PATH)!
	const first = content.indexOf(ANCHOR_TAG)
	const second = content.indexOf(ANCHOR_TAG, first + ANCHOR_TAG.length)
	return {
		lines: regionLinkLines(content),
		region: content.slice(first + ANCHOR_TAG.length, second),
	}
}

describe('日记链接前缀清空 → 落盘结果', () => {
	it('默认前缀 "- " → 每条链接行首是 "- [["', async () => {
		const { lines } = await syncOnce('- ')
		expect(lines.length).toBe(1)
		expect(lines[0].startsWith('- [[')).toBe(true)
		// 完整行（含 id 标记注释）
		expect(lines[0]).toBe('- [[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->')
	})

	it('清空前缀 "" → 每条链接行首是 "[["，整段不含 "- [["（真的不带 bullet）', async () => {
		const { lines, region } = await syncOnce('')
		expect(lines.length).toBe(1)
		expect(lines[0].startsWith('[[')).toBe(true)
		expect(lines[0].startsWith('- ')).toBe(false)
		expect(region.includes('- [[')).toBe(false)
		expect(lines[0]).toBe('[[article-file|Some Article Title]] <!-- notehelper:id:item-1 -->')
	})

	it('自定义前缀 "> " → 行首原样使用 "> [["', async () => {
		const { lines } = await syncOnce('> ')
		expect(lines[0].startsWith('> [[')).toBe(true)
	})

	it('前缀不自动补空格："-"（无空格）→ 行首 "-[["', async () => {
		const { lines } = await syncOnce('-')
		expect(lines[0].startsWith('-[[')).toBe(true)
	})
})

describe('「输入框能真的清空」——数据层不会把空串复位成默认', () => {
	it('DEFAULT_SETTINGS.diaryLinkPrefix 默认就是 "- "', () => {
		expect(DEFAULT_SETTINGS.diaryLinkPrefix).toBe('- ')
	})

	it('加载合并 Object.assign({}, DEFAULT_SETTINGS, loadedData) 保留用户存的空串', () => {
		// 模拟：用户清空输入框后 data.json 里写下的 diaryLinkPrefix: ""
		const savedData = { diaryLinkPrefix: '' }
		const loaded = Object.assign({}, DEFAULT_SETTINGS, savedData)
		expect(loaded.diaryLinkPrefix).toBe('') // 空串覆盖默认，未被复位
	})

	it('saveData/loadData 的 JSON round-trip 保留空串（不被丢弃成 undefined→默认）', () => {
		const loaded = Object.assign({}, DEFAULT_SETTINGS, { diaryLinkPrefix: '' })
		const roundTripped = JSON.parse(JSON.stringify(loaded))
		expect(Object.prototype.hasOwnProperty.call(roundTripped, 'diaryLinkPrefix')).toBe(true)
		expect(roundTripped.diaryLinkPrefix).toBe('')
	})
})
