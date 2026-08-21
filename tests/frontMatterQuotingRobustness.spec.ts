// 前置元数据模板里「用户手写的引号」对脏数据的鲁棒性矩阵 —— 固化当前行为。
//
// 背景（2026-07-30 用户工单）：用户自己写的前置元数据模板长这样
//   标题: {{title}}
//   描述: {{"文章内容一句话总结"}}
//   标签: [{{#labels}}, {{"结合内容总结3到5个标签"}} ,{{/labels}}]
// 里面的 {{"自然语言"}} 被当成变量名去查表（查不到→空串），labels 循环体里没有
// {{{name}}}，于是标签行渲染成 `标签: [,  ,,  ,]` 非法 YAML，整段 front matter 解析
// 失败 → 落盘只剩 id + omnivore_error，用户配的字段全丢。
//
// 回答"那到底该怎么写"时发现：值该不该加引号没有免费的午餐 —— 三种写法各有一类
// 必挂的脏数据。本文件把这个矩阵钉住，避免以后凭直觉改建议：
//
//   脏数据            | "双引号" | '单引号' | 裸值
//   值含 ASCII "      |   ✗整段  |   ✓      |  ✓
//   值含 ASCII '      |   ✓      |   ✗整段  |  ✓
//   值含 ": "         |   ✓      |   ✓      |  ✗整段
//   值以 # 开头       |   ✓      |   ✓      |  △null
//   值以 - 开头       |   ✓      |   ✓      |  ✗整段
//
// 结论（给用户的推荐写法）：用**双引号**。它唯一的雷是"值里含半角双引号"，而中文
// 内容通常用全角引号“”（安全）；单引号版怕英文撇号（it's / don't，概率高得多），
// 裸值版怕英文标题里极常见的 "Title: Subtitle"。
//
// ⚠️ "✗整段" 是插件端的短板，不是 YAML 的必然：renderItemContent 只把模板渲染完就
// 交给 parseYaml，没有对插值出来的**值**做 YAML 转义（sanitizeRenderedYaml 兜底只
// 会给整个值加引号，救不了值内部本来就有的引号）。要根治得在渲染层转义值，届时请
// 更新本矩阵而不是删掉它。

import { renderItemContent, DEFAULT_TEMPLATE } from '../src/settings/template'
import { Item } from '@omnivore-app/api'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsYaml = require('js-yaml')

const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

function frontMatterRaw(content: string): string {
  const m = content.match(/^---\n([\s\S]*?)---/)
  return m ? m[1] : ''
}

