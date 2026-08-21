// 单元测试：「合并文件模板」—— 用户自定义合并消息文件的样式（文件头）。
//
// 🔴 本特性的两条硬约束（回归了就是 P0）：
//   1. **绝不往用户笔记里写任何锚点 / 隐藏标记**。文件头靠「模板反推出的正则」认，
//      文件里一个新增注释都不许有。
//   2. 模板为空（默认值）时，输出必须与本特性上线前逐字一致。
//
// 分组：
//  §1 renderMergeFileTemplate   模板 → 新建文件的初始内容
//  §2 buildMergeHeaderMatcher / insertIntoMergeBody   文件头定位与插入
//  §3 MergeProcessor 集成       真的走 processBatch
//  §4 × 「消息不写 id」交叉      两个开关同时开 → 文件里零 HTML 注释、去重仍正确
//  §5 落盘前 frontmatter 兜底 + 设置页校验

import { Item } from '@omnivore-app/api'
import { stringifyYaml } from 'obsidian'
import { MessageSortOrder } from '../src/settings'
import { MergeBatchItem } from '../src/sync/MergeProcessor'
import {
  buildMergeHeaderMatcher,
  insertIntoMergeBody,
  isHeaderOnlyBody,
  mergeBodyHasContent,
  renderMergeFileTemplate,
  splitMergeHeader,
  validateMergeFileTemplate,
} from '../src/sync/mergeFileTemplate'
import { bloomAddId, createBloomFilter } from '../src/compressIds'
import { parseFrontMatterFromContent } from '../src/util'

const MOCK_FILE = {
  path: '笔记同步助手/2026-08-06/同步助手_2026-08-06.md',
  basename: '同步助手_2026-08-06',
} as never

/** 演示用模板：属性块 + 日期标题（用户最常见的写法）。 */
const TEMPLATE = '---\ntags: [消息汇总]\n---\n\n# 📮 {{{date}}} 的消息'
const VIEW = { date: '2026-08-06', title: '同步助手_2026-08-06' }

let uuidCounter = 200
function nextUuid(): string {
  return `b7c8d9e0-0000-4000-8000-0000000${String(uuidCounter++).padStart(5, '0')}`
}

function makeWeChatItem(savedAt: string, body: string): Item {
  return {
    id: nextUuid(),
    title: '同步助手_20260806_001_文本',
    savedAt,
    updatedAt: savedAt,
    content: body,
    url: 'https://example.com',
    slug: 's',
    labels: [],
    highlights: [],
    siteName: '企业微信',
  } as unknown as Item
}

function makeArticleItem(savedAt: string, title: string): Item {
  return {
    id: nextUuid(),
    title,
    savedAt,
    updatedAt: savedAt,
    content: 'unused',
    url: 'https://example.com/a',
    slug: 'a',
    labels: [],
    highlights: [],
  } as unknown as Item
}

function makeArticleContent(id: string, meta: Record<string, unknown>, bodyText: string): string {
  const fm: Record<string, unknown> = { id, ...meta, syncedIds: bloomAddId(createBloomFilter(), id) }
  return `---\n${stringifyYaml(fm)}---\n\n${bodyText}`
}

function makeMockContext(settings: Record<string, unknown> = {}, initialContent = '') {
  let fileContent = initialContent
  const ctx = {
    settings: {
      messageSortOrder: MessageSortOrder.DESC,
      dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
      wechatMessageTemplate: '## 📅 {{{dateSaved}}}\n{{{content}}}',
      sectionSeparator: '',
      sectionSeparatorEnd: '',
      mergeFileTemplate: '',
      ...settings,
    },
    app: {
      vault: {
        process: jest.fn(async (_file: unknown, fn: (data: string) => string) => {
          fileContent = fn(fileContent)
          return fileContent
        }),
      },
    },
    successTracker: { recordSuccess: jest.fn() },
    diaryLinkProcessor: { addLink: jest.fn() },
    enqueueFileForImageLocalization: jest.fn(async () => {}),
    enqueueFileForAttachmentLocalization: jest.fn(async () => {}),
    addProcessedFile: jest.fn(),
    imageLocalizer: null,
    getFileContent: () => fileContent,
  }
  return ctx
}

async function newProcessor(ctx: unknown) {
  const { MergeProcessor } = await import('../src/sync/MergeProcessor')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new MergeProcessor(ctx as any)
}

