/**
 * 复现 bug：企微消息的 diaryLinkMaxLength 设置不生效
 *
 * 根因：DiaryLinkProcessor.extractDisplayTitle() 对企微消息调用
 * generateMessageHeading()，后者在 template.ts 中硬编码 plainText.slice(0, 10)。
 * 因此送入 generateWikiLink 的 displayTitle 已经不超过 10 字，
 * 用户把 diaryLinkMaxLength 设成 >10 的值完全没有可见效果。
 *
 * 这些测试绕过了 diaryLinkFormat.spec.ts 的"重新实现 generateWikiLink"做法，
 * 直接驱动真正的 DiaryLinkProcessor.addLink + generateWikiLink 管线。
 */

class MockTFile {
  path: string
  name: string
  constructor(path: string) {
    this.path = path
    this.name = path.split('/').pop() || ''
  }
}

jest.mock('obsidian', () => ({
  App: jest.fn(),
  TFile: MockTFile,
  normalizePath: (path: string) => path,
  Notice: jest.fn(),
}))

jest.mock('obsidian-daily-notes-interface', () => ({
  getDailyNoteSettings: jest.fn(),
  createDailyNote: jest.fn(),
  appHasDailyNotesPluginLoaded: jest.fn(),
}))

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
}))

jest.mock('../src/util', () => ({
  ...jest.requireActual('../src/util'),
  formatDate: jest.fn((dateISO: string, _format: string) => dateISO.slice(0, 10)),
}))

import { DEFAULT_SETTINGS, OmnivoreSettings } from '../src/settings/index'
import { DiaryLinkProcessor } from '../src/sync/DiaryLinkProcessor'
import { DailyNoteResolver } from '../src/sync/DailyNoteResolver'

// DiaryLinkProcessor 构造函数要求一个 DailyNoteResolver，但这些测试不触发 processAll，
// 只调用 addLink + 私有 generateWikiLink，所以 resolver 不会被实际用到。
const stubResolver = {} as unknown as DailyNoteResolver

function buildProcessor(overrides: Partial<OmnivoreSettings>): DiaryLinkProcessor {
  const settings: OmnivoreSettings = {
    ...DEFAULT_SETTINGS,
    enableDiaryLinks: true,
    ...overrides,
  }
  const fakeApp = { vault: {} } as any
  return new DiaryLinkProcessor(fakeApp, settings, stubResolver)
}

function makeWeChatItem(content: string): any {
  return {
    id: 'msg-1',
    title: '同步助手_20240115', // 触发 isWeChatMessage
    content,
    savedAt: '2024-01-15T10:30:00.000Z',
    url: '',
    slug: '',
    author: null,
    siteName: null,
    siteIcon: null,
    publishedAt: null,
    updatedAt: '2024-01-15T10:30:00.000Z',
    readAt: null,
    createdAt: '2024-01-15T10:30:00.000Z',
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

function makeArticleItem(title: string): any {
  return {
    ...makeWeChatItem('irrelevant'),
    id: 'art-1',
    title, // 不以"同步助手_"开头 → isWeChatMessage = false
  }
}

/** 取出真实 DiaryLinkProcessor 内部生成的 wikilink 字符串 */
function generateWikiLinkForItem(
  processor: DiaryLinkProcessor,
  item: any,
  targetFile: string,
  anchor?: string,
): string {
  processor.addLink(item, targetFile, anchor)
  const links = (processor as any).links as Array<any>
  const linkItem = links[links.length - 1]
  return (processor as any).generateWikiLink(linkItem) as string
}

/** 从 `[[target|display]]` 或 `[[target#anchor|display]]` 中取出 `|` 之后的部分 */
function extractDisplayText(wikiLink: string): string {
  const match = wikiLink.match(/\|(.+?)\]\]\s*$/)
  if (!match) throw new Error(`wikiLink 格式异常: ${wikiLink}`)
  return match[1]
}

