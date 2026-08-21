import { sanitizeRenderedYaml, renderItemContent, DEFAULT_TEMPLATE } from '../src/settings/template'
import { Item } from '@omnivore-app/api'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsYaml = require('js-yaml')

function extractFrontMatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)---/)
  if (!match) return null
  return jsYaml.load(match[1]) as Record<string, unknown>
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
    publishedAt: null,
    url: 'https://example.com/article/test',
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

const TEMPLATE_WITH_SPECIALS = `author: {{{author}}}
title: {{{title}}}
source: {{{siteName}}}
description: {{{description}}}
url: "{{{originalUrl}}}"`

const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

describe('renderItemContent - front matter template 特殊字符防御', () => {
  it('title 含冒号时 YAML 解析成功', () => {
    const item = createMockArticle({ title: 'React: A Complete Guide' })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      TEMPLATE_WITH_SPECIALS, '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.title).toBe('React: A Complete Guide')
    expect(fm!.omnivore_error).toBeUndefined()
  })

  it('description 含方括号时 YAML 解析成功', () => {
    const item = createMockArticle({ description: 'See [this link] for details' })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      TEMPLATE_WITH_SPECIALS, '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    expect(fm!.description).toBe('See [this link] for details')
    expect(fm!.omnivore_error).toBeUndefined()
  })

  it('title 含 # 时 YAML 解析成功', () => {
    const item = createMockArticle({ title: 'C# Programming Guide' })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      TEMPLATE_WITH_SPECIALS, '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    expect(fm!.title).toBe('C# Programming Guide')
    expect(fm!.omnivore_error).toBeUndefined()
  })

  it('description 含换行时折叠为单行', () => {
    const item = createMockArticle({
      description: 'First line.\nSecond line.\nThird line.',
    })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      TEMPLATE_WITH_SPECIALS, '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    expect(fm!.description).toBe('First line. Second line. Third line.')
    expect(fm!.omnivore_error).toBeUndefined()
  })

  it('author 为 YAML 保留字 "true" 时不报错（已知限制：被解析为布尔值）', () => {
    const item = createMockArticle({ author: 'true' })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      TEMPLATE_WITH_SPECIALS, '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    // 已知限制: "author: true" 是合法 YAML，parseYaml 将其解析为布尔值
    // sanitizeRenderedYaml 仅在 parseYaml 失败时触发，此处不触发
    expect(fm!.author).toBe(true)
    expect(fm!.omnivore_error).toBeUndefined()
  })

  it('多个字段同时含特殊字符时全部正确解析', () => {
    const item = createMockArticle({
      title: 'React: Hooks & Components [2024]',
      author: 'O"Brien',
      description: 'A guide to #React with "best practices"',
      siteName: 'dev.to: Developer Community',
    })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      TEMPLATE_WITH_SPECIALS, '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    expect(fm!.omnivore_error).toBeUndefined()
    expect(fm!.title).toBe('React: Hooks & Components [2024]')
    expect(fm!.source).toBe('dev.to: Developer Community')
  })

  it('description 为空时不报错', () => {
    const item = createMockArticle({ description: '' })
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      TEMPLATE_WITH_SPECIALS, '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    expect(fm!.omnivore_error).toBeUndefined()
  })
})

describe('sanitizeRenderedYaml - YAML 特殊字符自动加引号', () => {
  it('值含冒号时自动加引号', () => {
    const input = 'title: React: A Complete Guide'
    const result = sanitizeRenderedYaml(input)
    expect(result).toBe('title: "React: A Complete Guide"')
  })

  it('值含方括号时自动加引号', () => {
    const input = 'description: See [this article] for details'
    const result = sanitizeRenderedYaml(input)
    expect(result).toBe('description: "See [this article] for details"')
  })

  it('值含 # 时自动加引号', () => {
    const input = 'title: C# Programming Guide'
    const result = sanitizeRenderedYaml(input)
    expect(result).toBe('title: "C# Programming Guide"')
  })

  it('值含双引号时转义并加引号', () => {
    const input = 'author: O"Brien'
    const result = sanitizeRenderedYaml(input)
    expect(result).toBe('author: "O\\"Brien"')
  })

  it('值为 YAML 保留字时加引号', () => {
    expect(sanitizeRenderedYaml('author: true')).toBe('author: "true"')
    expect(sanitizeRenderedYaml('author: null')).toBe('author: "null"')
    expect(sanitizeRenderedYaml('author: yes')).toBe('author: "yes"')
  })

  it('已有引号包裹的值不重复处理', () => {
    const input = 'url: "https://example.com"'
    expect(sanitizeRenderedYaml(input)).toBe(input)
  })

  it('普通值不加引号', () => {
    const input = 'author: John Smith'
    expect(sanitizeRenderedYaml(input)).toBe(input)
  })

  it('多行模板正确处理', () => {
    const input = `author: John: Doe
title: C# Guide
url: "https://example.com"
source: example.com`
    const result = sanitizeRenderedYaml(input)
    expect(result).toBe(`author: "John: Doe"
title: "C# Guide"
url: "https://example.com"
source: example.com`)
  })

  it('空值不处理', () => {
    const input = 'description: '
    expect(sanitizeRenderedYaml(input)).toBe(input)
  })
})

