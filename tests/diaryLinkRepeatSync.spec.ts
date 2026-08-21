/**
 * 日记双链「二次同步产生重复一条」问题复现（RED）
 *
 * 根因假设：
 *   DiaryLinkProcessor.processDateLinks 只通过 regionContent.includes(wikiLink)
 *   这种"整条 wikilink 字符串精确匹配"来去重。只要下列任何一项在两次同步之间
 *   发生细微变化，同一个 item.id 就会被插入第二条链接：
 *     1. 企微消息 displayTitle 来自 extractMessagePlainText(item.content)，内容在后
 *        端流水线（outsourcescrper）二次处理后可能在空白/HTML 上出现细微差异
 *        （diaryLinkMaxLength=0 时差异不会被截断抹平）。
 *     2. 文章 displayTitle = item.title，服务端修订后标题变了。
 *     3. 合并模式下锚点 anchorHeading 来自模板渲染，正文变化会带动锚点变化。
 *     4. FileProcessor 基名不一致：首次调 addLink 用 customFilename，第二次命中
 *        ID 索引后用 basename；两者若不一致（冲突后带 " 2" 后缀、用户重命名等）
 *        会形成 targetFile 不同的两条链接。
 *
 * 不变式：同一 item.id，无论 displayTitle / anchor / targetFile 是否"细微变化"，
 *        processAll 在第二次执行时都不应向锚点区域再插入新的一行。
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

// formatDate 在这些测试里只被分组键间接用到（slice(0,10) 已经够），
// 但 template.ts 运行路径会走到它，保持简单实现即可
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

// --- 内存化 vault ---
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

function makeDiaryContent(body: string): string {
	// 两个相同锚点包围的区域
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

function wechatItem(overrides: Partial<any> = {}): any {
	return baseItem({
		id: 'msg-1',
		title: '同步助手_20240115_001_文本', // 触发 isWeChatMessage
		content: '<p>消息正文</p>',
		...overrides,
	})
}

/** 统计锚点区域内的链接行数 */
function countLinksInRegion(content: string): number {
	const first = content.indexOf(ANCHOR_TAG)
	const second = content.indexOf(ANCHOR_TAG, first + ANCHOR_TAG.length)
	const region = content.slice(first + ANCHOR_TAG.length, second)
	// 每一条链接占独立一行，以 "- [[" 或 "[[" 起首
	return region
		.split('\n')
		.map(l => l.trim())
		.filter(l => l.includes('[['))
		.length
}