describe('diaryLinkMaxLength 对企微消息的生效情况（bug 复现）', () => {
  it('【RED】企微消息 + maxLength=20 应允许 display 文字超过 10 字', () => {
    // 内容共 28 字（全中文），明显长于 20
    const longContent = '这是一条非常非常长的微信消息内容用来测试截断功能是否生效哦'
    expect([...longContent].length).toBeGreaterThan(20) // 前置：确实够长

    const processor = buildProcessor({ diaryLinkMaxLength: 20 })
    const wikiLink = generateWikiLinkForItem(
      processor,
      makeWeChatItem(longContent),
      '同步助手_2024-01-15',
    )
    const display = extractDisplayText(wikiLink)

    // 期望：用户设的 20 字上限生效 → 前 19 字 + 省略号 = 20 字总长
    expect(display).toBe('这是一条非常非常长的微信消息内容用来测\u2026')
    expect([...display].length).toBe(20)
    // 若 bug 未修：display = '这是一条非常非常长的'（10 字），以下断言失败
    expect([...display].length).toBeGreaterThan(10)
  })

  it('【对照·GREEN】文章 + maxLength=20 + 长标题 → 设置本来就生效', () => {
    const longTitle = '这是一篇非常非常长的文章标题用来测试截断功能确实生效'
    expect([...longTitle].length).toBeGreaterThan(20)

    const processor = buildProcessor({ diaryLinkMaxLength: 20 })
    const wikiLink = generateWikiLinkForItem(
      processor,
      makeArticleItem(longTitle),
      '2024/01/15/某文章',
    )
    const display = extractDisplayText(wikiLink)

    expect([...display].length).toBe(20)
    expect(display.endsWith('\u2026')).toBe(true)
  })

  it('【RED】企微消息 + maxLength=0（不限制）→ 展示清洗后的完整正文', () => {
    // 采用方案 B：0 = 真正不限制。企微消息的 display 文字应该是清洗过的全文，
    // 不再被 generateMessageHeading 的硬编码 10 字 slice 拦截。
    // 同时验证 HTML / wikilink / markdown 链接会被清洗掉。
    const content =
      '<p>这是一条非常非常长的微信消息内容用来验证不限制场景 [链接](https://x) 以及 [[wikilink|别名]] 都能被清洗</p>'
    const processor = buildProcessor({ diaryLinkMaxLength: 0 })
    const wikiLink = generateWikiLinkForItem(
      processor,
      makeWeChatItem(content),
      '同步助手_2024-01-15',
    )
    const display = extractDisplayText(wikiLink)

    // 清洗后应为纯文本，不含 HTML 标签 / markdown 链接语法
    expect(display).not.toMatch(/<[^>]+>/)
    expect(display).not.toMatch(/\]\(/)
    expect(display).not.toMatch(/\[\[/)

    // 不带尾部省略号（没触发截断）
    expect(display.endsWith('\u2026')).toBe(false)

    // 且长度显著超过 10 字（证明旧的硬编码 slice 已经不再限制这里）
    expect([...display].length).toBeGreaterThan(10)

    // 关键字必须都在（来自原文的后半段，10 字 slice 路径下会看不到）
    expect(display).toContain('不限制场景')
    expect(display).toContain('别名')
  })

  it('【RED】消息正文含 wikilink 语法字符 → alias 不得出现裸 |/]]/[[', () => {
    // 企微消息正文里可能出现表格分隔符 |、残留的 ]]、孤立的 [[ 等。
    // 修复前这些字符会直接进入 wikilink 的 alias 部分，导致 Obsidian 解析错乱：
    //   [[file#anchor|左 | 右]] → alias 在第一个 | 处就被截断，后续变成裸文本
    // 本测试驱动真实 DiaryLinkProcessor 的 generateWikiLink 构造流程，
    // 期望 alias 中不再出现这三个危险字符。
    // 注意：前 10 字符特意留干净，避免污染 generateMessageHeading 生成的 anchor，
    //     这条测试只聚焦 alias sanitize。
    const content = '头十个字符干净的内容然后出现 | table 残留]] 孤立[[ 符号'
    const processor = buildProcessor({ diaryLinkMaxLength: 0 })
    const wikiLink = generateWikiLinkForItem(
      processor,
      makeWeChatItem(content),
      '同步助手_2024-01-15',
    )
    const display = extractDisplayText(wikiLink)

    // alias 里不得再出现裸的 wikilink 语法字符
    expect(display).not.toContain('|')
    expect(display).not.toContain(']]')
    expect(display).not.toContain('[[')

    // 原文关键词仍能看见（允许被视觉近似字符替换）
    expect(display).toContain('table')
    expect(display).toContain('符号')
  })

  it('【RED】maxLength>0 时 alias 同样会被 sanitize', () => {
    // 长度受限的场景下也不能泄漏 |。前 10 字干净，长度 15 的截断会把 | 包进 alias。
    const content = '头十个字符都干净接下来|紧跟分隔符|继续|更多|无穷' // 前 10 字无 |
    const processor = buildProcessor({ diaryLinkMaxLength: 15 })
    const wikiLink = generateWikiLinkForItem(
      processor,
      makeWeChatItem(content),
      '同步助手_2024-01-15',
    )
    const display = extractDisplayText(wikiLink)

    expect(display).not.toContain('|')
    // 仍应该被 maxLength=15 截断（含 omission）
    expect([...display].length).toBeLessThanOrEqual(15)
    expect(display.endsWith('\u2026')).toBe(true)
  })

  it('【GREEN】企微消息 + maxLength=5（<10）→ 仍可被截短到 5', () => {
    // 即便有硬编码 10 字上限，lodash truncate(length=5) 仍然会进一步截成 5 字
    const longContent = '这是一条非常非常长的微信消息内容'
    const processor = buildProcessor({ diaryLinkMaxLength: 5 })
    const wikiLink = generateWikiLinkForItem(
      processor,
      makeWeChatItem(longContent),
      '同步助手_2024-01-15',
    )
    const display = extractDisplayText(wikiLink)

    expect([...display].length).toBe(5)
    expect(display.endsWith('\u2026')).toBe(true)
  })
})