/**
 * 测试用户前置模板渲染问题
 *
 * 用户输入的模板（截图所示）:
 * ---
 * author: {{{author}}}
 * source: {{{siteName}}}
 * url: {{{originalUrl}}}
 * saved: {{#formatDate}}dateSaved,yyyy-MM-dd{{/formatDate}}
 * tags: [同步]
 *
 * 发现两个问题：
 * 问题1（致命）：{{#formatDate}}dateSaved,...{{/formatDate}} 中 dateSaved 未用 {{}} 包裹
 *   → render("dateSaved") 返回字面量 "dateSaved"，formatDate 抛出 Invalid date
 *   → 正确写法：{{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}
 *
 * 问题2（次要）：模板含 --- 分隔符
 *   → parseYaml 对 "---\n...\n---" 报错 "expected a single document"
 *   → 正确写法：不加 --- 分隔符，代码会自动添加
 */
import Mustache from 'mustache'
import { formatDate } from '../src/util'

const parseYaml = (text: string) => jsYaml.load(text)

// 与 src/settings/template.ts 中 formatDateFunc 完全一致（不含 Notice，测试环境无 obsidian）
function formatDateFunc() {
  return function (text: string, render: (text: string) => string) {
    if (!text.includes(',')) {
      const hint = text.trim()
      throw new Error(
        `formatDate 模板格式错误：缺少逗号分隔符。当前写法：{{#formatDate}}${hint}{{/formatDate}}，正确写法示例：{{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}`
      )
    }
    const [dateVariable, format] = text.split(',', 2)
    const date = render(dateVariable)
    if (!date) {
      return ''
    }
    return formatDate(date, format)
  }
}

const functionMap = {
  formatDate: formatDateFunc,
}

// 模拟 articleView（与 renderItemContent 中构建的一致）
const mockArticleView = {
  id: 'test-id-123',
  title: 'Test Article',
  siteName: 'example.com',
  originalUrl: 'https://example.com/article/test',
  author: 'John Doe',
  dateSaved: formatDate('2024-01-15T10:30:00.000Z', "yyyy-MM-dd'T'HH:mm"),
  labels: [{ name: '同步' }],
  ...functionMap,
}

