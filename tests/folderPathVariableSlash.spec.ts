/**
 * 客户端围栏：文件夹模板里的「变量值」不得注入路径分隔符
 *
 * 背景：replaceIllegalCharsFolder 为支持多级目录模板（如 A/B/C）故意保留 `/`。
 * 但当一个自由文本变量的【值】里含 `/`（典型：title=URL，或标题本来就是
 * "前端/后端"）时，render 把它填进文件夹模板后，Obsidian 会把这些 `/` 当成
 * 目录分隔符 → 单个变量炸成多级文件夹（url-title-becomes-path 事故）。
 *
 * 修复：render(item, template, fmt, { pathSafe: true }) 在渲染「路径」时，把自由
 * 文本变量值里的 `/` `\` 替成 `-`；只有模板里作者手写的字面 `/` 才生成目录层级。
 * ⚠️ 日期变量不在此列——folderDateFormat 用 `yyyy/MM/dd` 时的 `/` 是用户有意的
 * 目录层级，必须保留。
 *
 * 处理流程对齐修复后的 main.ts：
 *   replaceIllegalCharsFolder(normalizePath(render(item, folder, fmt, { pathSafe: true })))
 */

import { Item } from '@omnivore-app/api'
import { render } from '../src/settings/template'
import { replaceIllegalCharsFolder } from '../src/util'
import { normalizePath } from 'obsidian'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return { ...actual, Notice: jest.fn() }
})
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))

const XHS_URL =
  'https://www.xiaohongshu.com/explore/66923c750000000025003877?xsec_token=AB91juVeGA2kDqOCx6UaY843R_fLGUTd5By_pjDADKBBs=&xsec_source='

function mockItem(overrides?: Partial<Item>): Item {
  return {
    id: 'id-1',
    title: 'Test',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/a',
    author: 'Author',
    description: '',
    slug: 's',
    labels: [],
    highlights: [],
    updatedAt: '2024-07-13T12:00:00.000Z',
    savedAt: '2024-07-13T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: '<p>x</p>',
    publishedAt: null,
    url: 'https://example.com/a',
    image: null,
    readAt: null,
    wordsCount: 1,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  }
}

// 修复后的 folder 处理流程
function processFolder(folder: string, item: Item, dateFormat = 'yyyy-MM-dd'): string {
  return replaceIllegalCharsFolder(
    normalizePath(render(item, folder, dateFormat, { pathSafe: true })),
  )
}

describe('pathSafe 渲染：变量值里的 / 不再炸目录', () => {
  it('title=URL + folder={{{title}}} → 单段文件夹，不再多级', () => {
    const item = mockItem({ title: XHS_URL })
    const r = processFolder('{{{title}}}', item)
    expect(r.includes('/')).toBe(false)
    expect(r.startsWith('https-')).toBe(true)
  })

  it('标题本来就含 / （"前端/后端"）→ 折成单段', () => {
    const item = mockItem({ title: '前端/后端' })
    expect(processFolder('{{{title}}}', item)).toBe('前端-后端')
  })

  it('反斜杠 \\ 同样被折叠', () => {
    const item = mockItem({ title: 'A\\B\\C' })
    expect(processFolder('{{{title}}}', item)).toBe('A-B-C')
  })

  it('author / siteName 值里的 / 也被折叠', () => {
    const item = mockItem({ author: 'a/b', siteName: 'x/y' })
    expect(processFolder('{{{author}}}/{{{siteName}}}', item)).toBe('a-b/x-y')
  })
})

describe('pathSafe 渲染：字面模板 / 与日期 / 仍作目录层级', () => {
  it('模板里作者手写的字面 / 仍生成目录层级', () => {
    const item = mockItem({ title: 'A/B' })
    expect(processFolder('笔记/{{{title}}}', item)).toBe('笔记/A-B')
  })

  it('关键回归：folderDateFormat=yyyy/MM/dd 的日期 / 必须保留为目录层级', () => {
    const item = mockItem({ savedAt: '2024-07-13T10:30:00.000Z' })
    expect(processFolder('{{{date}}}', item, 'yyyy/MM/dd')).toBe('2024/07/13')
  })

  it('日期目录 + 标题（标题含 /）：日期分层保留，标题折叠', () => {
    const item = mockItem({ savedAt: '2024-07-13T10:30:00.000Z', title: 'A/B' })
    expect(processFolder('{{{date}}}/{{{title}}}', item, 'yyyy/MM/dd')).toBe('2024/07/13/A-B')
  })
})

describe('不传 pathSafe（文件名渲染路径）→ 行为不变', () => {
  it('render 默认不剥变量里的 /（文件名后续靠 replaceIllegalCharsFile 折叠）', () => {
    const item = mockItem({ title: 'A/B' })
    expect(render(item, '{{{title}}}', 'yyyy-MM-dd')).toBe('A/B')
  })
})
