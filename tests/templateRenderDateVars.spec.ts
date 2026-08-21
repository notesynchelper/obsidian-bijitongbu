/**
 * render() 对日期拆解变量的暴露
 *
 * 背景：TEMPLATE-VARIABLES.md 明确承诺文件夹 / 文件名模板里可以用
 * {{{yearSaved}}} / {{{monthSaved}}} / {{{daySaved}}}（还有文档里没列出、
 * 但 renderItemContent 里已经有的 published/archived/read/updated 同族变量）。
 *
 * 实际上 render()（src/settings/template.ts:638，负责文件夹、文件名、
 * 附件夹、图片夹、消息夹）的 view 里只塞了 date / dateSaved / datePublished /
 * dateArchived / dateRead 几个格式化后的整串，没有拆出 year/month/day，
 * 于是用户的 `同步助手/{{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}/images/{{{title}}}`
 * 经 Mustache 渲染后塌成 `同步助手///images/Test Article`，再被
 * normalizePath 合并斜杠变成 `同步助手/images/Test Article`。
 *
 * 这组测试锁定 render() 修复后应该暴露的完整日期拆解契约。
 */

import { Item } from '@omnivore-app/api'
import { render } from '../src/settings/template'
import { normalizePath } from 'obsidian'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  Logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

function createMockItem(overrides?: Partial<Item>): Item {
  return {
    id: 'test-id-123',
    title: 'Test Article',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/article',
    author: 'Test Author',
    description: 'A test description',
    slug: 'test-slug',
    labels: [],
    highlights: [],
    updatedAt: '2024-03-20T08:15:00.000Z',
    savedAt: '2024-01-15T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: '<p>Test content here.</p>',
    publishedAt: null,
    url: 'https://example.com/article',
    image: null,
    readAt: null,
    wordsCount: 100,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  }
}

const DATE_FORMAT = 'yyyy-MM-dd'

/**
 * 本地时区下从 ISO 串提取 year/month/day 两位补零版本。
 * render() 内部使用 new Date(iso).getFullYear/getMonth/getDate（本地时区），
 * 测试断言必须对齐同一时区逻辑，避免 UTC 与 CI 本地时区不一致导致假红。
 */
function expectedYmd(iso: string): { y: string; m: string; d: string } {
  const dt = new Date(iso)
  return {
    y: dt.getFullYear().toString(),
    m: (dt.getMonth() + 1).toString().padStart(2, '0'),
    d: dt.getDate().toString().padStart(2, '0'),
  }
}

describe('render(): dateSaved 拆解变量（文档已承诺）', () => {
  it('{{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}} 渲染为实际日期三段', () => {
    const item = createMockItem({ savedAt: '2024-01-15T10:30:00.000Z' })
    const { y, m, d } = expectedYmd(item.savedAt)

    const result = render(item, '{{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}', DATE_FORMAT)

    expect(result).toBe(`${y}/${m}/${d}`)
  })

  it('月份 / 日零填充到两位（1 月 5 日 → 01/05）', () => {
    const item = createMockItem({ savedAt: '2024-01-05T10:30:00.000Z' })
    const { m, d } = expectedYmd(item.savedAt)

    const result = render(item, '{{{monthSaved}}}/{{{daySaved}}}', DATE_FORMAT)

    expect(m).toBe('01')
    expect(d).toBe('05')
    expect(result).toBe('01/05')
  })

  it('用户报告的图片夹模板不再塌陷', () => {
    // 直接复现用户 2026-04-21 报告的场景：
    // 模板里带三段日期 + 标题，原 bug 下 mustache 渲染出空串，
    // normalizePath 再合并斜杠 → 日期段整段消失。
    const item = createMockItem({ savedAt: '2024-01-15T10:30:00.000Z' })
    const { y, m, d } = expectedYmd(item.savedAt)

    const template = '同步助手/{{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}/images/{{{title}}}'
    const rendered = render(item, template, DATE_FORMAT)
    const normalized = normalizePath(rendered)

    expect(normalized).toBe(`同步助手/${y}/${m}/${d}/images/Test Article`)
    expect(normalized).not.toBe('同步助手/images/Test Article')
  })
})

