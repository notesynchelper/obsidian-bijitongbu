/**
 * Test: 标签 API 兼容性测试
 *
 * 验证目标：
 * 1. 插件拉取文章时能否正确处理服务端返回的标签数据
 * 2. 服务端 labels 表移除 color 字段后，对插件是否有影响
 *
 * Mock 数据根据 omniserver API_DOCS.md v1.4.1 设计
 */

import { Item, Label } from '@omnivore-app/api'
import { renderItemContent, renderLabels, DEFAULT_TEMPLATE, LabelView } from '../src/settings/template'
import { DEFAULT_SETTINGS } from '../src/settings'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsYaml = require('js-yaml')

// ===================== Mock obsidian =====================
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

// ===================== 工具函数 =====================
function extractFrontMatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)---/)
  if (!match) return null
  return jsYaml.load(match[1]) as Record<string, unknown>
}

const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

function renderWithLabels(
  labels: Label[] | null,
  frontMatterVariables: string[] = ['tags'],
  frontMatterTemplate = '',
): string {
  const item = createMockArticle({ labels })
  return renderItemContent(
    item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
    DATE_FORMAT, DATE_FORMAT,
    false, frontMatterVariables, frontMatterTemplate,
    '', '',
  )
}

// ===================== Mock 数据工厂 =====================

/**
 * 基础文章 Mock（模拟 GraphQL search 响应中的 item）
 */
function createMockArticle(overrides?: Partial<Item>): Item {
  return {
    id: '7ca55b43-8df1-4959-8f98-293c845c4a15',
    title: '深入理解闭包',
    siteName: 'Tech Blog',
    originalArticleUrl: 'https://example.com/closures',
    author: 'Test Author',
    description: '一篇关于闭包的文章',
    slug: 'closures',
    labels: null,
    highlights: [],
    updatedAt: '2026-03-11T10:00:00.000Z',
    savedAt: '2026-03-11T08:00:00.000Z',
    pageType: 'ARTICLE',
    content: '# 闭包\n\n闭包是函数和其词法作用域的组合...',
    publishedAt: '2026-03-10T06:00:00.000Z',
    url: 'https://example.com/closures',
    image: null,
    readAt: null,
    wordsCount: 1200,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  }
}

/**
 * 模拟 API_DOCS v1.4.1 格式的标签（无 color 字段）
 * 对应文档第 9 节创建文章响应中的 labels 格式：
 *   { "id": "a1b2c3d4-...", "name": "前端" }
 */
function createApiV141Labels(): Label[] {
  return [
    { name: '前端', color: null, description: null },
    { name: 'JavaScript', color: null, description: null },
  ]
}

/**
 * 模拟旧版 API 返回的标签（带 color 字段）
 */
function createLegacyLabelsWithColor(): Label[] {
  return [
    { name: 'tech', color: '#ff0000', description: null },
    { name: 'reading', color: '#00ff00', description: null },
  ]
}

// =========================================================================
// 第 1 部分：标签数据能否正确传递到 front matter
// =========================================================================
describe('标签数据 → front matter 传递链路', () => {

  it('API 返回标签（v1.4.1 格式，无 color）→ tags 正确写入 front matter', () => {
    const content = renderWithLabels(createApiV141Labels())
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.tags).toEqual(['前端', 'JavaScript'])
  })

  it('API 返回标签（旧版格式，带 color）→ tags 正确写入 front matter', () => {
    const content = renderWithLabels(createLegacyLabelsWithColor())
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.tags).toEqual(['tech', 'reading'])
  })

  it('API 返回 labels: null → front matter 无 tags 字段', () => {
    const content = renderWithLabels(null)
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.tags).toBeUndefined()
  })

  it('API 返回 labels: [] → front matter 无 tags 字段', () => {
    const content = renderWithLabels([])
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.tags).toBeUndefined()
  })

  it('tags 未在 frontMatterVariables 中 → 即使有 labels 也不写入', () => {
    const content = renderWithLabels(createApiV141Labels(), ['title', 'author'])
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.tags).toBeUndefined()
    expect(fm!.title).toBe('深入理解闭包')
  })
})

