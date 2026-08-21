/**
 * Templater 接力（templaterRelay.ts）+ 渲染层掩码集成测试
 *
 * 规格来源：docs/templater-compat-design.md + 2026-08-07 真机实验结论
 * （memory templater-api-experiments）：
 * - 只接力 <% %> 插值；<%* 执行块 / <%+ 动态命令 / tp.file.* 等一律掩码原样保留
 * - 未装 Templater / 失败 / 超时 / 毒化（未闭合 <%、<%%）→ 原文返回，非破坏
 * - Mustache 不许吃掉未接力标签里的 {{...}}
 * - trigger_on_file_creation 注入面：创建文件前预挂抑制条目 + 延迟删除
 */
import Mustache from 'mustache'
import { Item } from '@omnivore-app/api'
import { App, TFile } from 'obsidian'
import {
  analyzeTemplaterTags,
  maskTemplaterTags,
  suppressTemplaterTriggerOnCreate,
  TEMPLATER_PLUGIN_ID,
} from '../src/sync/templaterRelay'
import {
  renderItemContent,
  renderWeChatMessageSimple,
  generateMessageAnchor,
} from '../src/settings/template'
import { validateTemplate } from '../src/settings/validation'

// ---------------------------------------------------------------------------
// analyzeTemplaterTags
// ---------------------------------------------------------------------------

