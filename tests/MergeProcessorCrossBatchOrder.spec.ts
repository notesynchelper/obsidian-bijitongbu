/**
 * 跨批次（跨分页）合并排序回归测试
 *
 * 复现真实事故（2026-06-02，data21.json，mergeMode=messages，desc）：
 * 用户「合并消息只显示到 11 点、下午没拉到」。真因不是丢消息，而是
 * MergeProcessor 跨分页拼接顺序错乱：
 *
 *   - 设置「新消息在上」(DESC)，但服务器对 `sort:saved-asc` 实际返回
 *     **newest-first 分页**（asc 被忽略）。
 *   - 旧 main.ts 在 `for (after...)` 循环里**每分页**调一次
 *     `processBatch`，每批整块 desc 排序后 prepend 到 body。
 *   - 结果：page1(最新 15:07→13:13) 先写 → page2(13:05→11:05) 整块压上面
 *     → page3(最老 10:57→08:24) 再压最上面 = 三个 desc 块「老块在上」堆叠，
 *     文件顶部是 10:57，当天最新 15:07 被埋在中段。
 *
 * 修法（用户拍板）：**不能每批独立 prepend**，应累积全部分页的 item 后
 * 调一次 `processBatch`（每个文件只写一次，内部 sortItems 即全局排序）。
 * 生产侧由 `flushMergeGroups` 封装这一「累积后一次性写入」语义，main.ts 把
 * 所有分页的 merge item 收进同一个 Map，循环结束后再 flush 一次。
 *
 * 附带收益：`processBatch` 的去重是对「文件起始 filter」判定、add 在之后
 * （见 MergeProcessorBatch.spec.ts TC10b），所以「累积后一次写入」时全部
 * item 都对同一份起始 filter 判重，**消除了旧的逐页增量 filter 造成的
 * 同轮 FP 丢消息**（真实事故里 10:01 那条就是逐页累积 filter 撞 FP 被丢的）。
 */
import { Item } from '@omnivore-app/api'
import { createBloomFilter, bloomAddId, bloomHasId } from '../src/compressIds'
import { MessageSortOrder } from '../src/settings'
import {
  MergeBatchItem,
  MergeGroup,
  flushMergeGroups,
} from '../src/sync/MergeProcessor'
import { parseFrontMatterFromContent, removeFrontMatterFromContent } from '../src/util'
import { stringifyYaml } from 'obsidian'

// 几个固定 UUID：FP_A + FP_B 已入 filter 后，FP_C 是它们的假阳性（k=4/264bit）
const UUID = {
  FP_A: '10b5eea8-c5db-5fa4-d111-1687590132dc',
  FP_B: '2fd04082-c87b-d539-1d1d-a8d50d09dc93',
  FP_C: '95135927-f51c-4b7a-1130-b4150387a624',
}

let uuidCounter = 200
function nextUuid(): string {
  return `f47ac10b-58cc-4372-a567-0e02b2c3d${String(uuidCounter++).padStart(3, '0')}`
}

function makeWeChatItem(savedAt: string, id?: string): Item {
  return {
    id: id ?? nextUuid(),
    title: '同步助手_20260602_001_文本',
    savedAt,
    content: `msg at ${savedAt}`,
    url: 'https://example.com',
    slug: 'test',
    labels: [],
    highlights: [],
    updatedAt: savedAt,
  } as unknown as Item
}

function makeMockContext(settings: Record<string, unknown> = {}) {
  let fileContent = ''
  const ctx = {
    settings: {
      messageSortOrder: MessageSortOrder.DESC,
      dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
      wechatMessageTemplate: '---\n#### {{{heading}}}\n## {{{dateSaved}}}\n{{{content}}}',
      sectionSeparator: '',
      sectionSeparatorEnd: '',
      ...settings,
    },
    app: {
      vault: {
        process: jest.fn(async (_file: unknown, fn: (data: string) => string) => {
          const result = fn(fileContent)
          fileContent = result
          return result
        }),
      },
    },
    successTracker: { recordSuccess: jest.fn() },
    diaryLinkProcessor: { addLink: jest.fn() },
    enqueueFileForImageLocalization: jest.fn(async () => {}),
    enqueueFileForAttachmentLocalization: jest.fn(async () => {}),
    addProcessedFile: jest.fn(),
    imageLocalizer: null,
    setFileContent(content: string) {
      fileContent = content
    },
    getFileContent() {
      return fileContent
    },
  }
  return ctx
}

const MOCK_FILE = { path: '笔记同步助手/2026-06-02/同步助手_2026-06-02.md', basename: '同步助手_2026-06-02' } as any

function extractTimestamps(content: string): string[] {
  const re = /## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g
  const matches: string[] = []
  let m
  while ((m = re.exec(content)) !== null) matches.push(m[1])
  return matches
}

// 服务器 newest-first 分页：page1 最新，page3 最老（镜像真实事故时间段）
function buildNewestFirstPages(): MergeBatchItem[][] {
  const page1 = [
    makeWeChatItem('2026-06-02T15:07:13.000Z'),
    makeWeChatItem('2026-06-02T14:30:00.000Z'),
    makeWeChatItem('2026-06-02T13:13:00.000Z'),
  ]
  const page2 = [
    makeWeChatItem('2026-06-02T13:05:00.000Z'),
    makeWeChatItem('2026-06-02T12:00:00.000Z'),
    makeWeChatItem('2026-06-02T11:05:00.000Z'),
  ]
  const page3 = [
    makeWeChatItem('2026-06-02T10:57:08.000Z'),
    makeWeChatItem('2026-06-02T09:30:00.000Z'),
    makeWeChatItem('2026-06-02T08:24:00.000Z'),
  ]
  return [page1, page2, page3].map(p => p.map(item => ({ item, content: '' })))
}