// =========================================================================
// 第 2 部分：color 字段缺失对插件的影响
// =========================================================================
describe('color 字段缺失兼容性', () => {

  it('renderLabels: 只提取 name，不依赖 color', () => {
    const labels: LabelView[] = [
      { name: '前端' },
      { name: 'JavaScript' },
    ]
    const result = renderLabels(labels)
    expect(result).toEqual([
      { name: '前端' },
      { name: 'JavaScript' },
    ])
  })

  it('renderLabels: undefined 输入 → 返回 undefined', () => {
    const result = renderLabels(undefined)
    expect(result).toBeUndefined()
  })

  it('color: null 的标签正常通过全流程', () => {
    const labels: Label[] = [
      { name: '后端', color: null, description: null },
      { name: 'Node.js', color: null, description: null },
    ]
    const content = renderWithLabels(labels)
    const fm = extractFrontMatter(content)
    expect(fm!.tags).toEqual(['后端', 'Node.js'])
  })

  it('混合 color 值（部分 null、部分有值）→ 不影响 tags 输出', () => {
    const labels: Label[] = [
      { name: '前端', color: '#ff0000', description: null },
      { name: 'CSS', color: null, description: null },
      { name: 'React', color: '#0000ff', description: null },
    ]
    const content = renderWithLabels(labels)
    const fm = extractFrontMatter(content)
    expect(fm!.tags).toEqual(['前端', 'CSS', 'React'])
  })

  it('color: undefined（字段完全不存在）→ 同样兼容', () => {
    // 模拟服务端响应中完全没有 color 字段
    const labels = [
      { name: '测试', color: undefined as unknown as string | null, description: null },
    ]
    const content = renderWithLabels(labels)
    const fm = extractFrontMatter(content)
    expect(fm!.tags).toEqual(['测试'])
  })
})

// =========================================================================
// 第 3 部分：根据 API 文档模拟完整 GraphQL 响应链路
// =========================================================================
describe('模拟 API 文档 GraphQL 搜索响应', () => {

  /**
   * 模拟 API 文档 v1.4.1 的自定义服务器 GraphQL 搜索响应
   * 对应 searchCustomServerItems 的预期返回
   */
  it('自定义服务器响应（带 labels）→ 标签正确传递', () => {
    // 模拟服务端 GraphQL 响应中的 item（基于 API 文档第 9、10 节）
    const serverItem: Item = createMockArticle({
      labels: [
        { name: '前端', color: null, description: null },
        { name: 'JavaScript', color: null, description: null },
      ],
    })

    const content = renderItemContent(
      serverItem, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT,
      false, ['title', 'author', 'tags', 'site_name'], '',
      '', '',
    )

    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.id).toBe('7ca55b43-8df1-4959-8f98-293c845c4a15')
    expect(fm!.title).toBe('深入理解闭包')
    expect(fm!.author).toBe('Test Author')
    expect(fm!.site_name).toBe('Tech Blog')
    expect(fm!.tags).toEqual(['前端', 'JavaScript'])
  })

  /**
   * 模拟本地 Mock 服务器的 GraphQL 搜索响应
   * searchLocalItems 的查询不包含 labels 字段，所以 item.labels 为 null
   */
  it('本地 Mock 服务器响应（无 labels 字段）→ 无 tags', () => {
    // 本地 Mock 服务器的 search 查询不包含 labels，返回的 item 中 labels 为 null/undefined
    const localItem: Item = createMockArticle({
      labels: null,
    })

    const content = renderItemContent(
      localItem, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT,
      false, ['title', 'author', 'tags'], '',
      '', '',
    )

    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.title).toBe('深入理解闭包')
    expect(fm!.author).toBe('Test Author')
    // labels 为 null → tags 不出现在 front matter 中
    expect(fm!.tags).toBeUndefined()
  })

  /**
   * 服务端返回标签但 GraphQL 响应中 labels 数组为空
   * （文章存在但未关联任何标签）
   */
  it('服务端返回空 labels 数组（文章无标签）→ 无 tags', () => {
    const itemNoTags: Item = createMockArticle({
      labels: [],
    })

    const content = renderItemContent(
      itemNoTags, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT,
      false, ['tags'], '',
      '', '',
    )

    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.tags).toBeUndefined()
  })
})

// =========================================================================
// 第 4 部分：标签名称特殊字符处理
// =========================================================================
describe('标签名称边界情况', () => {

  it('标签名含空格 → 空格替换为下划线（Obsidian 要求）', () => {
    const labels: Label[] = [
      { name: 'Web Dev', color: null, description: null },
      { name: 'Best Practices', color: null, description: null },
    ]
    const content = renderWithLabels(labels)
    const fm = extractFrontMatter(content)
    expect(fm!.tags).toEqual(['Web_Dev', 'Best_Practices'])
  })

  it('中文标签名 → 正常通过', () => {
    const labels: Label[] = [
      { name: '前端开发', color: null, description: null },
      { name: '学习笔记', color: null, description: null },
    ]
    const content = renderWithLabels(labels)
    const fm = extractFrontMatter(content)
    expect(fm!.tags).toEqual(['前端开发', '学习笔记'])
  })

  it('标签名含连字符和下划线 → 保持原样', () => {
    const labels: Label[] = [
      { name: 'react-hooks', color: null, description: null },
      { name: 'type_script', color: null, description: null },
    ]
    const content = renderWithLabels(labels)
    const fm = extractFrontMatter(content)
    expect(fm!.tags).toEqual(['react-hooks', 'type_script'])
  })

  it('单个标签 → 输出单元素数组', () => {
    const labels: Label[] = [
      { name: '独立标签', color: null, description: null },
    ]
    const content = renderWithLabels(labels)
    const fm = extractFrontMatter(content)
    expect(fm!.tags).toEqual(['独立标签'])
  })

  it('大量标签 → 全部输出', () => {
    const labels: Label[] = Array.from({ length: 20 }, (_, i) => ({
      name: `标签${i + 1}`,
      color: null,
      description: null,
    }))
    const content = renderWithLabels(labels)
    const fm = extractFrontMatter(content)
    expect(fm!.tags).toHaveLength(20)
    expect(fm!.tags).toContain('标签1')
    expect(fm!.tags).toContain('标签20')
  })
})

