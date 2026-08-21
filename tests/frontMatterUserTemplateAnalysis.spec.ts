import { renderItemContent, DEFAULT_TEMPLATE } from '../src/settings/template'
import { Item } from '@omnivore-app/api'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsYaml = require('js-yaml')

function extractFrontMatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)---/)
  if (!match) return null
  try {
    return jsYaml.load(match[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

function extractFrontMatterRaw(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)---/)
  return match ? match[1] : ''
}

function createMockArticle(overrides?: Partial<Item>): Item {
  return {
    id: 'test-id-123',
    title: 'Test Article',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/article/test',
    author: 'John Doe',
    description: 'A test description',
    slug: 'test-slug',
    labels: [],
    highlights: [],
    updatedAt: '2024-01-15T12:00:00.000Z',
    savedAt: '2024-01-15T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: 'Test content.',
    publishedAt: '2024-01-10T00:00:00.000Z',
    url: 'https://example.com/article/test',
    image: 'https://example.com/cover.jpg',
    readAt: '2024-01-16T08:00:00.000Z',
    wordsCount: 100,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  } as unknown as Item
}

/**
 * 用户提供的自定义前置模板。
 * 说明:
 *  - 第 6 行 `cover：` 用的是全角冒号(U+FF1A)，YAML 识别不了
 *  - 第 7~11 行是裸值(`{{{dateSaved}}}` 等)单独成行，不是 key:value
 *  - 第 12 行 `附件路径：...` 又是全角冒号
 *  - tags 行使用 `{{#labels}}[{{{name}}}]{{/labels}}`，多 label 会渲染成 `[a][b]` 非 YAML 列表
 */
const USER_TEMPLATE = `author: {{{author}}}
url: {{{siteName}}}
source: "{{{originalUrl}}}"
saved: {{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}
tags: {{#labels}}[{{{name}}}]{{/labels}}
cover：
{{{dateSaved}}}
{{{datePublished}}}
{{{dateRead}}}
{{{updatedAt}}}
{{{image}}}
附件路径：{{{fileAttachment}}}`

const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

describe('用户自定义前置模板 - YAML 解析问题分析', () => {
  it('渲染后打印前置区内容（供人工观察）', () => {
    const item = createMockArticle({
      labels: [{ name: 'tech' }, { name: 'react' }] as unknown as Item['labels'],
    })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      USER_TEMPLATE, '', '', 'attachments/my.pdf',
    )
    // 打印便于直观感知实际生成物
    // eslint-disable-next-line no-console
    console.log('===== 渲染后的 front matter 原文 =====\n' + extractFrontMatterRaw(content))
    // eslint-disable-next-line no-console
    console.log('===== 完整文件 =====\n' + content)
  })

  it('bug-1 固化: 全角冒号 `cover：` / `附件路径：` 不会被识别为 YAML key', () => {
    const item = createMockArticle()
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      USER_TEMPLATE, '', '', 'attachments/my.pdf',
    )
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    // 固化当前行为: 全角冒号无法作为 YAML key，这两个字段确定拿不到
    expect(fm!['cover']).toBeUndefined()
    expect(fm!['附件路径']).toBeUndefined()
  })

  it('bug-2 固化: 多个 label 时 `tags: [a][b]` 不是合法 YAML 列表', () => {
    const item = createMockArticle({
      labels: [{ name: 'tech' }, { name: 'react' }] as unknown as Item['labels'],
    })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      USER_TEMPLATE, '', '', 'attachments/my.pdf',
    )
    const fm = extractFrontMatter(content)
    // 固化当前行为: tags 不会是数组（整个 YAML 解析失败，tags 丢失）
    expect(Array.isArray(fm?.['tags'])).toBe(false)
  })

  it('bug-3 固化: 裸值 `{{{dateSaved}}}` 等单独成行会触发 YAML 解析失败 → omnivore_error', () => {
    const item = createMockArticle()
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      USER_TEMPLATE, '', '', 'attachments/my.pdf',
    )
    const fm = extractFrontMatter(content)
    // 固化当前行为: 这个用户模板一定会写入 omnivore_error
    expect(fm?.['omnivore_error']).toMatch(/error parsing/i)
  })

  it('bug-4: 空 labels 时 `tags: ` 值为空, YAML 解析为 null', () => {
    const item = createMockArticle({ labels: [] as unknown as Item['labels'] })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      USER_TEMPLATE, '', '', 'attachments/my.pdf',
    )
    const fm = extractFrontMatter(content)
    // 没有 label 时 tags 渲染为空 → YAML 里是 null
    // eslint-disable-next-line no-console
    console.log('tags when empty =', fm?.['tags'])
  })
})