const EXPECTED_DESC = [
  '2026-06-02 15:07:13',
  '2026-06-02 14:30:00',
  '2026-06-02 13:13:00',
  '2026-06-02 13:05:00',
  '2026-06-02 12:00:00',
  '2026-06-02 11:05:00',
  '2026-06-02 10:57:08',
  '2026-06-02 09:30:00',
  '2026-06-02 08:24:00',
]

describe('跨分页合并排序（flushMergeGroups 累积后一次写入）', () => {
  it('REGRESSION: 累积全部分页 item 后 flush 一次 → 文件全局 DESC（顶部=最新 15:07）', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    // main.ts 的新行为：所有分页的 item 收进同一个 group，循环结束后 flush 一次
    const groups = new Map<string, MergeGroup>()
    for (const page of buildNewestFirstPages()) {
      for (const bi of page) {
        const g = groups.get(MOCK_FILE.path)
          ?? groups.set(MOCK_FILE.path, { file: MOCK_FILE, items: [] }).get(MOCK_FILE.path)!
        g.items.push(bi)
      }
    }
    await flushMergeGroups(processor, groups.values())

    // 每个文件只应写一次
    expect(ctx.app.vault.process).toHaveBeenCalledTimes(1)
    expect(extractTimestamps(ctx.getFileContent())).toEqual(EXPECTED_DESC)
  })

  it('CHARACTERIZATION: 旧行为「每分页各调一次 processBatch」会把老块堆在顶部（顶部=10:57，错）', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    for (const page of buildNewestFirstPages()) {
      await processor.processBatch(page, MOCK_FILE)
    }

    const ts = extractTimestamps(ctx.getFileContent())
    // bug 表现：顶部是最老页(page3)的 10:57，而非全局最新 15:07
    expect(ts[0]).toBe('2026-06-02 10:57:08')
    expect(ts).not.toEqual(EXPECTED_DESC)
  })

  it('ASC：累积后一次 flush → 文件全局 ASC（顶部=最老 08:24）', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.ASC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const groups = new Map<string, MergeGroup>()
    for (const page of buildNewestFirstPages()) {
      for (const bi of page) {
        const g = groups.get(MOCK_FILE.path)
          ?? groups.set(MOCK_FILE.path, { file: MOCK_FILE, items: [] }).get(MOCK_FILE.path)!
        g.items.push(bi)
      }
    }
    await flushMergeGroups(processor, groups.values())

    expect(extractTimestamps(ctx.getFileContent())).toEqual([...EXPECTED_DESC].reverse())
  })

  it('内联标记天然无假阳性：曾互为 Bloom FP 的三条都精确写入', async () => {
    // 自检：FP_A + FP_B 入 Bloom 后，FP_C 是它们的假阳性——旧 Bloom 去重会丢 FP_C；
    // 内联标记按完整 id 精确比对，不存在这个问题。
    const probe = bloomAddId(bloomAddId(createBloomFilter(), UUID.FP_A), UUID.FP_B)
    expect(bloomHasId(probe, UUID.FP_C)).toBe(true)

    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const pageA: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-06-02T10:00:00.000Z', UUID.FP_A), content: '' },
      { item: makeWeChatItem('2026-06-02T10:05:00.000Z', UUID.FP_B), content: '' },
    ]
    const pageB: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-06-02T10:10:00.000Z', UUID.FP_C), content: '' },
    ]
    const groups = new Map<string, MergeGroup>()
    for (const page of [pageA, pageB]) {
      for (const bi of page) {
        const g = groups.get(MOCK_FILE.path)
          ?? groups.set(MOCK_FILE.path, { file: MOCK_FILE, items: [] }).get(MOCK_FILE.path)!
        g.items.push(bi)
      }
    }
    await flushMergeGroups(processor, groups.values())

    const written = ctx.getFileContent()
    // 三条各带内联标记，FP_C 没被 Bloom 假阳性丢掉；frontmatter 不再写 syncedIds
    expect(written).toContain(`<!--nh:${UUID.FP_A}-->`)
    expect(written).toContain(`<!--nh:${UUID.FP_B}-->`)
    expect(written).toContain(`<!--nh:${UUID.FP_C}-->`)
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(fm?.syncedIds).toBeUndefined()
    expect(extractTimestamps(written)).toEqual([
      '2026-06-02 10:10:00',
      '2026-06-02 10:05:00',
      '2026-06-02 10:00:00',
    ])
  })

  it('flushMergeGroups：processBatch 抛错时回退逐条 process', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const batchSpy = jest.spyOn(processor, 'processBatch')
    const processSpy = jest.spyOn(processor, 'process').mockResolvedValue()
    // 第一次（批量）抛错，回退路径里逐条 process 也会再次进 processBatch；
    // 用 mockImplementationOnce 只让首个批量调用失败
    batchSpy.mockImplementationOnce(async () => { throw new Error('boom') })

    const item = makeWeChatItem('2026-06-02T10:00:00.000Z')
    const groups: MergeGroup[] = [{ file: MOCK_FILE, items: [{ item, content: '' }] }]
    const errors: string[] = []
    await flushMergeGroups(processor, groups, (p) => errors.push(p))

    expect(errors).toContain(MOCK_FILE.path)
    expect(processSpy).toHaveBeenCalledWith(item, MOCK_FILE, '')
  })
})