/** 文件里所有 HTML 注释（用来断言「零隐藏标记」）。 */
function htmlComments(content: string): string[] {
  return content.match(/<!--[\s\S]*?-->/g) ?? []
}

// ---------------------------------------------------------------------------
// §1 renderMergeFileTemplate
// ---------------------------------------------------------------------------
describe('renderMergeFileTemplate', () => {
  test('空模板 → 空字符串（历史行为：创建空文件，零回归）', () => {
    expect(renderMergeFileTemplate('', VIEW)).toBe('')
    expect(renderMergeFileTemplate('   \n  ', VIEW)).toBe('')
  })

  test('渲染变量，且【不写入任何隐藏标记】', () => {
    const out = renderMergeFileTemplate(TEMPLATE, VIEW)
    expect(out).toBe('---\ntags: [消息汇总]\n---\n\n# 📮 2026-08-06 的消息\n')
    expect(htmlComments(out)).toEqual([])
  })

  test('{{{title}}} 同样可用', () => {
    expect(renderMergeFileTemplate('# {{{title}}}', VIEW)).toBe('# 同步助手_2026-08-06\n')
  })
})

// ---------------------------------------------------------------------------
// §2 文件头定位 / 插入
// ---------------------------------------------------------------------------
describe('文件头定位（不写锚点，靠模板反推正则）', () => {
  const headerRe = buildMergeHeaderMatcher(TEMPLATE)
  // 文件正文（frontmatter 已被 MergeProcessor 单独摘出去）
  const headerBody = '# 📮 2026-08-06 的消息'

  test('模板里的属性块不参与匹配（它在 frontmatter 里，不在正文）', () => {
    expect(headerRe).not.toBeNull()
    expect(splitMergeHeader(headerBody, headerRe).header).toBe(headerBody)
  })

  test('日期变了照样认得出文件头（变量位置是通配符）', () => {
    const otherDay = '# 📮 2099-12-31 的消息'
    expect(splitMergeHeader(otherDay, headerRe).header).toBe(otherDay)
  })

  test('无模板 → 没有文件头，一切退回历史行为', () => {
    expect(buildMergeHeaderMatcher('')).toBeNull()
    expect(splitMergeHeader(headerBody, null)).toEqual({ header: '', rest: headerBody })
  })

  test('用户把文件头改了 → 认不出，安全退回（绝不猜、绝不改用户字节）', () => {
    const edited = '# 我自己改的标题'
    expect(splitMergeHeader(edited, headerRe).header).toBe('')
  })

  test('模板以变量结尾 → 文件头吃到行尾，不会在半行处截断', () => {
    const re = buildMergeHeaderMatcher('# 消息 {{{date}}}')
    expect(splitMergeHeader('# 消息 2026-08-06\n\n正文', re).header).toBe('# 消息 2026-08-06')
  })

  test('模板全是变量、没有字面量 → 不给定位器（不瞎猜）', () => {
    expect(buildMergeHeaderMatcher('{{{title}}}')).toBeNull()
  })

  test('insert DESC：新块插在文件头之下、旧内容之上', () => {
    const body = `${headerBody}\n\n旧消息`
    const out = insertIntoMergeBody(body, '新消息', MessageSortOrder.DESC, headerRe)
    expect(out).toBe(`${headerBody}\n\n新消息\n\n旧消息`)
    expect(htmlComments(out)).toEqual([])
  })

  test('insert DESC 无文件头：与历史行为逐字一致（整体 prepend）', () => {
    expect(insertIntoMergeBody('旧内容', '新块', MessageSortOrder.DESC, null)).toBe('新块\n\n旧内容')
    expect(insertIntoMergeBody('', '新块', MessageSortOrder.DESC, null)).toBe('新块')
  })

  test('insert ASC：追加到末尾，与历史行为逐字一致', () => {
    expect(insertIntoMergeBody('旧内容', '新块', MessageSortOrder.ASC, headerRe)).toBe('旧内容\n\n新块')
    expect(insertIntoMergeBody('', '新块', MessageSortOrder.ASC, headerRe)).toBe('新块')
  })

  test('mergeBodyHasContent / isHeaderOnlyBody：只看文件头之外', () => {
    expect(mergeBodyHasContent(headerBody, headerRe)).toBe(false)
    expect(isHeaderOnlyBody(headerBody, headerRe, true)).toBe(true)
    expect(mergeBodyHasContent(`${headerBody}\n\n消息`, headerRe)).toBe(true)
    expect(isHeaderOnlyBody(`${headerBody}\n\n消息`, headerRe, true)).toBe(false)
    // 无模板时行为不变
    expect(mergeBodyHasContent('普通正文')).toBe(true)
    expect(isHeaderOnlyBody('普通正文', null, false)).toBe(false)
    // 只有属性块的模板：正文里没有可匹配的文件头，但空正文仍算「刚新建」
    expect(isHeaderOnlyBody('', null, true)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §3 MergeProcessor 集成
// ---------------------------------------------------------------------------
describe('MergeProcessor × 合并文件模板', () => {
  const skeleton = renderMergeFileTemplate(TEMPLATE, VIEW)

  test('DESC：两轮消息都在文件头之下，且新的在上；文件里零锚点', async () => {
    const ctx = makeMockContext({ mergeFileTemplate: TEMPLATE }, skeleton)
    const processor = await newProcessor(ctx)

    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T08:00:00.000Z', '早上的消息'), content: '' }],
      MOCK_FILE,
    )
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T15:00:00.000Z', '下午的消息'), content: '' }],
      MOCK_FILE,
    )

    const out = ctx.getFileContent()
    expect(out.indexOf('# 📮 2026-08-06 的消息')).toBeLessThan(out.indexOf('下午的消息'))
    expect(out.indexOf('下午的消息')).toBeLessThan(out.indexOf('早上的消息'))
    // 唯一允许存在的注释是历史就有的去重标记 <!--nh:id-->，绝不能出现别的锚点
    expect(htmlComments(out).every((c) => /^<!--nh:[0-9a-f-]+-->$/.test(c))).toBe(true)
    expect(out).not.toContain('nh-msgs')
  })

  test('ASC：追加在末尾，文件头仍在最上', async () => {
    const ctx = makeMockContext(
      { mergeFileTemplate: TEMPLATE, messageSortOrder: MessageSortOrder.ASC },
      skeleton,
    )
    const processor = await newProcessor(ctx)
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T08:00:00.000Z', '第一条'), content: '' }],
      MOCK_FILE,
    )
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T15:00:00.000Z', '第二条'), content: '' }],
      MOCK_FILE,
    )
    const out = ctx.getFileContent()
    expect(out.indexOf('# 📮')).toBeLessThan(out.indexOf('第一条'))
    expect(out.indexOf('第一条')).toBeLessThan(out.indexOf('第二条'))
  })

  test('模板为空（默认）：输出与本特性上线前逐字一致', async () => {
    const ctx = makeMockContext({}, '')
    const processor = await newProcessor(ctx)
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T08:00:00.000Z', '裸消息'), content: '' }],
      MOCK_FILE,
    )
    const out = ctx.getFileContent()
    expect(out.startsWith('---\n---\n\n')).toBe(true)
    expect(out).toContain('裸消息')
    expect(out).not.toContain('nh-msgs')
  })

  test('存量文件（无文件头）后来才开模板：老文件继续走旧插入路径', async () => {
    const legacy = '---\n---\n\n## 老消息\n历史正文\n'
    const ctx = makeMockContext({ mergeFileTemplate: TEMPLATE }, legacy)
    const processor = await newProcessor(ctx)
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T09:00:00.000Z', '新来的'), content: '' }],
      MOCK_FILE,
    )
    const out = ctx.getFileContent()
    expect(out.indexOf('新来的')).toBeLessThan(out.indexOf('老消息'))
    expect(out).toContain('历史正文')
  })

  test('模板自带的笔记属性跨同步保留', async () => {
    const ctx = makeMockContext({ mergeFileTemplate: TEMPLATE }, skeleton)
    const processor = await newProcessor(ctx)
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T08:00:00.000Z', '正文一'), content: '' }],
      MOCK_FILE,
    )
    const fm = parseFrontMatterFromContent(ctx.getFileContent()) as Record<string, unknown>
    expect(fm.tags).toEqual(['消息汇总'])
  })

  test('ALL 模式单篇文章 + 模板：文章属性仍写到文件级 frontmatter（不被误判成 digest）', async () => {
    const ctx = makeMockContext({ mergeFileTemplate: TEMPLATE }, skeleton)
    const processor = await newProcessor(ctx)
    const item = makeArticleItem('2026-08-06T10:00:00.000Z', '一篇文章')
    await processor.processBatch(
      [{ item, content: makeArticleContent(item.id, { author: '作者甲', source: 'qa.test' }, '文章正文') }],
      MOCK_FILE,
    )
    const out = ctx.getFileContent()
    const fm = parseFrontMatterFromContent(out) as Record<string, unknown>
    expect(fm.author).toBe('作者甲')
    expect(out).not.toContain('> [!note] 笔记属性')
    expect(out.indexOf('# 📮')).toBeLessThan(out.indexOf('文章正文'))
  })

  test('模板属性写了 id: → ALL 模式单篇仍进文件级属性，不被误判成 digest', async () => {
    const tpl = '---\nid: my-daily-note\n---\n\n# 📮 {{{date}}} 的消息'
    const ctx = makeMockContext({ mergeFileTemplate: tpl }, renderMergeFileTemplate(tpl, VIEW))
    const processor = await newProcessor(ctx)
    const item = makeArticleItem('2026-08-06T10:00:00.000Z', '单篇')
    await processor.processBatch(
      [{ item, content: makeArticleContent(item.id, { author: '作者乙' }, '正文乙') }],
      MOCK_FILE,
    )
    const fm = parseFrontMatterFromContent(ctx.getFileContent()) as Record<string, unknown>
    expect(fm.author).toBe('作者乙')
    expect(ctx.getFileContent()).not.toContain('> [!note] 笔记属性')
  })
})