// =========================================================================
// 第 5 部分：frontMatterTemplate 模式下的标签处理
// =========================================================================
describe('frontMatterTemplate 模式下的标签', () => {

  it('模板中使用 {{#labels}} 遍历标签', () => {
    const labels: Label[] = createApiV141Labels()
    const item = createMockArticle({ labels })
    const fmTemplate = `title: {{{title}}}
tags:
{{#labels}}
  - {{{name}}}
{{/labels}}`

    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT,
      false, [], fmTemplate,
      '', '',
    )

    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.title).toBe('深入理解闭包')
    expect(fm!.tags).toEqual(['前端', 'JavaScript'])
  })

  it('模板中 labels 为 null → {{#labels}} 块不渲染', () => {
    const item = createMockArticle({ labels: null })
    const fmTemplate = `title: {{{title}}}
{{#labels}}
tags:
{{#labels}}
  - {{{name}}}
{{/labels}}
{{/labels}}`

    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT,
      false, [], fmTemplate,
      '', '',
    )

    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.title).toBe('深入理解闭包')
    expect(fm!.tags).toBeUndefined()
  })

  it('模板中固定 tags + 动态 labels 组合', () => {
    const labels: Label[] = [
      { name: '前端', color: null, description: null },
    ]
    const item = createMockArticle({ labels })
    // 用户在模板中写死一些 tag，再追加动态 labels
    const fmTemplate = `title: {{{title}}}
tags: [同步笔记]`

    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT,
      false, [], fmTemplate,
      '', '',
    )

    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    // 使用 frontMatterTemplate 时，tags 由模板决定而非 labels
    expect(fm!.tags).toEqual(['同步笔记'])
  })
})

// =========================================================================
// 第 6 部分：tags 别名（alias）支持
// =========================================================================
describe('tags 别名支持', () => {

  it('tags::标签 → front matter 输出 "标签" 键名', () => {
    const labels: Label[] = createApiV141Labels()
    const content = renderWithLabels(labels, ['tags::标签'])
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!['标签']).toEqual(['前端', 'JavaScript'])
    expect(fm!.tags).toBeUndefined()
  })

  it('tags::labels → front matter 输出 "labels" 键名', () => {
    const labels: Label[] = [
      { name: 'tech', color: null, description: null },
    ]
    const content = renderWithLabels(labels, ['tags::labels'])
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.labels).toEqual(['tech'])
    expect(fm!.tags).toBeUndefined()
  })
})

// =========================================================================
// 第 7 部分：Highlight 上的标签处理
// =========================================================================
describe('Highlight 标签处理', () => {

  it('高亮带标签（无 color）→ 不影响渲染', () => {
    const item = createMockArticle({
      labels: [{ name: '前端', color: null, description: null }],
      highlights: [
        {
          id: 'hl-001',
          quote: '闭包是函数和其词法作用域的组合',
          annotation: '重要概念',
          patch: null,
          updatedAt: '2026-03-11T09:00:00.000Z',
          labels: [
            { name: '重点', color: null, description: null },
          ],
          type: 'HIGHLIGHT',
          highlightPositionPercent: 25,
          color: null,
          highlightPositionAnchorIndex: null,
        },
      ],
    })

    const template = `# {{{title}}}
{{{content}}}
## Highlights
{{#highlights}}
> {{{text}}}
{{#labels}}
标签: {{{name}}}
{{/labels}}
{{/highlights}}`

    const content = renderItemContent(
      item, template, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT,
      false, ['tags'], '',
      '', '',
    )

    expect(content).toContain('闭包是函数和其词法作用域的组合')
    expect(content).toContain('标签: 重点')
    const fm = extractFrontMatter(content)
    expect(fm!.tags).toEqual(['前端'])
  })

  it('高亮标签为 null → 高亮正常渲染', () => {
    const item = createMockArticle({
      highlights: [
        {
          id: 'hl-002',
          quote: '测试高亮',
          annotation: null,
          patch: null,
          updatedAt: null,
          labels: null,
          type: 'HIGHLIGHT',
          highlightPositionPercent: 50,
          color: null,
          highlightPositionAnchorIndex: null,
        },
      ],
    })

    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT,
      false, [], '',
      '', '',
    )

    // 不崩溃即为通过
    expect(content).toBeDefined()
  })
})
