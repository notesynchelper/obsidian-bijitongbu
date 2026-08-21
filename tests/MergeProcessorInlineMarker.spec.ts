/**
 * 合并消息「内联隐形标记」去重 —— 一天 8 批增量场景（方案 A）
 *
 * 背景：旧去重把 264-bit Bloom 压成 44 字 base64 blob 挂在 frontmatter
 * `syncedIds` 里，既丑（Properties 里一坨看不懂的串）又不准（~8% 假阳性会
 * 静默丢消息，见 project_bloom_filter_silent_message_drop）。
 *
 * 新设计（方案 A）：每条渲染出的消息块尾部挂一个隐形 HTML 注释标记
 *   `<!--nh:<完整 UUID>-->`
 * （阅读视图不渲染、只在源码模式可见；用完整 UUID → 零碰撞、精确）。
 * 去重 = 每次同步扫 body 收集已有标记集合，精确比对。frontmatter 里
 * **不再写 `syncedIds`**。
 *
 * 本用例模拟真实增量同步：同一天 8 次同步，每次只喂「本轮新增」的消息
 * （游标增量），断言跨 8 轮：
 *   - frontmatter 始终无 `syncedIds`（干净）
 *   - 每条消息带且仅带一个自己的标记
 *   - 无重复、无丢失（累计条数 == 去重后应有条数）
 *   - 增量幂等：重复喂同一批不新增
 *   - 跨批全局 DESC 排序（顶部=当天最新）
 */
import { Item } from '@omnivore-app/api'
import { MessageSortOrder } from '../src/settings'
import { MergeBatchItem } from '../src/sync/MergeProcessor'
import { parseFrontMatterFromContent } from '../src/util'
import { bloomAddId, bloomHasId, createBloomFilter } from '../src/compressIds'

// 期望的隐形标记线格式（观测契约，不依赖具体实现模块）
const MARKER_RE = /<!--nh:([0-9a-fA-F-]{36})-->/g

function markerFor(id: string): string {
  return `<!--nh:${id}-->`
}

function scanMarkers(content: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  MARKER_RE.lastIndex = 0
  while ((m = MARKER_RE.exec(content)) !== null) out.push(m[1])
  return out
}

function extractTimestamps(content: string): string[] {
  const re = /## (?:📅 )?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) out.push(m[1])
  return out
}

let uuidCounter = 100
function nextUuid(): string {
  // 合法 v4 形状的确定性 UUID（每条唯一）
  return `a1b2c3d4-0000-4000-8000-0000000${String(uuidCounter++).padStart(5, '0')}`
}

