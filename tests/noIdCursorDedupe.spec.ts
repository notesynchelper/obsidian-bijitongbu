/**
 * 「无 id」模式：取消消息注释符 / 笔记属性不写 id —— 去重纯靠最新同步游标
 *
 * 两个新设置（都默认关、开启需设置页二次确认）：
 *  - disableMessageMarkers：合并消息不再写 <!--nh:id--> 隐形注释符
 *  - omitFrontmatterId：笔记属性不写 id（合并模式也不写 syncedIds）
 *
 * 开启后防重复的唯一依据是「最新同步游标」（所有设备游标 + 全局 syncAt 的最大值）：
 * item.updatedAt 严格早于该游标 → 视为已有设备同步过 → 跳过（见 src/sync/cursorDedupe.ts）。
 *
 * 本组测试钉住：
 *  1. cursorDedupe 纯函数契约（maxIsoCursor / latestSyncCursor / isCursorCovered）
 *  2. noMarkers：新消息无注释符、frontmatter 干净；游标覆盖的消息被跳过；
 *     存量注释符 / legacy Bloom 仍参与去重；burn 模式优先不受影响
 *  3. omitId：合并文章不写 id/syncedIds；游标覆盖的文章整条跳过（含空文件不写元数据壳）
 *  4. renderItemContent：omitFrontmatterId 下 frontmatter 无 id、合并分支无 syncedIds；
 *     默认行为不变（回归）
 *  5. debugActive 旁路：调试模式重拉的旧 item 不被游标误杀
 */
import { Item } from '@omnivore-app/api'
import { MessageSortOrder } from '../src/settings'
import { MergeBatchItem } from '../src/sync/MergeProcessor'
import { parseFrontMatterFromContent } from '../src/util'
import {
  maxIsoCursor,
  latestSyncCursor,
  isCursorCovered,
} from '../src/sync/cursorDedupe'

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

const MARKER_RE = /<!--nh:([0-9a-zA-Z-]+)-->/g

function scanMarkers(content: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  MARKER_RE.lastIndex = 0
  while ((m = MARKER_RE.exec(content)) !== null) out.push(m[1])
  return out
}

let uuidCounter = 100
function nextUuid(): string {
  return `c1d2e3f4-0000-4000-8000-0000000${String(uuidCounter++).padStart(5, '0')}`
}

function makeWeChatItem(savedAt: string, id?: string): Item {
  return {
    id: id ?? nextUuid(),
    title: '同步助手_20260805_001_文本',
    savedAt,
    updatedAt: savedAt,
    content: `msg body @ ${savedAt}`,
    url: 'https://example.com',
    slug: 's',
    labels: [],
    highlights: [],
    siteName: '企业微信',
  } as unknown as Item
}

function makeArticleItem(savedAt: string, title: string, id?: string): Item {
  return {
    id: id ?? nextUuid(),
    title,
    savedAt,
    updatedAt: savedAt,
    content: `<p>article body of ${title}</p>`,
    url: `https://example.com/${title}`,
    slug: title,
    labels: [],
    highlights: [],
    siteName: 'example.com',
  } as unknown as Item
}

/** 合并模式下文章 item 的 content（模拟 renderItemContent 输出：可带/不带 id、syncedIds） */
function articleContent(item: Item, opts: { withId?: boolean } = {}): string {
  const idLine = opts.withId === false ? '' : `id: ${item.id}\n`
  return `---\n${idLine}author: 作者\nsource: example.com\n---\n\narticle body of ${
    (item as { title?: string }).title
  }`
}

