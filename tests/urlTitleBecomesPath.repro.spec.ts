/**
 * 回归守卫：小红书链接同步后「网址变路径」（用户截图原始 case）
 *
 * 原始现象（修复前）：当某文章 item.title === 文章 URL（服务端抽取标题失败回退成
 * URL）、且文件夹模板含 {{{title}}} 时，vault 会炸出：
 *   https-/www.xiaohongshu.com/explore/66923c750000000025003877-xse.../
 *     https---www.xiaohongshu.com-e....md
 *
 * 双层修复：
 *   ① 服务端 content-processor：标题绝不为 URL（pickArticleTitle 回退平台名/hostname）
 *   ② 客户端围栏（本仓）：folder 渲染走 render(..., { pathSafe: true })，把变量值里的
 *      `/` `\` 折成 `-`，只有模板字面 `/` 才生成目录层级。
 *
 * 本用例守住客户端围栏：即便服务端漏网、title 仍是 URL，folder 也不再炸成多级目录。
 *
 * 处理流程对齐修复后的 main.ts：
 *   folder:   replaceIllegalCharsFolder(normalizePath(render(item, folder, fmt, { pathSafe: true })))
 *   filename: replaceIllegalCharsFile(renderFilename(item, filename, fmt))
 */

import { Item } from '@omnivore-app/api'
import { render, renderFilename } from '../src/settings/template'
import { replaceIllegalCharsFolder, replaceIllegalCharsFile } from '../src/util'
import { normalizePath } from 'obsidian'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return { ...actual, Notice: jest.fn() }
})
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))

// 用户截图里的真实链接
const XHS_URL =
  'https://www.xiaohongshu.com/explore/66923c750000000025003877?xsec_token=AB91juVeGA2kDqOCx6UaY843R_fLGUTd5By_pjDADKBBs=&xsec_source='

function mockItem(overrides?: Partial<Item>): Item {
  return {
    id: 'xhs-66923c75',
    title: XHS_URL, // ← 模拟服务端漏网：标题仍是 URL
    siteName: 'xiaohongshu.com',
    originalArticleUrl: XHS_URL,
    author: 'unknown',
    description: '',
    slug: 'xhs',
    labels: [],
    highlights: [],
    updatedAt: '2024-07-13T12:00:00.000Z',
    savedAt: '2024-07-13T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: '<p>x</p>',
    publishedAt: null,
    url: XHS_URL,
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

// 对齐修复后的 main.ts：folder 渲染带 pathSafe
function processFolder(folder: string, item: Item): string {
  return replaceIllegalCharsFolder(
    normalizePath(render(item, folder, 'yyyy-MM-dd', { pathSafe: true })),
  )
}
function processFilename(filename: string, item: Item): string {
  return replaceIllegalCharsFile(renderFilename(item, filename, 'yyyy-MM-dd'))
}

describe('围栏后：title=URL 不再把 vault 炸成多级目录', () => {
  const item = mockItem()

  it('folder={{{title}}} → 单段文件夹（无目录层级）', () => {
    const folder = processFolder('{{{title}}}', item)
    expect(folder.includes('/')).toBe(false)
    expect(folder.startsWith('https-')).toBe(true)
  })

  it('folder=笔记/{{{title}}} → 只有字面「笔记/」一层，URL 折进末段', () => {
    const folder = processFolder('笔记/{{{title}}}', item)
    const segs = folder.split('/')
    expect(segs.length).toBe(2)
    expect(segs[0]).toBe('笔记')
    expect(segs[1].includes('/')).toBe(false)
  })

  it('完整 page 路径不再出现 URL 多级目录', () => {
    const folder = processFolder('{{{title}}}', item)
    const fname = processFilename('{{{title}}}', item)
    const page = normalizePath(`${folder}/${fname}.md`)
    // 只剩「单段文件夹 / 单个 .md」两段
    expect(page.split('/').length).toBe(2)
    expect(page.endsWith('.md')).toBe(true)
  })

  it('对照组：正常标题照常工作', () => {
    const normal = mockItem({ title: '我的小红书笔记标题' })
    expect(processFolder('{{{title}}}', normal)).toBe('我的小红书笔记标题')
    expect(processFilename('{{{title}}}', normal)).toBe('我的小红书笔记标题')
  })
})