describe('用户前置模板问题诊断', () => {

  describe('问题1（致命）：formatDate 中变量未用 {{}} 包裹', () => {
    it('render("dateSaved") 返回字面量 "dateSaved"，导致 Invalid date', () => {
      const template = '{{#formatDate}}dateSaved,yyyy-MM-dd{{/formatDate}}'
      expect(() => {
        Mustache.render(template, mockArticleView)
      }).toThrow('Invalid date: dateSaved')
    })

    it('render("{{dateSaved}}") 正确解析变量值', () => {
      const template = '{{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}'
      const result = Mustache.render(template, mockArticleView)
      expect(result).toBe('2024-01-15')
    })
  })

  describe('问题2（次要）：模板含 --- 分隔符', () => {
    it('含 --- 开头和 --- 结尾：parseYaml 报错 "expected a single document"', () => {
      const yamlWithDelimiters = `---
author: John Doe
source: example.com
tags: [同步]
---`
      expect(() => parseYaml(yamlWithDelimiters)).toThrow('expected a single document')
    })

    it('不含 --- 分隔符：parseYaml 正常解析', () => {
      const yamlWithout = `author: John Doe
source: example.com
tags: [同步]`
      const parsed = parseYaml(yamlWithout) as Record<string, unknown>
      expect(parsed.author).toBe('John Doe')
      expect(parsed.tags).toEqual(['同步'])
    })

    it('仅含开头 ---（无结尾 ---）：parseYaml 正常解析', () => {
      const yamlStartOnly = `---
author: John Doe
source: example.com`
      const parsed = parseYaml(yamlStartOnly) as Record<string, unknown>
      expect(parsed.author).toBe('John Doe')
    })
  })

  describe('用户的模板（两个问题叠加导致渲染失败）', () => {
    const userTemplate = `---
author: {{{author}}}
source: {{{siteName}}}
url: {{{originalUrl}}}
saved: {{#formatDate}}dateSaved,yyyy-MM-dd{{/formatDate}}
tags: [同步]`

    it('Mustache 渲染时即抛出 Invalid date 错误', () => {
      expect(() => {
        Mustache.render(userTemplate, mockArticleView)
      }).toThrow('Invalid date: dateSaved')
    })
  })

  describe('正确写法：修复两个问题后的完整流程', () => {
    // 修正：1. 去掉 --- 2. dateSaved 用 {{}} 包裹
    const fixedTemplate = `author: {{{author}}}
source: {{{siteName}}}
url: {{{originalUrl}}}
saved: {{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}
tags: [同步]`

    it('Mustache 渲染成功', () => {
      const rendered = Mustache.render(fixedTemplate, mockArticleView)
      console.log('=== 修正后模板渲染结果 ===')
      console.log(rendered)
      expect(rendered).toContain('author: John Doe')
      expect(rendered).toContain('source: example.com')
      expect(rendered).toContain('url: https://example.com/article/test')
      expect(rendered).toContain('saved: 2024-01-15')
      expect(rendered).toContain('tags: [同步]')
    })

    it('YAML 解析成功', () => {
      const rendered = Mustache.render(fixedTemplate, mockArticleView)
      const parsed = parseYaml(rendered) as Record<string, unknown>
      console.log('=== YAML 解析结果 ===')
      console.log(JSON.stringify(parsed, null, 2))
      expect(parsed.author).toBe('John Doe')
      expect(parsed.source).toBe('example.com')
      expect(parsed.url).toBe('https://example.com/article/test')
      // YAML 自动将 2024-01-15 解析为 Date 对象（这是正常的）
      expect(parsed.saved).toBeInstanceOf(Date)
      expect(parsed.tags).toEqual(['同步'])
    })

    it('完整流程：渲染 → YAML 解析 → 合并 frontMatter', () => {
      const rendered = Mustache.render(fixedTemplate, mockArticleView)
      const frontMatterParsed = parseYaml(rendered) as Record<string, unknown> | null
      const frontMatter: Record<string, unknown> = {
        ...(frontMatterParsed ?? {}),
        id: 'test-id-123',
      }
      expect(frontMatter.author).toBe('John Doe')
      expect(frontMatter.source).toBe('example.com')
      expect(frontMatter.url).toBe('https://example.com/article/test')
      expect(frontMatter.saved).toBeInstanceOf(Date) // YAML 自动转换
      expect(frontMatter.tags).toEqual(['同步'])
      expect(frontMatter.id).toBe('test-id-123')
    })
  })

  describe('更简洁的替代方案：直接用 {{{dateSaved}}} 变量', () => {
    it('dateSaved 已经被 dateSavedFormat 预格式化，可直接使用', () => {
      const simpleTemplate = `author: {{{author}}}
source: {{{siteName}}}
url: {{{originalUrl}}}
saved: {{{dateSaved}}}
tags: [同步]`
      const rendered = Mustache.render(simpleTemplate, mockArticleView)
      console.log('=== 直接使用 {{{dateSaved}}} ===')
      console.log(rendered)
      const parsed = parseYaml(rendered) as Record<string, unknown>
      expect(parsed.author).toBe('John Doe')
      expect(parsed.saved).toBeDefined()
    })
  })
})

/**
 * 用户实际反馈问题：formatDate 缺少逗号分隔符导致文章无法同步
 *
 * 用户的 frontMatterTemplate 中写了：
 *   createTime: {{#formatDate}}{{dateSaved}}DDD{{/formatDate}}
 * 正确写法应为：
 *   createTime: {{#formatDate}}{{dateSaved}},DDD{{/formatDate}}
 *
 * 缺少逗号导致 text.split(',',2) 只有一个元素，format=undefined，
 * 日期值和格式字符串拼在一起（如 "2024-01-15 10:30:00DDD"），
 * 传给 formatDate 后抛 Invalid date，导致整篇文章同步被跳过。
 */