function makeMockContext(
  settings: Record<string, unknown> = {},
  ctxOverrides: Record<string, unknown> = {},
) {
  let fileContent = ''
  const ctx = {
    settings: {
      messageSortOrder: MessageSortOrder.DESC,
      dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
      wechatMessageTemplate: '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}',
      sectionSeparator: '',
      sectionSeparatorEnd: '',
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
    setFileContent: (c: string) => { fileContent = c },
    ...ctxOverrides,
  }
  return ctx
}

const MOCK_FILE = {
  path: '笔记同步助手/2026-08-05/同步助手_2026-08-05.md',
  basename: '同步助手_2026-08-05',
} as any // eslint-disable-line @typescript-eslint/no-explicit-any

async function newProcessor(ctx: unknown) {
  const { MergeProcessor } = await import('../src/sync/MergeProcessor')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new MergeProcessor(ctx as any)
}

// ---------------------------------------------------------------------------
// 1. cursorDedupe 纯函数
// ---------------------------------------------------------------------------
describe('cursorDedupe 纯函数', () => {
  test('maxIsoCursor 取最新值，忽略空串与无效串', () => {
    expect(
      maxIsoCursor(['2026-08-01T00:00:00.000Z', '', 'not-a-date', '2026-08-03T00:00:00.000Z']),
    ).toBe('2026-08-03T00:00:00.000Z')
    expect(maxIsoCursor([])).toBe('')
    expect(maxIsoCursor(['', 'garbage'])).toBe('')
  })

  test('latestSyncCursor 综合全局 syncAt 与各设备游标', () => {
    expect(
      latestSyncCursor({
        syncAt: '2026-08-01T00:00:00.000Z',
        deviceSyncCursors: {
          phone: '2026-08-04T00:00:00.000Z',
          desktop: '2026-08-02T00:00:00.000Z',
        },
      }),
    ).toBe('2026-08-04T00:00:00.000Z')
    expect(latestSyncCursor({ syncAt: '', deviceSyncCursors: {} })).toBe('')
    // deviceSyncCursors 缺失（旧配置）不炸
    expect(
      latestSyncCursor({ syncAt: '2026-08-01T00:00:00.000Z' } as never),
    ).toBe('2026-08-01T00:00:00.000Z')
  })

  test('legacy 无时区秒级游标（手输「最后同步」的 yyyy-MM-ddTHH:mm:ss）也被识别', () => {
    // 旧配置 / 手输入的游标可能是无时区秒级格式；解析语义须与 main.ts 的
    // parseDateTime 保持一致（本地时区），不能只认带时区的完整 ISO。
    expect(
      maxIsoCursor(['2026-08-01T08:00:00', '2026-08-03T09:30:00']),
    ).toBe('2026-08-03T09:30:00')
    expect(
      latestSyncCursor({
        syncAt: '2026-08-03T09:30:00',
        deviceSyncCursors: { phone: '2026-08-01T00:00:00' },
      }),
    ).toBe('2026-08-03T09:30:00')
    expect(isCursorCovered('2026-08-02T00:00:00', '2026-08-03T09:30:00')).toBe(true)
    expect(isCursorCovered('2026-08-04T00:00:00', '2026-08-03T09:30:00')).toBe(false)
  })

  test('isCursorCovered 严格小于：等于游标的 item 是新数据必须写入', () => {
    const cursor = '2026-08-04T00:00:00.000Z'
    expect(isCursorCovered('2026-08-03T23:59:59.000Z', cursor)).toBe(true)
    expect(isCursorCovered(cursor, cursor)).toBe(false)
    expect(isCursorCovered('2026-08-04T00:00:01.000Z', cursor)).toBe(false)
    // 无游标（首次同步）/ 无时间：一律不算覆盖
    expect(isCursorCovered('2026-08-03T00:00:00.000Z', '')).toBe(false)
    expect(isCursorCovered(undefined, cursor)).toBe(false)
    expect(isCursorCovered('garbage', cursor)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. disableMessageMarkers：消息无注释符 + 游标去重
// ---------------------------------------------------------------------------
describe('disableMessageMarkers：合并消息取消注释符', () => {
  const CURSOR = '2026-08-05T08:00:00.000Z' // 「其它设备」已同步到这里

  function noMarkerSettings(extra: Record<string, unknown> = {}) {
    return {
      disableMessageMarkers: true,
      syncAt: '',
      deviceSyncCursors: { otherDevice: CURSOR },
      ...extra,
    }
  }

  test('新消息落盘不带 <!--nh:--> 注释符，frontmatter 无 syncedIds', async () => {
    const ctx = makeMockContext(noMarkerSettings())
    const processor = await newProcessor(ctx)
    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-08-05T09:00:00.000Z'), content: '' },
      { item: makeWeChatItem('2026-08-05T10:00:00.000Z'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const content = ctx.getFileContent()
    expect(scanMarkers(content)).toHaveLength(0)
    expect(content).toContain('msg body @ 2026-08-05T09:00:00.000Z')
    expect(content).toContain('msg body @ 2026-08-05T10:00:00.000Z')
    const fm = parseFrontMatterFromContent(content) as Record<string, unknown> | null
    expect(fm?.syncedIds).toBeUndefined()
    expect(fm?.id).toBeUndefined()
  })

  test('游标覆盖（updatedAt < 最新设备游标）的消息被跳过 —— 跨设备防重复', async () => {
    const ctx = makeMockContext(noMarkerSettings())
    const processor = await newProcessor(ctx)
    const covered = makeWeChatItem('2026-08-05T07:00:00.000Z') // < CURSOR：其它设备已写过
    const fresh = makeWeChatItem('2026-08-05T09:00:00.000Z')   // > CURSOR：真新消息
    await processor.processBatch(
      [{ item: covered, content: '' }, { item: fresh, content: '' }],
      MOCK_FILE,
    )

    const content = ctx.getFileContent()
    expect(content).not.toContain('msg body @ 2026-08-05T07:00:00.000Z')
    expect(content).toContain('msg body @ 2026-08-05T09:00:00.000Z')
  })

  test('恰好等于游标的消息必须写入（游标 = maxUpdatedAt+1s，等值是新数据）', async () => {
    const ctx = makeMockContext(noMarkerSettings())
    const processor = await newProcessor(ctx)
    const atCursor = makeWeChatItem(CURSOR)
    await processor.processBatch([{ item: atCursor, content: '' }], MOCK_FILE)
    expect(ctx.getFileContent()).toContain(`msg body @ ${CURSOR}`)
  })

  test('存量注释符仍参与去重（开关打开前写入的历史消息不重复）', async () => {
    const ctx = makeMockContext(noMarkerSettings())
    const legacy = makeWeChatItem('2026-08-05T09:30:00.000Z') // > 游标，但正文已有它的标记
    ctx.setFileContent(
      `---\n---\n\n---\n#### 旧\n## 📅 2026-08-05 17:30:00\nmsg body @ 2026-08-05T09:30:00.000Z\n<!--nh:${legacy.id}-->`,
    )
    const processor = await newProcessor(ctx)
    await processor.processBatch([{ item: legacy, content: '' }], MOCK_FILE)

    const content = ctx.getFileContent()
    // 只出现一次（没有被重复追加）
    expect(content.split('msg body @ 2026-08-05T09:30:00.000Z').length - 1).toBe(1)
  })

  test('空 frontmatter + 正文以 --- 开头：跳过轮次字节稳定（不蚕食消息分隔线）', async () => {
    // 真机 E2E 抓到的回归：`---\n---\n\n---\n<消息模板>` 被通用 fm 正则把正文首条
    // 消息的 --- 分隔线吞进 fm 块，每轮 sync 蚕食一行。修复 = 先试空 fm 精确匹配。
    const ctx = makeMockContext(noMarkerSettings())
    const processor = await newProcessor(ctx)
    const fresh = makeWeChatItem('2026-08-05T09:00:00.000Z')
    await processor.processBatch([{ item: fresh, content: '' }], MOCK_FILE)
    const after1 = ctx.getFileContent()
    // 纯消息文件：空 frontmatter（不是 "{}" 字面量壳），正文首行是模板的 ---
    expect(after1.startsWith('---\n---\n\n---\n')).toBe(true)

    // 第二轮只送游标覆盖的消息（跳过，不写）→ 文件必须逐字节不变
    const covered = makeWeChatItem('2026-08-05T07:00:00.000Z')
    await processor.processBatch([{ item: covered, content: '' }], MOCK_FILE)
    expect(ctx.getFileContent()).toBe(after1)
  })

  test('首次同步（无任何游标）一切照写', async () => {
    const ctx = makeMockContext({
      disableMessageMarkers: true,
      syncAt: '',
      deviceSyncCursors: {},
    })
    const processor = await newProcessor(ctx)
    const item = makeWeChatItem('2026-08-05T06:00:00.000Z')
    await processor.processBatch([{ item, content: '' }], MOCK_FILE)
    const content = ctx.getFileContent()
    expect(content).toContain('msg body @ 2026-08-05T06:00:00.000Z')
    expect(scanMarkers(content)).toHaveLength(0)
  })

  test('debugActive 旁路：调试模式重拉的旧 item 不被游标误杀', async () => {
    const ctx = makeMockContext(noMarkerSettings(), { debugActive: true })
    const processor = await newProcessor(ctx)
    const old = makeWeChatItem('2026-08-05T07:00:00.000Z') // < CURSOR
    await processor.processBatch([{ item: old, content: '' }], MOCK_FILE)
    expect(ctx.getFileContent()).toContain('msg body @ 2026-08-05T07:00:00.000Z')
  })

  test('burn 优先：阅后即焚下开关不生效，仍走精确 burnSyncedIds 去重', async () => {
    const ctx = makeMockContext(
      noMarkerSettings({
        burnAfterReading: true,
        burnAfterReadingEnabledAt: '2026-08-01T00:00:00.000Z',
        pendingBurnDeletes: [],
      }),
      {
        burnTracker: {
          recordCursor: jest.fn(),
          recordDelete: jest.fn(),
          maxCursorUpdatedAt: jest.fn(() => ''),
        },
      },
    )
    const processor = await newProcessor(ctx)
    // 游标覆盖的旧 item：burn 模式不看游标（精确数组判重），必须照写（读后删除语义）
    const old = makeWeChatItem('2026-08-05T07:00:00.000Z')
    await processor.processBatch([{ item: old, content: '' }], MOCK_FILE)
    const content = ctx.getFileContent()
    expect(content).toContain('msg body @ 2026-08-05T07:00:00.000Z')
    const fm = parseFrontMatterFromContent(content) as Record<string, unknown> | null
    expect(Array.isArray(fm?.burnSyncedIds)).toBe(true)
  })

  test('开关关闭（默认）：行为不变，仍写注释符（回归）', async () => {
    const ctx = makeMockContext({
      syncAt: '',
      deviceSyncCursors: { otherDevice: CURSOR },
    })
    const processor = await newProcessor(ctx)
    const old = makeWeChatItem('2026-08-05T07:00:00.000Z') // < 游标也照写（默认不看游标）
    await processor.processBatch([{ item: old, content: '' }], MOCK_FILE)
    const content = ctx.getFileContent()
    expect(content).toContain('msg body @ 2026-08-05T07:00:00.000Z')
    expect(scanMarkers(content)).toEqual([old.id])
  })
})

// ---------------------------------------------------------------------------
// 3. omitFrontmatterId：合并文章不写 id/syncedIds + 游标去重
// ---------------------------------------------------------------------------
describe('omitFrontmatterId：合并文章（ALL 模式）', () => {
  const CURSOR = '2026-08-05T08:00:00.000Z'

  function omitIdSettings(extra: Record<string, unknown> = {}) {
    return {
      omitFrontmatterId: true,
      syncAt: '',
      deviceSyncCursors: { otherDevice: CURSOR },
      ...extra,
    }
  }

  test('新单篇文章：文件级 frontmatter 带业务字段但无 id、无 syncedIds', async () => {
    const ctx = makeMockContext(omitIdSettings())
    const processor = await newProcessor(ctx)
    const item = makeArticleItem('2026-08-05T09:00:00.000Z', '深度好文')
    await processor.processBatch(
      [{ item, content: articleContent(item, { withId: false }) }],
      MOCK_FILE,
    )

    const content = ctx.getFileContent()
    expect(content).toContain('article body of 深度好文')
    const fm = parseFrontMatterFromContent(content) as Record<string, unknown> | null
    expect(fm?.author).toBe('作者')
    expect(fm?.id).toBeUndefined()
    expect(fm?.syncedIds).toBeUndefined()
  })

  test('游标覆盖的文章整条跳过：空文件不产出「只有元数据没正文」的壳', async () => {
    const ctx = makeMockContext(omitIdSettings())
    const processor = await newProcessor(ctx)
    const covered = makeArticleItem('2026-08-05T07:00:00.000Z', '旧文章')
    await processor.processBatch(
      [{ item: covered, content: articleContent(covered, { withId: false }) }],
      MOCK_FILE,
    )

    const content = ctx.getFileContent()
    expect(content).not.toContain('article body of 旧文章')
    const fm = parseFrontMatterFromContent(content) as Record<string, unknown> | null
    // 不写业务元数据壳
    expect(fm?.author).toBeUndefined()
  })

  test('游标覆盖 + 新文章混批：只写新文章', async () => {
    const ctx = makeMockContext(omitIdSettings())
    const processor = await newProcessor(ctx)
    const covered = makeArticleItem('2026-08-05T07:00:00.000Z', '旧文章')
    const fresh = makeArticleItem('2026-08-05T09:00:00.000Z', '新文章')
    await processor.processBatch(
      [
        { item: covered, content: articleContent(covered, { withId: false }) },
        { item: fresh, content: articleContent(fresh, { withId: false }) },
      ],
      MOCK_FILE,
    )
    const content = ctx.getFileContent()
    expect(content).not.toContain('article body of 旧文章')
    expect(content).toContain('article body of 新文章')
  })

  test('更新重下发的既有文章：按分隔符识别、原地替换而非追加重复（codex round2 P1）', async () => {
    const ctx = makeMockContext(
      omitIdSettings({
        sectionSeparator: '%%{{{dateSaved}}}_start%%',
        sectionSeparatorEnd: '%%{{{dateSaved}}}_end%%',
      }),
    )
    const { formatDate } = await import('../src/util')
    const item = makeArticleItem('2026-08-05T07:30:00.000Z', '被更新的文章')
    // 上游更新：updatedAt 越过所有游标（不被游标跳过），savedAt 稳定（分隔符渲染稳定）
    ;(item as { updatedAt?: string }).updatedAt = '2026-08-05T09:00:00.000Z'
    const dateSaved = formatDate(item.savedAt, 'yyyy-MM-dd HH:mm:ss')
    ctx.setFileContent(
      `---\nauthor: 作者\n---\n\n%%${dateSaved}_start%%\n旧版本正文\n%%${dateSaved}_end%%`,
    )
    const newContent = `---\nauthor: 作者\n---\n\n%%${dateSaved}_start%%\narticle body of 被更新的文章 v2\n%%${dateSaved}_end%%`

    const processor = await newProcessor(ctx)
    await processor.processBatch([{ item, content: newContent }], MOCK_FILE)

    const body = ctx.getFileContent()
    expect(body).toContain('article body of 被更新的文章 v2')
    expect(body).not.toContain('旧版本正文')
    // 只有一个 section（原地替换，没有追加出第二份）
    expect(body.split(`%%${dateSaved}_start%%`).length - 1).toBe(1)
    // frontmatter 仍然干净
    const fm = parseFrontMatterFromContent(body) as Record<string, unknown> | null
    expect(fm?.id).toBeUndefined()
    expect(fm?.syncedIds).toBeUndefined()
  })

  test('legacy 文件的 syncedIds 原样保留、不再增长', async () => {
    const ctx = makeMockContext(omitIdSettings())
    const { bloomFromIds } = await import('../src/compressIds')
    const legacyBloom = bloomFromIds(['aaaabbbb-0000-4000-8000-000000000001'])
    ctx.setFileContent(`---\nsyncedIds: ${legacyBloom}\n---\n\n旧正文`)
    const processor = await newProcessor(ctx)
    const fresh = makeArticleItem('2026-08-05T09:00:00.000Z', '新文章')
    await processor.processBatch(
      [{ item: fresh, content: articleContent(fresh, { withId: false }) }],
      MOCK_FILE,
    )
    const fm = parseFrontMatterFromContent(ctx.getFileContent()) as Record<string, unknown> | null
    // 旧值原样保留（不删既有数据），且没有因新文章而变化
    expect(fm?.syncedIds).toBe(legacyBloom)
  })

  test('开关关闭（默认）：单篇文章文件级 fm 仍写 id（回归）', async () => {
    const ctx = makeMockContext({ syncAt: '', deviceSyncCursors: {} })
    const processor = await newProcessor(ctx)
    const item = makeArticleItem('2026-08-05T09:00:00.000Z', '常规文章')
    await processor.processBatch(
      [{ item, content: articleContent(item) }],
      MOCK_FILE,
    )
    const fm = parseFrontMatterFromContent(ctx.getFileContent()) as Record<string, unknown> | null
    expect(fm?.id).toBe(item.id)
  })
})

// ---------------------------------------------------------------------------
// 4. renderItemContent：omitFrontmatterId 渲染契约
// ---------------------------------------------------------------------------
describe('renderItemContent：omitFrontmatterId', () => {
  function makeItem(overrides?: Partial<Item>): Item {
    return {
      id: 'render-test-id-123',
      title: 'Render Test Article',
      siteName: 'example.com',
      originalArticleUrl: 'https://example.com/a',
      author: 'Author',
      description: 'desc',
      slug: 'slug',
      labels: [],
      highlights: [],
      updatedAt: '2026-08-05T09:00:00.000Z',
      savedAt: '2026-08-05T09:00:00.000Z',
      pageType: 'ARTICLE',
      content: '<p>body</p>',
      publishedAt: null,
      url: 'https://example.com/a',
      image: null,
      readAt: null,
      wordsCount: 10,
      readingProgressPercent: 0,
      isArchived: false,
      archivedAt: null,
      contentReader: null,
    } as unknown as Item
  }

  const FM_TEMPLATE = 'author: {{{author}}}\nsource: {{{siteName}}}'

  async function renderWith(omitId: boolean, shouldMerge: boolean) {
    const { renderItemContent } = await import('../src/settings/template')
    return renderItemContent(
      makeItem(),
      '{{{content}}}',
      'LOCATION',
      undefined,
      'yyyy-MM-dd HH:mm:ss',
      'yyyy-MM-dd HH:mm:ss',
      shouldMerge,
      [],
      FM_TEMPLATE,
      '',
      '',
      undefined,
      undefined,
      omitId,
    )
  }

  test('非合并 + omitId：frontmatter 无 id，业务字段保留', async () => {
    const content = await renderWith(true, false)
    const fm = parseFrontMatterFromContent(content) as Record<string, unknown> | null
    expect(fm?.id).toBeUndefined()
    expect(fm?.author).toBe('Author')
    expect(fm?.source).toBe('example.com')
  })

  test('合并 + omitId：frontmatter 无 id、无 syncedIds', async () => {
    const content = await renderWith(true, true)
    const fm = parseFrontMatterFromContent(content) as Record<string, unknown> | null
    expect(fm?.id).toBeUndefined()
    expect(fm?.syncedIds).toBeUndefined()
    expect(fm?.author).toBe('Author')
  })

  test('默认（不 omit）：id / 合并 syncedIds 照写（回归）', async () => {
    const single = await renderWith(false, false)
    const fmSingle = parseFrontMatterFromContent(single) as Record<string, unknown> | null
    expect(fmSingle?.id).toBe('render-test-id-123')

    const merged = await renderWith(false, true)
    const fmMerged = parseFrontMatterFromContent(merged) as Record<string, unknown> | null
    expect(fmMerged?.id).toBe('render-test-id-123')
    expect(typeof fmMerged?.syncedIds).toBe('string')
  })
})