// ---------------------------------------------------------------------------
// §4 × 「消息不写 id」（disableMessageMarkers）交叉
// ---------------------------------------------------------------------------
describe('合并文件模板 × 消息不写 id（交叉）', () => {
  const skeleton = renderMergeFileTemplate(TEMPLATE, VIEW)
  const NO_MARKER = {
    mergeFileTemplate: TEMPLATE,
    disableMessageMarkers: true,
    // 游标去重：写过的消息靠「最新同步游标」判重
    deviceSyncCursors: { devA: '2026-08-06T07:00:00.000Z' },
  }

  test('两个开关同时开 → 整份文件【一个 HTML 注释都没有】', async () => {
    const ctx = makeMockContext(NO_MARKER, skeleton)
    const processor = await newProcessor(ctx)
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T08:00:00.000Z', '无 id 的消息'), content: '' }],
      MOCK_FILE,
    )
    const out = ctx.getFileContent()
    expect(htmlComments(out)).toEqual([])
    expect(out).toContain('无 id 的消息')
    // 文件头仍在最上
    expect(out.indexOf('# 📮')).toBeLessThan(out.indexOf('无 id 的消息'))
  })

  test('两个开关同时开 + 多轮：新消息始终插在文件头之下、旧消息之上', async () => {
    const ctx = makeMockContext(NO_MARKER, skeleton)
    const processor = await newProcessor(ctx)
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T08:00:00.000Z', '第一批'), content: '' }],
      MOCK_FILE,
    )
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T15:00:00.000Z', '第二批'), content: '' }],
      MOCK_FILE,
    )
    const out = ctx.getFileContent()
    expect(htmlComments(out)).toEqual([])
    expect(out.indexOf('# 📮')).toBeLessThan(out.indexOf('第二批'))
    expect(out.indexOf('第二批')).toBeLessThan(out.indexOf('第一批'))
  })

  test('两个开关同时开：被游标覆盖的旧消息不重复写（去重仍然生效）', async () => {
    const ctx = makeMockContext(NO_MARKER, skeleton)
    const processor = await newProcessor(ctx)
    // savedAt/updatedAt 早于设备游标 → 视为已同步过，跳过
    const old = makeWeChatItem('2026-08-06T06:00:00.000Z', '游标之前的老消息')
    await processor.processBatch([{ item: old, content: '' }], MOCK_FILE)
    expect(ctx.getFileContent()).not.toContain('游标之前的老消息')
    // 游标之后的正常写入
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T09:00:00.000Z', '游标之后的新消息'), content: '' }],
      MOCK_FILE,
    )
    expect(ctx.getFileContent()).toContain('游标之后的新消息')
    expect(htmlComments(ctx.getFileContent())).toEqual([])
  })

  test('只开「消息不写 id」、不开模板：行为与本特性上线前逐字一致', async () => {
    const ctx = makeMockContext(
      { disableMessageMarkers: true, deviceSyncCursors: { devA: '2026-08-06T07:00:00.000Z' } },
      '',
    )
    const processor = await newProcessor(ctx)
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T08:00:00.000Z', 'A'), content: '' }],
      MOCK_FILE,
    )
    const out = ctx.getFileContent()
    expect(out.startsWith('---\n---\n\n')).toBe(true)
    expect(htmlComments(out)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// §5 落盘前 frontmatter 兜底 + 设置页校验
// ---------------------------------------------------------------------------
describe('合并文件模板：属性块 YAML 兜底', () => {
  test('title 值以 @ 开头（@daily）→ 落盘前自动补引号，不产出解析不了的文件', () => {
    const out = renderMergeFileTemplate('---\ntitle: {{{title}}}\n---\n\n# 头', {
      date: '2026-08-06',
      title: '@daily',
    })
    const fm = parseFrontMatterFromContent(out) as Record<string, unknown>
    expect(fm).toBeTruthy()
    expect(String(fm.title)).toContain('@daily')
  })

  test('属性块彻底解析不了 → 丢属性块保正文，文件仍可写入消息', async () => {
    const tpl = '---\n{{{title}}}\n---\n\n# 头'
    const out = renderMergeFileTemplate(tpl, { date: '2026-08-06', title: 'a: b: c\n\t- x' })
    expect(out.startsWith('# 头')).toBe(true)
    const ctx = makeMockContext({ mergeFileTemplate: tpl }, out)
    const processor = await newProcessor(ctx)
    await expect(
      processor.processBatch(
        [{ item: makeWeChatItem('2026-08-06T08:00:00.000Z', '能写进来'), content: '' }],
        MOCK_FILE,
      ),
    ).resolves.toBeUndefined()
    expect(ctx.getFileContent()).toContain('能写进来')
  })

  test('属性块根不是键值对（数组/标量）→ 整块丢弃，不被首轮同步抹掉/改坏', () => {
    expect(renderMergeFileTemplate('---\n- a\n- b\n---\n\n# 头', VIEW).startsWith('# 头')).toBe(true)
    expect(renderMergeFileTemplate('---\n单独一个标量\n---\n\n# 头2', VIEW).startsWith('# 头2')).toBe(true)
  })

  // 回归：MergeProcessor 曾拿【整份 content】喂 parseFrontMatterFromContent，而那个正则
  // 不认空 frontmatter（`---\n---`），会一路吃到正文里下一处 `---`（消息模板自带的分隔线）
  // 当 YAML → YAMLException → 整份写入失败、消息一条都进不来。
  test('正文里有 --- 分隔线时，多轮同步不因 YAML 误解析而失败', async () => {
    const ctx = makeMockContext(
      { mergeFileTemplate: TEMPLATE, wechatMessageTemplate: '---\n## {{{dateSaved}}}\n{{{content}}}' },
      renderMergeFileTemplate(TEMPLATE, VIEW),
    )
    const processor = await newProcessor(ctx)
    await processor.processBatch(
      [{ item: makeWeChatItem('2026-08-06T08:00:00.000Z', '第一轮'), content: '' }],
      MOCK_FILE,
    )
    await expect(
      processor.processBatch(
        [{ item: makeWeChatItem('2026-08-06T09:00:00.000Z', '第二轮'), content: '' }],
        MOCK_FILE,
      ),
    ).resolves.toBeUndefined()
    expect(ctx.getFileContent()).toContain('第一轮')
    expect(ctx.getFileContent()).toContain('第二轮')
  })
})

describe('validateMergeFileTemplate', () => {
  test('空模板 / 不以 --- 开头 → 合法', () => {
    expect(validateMergeFileTemplate('').valid).toBe(true)
    expect(validateMergeFileTemplate('# {{{date}}}').valid).toBe(true)
  })

  test('开头是合法闭合的属性块 → 合法', () => {
    expect(validateMergeFileTemplate(TEMPLATE).valid).toBe(true)
  })

  test('空属性块 ---\\n--- 是合法写法 → 不报假警', () => {
    expect(validateMergeFileTemplate('---\n---\n\n# {{{title}}}').valid).toBe(true)
  })

  test('把 --- 当第一行的水平分割线 → 提示（会被 Obsidian 当属性块起始）', () => {
    const r = validateMergeFileTemplate('---\n# {{{date}}} 的消息')
    expect(r.valid).toBe(false)
    expect(r.error).toContain('属性块')
  })

  test('开头属性块不是合法 YAML → 提示具体原因', () => {
    const r = validateMergeFileTemplate('---\ntags: [未闭合\n---\n\n# 头')
    expect(r.valid).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

// 让 MergeBatchItem 类型被引用（保持与其它 merge spec 相同的导入约定）
export type _MergeBatchItem = MergeBatchItem

// ---------------------------------------------------------------------------
// §6 codex 复检：旧写法 / 旧文件的兼容与边界
// ---------------------------------------------------------------------------
describe('兼容与边界（codex 复检）', () => {
  test('模板里还写着旧的 {{{messages}}} → 只取它之前的部分当文件头，占位符不落盘', () => {
    const tpl = '# 📮 {{{date}}} 的消息\n\n{{{messages}}}\n\n***\n旧的页脚'
    const out = renderMergeFileTemplate(tpl, VIEW)
    expect(out).toBe('# 📮 2026-08-06 的消息\n')
    expect(out).not.toContain('messages')
    expect(out).not.toContain('旧的页脚')
    // 文件头定位器同样按截断后的模板构造
    expect(splitMergeHeader('# 📮 2026-08-06 的消息', buildMergeHeaderMatcher(tpl)).header)
      .toBe('# 📮 2026-08-06 的消息')
  })

  test('3.1.22 写过锚点的老文件：起始锚点即文件头边界，新消息插在它之下', () => {
    const legacyBody = '# 老页眉\n\n<!--nh-msgs-->\n\n老消息\n\n<!--nh-msgs-end-->\n\n老页脚'
    const out = insertIntoMergeBody(legacyBody, '新消息', MessageSortOrder.DESC, null)
    expect(out.indexOf('# 老页眉')).toBeLessThan(out.indexOf('新消息'))
    expect(out.indexOf('新消息')).toBeLessThan(out.indexOf('老消息'))
    expect(out.trimEnd().endsWith('老页脚')).toBe(true)
  })

  test('变量值里含有它后面那段字面量 → 文件头补齐到行尾，不劈开标题行', () => {
    const re = buildMergeHeaderMatcher('# {{{title}}} 消息')
    const { header, rest } = splitMergeHeader('# 周报 消息 消息\n\n正文', re)
    expect(header).toBe('# 周报 消息 消息')
    expect(rest).toBe('正文')
  })

  test('模板首行留空 / 带缩进 → 仍认得出文件头', () => {
    const tpl = '\n# 📮 {{{date}}} 的消息'
    const rendered = renderMergeFileTemplate(tpl, VIEW)
    const re = buildMergeHeaderMatcher(tpl)
    expect(splitMergeHeader(rendered.replace(/\n$/, ''), re).header.trim())
      .toBe('# 📮 2026-08-06 的消息')
  })

  test('只有属性块的模板：ALL 模式单篇文章仍进文件级属性', async () => {
    const tpl = '---\nid: my-daily-note\n---'
    const ctx = makeMockContext({ mergeFileTemplate: tpl }, renderMergeFileTemplate(tpl, VIEW))
    const processor = await newProcessor(ctx)
    const item = makeArticleItem('2026-08-06T10:00:00.000Z', '单篇')
    await processor.processBatch(
      [{ item, content: makeArticleContent(item.id, { author: '作者丙' }, '正文丙') }],
      MOCK_FILE,
    )
    const fm = parseFrontMatterFromContent(ctx.getFileContent()) as Record<string, unknown>
    expect(fm.author).toBe('作者丙')
    expect(ctx.getFileContent()).not.toContain('> [!note] 笔记属性')
  })
})

describe('文件头定位：变量通配符不跨行（codex P2）', () => {
  test('用户删掉变量后面的字面量 → 认不出就退回，绝不把老消息吞进文件头', () => {
    // 模板 `# 📮 {{{date}}} 的消息`；用户把「的消息」删了，而某条老消息里恰好含「的消息」
    const re = buildMergeHeaderMatcher('# 📮 {{{date}}} 的消息')
    const edited = '# 📮 2026-08-06\n\n## 老消息\n他发来一句「今天的消息」\n'
    expect(splitMergeHeader(edited, re).header).toBe('')
    // 于是退回历史行为：新消息插到最前面，一条老内容都没被算进文件头
    const out = insertIntoMergeBody(edited, '新消息', MessageSortOrder.DESC, re)
    expect(out.startsWith('新消息')).toBe(true)
    expect(out).toContain('他发来一句「今天的消息」')
  })
})