describe('render(): datePublished 拆解（当 publishedAt 存在）', () => {
  it('{{{yearPublished}}}/{{{monthPublished}}}/{{{dayPublished}}} 渲染为实际日期', () => {
    const item = createMockItem({ publishedAt: '2023-11-08T14:22:00.000Z' })
    const { y, m, d } = expectedYmd(item.publishedAt as string)

    const result = render(item, '{{{yearPublished}}}/{{{monthPublished}}}/{{{dayPublished}}}', DATE_FORMAT)

    expect(result).toBe(`${y}/${m}/${d}`)
  })

  it('publishedAt 为 null 时，三个变量渲染为空串（Mustache 缺省行为）', () => {
    const item = createMockItem({ publishedAt: null })

    const result = render(item, '[{{{yearPublished}}}][{{{monthPublished}}}][{{{dayPublished}}}]', DATE_FORMAT)

    expect(result).toBe('[][][]')
  })
})

describe('render(): dateArchived 拆解（当 archivedAt 存在）', () => {
  it('{{{yearArchived}}}/{{{monthArchived}}}/{{{dayArchived}}} 渲染为实际日期', () => {
    const item = createMockItem({ archivedAt: '2024-05-01T00:00:00.000Z', isArchived: true })
    const { y, m, d } = expectedYmd(item.archivedAt as string)

    const result = render(item, '{{{yearArchived}}}/{{{monthArchived}}}/{{{dayArchived}}}', DATE_FORMAT)

    expect(result).toBe(`${y}/${m}/${d}`)
  })

  it('archivedAt 为 null 时，三个变量渲染为空串', () => {
    const item = createMockItem({ archivedAt: null })

    const result = render(item, '[{{{yearArchived}}}][{{{monthArchived}}}][{{{dayArchived}}}]', DATE_FORMAT)

    expect(result).toBe('[][][]')
  })
})

describe('render(): dateRead 拆解（当 readAt 存在）', () => {
  it('{{{yearRead}}}/{{{monthRead}}}/{{{dayRead}}} 渲染为实际日期', () => {
    const item = createMockItem({ readAt: '2024-02-20T09:00:00.000Z' })
    const { y, m, d } = expectedYmd(item.readAt as string)

    const result = render(item, '{{{yearRead}}}/{{{monthRead}}}/{{{dayRead}}}', DATE_FORMAT)

    expect(result).toBe(`${y}/${m}/${d}`)
  })

  it('readAt 为 null 时，三个变量渲染为空串', () => {
    const item = createMockItem({ readAt: null })

    const result = render(item, '[{{{yearRead}}}][{{{monthRead}}}][{{{dayRead}}}]', DATE_FORMAT)

    expect(result).toBe('[][][]')
  })
})

describe('render(): dateUpdated 拆解（updatedAt 一般始终存在）', () => {
  it('{{{yearUpdated}}}/{{{monthUpdated}}}/{{{dayUpdated}}} 渲染为实际日期', () => {
    const item = createMockItem({ updatedAt: '2024-03-20T08:15:00.000Z' })
    const { y, m, d } = expectedYmd(item.updatedAt as string)

    const result = render(item, '{{{yearUpdated}}}/{{{monthUpdated}}}/{{{dayUpdated}}}', DATE_FORMAT)

    expect(result).toBe(`${y}/${m}/${d}`)
  })

  it('updatedAt 为 null 时，三个变量渲染为空串', () => {
    const item = createMockItem({ updatedAt: null })

    const result = render(item, '[{{{yearUpdated}}}][{{{monthUpdated}}}][{{{dayUpdated}}}]', DATE_FORMAT)

    expect(result).toBe('[][][]')
  })
})

