/**
 * mapValue helper —— 模板里把某个变量的值按规则映射/通配转换
 *
 * 背景：用户希望在「属性配置（frontmatter）」里把 {{{siteName}}} 的业务值做
 * 映射，例如 siteName="抖音" → "视频转图文"，或按 contains 通配
 * （siteName 含「播客」→「播客整理」）。Mustache 原生没有 if/replace/contains，
 * 现有 functionMap 只有 lowerCase/upperCase/upperCaseFirst/formatDate。
 *
 * 本组用例锁定新增 helper `mapValue` 的契约：
 *   {{#mapValue}}<取值表达式>|<规则表>{{/mapValue}}
 *   - 取值表达式先经 Mustache 渲染（所以可写 {{{siteName}}}）
 *   - 规则表是逗号分隔的 `pattern=result`：
 *       · 精确：  抖音=视频转图文
 *       · 通配：  *播客*=播客整理   （value 含「播客」即命中，contains 语义）
 *       · 兜底：  *=其他           （都不命中时用它）
 *   - 命中优先级：精确 > 通配 > 兜底 > 原值（无任何规则命中且无兜底则原样返回取值）
 *
 * 同时含「回归断言」：证明引入 mapValue 不影响既有渲染——
 *   不含 mapValue 的模板渲染结果不变、既有 helper（lowerCase/formatDate）照常工作。
 *
 * 注意：实现前 Mustache 把未知 section `{{#mapValue}}…{{/mapValue}}` 当 falsy
 * 省略 → 渲染成空串，故 mapValue 用例此刻应为「红」。
 */

import { Item } from '@omnivore-app/api'
import { render, renderItemContent, DEFAULT_TEMPLATE } from '../src/settings/template'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsYaml = require('js-yaml')

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

const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

function extractFrontMatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)---/)
  if (!match) return null
  return jsYaml.load(match[1]) as Record<string, unknown>
}

// 用 render()（文件夹/文件名路径）做最干净的字符串断言；它和 renderItemContent
// 共用同一个 functionMap，所以这里验证的 helper 行为对两条路径都成立。
function mapViaRender(siteName: string, tpl: string): string {
  return render(createMockItem({ siteName }), tpl, DATE_FORMAT)
}

describe('mapValue helper — 精确映射', () => {
  it('siteName="抖音" 精确命中 → "视频转图文"', () => {
    const out = mapViaRender(
      '抖音',
      '{{#mapValue}}{{{siteName}}}|抖音=视频转图文,小宇宙=播客整理{{/mapValue}}',
    )
    expect(out).toBe('视频转图文')
  })

  it('siteName="小宇宙" 命中第二条精确规则 → "播客整理"', () => {
    const out = mapViaRender(
      '小宇宙',
      '{{#mapValue}}{{{siteName}}}|抖音=视频转图文,小宇宙=播客整理{{/mapValue}}',
    )
    expect(out).toBe('播客整理')
  })

  it('无任何规则命中且无兜底 → 原样返回取值', () => {
    const out = mapViaRender(
      '知乎',
      '{{#mapValue}}{{{siteName}}}|抖音=视频转图文,小宇宙=播客整理{{/mapValue}}',
    )
    expect(out).toBe('知乎')
  })
})

describe('mapValue helper — 通配（contains）', () => {
  it('*视频*：siteName="某视频号" 含「视频」→ "视频转图文"', () => {
    const out = mapViaRender(
      '某视频号',
      '{{#mapValue}}{{{siteName}}}|*视频*=视频转图文,*播客*=播客整理{{/mapValue}}',
    )
    expect(out).toBe('视频转图文')
  })

  it('*播客*：siteName="小宇宙播客" 含「播客」→ "播客整理"', () => {
    const out = mapViaRender(
      '小宇宙播客',
      '{{#mapValue}}{{{siteName}}}|*视频*=视频转图文,*播客*=播客整理{{/mapValue}}',
    )
    expect(out).toBe('播客整理')
  })

  it('通配都不含 → 原样返回', () => {
    const out = mapViaRender(
      '知乎专栏',
      '{{#mapValue}}{{{siteName}}}|*视频*=视频转图文,*播客*=播客整理{{/mapValue}}',
    )
    expect(out).toBe('知乎专栏')
  })
})