describe('formatDate 缺少逗号分隔符 - 用户实际报错场景', () => {
  it('缺少逗号时应抛出明确的格式错误提示', () => {
    // 用户实际写法：{{#formatDate}}{{dateSaved}}DDD{{/formatDate}}
    const template = '{{#formatDate}}{{dateSaved}}DDD{{/formatDate}}'
    expect(() => {
      Mustache.render(template, mockArticleView)
    }).toThrow('formatDate 模板格式错误：缺少逗号分隔符')
  })

  it('缺少逗号时错误信息包含用户的写法和正确示例', () => {
    const template = '{{#formatDate}}{{dateSaved}}DDD{{/formatDate}}'
    expect(() => {
      Mustache.render(template, mockArticleView)
    }).toThrow('正确写法示例')
  })

  it('有逗号时正常工作', () => {
    const template = '{{#formatDate}}{{dateSaved}},DDD{{/formatDate}}'
    const result = Mustache.render(template, mockArticleView)
    // DDD 是 Luxon 的 localized date format，应能正常渲染
    expect(result).toBeTruthy()
    expect(result).not.toContain('formatDate')
  })

  it('用户完整 frontMatterTemplate 场景（缺逗号）', () => {
    const userTemplate = `author: {{{author}}}
title: {{{title}}}
source: {{{siteName}}}
description: {{{description}}}
url: "{{{originalUrl}}}"
createTime: {{#formatDate}}{{dateSaved}}DDD{{/formatDate}}`

    expect(() => {
      Mustache.render(userTemplate, mockArticleView)
    }).toThrow('formatDate 模板格式错误：缺少逗号分隔符')
  })

  it('用户完整 frontMatterTemplate 场景（加逗号后正常）', () => {
    const fixedTemplate = `author: {{{author}}}
title: {{{title}}}
source: {{{siteName}}}
description: {{{description}}}
url: "{{{originalUrl}}}"
createTime: {{#formatDate}}{{dateSaved}},DDD{{/formatDate}}`

    const rendered = Mustache.render(fixedTemplate, mockArticleView)
    expect(rendered).toContain('author: John Doe')
    expect(rendered).toContain('title: Test Article')
    expect(rendered).toContain('createTime: ')
    // createTime 不应为空
    const createTimeLine = rendered.split('\n').find(l => l.startsWith('createTime:'))
    expect(createTimeLine).toBeDefined()
    expect(createTimeLine!.replace('createTime: ', '').trim()).not.toBe('')
  })
})

describe('renderItemContent - formatDate 模板错误时文章仍能同步', () => {
  it('frontMatterTemplate 中 formatDate 缺逗号时，文章内容仍正常渲染（不抛异常），createTime 为空', () => {
    const item = createMockArticle()
    // 用户的错误写法
    const badFrontMatterTemplate = `author: {{{author}}}
createTime: {{#formatDate}}{{dateSaved}}DDD{{/formatDate}}`

    // 修复前：这里会抛异常导致整篇文章同步被跳过
    // 修复后：formatDateFunc 检测到缺逗号，返回空字符串并通过 Notice 提醒用户
    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      badFrontMatterTemplate, '', '', undefined,
    )

    // 文章应该仍然被渲染（不应抛异常）
    expect(content).toBeDefined()
    expect(content.length).toBeGreaterThan(0)

    // frontMatter 正常解析，createTime 为空（因 formatDate 返回了 ''）
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.author).toBe('John Doe')
    // createTime 值为空或 null（formatDate 返回 ''）
    expect(fm!.createTime).toBeFalsy()

    // 文章正文内容仍然存在
    expect(content).toContain('Test content.')
  })

  it('frontMatterTemplate 中 formatDate 写法正确时，正常渲染无错误', () => {
    const item = createMockArticle()
    const goodFrontMatterTemplate = `author: {{{author}}}
createTime: {{#formatDate}}{{dateSaved}},DDD{{/formatDate}}`

    const content = renderItemContent(
      item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      goodFrontMatterTemplate, '', '', undefined,
    )

    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.omnivore_error).toBeUndefined()
    expect(fm!.author).toBe('John Doe')
    expect(content).toContain('Test content.')
  })
})