describe('render(): 回归保护（已工作变量不应受修复影响）', () => {
  const item = createMockItem({
    savedAt: '2024-01-15T10:30:00.000Z',
    publishedAt: '2023-11-08T14:22:00.000Z',
    readAt: '2024-02-20T09:00:00.000Z',
    archivedAt: '2024-05-01T00:00:00.000Z',
    isArchived: true,
  })

  it('{{{dateSaved}}} 按 dateFormat 渲染', () => {
    expect(render(item, '{{{dateSaved}}}', 'yyyy-MM-dd')).toBe('2024-01-15')
    expect(render(item, '{{{dateSaved}}}', 'yyyy/MM/dd')).toBe('2024/01/15')
    expect(render(item, '{{{dateSaved}}}', 'yyyyMMdd')).toBe('20240115')
  })

  it('{{{date}}} 是 dateSaved 的别名', () => {
    expect(render(item, '{{{date}}}', 'yyyy-MM-dd')).toBe('2024-01-15')
    expect(render(item, '{{{date}}}', 'yyyy/MM/dd')).toBe('2024/01/15')
  })

  it('{{{datePublished}}} / {{{dateArchived}}} / {{{dateRead}}} 按 dateFormat 渲染', () => {
    expect(render(item, '{{{datePublished}}}', 'yyyy-MM-dd')).toBe('2023-11-08')
    expect(render(item, '{{{dateArchived}}}', 'yyyy-MM-dd')).toBe('2024-05-01')
    expect(render(item, '{{{dateRead}}}', 'yyyy-MM-dd')).toBe('2024-02-20')
  })

  it('{{{title}}} / {{{author}}} / {{{siteName}}} / {{{originalUrl}}} 正常工作', () => {
    expect(render(item, '{{{title}}}', DATE_FORMAT)).toBe('Test Article')
    expect(render(item, '{{{author}}}', DATE_FORMAT)).toBe('Test Author')
    expect(render(item, '{{{siteName}}}', DATE_FORMAT)).toBe('example.com')
    expect(render(item, '{{{originalUrl}}}', DATE_FORMAT)).toBe('https://example.com/article')
  })

  it('{{{state}}} / {{{type}}} 正常工作', () => {
    expect(render(item, '{{{state}}}', DATE_FORMAT)).toBe('ARCHIVED') // isArchived: true
    expect(render(item, '{{{type}}}', DATE_FORMAT)).toBe('ARTICLE')
  })

  it('author 为 null 时 fallback 到 "unknown"', () => {
    const noAuthor = createMockItem({ author: null })
    expect(render(noAuthor, '{{{author}}}', DATE_FORMAT)).toBe('unknown')
  })

  it('自定义函数 {{#formatDate}} / {{#lowerCase}} / {{#upperCase}} 正常工作', () => {
    // formatDate 约定 `{{dateVar}},format` —— 双括号才会被内层 mustache 解引用；
    // TEMPLATE-VARIABLES.md 示例漏了括号，已在 frontMatterTemplate.spec.ts 里记录。
    expect(render(item, '{{#formatDate}}{{dateSaved}},yyyyMMdd{{/formatDate}}', DATE_FORMAT)).toBe('20240115')
    expect(render(item, '{{#lowerCase}}{{{title}}}{{/lowerCase}}', DATE_FORMAT)).toBe('test article')
    expect(render(item, '{{#upperCase}}{{{title}}}{{/upperCase}}', DATE_FORMAT)).toBe('TEST ARTICLE')
  })
})

describe('render(): 文件夹拼装的完整路径', () => {
  it('年月三层 + 标题拼出合法路径', () => {
    const item = createMockItem({ savedAt: '2024-01-15T10:30:00.000Z' })
    const { y, m, d } = expectedYmd(item.savedAt)

    const template = 'vault/{{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}/{{{title}}}'
    const rendered = render(item, template, DATE_FORMAT)
    const normalized = normalizePath(rendered)

    expect(normalized).toBe(`vault/${y}/${m}/${d}/Test Article`)
    expect(normalized.split('/')).toHaveLength(5)
  })

  it('publishedAt 空时该段不塌陷为非法路径（Mustache 渲染空串，normalizePath 合并斜杠）', () => {
    // 文档上的约定：变量缺失就渲染为空；用户自己负责避开这种模板组合。
    // 这里只是固化"空 → 空串 → 斜杠合并"这条既定行为，防止未来意外抛错。
    const item = createMockItem({ publishedAt: null })

    const template = 'vault/{{{yearPublished}}}/{{{monthPublished}}}/{{{dayPublished}}}/images'
    const rendered = render(item, template, DATE_FORMAT)
    const normalized = normalizePath(rendered)

    expect(normalized).toBe('vault/images')
  })
})