describe('mapValue helper — 优先级 & 兜底', () => {
  it('精确优先于通配：value 同时满足精确「抖音视频」和通配「*视频*」时取精确', () => {
    const out = mapViaRender(
      '抖音视频',
      '{{#mapValue}}{{{siteName}}}|*视频*=通配命中,抖音视频=精确命中{{/mapValue}}',
    )
    expect(out).toBe('精确命中')
  })

  it('精确优先与规则书写顺序无关（精确写在通配之后也优先）', () => {
    const out = mapViaRender(
      '抖音视频',
      '{{#mapValue}}{{{siteName}}}|抖音视频=精确命中,*视频*=通配命中{{/mapValue}}',
    )
    expect(out).toBe('精确命中')
  })

  it('兜底 *=：精确/通配都不命中时用兜底值', () => {
    const out = mapViaRender(
      '未知站',
      '{{#mapValue}}{{{siteName}}}|抖音=视频转图文,*播客*=播客整理,*=其他{{/mapValue}}',
    )
    expect(out).toBe('其他')
  })

  it('有兜底时，命中精确仍取精确（兜底不抢占）', () => {
    const out = mapViaRender(
      '抖音',
      '{{#mapValue}}{{{siteName}}}|抖音=视频转图文,*=其他{{/mapValue}}',
    )
    expect(out).toBe('视频转图文')
  })
})

describe('mapValue helper — 容错', () => {
  it('缺少 | 分隔符 → 原样返回渲染后的取值（不抛错）', () => {
    const out = mapViaRender(
      '抖音',
      '{{#mapValue}}{{{siteName}}}{{/mapValue}}',
    )
    expect(out).toBe('抖音')
  })

  it('取值前后空白被裁剪后再比对', () => {
    const out = mapViaRender(
      '  抖音  ',
      '{{#mapValue}}{{{siteName}}}|抖音=视频转图文{{/mapValue}}',
    )
    expect(out).toBe('视频转图文')
  })

  it('取值本身含 | 时不被误当分隔符截断（先按模板原文切分）', () => {
    // title="Foo | Bar"，无规则命中且无兜底 → 应原样返回完整取值
    const out = render(
      createMockItem({ title: 'Foo | Bar' }),
      '{{#mapValue}}{{{title}}}|抖音=视频转图文{{/mapValue}}',
      DATE_FORMAT,
    )
    expect(out).toBe('Foo | Bar')
  })
})

describe('mapValue helper — 在 frontmatter 属性模板中可用', () => {
  it('type 属性按 siteName 映射成「视频转图文」并产出合法 YAML', () => {
    const fmTemplate = [
      'source: {{{siteName}}}',
      'type: {{#mapValue}}{{{siteName}}}|抖音=视频转图文,*播客*=播客整理{{/mapValue}}',
    ].join('\n')
    const content = renderItemContent(
      createMockItem({ siteName: '抖音' }),
      DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      fmTemplate, '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.type).toBe('视频转图文')
    expect(fm!.source).toBe('抖音')
    expect(fm!.omnivore_error).toBeUndefined()
  })

  it('frontmatter 中通配命中：siteName 含「播客」→ type=播客整理', () => {
    const fmTemplate =
      'type: {{#mapValue}}{{{siteName}}}|抖音=视频转图文,*播客*=播客整理{{/mapValue}}'
    const content = renderItemContent(
      createMockItem({ siteName: '小宇宙播客' }),
      DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      fmTemplate, '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    expect(fm!.type).toBe('播客整理')
    expect(fm!.omnivore_error).toBeUndefined()
  })
})

// ───────────────────────── 回归：引入 mapValue 不破坏既有行为 ─────────────────────────

describe('回归：不含 mapValue 的模板渲染保持不变', () => {
  it('普通变量模板原样工作', () => {
    const out = mapViaRender('example.com', '站点：{{{siteName}}}')
    expect(out).toBe('站点：example.com')
  })

  it('既有 helper formatDate 仍正常', () => {
    const out = render(
      createMockItem({ savedAt: '2024-01-15T10:30:00.000Z' }),
      '{{#formatDate}}{{{dateSaved}}},yyyy-MM-dd{{/formatDate}}',
      DATE_FORMAT,
    )
    expect(out).toBe('2024-01-15')
  })

  it('既有 helper lowerCase/upperCase 仍正常', () => {
    expect(mapViaRender('Example.COM', '{{#lowerCase}}{{{siteName}}}{{/lowerCase}}')).toBe(
      'example.com',
    )
    expect(mapViaRender('abc', '{{#upperCase}}{{{siteName}}}{{/upperCase}}')).toBe('ABC')
  })

  it('默认 frontmatter 模板（含 labels section）不受影响', () => {
    const content = renderItemContent(
      createMockItem({
        labels: [{ name: '科技' }] as unknown as Item['labels'],
      }),
      DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [],
      'source: {{{siteName}}}\ntags: [笔记同步助手{{#labels}}, {{{name}}}{{/labels}}]',
      '', '', undefined,
    )
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.source).toBe('example.com')
    expect(fm!.tags).toEqual(['笔记同步助手', '科技'])
    expect(fm!.omnivore_error).toBeUndefined()
  })
})