describe('analyzeTemplaterTags', () => {
  it('无标签文本', () => {
    const a = analyzeTemplaterTags('# {{{title}}}\n{{{content}}}')
    expect(a.hasTags).toBe(false)
    expect(a.relayableCount).toBe(0)
    expect(a.poisoned).toBe(false)
  })

  it('插值标签计数（含空白控制变体）', () => {
    const a = analyzeTemplaterTags(
      '<% tp.date.now("YYYY-MM-DD") %> and <%- tp.date.tomorrow() -%> and <%_ tp.web.random_picture() _%>',
    )
    expect(a.hasTags).toBe(true)
    expect(a.relayableCount).toBe(3)
    expect(a.execCount).toBe(0)
    expect(a.poisoned).toBe(false)
  })

  it('<%* 执行块与 <%+ 动态命令分别计数', () => {
    const a = analyzeTemplaterTags(
      '<%* await tp.file.rename("x") %>\n<%+ tp.date.now() %>\n<% tp.date.now() %>',
    )
    expect(a.execCount).toBe(1)
    expect(a.dynamicCount).toBe(1)
    expect(a.relayableCount).toBe(1)
  })

  it('空白控制 + 执行块组合（<%-* ）仍识别为执行块', () => {
    const a = analyzeTemplaterTags('<%-* tp.file.create_new("x") %>')
    expect(a.execCount).toBe(1)
    expect(a.relayableCount).toBe(0)
  })

  it('不支持的命名空间：tp.file / tp.frontmatter / tp.config / tp.hooks / tp.system.prompt', () => {
    const a = analyzeTemplaterTags(
      [
        '<% tp.file.title %>',
        '<% tp.frontmatter.category %>',
        '<% tp.frontmatter["my key"] %>',
        '<% tp.config.run_mode %>',
        '<% tp.hooks.on_all_templates_executed(() => 1) %>',
        '<% tp.system.prompt("q") %>',
        '<% tp.system.suggester(["a"], ["a"]) %>',
      ].join('\n'),
    )
    expect(a.relayableCount).toBe(0)
    expect(a.unsupportedCalls.length).toBeGreaterThanOrEqual(5)
    expect(a.unsupportedCalls.join(',')).toContain('tp.file.')
    expect(a.unsupportedCalls.join(',')).toContain('tp.system.prompt')
  })

  it('tp.date / tp.web / tp.user / tp.system.clipboard 是可接力的', () => {
    const a = analyzeTemplaterTags(
      '<% tp.date.now() %> <% tp.web.daily_quote() %> <% tp.user.myFn() %> <% tp.system.clipboard() %>',
    )
    expect(a.relayableCount).toBe(4)
    expect(a.unsupportedCalls).toEqual([])
  })

  it('非点号访问绕不过 deny 规则：tp?.file / tp["file"]（codex P1）', () => {
    const a = analyzeTemplaterTags(
      '<% tp?.file.rename("x") %>\n<% tp["file"].title %>\n<% tp ?. date.now() %>',
    )
    expect(a.relayableCount).toBe(0)
    expect(a.unsupportedCalls.join(',')).toContain('tp[...] / tp?.')
  })

  it('tp.system 白名单：multi_suggester 等弹窗 API 不接力，clipboard 放行（codex P2）', () => {
    const a = analyzeTemplaterTags(
      '<% tp.system.multi_suggester(["a"],["a"]) %>\n<% tp.system["prompt"]("q") %>\n<% tp.system.clipboard() %>',
    )
    expect(a.relayableCount).toBe(1) // 只有 clipboard
    expect(a.unsupportedCalls.join(',')).toContain('tp.system.multi_suggester')
    expect(a.unsupportedCalls.join(',')).toContain('tp.system.prompt')
  })

  it('tp.file 的变体访问也不接力：tp.file?.title / tp.file["x"] / 裸 tp.file', () => {
    const a = analyzeTemplaterTags(
      '<% tp.file?.title %>\n<% tp.file["folder"] %>\n<% JSON.stringify(tp.file) %>',
    )
    expect(a.relayableCount).toBe(0)
    expect(a.unsupportedCalls.join(',')).toContain('tp.file.*')
  })

  it('毒化检测：未闭合 <%', () => {
    const a = analyzeTemplaterTags('前面 <% tp.date.now() %> 后面残留 <% 没闭合')
    expect(a.poisoned).toBe(true)
  })

  it('毒化检测：<%%', () => {
    const a = analyzeTemplaterTags('<%% tp.date.now() %>')
    expect(a.poisoned).toBe(true)
  })

  it('杂散 %> 无害（真机 C4）', () => {
    const a = analyzeTemplaterTags('文本 %> 更多文本 <% tp.date.now() %>')
    expect(a.poisoned).toBe(false)
    expect(a.relayableCount).toBe(1)
  })

  it('跨行标签', () => {
    const a = analyzeTemplaterTags('<% tp.date.now(\n  "YYYY-MM-DD"\n) %>')
    expect(a.relayableCount).toBe(1)
    expect(a.poisoned).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// maskTemplaterTags
// ---------------------------------------------------------------------------

describe('maskTemplaterTags', () => {
  it('掩码后无 <%，restore 恒等还原', () => {
    const src = '头 <% tp.date.now("YYYY") %> 中 <%* exec() %> 尾'
    const m = maskTemplaterTags(src)
    expect(m.text).not.toContain('<%')
    expect(m.maskedCount).toBe(2)
    expect(m.restore(m.text)).toBe(src)
  })

  it('同一输入两次掩码产出相同文本（确定性，Mustache 模板缓存不膨胀）', () => {
    const src = 'a <% tp.date.now() %> b'
    expect(maskTemplaterTags(src).text).toBe(maskTemplaterTags(src).text)
  })

  it('filter 只掩码非插值标签', () => {
    const src = '<% tp.date.now() %> | <%* side() %> | <%+ dyn %> | <% tp.file.title %>'
    const m = maskTemplaterTags(src, (tag) => tag.kind !== 'interpolation')
    expect(m.text).toContain('<% tp.date.now() %>')
    expect(m.text).not.toContain('<%*')
    expect(m.text).not.toContain('<%+')
    expect(m.text).not.toContain('tp.file.title')
    expect(m.restore(m.text)).toBe(src)
  })

  it('占位符经 Mustache 渲染后仍可还原（标签内 {{...}} 不被吃掉）', () => {
    const src = '日期:: [[<% tp.date.now("YYYY-MM-DD", -365) %>]]\n{{{content}}}\n<% tp.date.now("{{x}}") %>'
    const m = maskTemplaterTags(src)
    const rendered = Mustache.render(m.text, { content: '正文', x: '不该出现' })
    const restored = m.restore(rendered)
    expect(restored).toContain('[[<% tp.date.now("YYYY-MM-DD", -365) %>]]')
    expect(restored).toContain('正文')
    expect(restored).toContain('<% tp.date.now("{{x}}") %>')
    expect(restored).not.toContain('不该出现')
  })

  it('Mustache section 复制占位符时全部还原', () => {
    const src = '{{#list}}<% tp.date.now() %>-{{name}} {{/list}}'
    const m = maskTemplaterTags(src)
    const rendered = Mustache.render(m.text, { list: [{ name: 'a' }, { name: 'b' }] })
    const restored = m.restore(rendered)
    expect(restored).toBe('<% tp.date.now() %>-a <% tp.date.now() %>-b ')
  })

  it('空文本 / 无标签走快路径', () => {
    expect(maskTemplaterTags('').text).toBe('')
    const m = maskTemplaterTags('plain {{{content}}}')
    expect(m.text).toBe('plain {{{content}}}')
    expect(m.maskedCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// suppressTemplaterTriggerOnCreate（P0 注入面加固）
// ---------------------------------------------------------------------------

// fake Templater 实例：只需要 P0 抑制条目集合（市场版已移除插值接力）
function makeFakeTemplater() {
  return {
    files_with_pending_templates: new Set<string>(),
  }
}

// fake App：塞一个 app.plugins.plugins['templater-obsidian'].templater
function makeApp({ templater }: { templater: unknown }) {
  return {
    plugins: {
      plugins: {
        'templater-obsidian': templater === null ? undefined : { templater },
      },
    },
  } as never
}

describe('suppressTemplaterTriggerOnCreate', () => {
  it('创建前预挂抑制条目；release 后约 900ms 删除（覆盖 Templater 的 300ms 触发窗）', () => {
    jest.useFakeTimers()
    try {
      const tpl = makeFakeTemplater()
      const app = makeApp({ templater: tpl })
      const release = suppressTemplaterTriggerOnCreate(app, 'folder/新文件.md')
      expect(tpl.files_with_pending_templates.has('folder/新文件.md')).toBe(true)
      // 未 release（create 还没完成）时条目**永不**过期——慢设备上 create 本身
      // 可能 >600ms，计时必须从 create 完成后才开始
      jest.advanceTimersByTime(5000)
      expect(tpl.files_with_pending_templates.has('folder/新文件.md')).toBe(true)
      release()
      // release 后 300ms（Templater trigger 检查点）时条目还在
      jest.advanceTimersByTime(400)
      expect(tpl.files_with_pending_templates.has('folder/新文件.md')).toBe(true)
      // 到期后清掉，不留垃圾
      jest.advanceTimersByTime(600)
      expect(tpl.files_with_pending_templates.has('folder/新文件.md')).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('release 幂等：重复调用只计时一次', () => {
    jest.useFakeTimers()
    try {
      const tpl = makeFakeTemplater()
      const app = makeApp({ templater: tpl })
      const release = suppressTemplaterTriggerOnCreate(app, 'a.md')
      release()
      jest.advanceTimersByTime(500)
      release() // 不应重置计时
      jest.advanceTimersByTime(500)
      expect(tpl.files_with_pending_templates.has('a.md')).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('未装 Templater / 结构缺失时静默跳过（返回 noop release）', () => {
    expect(() =>
      suppressTemplaterTriggerOnCreate(makeApp({ templater: null }), 'a.md')(),
    ).not.toThrow()
    expect(() =>
      suppressTemplaterTriggerOnCreate(makeApp({ templater: {} }), 'a.md')(),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 渲染层掩码集成（template.ts）
// ---------------------------------------------------------------------------

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
  } as Item
}

const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

describe('renderItemContent - Templater 标签掩码', () => {
  it('未接力的 <% %>（含 {{...}}）原样落盘，Mustache 变量正常填充', () => {
    const template =
      '<% tp.web.random_picture("512x384", "landscape") %>\n日期:: [[<% tp.date.now("YYYY-MM-DD", -365) %>]]\n{{{content}}}\n<% tp.date.now("{{format}}") %>'
    const content = renderItemContent(
      createMockArticle(), template, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [], '', '', '', undefined,
    )
    expect(content).toContain('<% tp.web.random_picture("512x384", "landscape") %>')
    expect(content).toContain('[[<% tp.date.now("YYYY-MM-DD", -365) %>]]')
    expect(content).toContain('Test content.')
    // 标签内的 {{format}} 不被 Mustache 吃掉
    expect(content).toContain('<% tp.date.now("{{format}}") %>')
  })

  it('<%* 执行块原样落盘（不执行、不丢失）', () => {
    const template = '<%* await tp.file.rename("t") %>\n{{{content}}}'
    const content = renderItemContent(
      createMockArticle(), template, 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [], '', '', '', undefined,
    )
    expect(content).toContain('<%* await tp.file.rename("t") %>')
  })

  it('正文（同步内容）里的 <% %> 不受掩码影响、原样保留', () => {
    const content = renderItemContent(
      createMockArticle({ content: '网页正文里恰好有 <% 1 + 1 %> 这样的片段' }),
      '{{{content}}}', 'LOCATION', undefined,
      DATE_FORMAT, DATE_FORMAT, false, [], '', '', '', undefined,
    )
    expect(content).toContain('<% 1 + 1 %>')
  })
})

describe('renderWeChatMessageSimple - Templater 标签掩码', () => {
  it('未接力的 <% %> 原样保留，{{{content}}} 正常填充', () => {
    const item = createMockArticle({
      title: '同步助手_20240115_abc_文本',
      content: '一条消息',
    })
    const rendered = renderWeChatMessageSimple(
      item, DATE_FORMAT,
      '<% tp.date.now("YYYY-MM-DD") %>\n#### {{{heading}}}\n{{{content}}}',
    )
    expect(rendered).toContain('<% tp.date.now("YYYY-MM-DD") %>')
    expect(rendered).toContain('一条消息')
  })
})

describe('generateMessageAnchor - 标题行含 Templater 标签', () => {
  it('锚点用与正文相同的规则渲染（标签原样保留 → 锚点与文件标题一致）', () => {
    const item = createMockArticle({
      title: '同步助手_20240115_abc_文本',
      content: '一条消息',
    })
    const template = '#### <% tp.date.now("YYYY") %> {{{heading}}}\n{{{content}}}'
    const anchor = generateMessageAnchor(item, DATE_FORMAT, template)
    const rendered = renderWeChatMessageSimple(item, DATE_FORMAT, template)
    // 文件里的标题行
    const headingLine = rendered.split('\n').find((l) => l.startsWith('####'))
    expect(headingLine).toContain('<% tp.date.now("YYYY") %>')
    // 锚点 = 标题文本（Obsidian 锚点规则化后）；两边都保留原始标签文本才对得上
    expect(anchor).toContain('tp.date.now("YYYY")')
  })
})

describe('validateTemplate - Templater 掩码只对声明支持的字段生效', () => {
  it('allowTemplaterTags: <% tp.x("{{") %> 通过校验（文章/消息模板）', () => {
    expect(
      validateTemplate('<% tp.date.now("{{") %>\n{{{content}}}', '文章模板', {
        allowTemplaterTags: true,
      }),
    ).toBe(true)
  })

  it('默认（不支持接力的字段）保持严格校验：<% "{{" %> 拒绝保存（codex P1）', () => {
    // 前置元数据/文件夹/合并文件模板等字段的运行时渲染不掩码，放进这种值会让
    // fetchOmnivore 的 preParseTemplate 直接抛错、每轮同步失败 —— 必须在保存时挡住
    expect(validateTemplate('<% tp.date.now("{{") %>', '前置元数据模板')).toBe(false)
  })
})