describe('日记双链二次同步去重（RED）', () => {
	it('【baseline GREEN】同一文章，两次同步 content 完全一致 → 只有一条链接', async () => {
		const diaryFile = new MockTFile(DIARY_PATH)
		const vault = buildVault({ [DIARY_PATH]: makeDiaryContent('') })
		const item = baseItem()

		// 第一次同步
		let processor = buildProcessor({}, vault, diaryFile)
		processor.addLink(item, 'article-file', undefined)
		await processor.processAll()

		// 第二次同步（完全一致）
		processor = buildProcessor({}, vault, diaryFile)
		processor.addLink(item, 'article-file', undefined)
		await processor.processAll()

		expect(countLinksInRegion(vault.files.get(DIARY_PATH)!)).toBe(1)
	})

	it('【RED】文章：服务端改了 item.title（同 id）→ 不应新增第二条', async () => {
		const diaryFile = new MockTFile(DIARY_PATH)
		const vault = buildVault({ [DIARY_PATH]: makeDiaryContent('') })

		const itemV1 = baseItem({ title: '文章标题 第一版' })
		const itemV2 = baseItem({ title: '文章标题 第一版(修订)' })

		let processor = buildProcessor({}, vault, diaryFile)
		processor.addLink(itemV1, 'article-file', undefined)
		await processor.processAll()

		processor = buildProcessor({}, vault, diaryFile)
		processor.addLink(itemV2, 'article-file', undefined)
		await processor.processAll()

		const after = vault.files.get(DIARY_PATH)!
		expect(countLinksInRegion(after)).toBe(1)
	})

	it('【RED】企微消息 maxLength=0：content HTML 实体差异（&amp; vs &）→ 不应新增第二条', async () => {
		const diaryFile = new MockTFile(DIARY_PATH)
		const vault = buildVault({ [DIARY_PATH]: makeDiaryContent('') })

		// 后端两次净化结果在实体编码上不同：一次保留 &amp;，一次输出 &
		// extractMessagePlainText 只剥 HTML 标签，不做实体解码 → 字符串不同 → 当前实现会重复。
		const v1 = wechatItem({
			content:
				'<p>跨两次同步保持一致的长消息用来验证去重 A &amp; B &amp; C</p>',
		})
		const v2 = wechatItem({
			content:
				'<p>跨两次同步保持一致的长消息用来验证去重 A & B & C</p>',
		})

		let processor = buildProcessor({ diaryLinkMaxLength: 0 }, vault, diaryFile)
		processor.addLink(v1, '同步助手_2024-01-15', '跨两次同步保持一致')
		await processor.processAll()

		processor = buildProcessor({ diaryLinkMaxLength: 0 }, vault, diaryFile)
		processor.addLink(v2, '同步助手_2024-01-15', '跨两次同步保持一致')
		await processor.processAll()

		expect(countLinksInRegion(vault.files.get(DIARY_PATH)!)).toBe(1)
	})

	it('【RED】企微消息 maxLength=0：content 尾部新增一个标点 → 不应新增第二条', async () => {
		const diaryFile = new MockTFile(DIARY_PATH)
		const vault = buildVault({ [DIARY_PATH]: makeDiaryContent('') })

		const v1 = wechatItem({
			content: '<p>这是另一条长消息不截断时整段都会成为 alias 请注意观察</p>',
		})
		const v2 = wechatItem({
			content: '<p>这是另一条长消息不截断时整段都会成为 alias 请注意观察。</p>',
		})

		let processor = buildProcessor({ diaryLinkMaxLength: 0 }, vault, diaryFile)
		processor.addLink(v1, '同步助手_2024-01-15', '这是另一条长消息不')
		await processor.processAll()

		processor = buildProcessor({ diaryLinkMaxLength: 0 }, vault, diaryFile)
		processor.addLink(v2, '同步助手_2024-01-15', '这是另一条长消息不')
		await processor.processAll()

		expect(countLinksInRegion(vault.files.get(DIARY_PATH)!)).toBe(1)
	})

	it('【RED】企微消息合并模式：anchor 随 content 变化 → 不应新增第二条', async () => {
		// 合并模式下 anchor 来自 generateMessageAnchor(content)，细微正文差异
		// 会让锚点首 10 字发生改变，直接导致 wikilink 字符串不一致。
		const diaryFile = new MockTFile(DIARY_PATH)
		const vault = buildVault({ [DIARY_PATH]: makeDiaryContent('') })

		// 首 10 字里有变化（'逗'号位置前后差 1 个字）：锚点会不同
		const v1 = wechatItem({ content: '<p>关于项目X的进度更新如下：a b c</p>' })
		const v2 = wechatItem({ content: '<p>关于项目X 的进度更新如下：a b c</p>' })
		//                                            ^ 多了一个空格

		let processor = buildProcessor({ diaryLinkMaxLength: 0 }, vault, diaryFile)
		processor.addLink(v1, '同步助手_2024-01-15', '关于项目X的进度更新')
		await processor.processAll()

		processor = buildProcessor({ diaryLinkMaxLength: 0 }, vault, diaryFile)
		processor.addLink(v2, '同步助手_2024-01-15', '关于项目X 的进度更') // 锚点变了
		await processor.processAll()

		expect(countLinksInRegion(vault.files.get(DIARY_PATH)!)).toBe(1)
	})

	it('【RED】FileProcessor ID 冲突路径：整链路走 FileProcessor 后，日记锚点区不应重复', async () => {
		// 真正驱动 FileProcessor.handleIdConflict 流程：
		//   首次同步：vault 中已有 folder/冲突文章.md（id=other）→ 新文件落在
		//     folder/冲突文章 2.md。FileProcessor 当前实现会用 customFilename='冲突文章'
		//     调 addLink（即错误 basename）。
		//   二次同步：findFileById 命中新建文件，传入 basename='冲突文章 2' 调 addLink。
		//   两次 addLink 目标不同 → 当前实现会产生两条链接。
		// 任意一侧的正确修复都应该让这条测试转绿：
		//   (a) FileProcessor 修 bug：首次就传入新建文件的真实 basename；
		//   (b) DiaryLinkProcessor 修 bug：按 id 去重（忽略 alias/targetFile 差异）。
		const { FileProcessor } = await import('../src/sync/FileProcessor')

		const diaryFile = new MockTFile(DIARY_PATH)
		const FOLDER = '笔记同步助手/2024-01-15'
		const FILENAME = '冲突文章'
		const CONFLICT_PATH = `${FOLDER}/${FILENAME}.md`
		const SUFFIXED_PATH = `${FOLDER}/${FILENAME} 2.md`

		const vault = buildVault({
			[DIARY_PATH]: makeDiaryContent(''),
			[CONFLICT_PATH]: `---\nid: other-item-id\n---\n\nold file body`,
		})

		const item = baseItem({ id: 'dup-target', title: '要去重的文章' })
		const newContent = `---\nid: ${item.id}\n---\n\nbody of new file`

		const stubResolver = {
			resolve: jest.fn(async () => ({ file: diaryFile })),
		} as unknown as DailyNoteResolver

		const sharedSettings: OmnivoreSettings = {
			...DEFAULT_SETTINGS,
			enableDiaryLinks: true,
			diaryAnchor: ANCHOR,
			diaryLinkPrefix: '- ',
			diaryLinkMaxLength: 0,
			diaryLinkType: DiaryLinkType.ALL,
		}

		const buildCtx = (overrides: Partial<any> = {}) => ({
			app: {
				vault: {
					read: async (f: any) => vault.read(f),
					modify: async (f: any, c: string) => vault.modify(f, c),
					create: async (p: string, c: string) => {
						vault.files.set(p, c)
						return new MockTFile(p)
					},
					getAbstractFileByPath: (p: string) =>
						vault.files.has(p) ? new MockTFile(p) : null,
				},
			},
			settings: sharedSettings,
			findFileById: jest.fn(() => undefined),
			successTracker: { recordSuccess: jest.fn() },
			isMergeFilePath: () => false,   // 本 spec 全是普通单篇文件，无合并文件
			enqueueFileForImageLocalization: async () => {},
			enqueueFileForAttachmentLocalization: async () => {},
			addProcessedFile: jest.fn(),
			imageLocalizer: null,
			...overrides,
		})

		// --- 第一次同步：没有 ID 索引（首跑）---
		const dlp1 = new DiaryLinkProcessor({ vault } as any, sharedSettings, stubResolver)
		const ctx1: any = buildCtx({ diaryLinkProcessor: dlp1 })
		const fp1 = new FileProcessor(ctx1)
		await fp1.process(item, CONFLICT_PATH, newContent, FOLDER, FILENAME)
		await dlp1.processAll()

		// 确认 handleIdConflict 确实新建了带后缀文件
		expect(vault.files.has(SUFFIXED_PATH)).toBe(true)

		// --- 第二次同步：ID 索引命中新建文件（basename='冲突文章 2'）---
		const suffixedTFile = new MockTFile(SUFFIXED_PATH)
		const dlp2 = new DiaryLinkProcessor({ vault } as any, sharedSettings, stubResolver)
		const ctx2: any = buildCtx({
			diaryLinkProcessor: dlp2,
			findFileById: jest.fn((id: string) => (id === item.id ? suffixedTFile : undefined)),
		})
		const fp2 = new FileProcessor(ctx2)
		await fp2.process(item, CONFLICT_PATH, newContent, FOLDER, FILENAME)
		await dlp2.processAll()

		// 仅去重还不够：第一次写入的链接 target 也必须是真实落盘的 basename，
		// 否则日记留下的 [[冲突文章|…]] 点不到任何文件。
		const finalContent = vault.files.get(DIARY_PATH)!
		expect(countLinksInRegion(finalContent)).toBe(1)
		const firstAnchor = finalContent.indexOf(ANCHOR_TAG)
		const secondAnchor = finalContent.indexOf(ANCHOR_TAG, firstAnchor + ANCHOR_TAG.length)
		const region = finalContent.slice(firstAnchor + ANCHOR_TAG.length, secondAnchor)
		expect(region).toContain('[[冲突文章 2|')
		expect(region).not.toMatch(/\[\[冲突文章\|/)
	})

	// 共享辅助：完整跑一次 FileProcessor+DiaryLinkProcessor，
	// 用于让"重命名"系列测试真正走到 findFileById 分支。
	async function runFileProcessorSync(params: {
		vault: FakeVault
		diaryFile: InstanceType<typeof MockTFile>
		item: any
		folder: string
		customFilename: string
		existingFileForId: InstanceType<typeof MockTFile> | undefined
	}) {
		const { FileProcessor } = await import('../src/sync/FileProcessor')
		const { vault, diaryFile, item, folder, customFilename, existingFileForId } = params

		const pageName = `${folder}/${customFilename}.md`
		const content = `---\nid: ${item.id}\n---\n\nbody`

		const settings: OmnivoreSettings = {
			...DEFAULT_SETTINGS,
			enableDiaryLinks: true,
			diaryAnchor: ANCHOR,
			diaryLinkPrefix: '- ',
			diaryLinkMaxLength: 0,
			diaryLinkType: DiaryLinkType.ALL,
		}

		const stubResolver = {
			resolve: jest.fn(async () => ({ file: diaryFile })),
		} as unknown as DailyNoteResolver
		const dlp = new DiaryLinkProcessor({ vault } as any, settings, stubResolver)

		const ctx: any = {
			app: {
				vault: {
					read: async (f: any) => vault.read(f),
					modify: async (f: any, c: string) => vault.modify(f, c),
					create: async (p: string, c: string) => {
						vault.files.set(p, c)
						return new MockTFile(p)
					},
					getAbstractFileByPath: (p: string) =>
						vault.files.has(p) ? new MockTFile(p) : null,
				},
			},
			settings,
			findFileById: jest.fn((id: string) =>
				existingFileForId && id === item.id ? existingFileForId : undefined,
			),
			successTracker: { recordSuccess: jest.fn() },
			isMergeFilePath: () => false,   // 本 spec 全是普通单篇文件，无合并文件
			enqueueFileForImageLocalization: async () => {},
			enqueueFileForAttachmentLocalization: async () => {},
			addProcessedFile: jest.fn(),
			imageLocalizer: null,
			diaryLinkProcessor: dlp,
		}

		const fp = new FileProcessor(ctx)
		await fp.process(item, pageName, content, folder, customFilename)
		await dlp.processAll()
	}

	it('【baseline GREEN】Obsidian 仅重命名（alias 不变）→ 二次同步当前已能识别为同一条', async () => {
		// 整链路：FileProcessor 首次新建文件 → 用户重命名 → FileProcessor 二次走
		//        findFileById 拿到新 basename。title 不变，原生 dedup 已能命中。
		const diaryFile = new MockTFile(DIARY_PATH)
		const FOLDER = '笔记同步助手/2024-01-15'
		const vault = buildVault({ [DIARY_PATH]: makeDiaryContent('') })
		const item = baseItem({ id: 'rename-target', title: '文章标题' })

		await runFileProcessorSync({
			vault, diaryFile, item,
			folder: FOLDER, customFilename: '旧文件名',
			existingFileForId: undefined,
		})

		// 模拟 Obsidian 重命名：移动 vault 中的文件，同步改写日记里的 target
		const oldPath = `${FOLDER}/旧文件名.md`
		const newPath = `${FOLDER}/新文件名.md`
		vault.files.set(newPath, vault.files.get(oldPath)!)
		vault.files.delete(oldPath)
		vault.files.set(
			DIARY_PATH,
			vault.files.get(DIARY_PATH)!.replace(/\[\[旧文件名\|/g, '[[新文件名|'),
		)

		// 二次同步：FileProcessor 通过 ID 索引拿到新文件
		const renamedTFile = new MockTFile(newPath)
		await runFileProcessorSync({
			vault, diaryFile, item,
			folder: FOLDER, customFilename: '旧文件名', // 模板渲染出来可能还是旧名（server title 未变）
			existingFileForId: renamedTFile,
		})

		expect(countLinksInRegion(vault.files.get(DIARY_PATH)!)).toBe(1)
	})

	it('【RED】Obsidian 重命名 + 服务端改 title → 二次同步不应新增第二条', async () => {
		// T0 FileProcessor 建文件并写入 [[旧文件名|旧标题]]。
		// T1 用户重命名：Obsidian 只改 target → [[新文件名|旧标题]]（alias 不变）。
		// T2 二次同步：server 改了 title，FileProcessor 通过 ID 索引拿到
		//    basename='新文件名'。生成 [[新文件名|新标题]] → 当前实现会新增一条。
		const diaryFile = new MockTFile(DIARY_PATH)
		const FOLDER = '笔记同步助手/2024-01-15'
		const vault = buildVault({ [DIARY_PATH]: makeDiaryContent('') })
		const itemV1 = baseItem({ id: 'rename-title', title: '旧标题' })
		const itemV2 = baseItem({ id: 'rename-title', title: '新标题' })

		await runFileProcessorSync({
			vault, diaryFile, item: itemV1,
			folder: FOLDER, customFilename: '旧文件名',
			existingFileForId: undefined,
		})

		// 模拟 Obsidian 重命名
		const oldPath = `${FOLDER}/旧文件名.md`
		const newPath = `${FOLDER}/新文件名.md`
		vault.files.set(newPath, vault.files.get(oldPath)!)
		vault.files.delete(oldPath)
		vault.files.set(
			DIARY_PATH,
			vault.files.get(DIARY_PATH)!.replace(/\[\[旧文件名\|/g, '[[新文件名|'),
		)

		const renamedTFile = new MockTFile(newPath)
		await runFileProcessorSync({
			vault, diaryFile, item: itemV2,
			folder: FOLDER, customFilename: '任意都行', // 走 findFileById 分支
			existingFileForId: renamedTFile,
		})

		expect(countLinksInRegion(vault.files.get(DIARY_PATH)!)).toBe(1)
	})
})
