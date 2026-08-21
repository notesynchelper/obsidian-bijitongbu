/**
 * 文件夹路径解析测试
 * 测试目标：含特殊字符（点号、中文、连字符）的多级文件夹路径能否正常解析
 *
 * 处理流程：render() → normalizePath() → replaceIllegalCharsFolder()
 */

import { Item } from '@omnivore-app/api'
import { render } from '../src/settings/template'
import { replaceIllegalCharsFolder } from '../src/util'
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
    updatedAt: '2024-01-15T12:00:00.000Z',
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

/**
 * 模拟 main.ts 中的完整文件夹路径处理流程：
 *   replaceIllegalCharsFolder(normalizePath(render(item, folder, dateFormat)))
 */
function processFolder(folder: string, item?: Item, dateFormat?: string): string {
  const i = item ?? createMockItem()
  const rendered = render(i, folder, dateFormat ?? 'yyyy-MM-dd')
  const normalized = normalizePath(rendered)
  return replaceIllegalCharsFolder(normalized)
}

describe('含点号的多级文件夹路径解析', () => {
  const FOLDER = 'Documents/I.P.A.R.A/0-收集箱/网络资源'

  it('纯文本路径经过完整处理流程后保持不变', () => {
    const result = processFolder(FOLDER)
    expect(result).toBe(FOLDER)
  })

  it('解析结果为四层文件夹路径', () => {
    const result = processFolder(FOLDER)
    const segments = result.split('/')
    expect(segments).toHaveLength(4)
    expect(segments).toEqual(['Documents', 'I.P.A.R.A', '0-收集箱', '网络资源'])
  })

  it('点号不被视为非法字符', () => {
    const result = replaceIllegalCharsFolder('I.P.A.R.A')
    expect(result).toBe('I.P.A.R.A')
  })

  it('连字符不被视为非法字符', () => {
    const result = replaceIllegalCharsFolder('0-收集箱')
    expect(result).toBe('0-收集箱')
  })

  it('中文文件夹名不被视为非法字符', () => {
    const result = replaceIllegalCharsFolder('收集箱/网络资源')
    expect(result).toBe('收集箱/网络资源')
  })

  it('normalizePath 不改变正斜杠分隔的正常路径', () => {
    const result = normalizePath(FOLDER)
    expect(result).toBe(FOLDER)
  })

  it('normalizePath 将反斜杠转为正斜杠', () => {
    const result = normalizePath('Documents\\I.P.A.R.A\\0-收集箱\\网络资源')
    expect(result).toBe(FOLDER)
  })

  it('normalizePath 合并重复斜杠', () => {
    const result = normalizePath('Documents//I.P.A.R.A///0-收集箱/网络资源')
    expect(result).toBe(FOLDER)
  })
})

describe('含模板变量的点号路径', () => {
  const item = createMockItem()

  it('点号路径 + {{{dateSaved}}} 模板 → 正确展开日期', () => {
    const folder = 'Documents/I.P.A.R.A/0-收集箱/{{{dateSaved}}}'
    const result = processFolder(folder, item)
    const segments = result.split('/')
    expect(segments).toHaveLength(4)
    expect(segments[0]).toBe('Documents')
    expect(segments[1]).toBe('I.P.A.R.A')
    expect(segments[2]).toBe('0-收集箱')
    expect(segments[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('点号路径 + {{{title}}} 模板 → 正确展开标题', () => {
    const folder = 'I.P.A.R.A/{{{title}}}'
    const result = processFolder(folder, item)
    expect(result).toBe('I.P.A.R.A/Test Article')
  })

  it('多个连续点号的文件夹名 → 保持不变', () => {
    const result = processFolder('A...B/C..D')
    const segments = result.split('/')
    expect(segments).toEqual(['A...B', 'C..D'])
  })
})