function makeWeChatItem(savedAt: string, id?: string): Item {
  return {
    id: id ?? nextUuid(),
    title: '同步助手_20260713_001_文本',
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

function makeMockContext(settings: Record<string, unknown> = {}) {
  // 全新的一天：空文件（无 frontmatter、无 body）
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
  }
  return ctx
}

const MOCK_FILE = {
  path: '笔记同步助手/2026-07-13/同步助手_2026-07-13.md',
  basename: '同步助手_2026-07-13',
} as any

// 一天 8 批，每批 2 条，时间从早到晚推进。模拟增量：第 k 次同步只拿第 k 批。
function buildEightBatches(): MergeBatchItem[][] {
  const hours = ['08', '09', '10', '11', '13', '14', '15', '16']
  return hours.map((h) => {
    const a = makeWeChatItem(`2026-07-13T${h}:05:00.000Z`)
    const b = makeWeChatItem(`2026-07-13T${h}:35:00.000Z`)
    return [a, b].map((item) => ({ item, content: '' }))
  })
}

async function newProcessor(ctx: unknown) {
  const { MergeProcessor } = await import('../src/sync/MergeProcessor')
  return new MergeProcessor(ctx as any)
}

describe('合并消息内联标记去重 · 一天 8 批增量', () => {
  it('每轮只写增量，8 轮后无重复无丢失，frontmatter 无 syncedIds', async () => {
    const ctx = makeMockContext()
    const processor = await newProcessor(ctx)
    const batches = buildEightBatches()

    const seenIds: string[] = []
    for (let k = 0; k < batches.length; k++) {
      // 一次同步 = 一次 processBatch（本轮新增的那批）
      await processor.processBatch(batches[k], MOCK_FILE)

      for (const bi of batches[k]) seenIds.push(bi.item.id)
      const content = ctx.getFileContent()

      // 1) frontmatter 干净：绝无 syncedIds
      const fm = (parseFrontMatterFromContent(content) ?? {}) as Record<string, unknown>
      expect(fm?.syncedIds).toBeUndefined()
      expect(content).not.toContain('syncedIds')

      // 2) 每条消息带且仅带一个自己的标记，累计条数正确（无重复无丢失）
      const markers = scanMarkers(content).sort()
      expect(markers).toEqual([...seenIds].sort())

      // 3) 时间戳条数 == 累计消息数
      expect(extractTimestamps(content).length).toBe(seenIds.length)
    }

    // 4) 跨 8 批全局 DESC（顶部=当天最新 16:35）
    const ts = extractTimestamps(ctx.getFileContent())
    const sortedDesc = [...ts].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    expect(ts).toEqual(sortedDesc)
    expect(ts[0]).toBe('2026-07-13 16:35:00')
    expect(ts[ts.length - 1]).toBe('2026-07-13 08:05:00')
  })

  it('增量幂等：重复喂同一批不新增（模拟游标边界项被重复返回）', async () => {
    const ctx = makeMockContext()
    const processor = await newProcessor(ctx)
    const batches = buildEightBatches()

    // 先同步前 3 批
    for (let k = 0; k < 3; k++) await processor.processBatch(batches[k], MOCK_FILE)
    const afterThree = ctx.getFileContent()
    const countThree = scanMarkers(afterThree).length
    expect(countThree).toBe(6)

    // 重复喂第 3 批（服务器按 updatedAt 增量常把边界项重复返回）→ 不新增
    await processor.processBatch(batches[2], MOCK_FILE)
    expect(scanMarkers(ctx.getFileContent()).length).toBe(6)
  })

  it('批内含已同步项（重叠增量）：只写真正的新项', async () => {
    const ctx = makeMockContext()
    const processor = await newProcessor(ctx)

    const m1 = makeWeChatItem('2026-07-13T08:05:00.000Z')
    const m2 = makeWeChatItem('2026-07-13T08:35:00.000Z')
    const m3 = makeWeChatItem('2026-07-13T09:05:00.000Z')
    const m4 = makeWeChatItem('2026-07-13T09:35:00.000Z')

    // 第 1 轮：m1, m2
    await processor.processBatch(
      [m1, m2].map((item) => ({ item, content: '' })),
      MOCK_FILE,
    )
    // 第 2 轮：m2(重叠), m3, m4 —— 只应新增 m3, m4
    await processor.processBatch(
      [m2, m3, m4].map((item) => ({ item, content: '' })),
      MOCK_FILE,
    )

    const markers = scanMarkers(ctx.getFileContent())
    expect(markers.sort()).toEqual([m1, m2, m3, m4].map((i) => i.id).sort())
    // m2 只出现一次
    expect(markers.filter((id) => id === m2.id).length).toBe(1)
  })

  it('迁移：旧文件(Bloom+无标记正文) → 重取的老消息不重复，新消息走精确标记', async () => {
    const OLD_ID = 'b0000000-0000-4000-8000-000000000001'
    const legacyBloom = bloomAddId(createBloomFilter(), OLD_ID)
    const ctx = makeMockContext()
    // 旧 plugin 落盘的文件：frontmatter 是 Bloom，正文里的老消息块【没有标记】
    ctx.setFileContent(
      '---\nsyncedIds: ' + legacyBloom + '\n---\n\n' +
      '---\n#### old\n## 📅 2026-07-12 09:00:00\nold body',
    )
    const processor = await newProcessor(ctx)

    const oldItem = makeWeChatItem('2026-07-12T09:00:00.000Z', OLD_ID) // 被重新拉取
    const newItem = makeWeChatItem('2026-07-13T08:05:00.000Z')        // 全新
    await processor.processBatch(
      [oldItem, newItem].map((item) => ({ item, content: '' })),
      MOCK_FILE,
    )

    const written = ctx.getFileContent()
    // 老消息（Bloom 命中）不被重复追加：仍只有一处 09:00:00
    expect(extractTimestamps(written).filter((t) => t === '2026-07-12 09:00:00').length).toBe(1)
    // 老消息没有内联标记（它靠 legacy Bloom 兜底去重）
    expect(written).not.toContain(markerFor(OLD_ID))
    // 新消息精确写入并带标记
    expect(written).toContain(markerFor(newItem.id))
    // legacy Bloom 被保留（迁移期老消息回退去重），且不含新消息
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(bloomHasId(fm.syncedIds as string, OLD_ID)).toBe(true)
    expect(bloomHasId(fm.syncedIds as string, newItem.id)).toBe(false)
  })

  it('标记是隐形 HTML 注释，且渲染正文里没有裸 UUID 噪音', async () => {
    const ctx = makeMockContext()
    const processor = await newProcessor(ctx)
    const item = makeWeChatItem('2026-07-13T08:05:00.000Z')

    await processor.processBatch([{ item, content: '' }], MOCK_FILE)
    const content = ctx.getFileContent()

    // 标记以 HTML 注释形态存在（阅读视图不渲染）
    expect(content).toContain(markerFor(item.id))
    // 除注释外，正文别的地方不该再撒裸 UUID
    const withoutMarkers = content.replace(MARKER_RE, '')
    expect(withoutMarkers).not.toContain(item.id)
  })
})