function frontMatterParsed(content: string): Record<string, unknown> | null {
  const m = content.match(/^---\n([\s\S]*?)---/)
  if (!m) return null
  try {
    return jsYaml.load(m[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

function mockArticle(overrides?: Partial<Item>): Item {
  return {
    id: 'id-1',
    title: '正常标题',
    siteName: '巴蜀文化研究',
    originalArticleUrl: 'https://mp.weixin.qq.com/s/abc',
    author: '作者',
    description: '一句话描述。',
    slug: 's',
    labels: [{ name: '都江堰' }, { name: '李冰' }],
    highlights: [],
    updatedAt: '2026-07-30T11:33:39.000Z',
    savedAt: '2026-07-30T11:33:39.000Z',
    pageType: 'ARTICLE',
    content: '正文',
    publishedAt: '2026-07-29T00:00:00.000Z',
    url: 'https://mp.weixin.qq.com/s/abc',
    image: '',
    readAt: null,
    wordsCount: 100,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  } as unknown as Item
}

/** 同一套字段，只改「值外面包什么引号」。tags 行用插件默认的 C 写法（flow seq）。 */
const template = (quote: '"' | "'" | '') =>
  `标题: ${quote}{{{title}}}${quote}\n` +
  `链接: ${quote}{{{originalUrl}}}${quote}\n` +
  `描述: ${quote}{{{description}}}${quote}\n` +
  `保存: {{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}\n` +
  `来源: ${quote}{{{siteName}}} | 笔记同步助手${quote}\n` +
  `tags: [笔记同步助手{{#labels}}, {{{name}}}{{/labels}}]`

const render = (tpl: string, item: Item) =>
  renderItemContent(
    item, DEFAULT_TEMPLATE, 'LOCATION', undefined,
    DATE_FORMAT, DATE_FORMAT, false, [], tpl, '', '', '',
  )

type Verdict = 'ok' | 'whole-block-lost' | 'field-null'

function verdictOf(tpl: string, item: Item): Verdict {
  const content = render(tpl, item)
  if (/omnivore_error/.test(frontMatterRaw(content))) return 'whole-block-lost'
  const fm = frontMatterParsed(content)
  if (fm?.['标题'] == null || fm?.['描述'] == null) return 'field-null'
  return 'ok'
}

describe('前置元数据模板：引号写法 × 脏数据 鲁棒性矩阵（固化当前行为）', () => {
  const cases: Array<{
    label: string
    override: Partial<Item>
    expect: { double: Verdict; single: Verdict; bare: Verdict }
  }> = [
    {
      label: '值含 ASCII 双引号 → 双引号版整段丢失',
      override: { title: '他说"你好"' } as Partial<Item>,
      expect: { double: 'whole-block-lost', single: 'ok', bare: 'ok' },
    },
    {
      label: '值含 ASCII 单引号（英文撇号）→ 单引号版整段丢失',
      override: { title: "it's fine" } as Partial<Item>,
      expect: { double: 'ok', single: 'whole-block-lost', bare: 'ok' },
    },
    {
      label: '值含「冒号+空格」→ 裸值版整段丢失',
      override: { title: '深度: 都江堰' } as Partial<Item>,
      expect: { double: 'ok', single: 'ok', bare: 'whole-block-lost' },
    },
    {
      label: '值以 # 开头 → 裸值版被当注释，字段静默变 null',
      override: { title: '#爆款 都江堰' } as Partial<Item>,
      expect: { double: 'ok', single: 'ok', bare: 'field-null' },
    },
    {
      label: '值以 - 开头 → 裸值版整段丢失',
      override: { title: '- 列表项标题' } as Partial<Item>,
      expect: { double: 'ok', single: 'ok', bare: 'whole-block-lost' },
    },
    {
      label: '描述含 ASCII 双引号 → 双引号版整段丢失（与标题同理）',
      override: { description: '他说"行"，然后走了' } as Partial<Item>,
      expect: { double: 'whole-block-lost', single: 'ok', bare: 'ok' },
    },
  ]

  for (const c of cases) {
    it(c.label, () => {
      const item = mockArticle(c.override)
      expect(verdictOf(template('"'), item)).toBe(c.expect.double)
      expect(verdictOf(template("'"), item)).toBe(c.expect.single)
      expect(verdictOf(template(''), item)).toBe(c.expect.bare)
    })
  }

  it('干净数据下三种写法都 OK，且 tags 落盘为 YAML 数组（Properties 面板才给可删 pill）', () => {
    for (const q of ['"', "'", ''] as const) {
      const content = render(template(q), mockArticle())
      const fm = frontMatterParsed(content)
      expect(fm?.['omnivore_error']).toBeUndefined()
      expect(fm?.['tags']).toEqual(['笔记同步助手', '都江堰', '李冰'])
    }
  })

  it('用户原版模板：{{"自然语言"}} 不是变量，标签行渲染成非法 YAML → 整段丢失', () => {
    const USER_TEMPLATE =
      '标题: {{title}}\n' +
      '链接: "{{{originalUrl}}}"\n' +
      '描述: {{"文章内容一句话总结"}}\n' +
      '保存: {{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}\n' +
      '来源: {{{siteName}}} | 笔记同步助手\n' +
      '标签: [{{#labels}}, {{"结合内容总结3到5个标签"}} ,{{/labels}}]'
    const content = render(USER_TEMPLATE, mockArticle())
    const fm = frontMatterParsed(content)
    expect(fm?.['omnivore_error']).toMatch(/error parsing/i)
    expect(fm?.['标题']).toBeUndefined()
    expect(fm?.['标签']).toBeUndefined()
  })

  it('去掉固定首项标签时，逗号必须挪到 name 后面（否则空首项被兜底成一坨字符串）', () => {
    // 带固定首项「笔记同步助手」时，逗号写在 name 前面才对：
    //   tags: [笔记同步助手{{#labels}}, {{{name}}}{{/labels}}]  → [固定, a, b]
    // 用户想删掉固定标签时，如果照抄"逗号在前"就会得到 `[, a, b]` 空首项：
    // 非法 flow seq → sanitize 兜底加引号 → 变成【单个字符串】，Properties 里
    // 退化成一个挤成一坨的 chip（不报错，所以特别容易被当成"正常"）。
    const commaBefore = 'tags: [{{#labels}}, {{{name}}}{{/labels}}]'
    const commaAfter = 'tags: [{{#labels}}{{{name}}}, {{/labels}}]'
    const labels3 = mockArticle()
    const labels1 = mockArticle({ labels: [{ name: '李冰' }] } as unknown as Partial<Item>)
    const labels0 = mockArticle({ labels: [] } as unknown as Partial<Item>)

    // ✗ 逗号在前：退化成单字符串（注意不是抛错，是静默变形）
    expect(frontMatterParsed(render(commaBefore, labels3))?.['tags'])
      .toBe('[, 都江堰, 李冰]')
    expect(frontMatterParsed(render(commaBefore, labels1))?.['tags'])
      .toBe('[, 李冰]')

    // ✓ 逗号在后（尾逗号）：0 / 1 / N 个标签都是合法数组
    expect(frontMatterParsed(render(commaAfter, labels3))?.['tags'])
      .toEqual(['都江堰', '李冰'])
    expect(frontMatterParsed(render(commaAfter, labels1))?.['tags'])
      .toEqual(['李冰'])
    expect(frontMatterParsed(render(commaAfter, labels0))?.['tags'])
      .toEqual([])
  })

  it('块状 list 写法在 0 个标签时退化成 null，所以不如尾逗号 flow seq', () => {
    const block = 'tags:{{#labels}}\n  - {{{name}}}{{/labels}}'
    expect(frontMatterParsed(render(block, mockArticle()))?.['tags'])
      .toEqual(['都江堰', '李冰'])
    expect(frontMatterParsed(render(block, mockArticle({ labels: [] } as unknown as Partial<Item>)))?.['tags'])
      .toBeNull()
  })

  it('同一模板在 labels 为空时反而能解析（`标签: []` 合法）—— 所以故障看着"时好时坏"', () => {
    const USER_TEMPLATE =
      '标题: {{{title}}}\n' +
      '标签: [{{#labels}}, {{"结合内容总结3到5个标签"}} ,{{/labels}}]'
    const content = render(USER_TEMPLATE, mockArticle({ labels: [] } as Partial<Item>))
    const fm = frontMatterParsed(content)
    expect(fm?.['omnivore_error']).toBeUndefined()
    expect(fm?.['标签']).toEqual([])
  })
})
