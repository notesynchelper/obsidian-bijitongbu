import { Item } from '@omnivore-app/api'
import { createBloomFilter, bloomAddId, bloomHasId } from '../src/compressIds'
import { MessageSortOrder } from '../src/settings'
import { sortItems, MergeBatchItem } from '../src/sync/MergeProcessor'
import {
  parseFrontMatterFromContent,
  removeFrontMatterFromContent,
  formatDate,
} from '../src/util'
import { stringifyYaml } from 'obsidian'

// --- Fixed UUIDs for test items (bloom filter requires valid UUIDs) ---
const UUID = {
  W0: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  W1: '550e8400-e29b-41d4-a716-446655440001',
  W2: '550e8400-e29b-41d4-a716-446655440002',
  W3: '550e8400-e29b-41d4-a716-446655440003',
  W4: 'f47ac10b-58cc-4372-a567-0e02b2c3d004',
  W5: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  FP1: '10b5eea8-c5db-5fa4-d111-1687590132dc',
  FP2: '2fd04082-c87b-d539-1d1d-a8d50d09dc93',
  FP3: '95135927-f51c-4b7a-1130-b4150387a624',
  A1: '6ba7b810-9dad-11d1-80b4-00c04fd43001',
  A2: '6ba7b810-9dad-11d1-80b4-00c04fd43002',
}

// --- Factories ---

let uuidCounter = 100
function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: overrides.id ?? `f47ac10b-58cc-4372-a567-0e02b2c3d${String(uuidCounter++).padStart(3, '0')}`,
    title: overrides.title ?? '同步助手_20260323_001_文本',
    savedAt: overrides.savedAt ?? '2026-03-23T10:00:00.000Z',
    content: overrides.content ?? 'test content',
    url: 'https://example.com',
    slug: 'test',
    labels: [],
    highlights: [],
    updatedAt: overrides.savedAt ?? '2026-03-23T10:00:00.000Z',
    ...overrides,
  } as Item
}

function makeWeChatItem(savedAt: string, id: string, content?: string): Item {
  return makeItem({
    id,
    title: `同步助手_20260323_001_文本`,
    savedAt,
    content: content ?? `msg at ${savedAt}`,
  })
}

function makeArticleItem(savedAt: string, id: string): Item {
  return makeItem({
    id,
    title: `Regular Article ${savedAt}`,
    savedAt,
    content: `article content at ${savedAt}`,
  })
}

// Minimal mock for SyncContext
function makeMockContext(settings: Record<string, unknown> = {}) {
  let fileContent = ''
  return {
    fileContent,
    settings: {
      messageSortOrder: MessageSortOrder.DESC,
      dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
      wechatMessageTemplate:
        '---\n#### {{{heading}}}\n## {{{dateSaved}}}\n{{{content}}}',
      sectionSeparator: '',
      sectionSeparatorEnd: '',
      ...settings,
    },
    app: {
      vault: {
        read: jest.fn(async () => fileContent),
        modify: jest.fn(async (_file: unknown, content: string) => {
          fileContent = content
        }),
        process: jest.fn(async (_file: unknown, fn: (data: string) => string) => {
          const result = fn(fileContent)
          fileContent = result
          return result
        }),
      },
      fileManager: {
        processFrontMatter: jest.fn(async (_file: unknown, fn: (fm: Record<string, unknown>) => void) => {
          const rawFm = parseFrontMatterFromContent(fileContent) ?? {}
          const parsedFm = (Array.isArray(rawFm) ? { messages: rawFm } : rawFm) as Record<string, unknown>
          fn(parsedFm)
          const body = removeFrontMatterFromContent(fileContent)
          fileContent = `---\n${stringifyYaml(parsedFm)}---\n\n${body}`
        }),
      },
    },
    successTracker: { recordSuccess: jest.fn() },
    diaryLinkProcessor: { addLink: jest.fn() },
    enqueueFileForImageLocalization: jest.fn(async () => {}),
    enqueueFileForAttachmentLocalization: jest.fn(async () => {}),
    addProcessedFile: jest.fn(),
    setFileContent(content: string) {
      fileContent = content
      this.app.vault.read.mockImplementation(async () => fileContent)
    },
    getFileContent() {
      return fileContent
    },
  }
}

const MOCK_FILE = { path: 'test/merge.md', basename: 'merge' } as any

// 内联标记去重（方案 A）：消息块尾挂 <!--nh:id-->，取代 frontmatter 的 Bloom syncedIds。
function hasMarker(content: string, id: string): boolean {
  return content.includes(`<!--nh:${id}-->`)
}

// Helper: extract message order from file content by matching dateSaved timestamps
function extractTimestamps(content: string): string[] {
  const re = /## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g
  const matches: string[] = []
  let m
  while ((m = re.exec(content)) !== null) {
    matches.push(m[1])
  }
  return matches
}

describe('MergeProcessor.processBatch', () => {
  it('placeholder', () => {
    expect(true).toBe(true)
  })
})

describe('processBatch - WeChat messages', () => {
  it('TC1: DESC - 3 messages into empty file -> newest first', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'msg1'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W2, 'msg2'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:10:00.000Z', UUID.W3, 'msg3'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    const timestamps = extractTimestamps(written)
    expect(timestamps).toEqual([
      '2026-03-23 10:10:00',
      '2026-03-23 10:05:00',
      '2026-03-23 10:00:00',
    ])
  })

  it('TC2: ASC - 3 messages into empty file -> oldest first', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.ASC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'msg1'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W2, 'msg2'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:10:00.000Z', UUID.W3, 'msg3'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const timestamps = extractTimestamps(ctx.getFileContent())
    expect(timestamps).toEqual([
      '2026-03-23 10:00:00',
      '2026-03-23 10:05:00',
      '2026-03-23 10:10:00',
    ])
  })

  it('TC3: DESC - batch merge with existing content', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    const existingFilter = bloomAddId(createBloomFilter(), UUID.W0)
    ctx.setFileContent(
      '---\nsyncedIds: ' + existingFilter + '\n---\n\n' +
      '---\n#### existing\n## 2026-03-23 09:00:00\nold msg'
    )
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'msg1'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W2, 'msg2'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:10:00.000Z', UUID.W3, 'msg3'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const timestamps = extractTimestamps(ctx.getFileContent())
    expect(timestamps).toEqual([
      '2026-03-23 10:10:00',
      '2026-03-23 10:05:00',
      '2026-03-23 10:00:00',
      '2026-03-23 09:00:00',
    ])
  })

  it('TC4: ASC - batch merge with existing content', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.ASC })
    const existingFilter = bloomAddId(createBloomFilter(), UUID.W0)
    ctx.setFileContent(
      '---\nsyncedIds: ' + existingFilter + '\n---\n\n' +
      '---\n#### existing\n## 2026-03-23 09:00:00\nold msg'
    )
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'msg1'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W2, 'msg2'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:10:00.000Z', UUID.W3, 'msg3'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const timestamps = extractTimestamps(ctx.getFileContent())
    expect(timestamps).toEqual([
      '2026-03-23 09:00:00',
      '2026-03-23 10:00:00',
      '2026-03-23 10:05:00',
      '2026-03-23 10:10:00',
    ])
  })

  it('TC5: DESC - unordered input still produces correct order', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W2, 'msg2'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'msg1'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:10:00.000Z', UUID.W3, 'msg3'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const timestamps = extractTimestamps(ctx.getFileContent())
    expect(timestamps).toEqual([
      '2026-03-23 10:10:00',
      '2026-03-23 10:05:00',
      '2026-03-23 10:00:00',
    ])
  })

  it('TC8: empty batch is a no-op', async () => {
    const ctx = makeMockContext()
    const originalContent = '---\nsyncedIds: ' + createBloomFilter() + '\n---\n\noriginal'
    ctx.setFileContent(originalContent)
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    await processor.processBatch([], MOCK_FILE)

    expect(ctx.app.vault.process).not.toHaveBeenCalled()
    expect(ctx.app.fileManager.processFrontMatter).not.toHaveBeenCalled()
  })
})

describe('processBatch - dedup and bloom filter', () => {
  it('TC7: skips already-synced messages, writes only new ones', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    const filter = bloomAddId(createBloomFilter(), UUID.W0)
    ctx.setFileContent(
      '---\nsyncedIds: ' + filter + '\n---\n\n' +
      '---\n#### existing\n## 2026-03-23 10:00:00\nexisting msg'
    )
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W0, 'existing msg'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W1, 'new msg'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    const timestamps = extractTimestamps(written)
    expect(timestamps).toEqual([
      '2026-03-23 10:05:00',
      '2026-03-23 10:00:00',
    ])
  })

  it('TC9: all duplicates -> frontmatter updated but content unchanged', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    let filter = createBloomFilter()
    filter = bloomAddId(filter, UUID.W1)
    filter = bloomAddId(filter, UUID.W2)
    ctx.setFileContent(
      '---\nsyncedIds: ' + filter + '\n---\n\n' +
      '---\n#### msg1\n## 2026-03-23 10:00:00\nmsg1\n\n' +
      '---\n#### msg2\n## 2026-03-23 10:05:00\nmsg2'
    )
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'msg1'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W2, 'msg2'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const timestamps = extractTimestamps(ctx.getFileContent())
    expect(timestamps).toEqual([
      '2026-03-23 10:00:00',
      '2026-03-23 10:05:00',
    ])
  })

  it('TC10: 内联标记精确记录全部新 id，frontmatter 无 syncedIds', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1), content: '' },
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W2), content: '' },
      { item: makeWeChatItem('2026-03-23T10:10:00.000Z', UUID.W3), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    // 内联标记精确记录全部新 id（取代 Bloom，零假阳性）
    expect(hasMarker(written, UUID.W1)).toBe(true)
    expect(hasMarker(written, UUID.W2)).toBe(true)
    expect(hasMarker(written, UUID.W3)).toBe(true)
    // 纯消息文件（seed 的是空 Bloom）→ frontmatter 不再写 syncedIds
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(fm?.syncedIds).toBeUndefined()
  })

  it('TC10b: same-batch messages are not dropped by an incremental bloom false positive', async () => {
    let incremental = createBloomFilter()
    incremental = bloomAddId(incremental, UUID.FP1)
    incremental = bloomAddId(incremental, UUID.FP2)
    expect(bloomHasId(incremental, UUID.FP3)).toBe(true)

    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.FP1, 'fp1'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.FP2, 'fp2'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:10:00.000Z', UUID.FP3, 'fp3'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    expect(written).toContain('fp1')
    expect(written).toContain('fp2')
    expect(written).toContain('fp3')
  })
})

describe('process() backward compatibility', () => {
  it('TC6: single item via process() produces same output as processBatch([item])', async () => {
    const ctx1 = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx1.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const ctx2 = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx2.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')

    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor1 = new MergeProcessor(ctx1 as any)
    const processor2 = new MergeProcessor(ctx2 as any)

    const item = makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'test content')

    await processor1.process(item, MOCK_FILE, '')
    await processor2.processBatch([{ item, content: '' }], MOCK_FILE)

    expect(ctx1.getFileContent()).toEqual(ctx2.getFileContent())
  })
})

describe('sortItems', () => {
  const items: MergeBatchItem[] = [
    { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W2), content: '' },
    { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1), content: '' },
    { item: makeWeChatItem('2026-03-23T10:10:00.000Z', UUID.W3), content: '' },
  ]

  it('TC1/TC5: DESC sorts newest first', () => {
    const sorted = sortItems(items, MessageSortOrder.DESC)
    const times = sorted.map(i => i.item.savedAt)
    expect(times).toEqual([
      '2026-03-23T10:10:00.000Z',
      '2026-03-23T10:05:00.000Z',
      '2026-03-23T10:00:00.000Z',
    ])
  })

  it('TC2: ASC sorts oldest first', () => {
    const sorted = sortItems(items, MessageSortOrder.ASC)
    const times = sorted.map(i => i.item.savedAt)
    expect(times).toEqual([
      '2026-03-23T10:00:00.000Z',
      '2026-03-23T10:05:00.000Z',
      '2026-03-23T10:10:00.000Z',
    ])
  })

  it('does not mutate original array', () => {
    const original = [...items]
    sortItems(items, MessageSortOrder.DESC)
    expect(items.map(i => i.item.savedAt)).toEqual(original.map(i => i.item.savedAt))
  })
})

describe('processBatch - mixed types', () => {
  it('TC11: mixed WeChat messages and regular article in same batch', async () => {
    const ctx = makeMockContext({
      messageSortOrder: MessageSortOrder.DESC,
      sectionSeparator: '',
      sectionSeparatorEnd: '',
    })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const articleContent = '---\nid: ' + UUID.A1 + '\n---\n\narticle body'
    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'wechat msg 1'), content: '' },
      { item: makeArticleItem('2026-03-23T10:05:00.000Z', UUID.A1), content: articleContent },
      { item: makeWeChatItem('2026-03-23T10:10:00.000Z', UUID.W2, 'wechat msg 2'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    // WeChat messages should be rendered (check for their timestamps)
    expect(written).toContain('2026-03-23 10:10:00')
    expect(written).toContain('2026-03-23 10:00:00')
    // Article body should be present
    expect(written).toContain('article body')
    // All 3 items tracked
    expect(ctx.successTracker.recordSuccess).toHaveBeenCalledTimes(3)
  })
})

describe('processBatch - error handling', () => {
  it('TC12: batch failure falls back to one-by-one process()', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    const initialContent = '---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n'
    ctx.setFileContent(initialContent)
    // Re-wire vault.read to always return the live fileContent so sequential
    // process() calls each see the latest written state
    ctx.app.vault.read.mockImplementation(async () => ctx.getFileContent())
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'msg1'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W2, 'msg2'), content: '' },
    ]

    // Mock processBatch to throw on first call, then restore
    const originalProcessBatch = processor.processBatch.bind(processor)
    let callCount = 0
    processor.processBatch = async (...args: Parameters<typeof processor.processBatch>) => {
      callCount++
      if (callCount === 1) throw new Error('Simulated batch failure')
      return originalProcessBatch(...args)
    }

    // Simulate the call-site fallback pattern from main.ts Phase 2
    try {
      await processor.processBatch(items, MOCK_FILE)
    } catch {
      // Fallback: process items one-by-one
      for (const { item, content } of items) {
        await processor.process(item, MOCK_FILE, content)
      }
    }

    // Both items should be tracked via individual process() calls
    expect(ctx.successTracker.recordSuccess).toHaveBeenCalledTimes(2)
    const written = ctx.getFileContent()
    expect(written).toContain('msg1')
    expect(written).toContain('msg2')
  })
})

describe('processBatch - frontmatter preservation', () => {
  it('preserves user-customized frontmatter properties after sync', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    const initialFilter = createBloomFilter()
    // File with user-customized properties: tags, cssclass, aliases
    ctx.setFileContent(
      '---\nsyncedIds: ' + initialFilter + '\ntags:\n  - journal\n  - wechat\ncssclass: custom-note\naliases:\n  - my-merge\n---\n\nold content'
    )
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'new msg'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    // 新消息用内联标记记录（frontmatter 不再写 syncedIds）
    expect(hasMarker(written, UUID.W1)).toBe(true)
    expect(fm?.syncedIds).toBeUndefined()
    // User properties should be preserved
    expect(fm.tags).toEqual(['journal', 'wechat'])
    expect(fm.cssclass).toBe('custom-note')
    expect(fm.aliases).toEqual(['my-merge'])
    // New message should be in content
    expect(written).toContain('new msg')
  })

  it('removes legacy messages field via processFrontMatter', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    // File with legacy messages array
    ctx.setFileContent(
      '---\nmessages:\n  - id: ' + UUID.W0 + '\n---\n\nold content'
    )
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeWeChatItem('2026-03-23T10:00:00.000Z', UUID.W1, 'new msg'), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    // 旧 messages 字段被清掉
    expect(fm.messages).toBeUndefined()
    // 新消息 W1 用内联标记
    expect(hasMarker(written, UUID.W1)).toBe(true)
    // 迁移：旧 messages 转成的 legacy Bloom 保留（作迁移前老消息的回退去重），
    // 仍去重得到 W0；新消息不再往 Bloom 里加。
    expect(fm.syncedIds).toBeDefined()
    expect(bloomHasId(fm.syncedIds as string, UUID.W0)).toBe(true)
  })
})

describe('processBatch - cross-batch ordering', () => {
  it('DESC: batch1=[10:05,10:07] batch2=[10:13] -> 13,7,5', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    // Batch 1
    await processor.processBatch([
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W1, 'msg05'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:07:00.000Z', UUID.W2, 'msg07'), content: '' },
    ], MOCK_FILE)

    // Batch 2 (use W5 to avoid bloom filter collision with W1/W2)
    await processor.processBatch([
      { item: makeWeChatItem('2026-03-23T10:13:00.000Z', UUID.W5, 'msg13'), content: '' },
    ], MOCK_FILE)

    const timestamps = extractTimestamps(ctx.getFileContent())
    expect(timestamps).toEqual([
      '2026-03-23 10:13:00',
      '2026-03-23 10:07:00',
      '2026-03-23 10:05:00',
    ])
  })

  it('ASC: batch1=[10:05,10:07] batch2=[10:13] -> 5,7,13', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.ASC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    await processor.processBatch([
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W1, 'msg05'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:07:00.000Z', UUID.W2, 'msg07'), content: '' },
    ], MOCK_FILE)

    await processor.processBatch([
      { item: makeWeChatItem('2026-03-23T10:13:00.000Z', UUID.W5, 'msg13'), content: '' },
    ], MOCK_FILE)

    const timestamps = extractTimestamps(ctx.getFileContent())
    expect(timestamps).toEqual([
      '2026-03-23 10:05:00',
      '2026-03-23 10:07:00',
      '2026-03-23 10:13:00',
    ])
  })

  it('DESC: batch1=[10:05,10:07] batch2=[10:04] -> 4,7,5 (batch arrival order)', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.DESC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    await processor.processBatch([
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W1, 'msg05'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:07:00.000Z', UUID.W2, 'msg07'), content: '' },
    ], MOCK_FILE)

    await processor.processBatch([
      { item: makeWeChatItem('2026-03-23T10:04:00.000Z', UUID.W4, 'msg04'), content: '' },
    ], MOCK_FILE)

    const timestamps = extractTimestamps(ctx.getFileContent())
    expect(timestamps).toEqual([
      '2026-03-23 10:04:00',
      '2026-03-23 10:07:00',
      '2026-03-23 10:05:00',
    ])
  })

  it('ASC: batch1=[10:05,10:07] batch2=[10:04] -> 5,7,4 (batch arrival order)', async () => {
    const ctx = makeMockContext({ messageSortOrder: MessageSortOrder.ASC })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    await processor.processBatch([
      { item: makeWeChatItem('2026-03-23T10:05:00.000Z', UUID.W1, 'msg05'), content: '' },
      { item: makeWeChatItem('2026-03-23T10:07:00.000Z', UUID.W2, 'msg07'), content: '' },
    ], MOCK_FILE)

    await processor.processBatch([
      { item: makeWeChatItem('2026-03-23T10:04:00.000Z', UUID.W4, 'msg04'), content: '' },
    ], MOCK_FILE)

    const timestamps = extractTimestamps(ctx.getFileContent())
    expect(timestamps).toEqual([
      '2026-03-23 10:05:00',
      '2026-03-23 10:07:00',
      '2026-03-23 10:04:00',
    ])
  })
})

// --- Real user data tests (真实企微消息样本) ---
// 用 formatDate 动态计算期望时间戳，测试在任何时区下都正确
// 用户 Obsidian 运行在 UTC+8 (Asia/Shanghai)，jest 运行在 UTC
describe('processBatch - real user data', () => {
  const REAL = {
    item1: {
      id: 'ec1da259-3457-4b6c-a824-bb0e5f44e846',
      title: '同步助手_20260330_1_文本',
      savedAt: '2026-03-30T09:42:19.801999+00:00',
      content: '1',
    },
    item2: {
      id: 'efdc45a0-7a20-46bb-b549-32bf89d97cf1',
      title: '同步助手_20260330_2_文本',
      savedAt: '2026-03-30T09:42:24.611401+00:00',
      content: '2',
    },
    item3: {
      id: 'dc9ca0ac-ee0d-45f3-bffd-a14ee348ab77',
      title: '同步助手_20260330_3_文本',
      savedAt: '2026-03-30T09:42:56.115386+00:00',
      content: '3',
    },
  }

  // 用 formatDate 计算本地时区下的期望时间戳（与生产代码一致）
  const DATE_FMT = 'yyyy-MM-dd HH:mm:ss'
  const ts1 = formatDate(REAL.item1.savedAt, DATE_FMT)
  const ts2 = formatDate(REAL.item2.savedAt, DATE_FMT)
  const ts3 = formatDate(REAL.item3.savedAt, DATE_FMT)

  function makeRealItem(data: typeof REAL.item1): Item {
    return makeItem({
      ...data,
      url: '',
      slug: '',
      labels: [],
      highlights: [],
      updatedAt: data.savedAt,
    })
  }

  // 匹配带或不带 📅 emoji 的 timestamp
  function extractTimestampsWithEmoji(content: string): string[] {
    const re = /## (?:📅 )?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g
    const matches: string[] = []
    let m
    while ((m = re.exec(content)) !== null) {
      matches.push(m[1])
    }
    return matches
  }

  it('TC-Real-1: DESC - Phase D side-effects with 3 real WeChat messages', async () => {
    const prodTemplate = '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}'
    const ctx = makeMockContext({
      messageSortOrder: MessageSortOrder.DESC,
      wechatMessageTemplate: prodTemplate,
    })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeRealItem(REAL.item1), content: '' },
      { item: makeRealItem(REAL.item2), content: '' },
      { item: makeRealItem(REAL.item3), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    console.log('=== TC-Real-1 DESC output ===\n' + written)
    // 注：jest TZ=UTC 显示 09:42:xx，用户 Obsidian TZ=Asia/Shanghai 显示 17:42:xx

    // Phase B/C: 消息顺序 3→2→1 (DESC)
    const timestamps = extractTimestampsWithEmoji(written)
    expect(timestamps).toEqual([ts3, ts2, ts1])

    // Phase B/C: 内联标记记录 3 个真实 UUID，frontmatter 无 syncedIds
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(hasMarker(written, REAL.item1.id)).toBe(true)
    expect(hasMarker(written, REAL.item2.id)).toBe(true)
    expect(hasMarker(written, REAL.item3.id)).toBe(true)
    expect(fm?.syncedIds).toBeUndefined()

    // Phase D: enqueueFileForImageLocalization 调用 1 次，meta 取首条 input item
    // (旧实现传 savedAt 字符串；新实现传 itemToLocalizerMeta(items[0].item)，
    // 至少含 savedAt + id；显式钉 savedAt 字段确认 owner item 选对)
    expect(ctx.enqueueFileForImageLocalization).toHaveBeenCalledTimes(1)
    expect(ctx.enqueueFileForImageLocalization).toHaveBeenCalledWith(
      MOCK_FILE,
      expect.objectContaining({ savedAt: REAL.item1.savedAt, id: REAL.item1.id }),
    )

    // Phase D: enqueueFileForAttachmentLocalization 调用 1 次
    expect(ctx.enqueueFileForAttachmentLocalization).toHaveBeenCalledTimes(1)
    expect(ctx.enqueueFileForAttachmentLocalization).toHaveBeenCalledWith(
      MOCK_FILE,
      expect.objectContaining({ savedAt: REAL.item1.savedAt, id: REAL.item1.id }),
    )

    // Phase D: addProcessedFile 调用 1 次
    expect(ctx.addProcessedFile).toHaveBeenCalledTimes(1)
    expect(ctx.addProcessedFile).toHaveBeenCalledWith(MOCK_FILE)

    // Phase D: recordSuccess 调用 3 次，传入各自的真实 UUID
    expect(ctx.successTracker.recordSuccess).toHaveBeenCalledTimes(3)
    expect(ctx.successTracker.recordSuccess).toHaveBeenCalledWith(REAL.item1.id)
    expect(ctx.successTracker.recordSuccess).toHaveBeenCalledWith(REAL.item2.id)
    expect(ctx.successTracker.recordSuccess).toHaveBeenCalledWith(REAL.item3.id)

    // Phase D: diaryLinkProcessor.addLink 调用 3 次，anchor = heading = content 前 10 字
    expect(ctx.diaryLinkProcessor.addLink).toHaveBeenCalledTimes(3)
    expect(ctx.diaryLinkProcessor.addLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: REAL.item1.id }), MOCK_FILE.basename, '1'
    )
    expect(ctx.diaryLinkProcessor.addLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: REAL.item2.id }), MOCK_FILE.basename, '2'
    )
    expect(ctx.diaryLinkProcessor.addLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: REAL.item3.id }), MOCK_FILE.basename, '3'
    )
  })

  it('TC-Real-2: DESC - only 2 messages (matches user Obsidian output)', async () => {
    const prodTemplate = '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}'
    const ctx = makeMockContext({
      messageSortOrder: MessageSortOrder.DESC,
      wechatMessageTemplate: prodTemplate,
    })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    // 仅同步 msg1 和 msg2（与用户 Obsidian 实际同步结果一致）
    const items: MergeBatchItem[] = [
      { item: makeRealItem(REAL.item1), content: '' },
      { item: makeRealItem(REAL.item2), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    console.log('=== TC-Real-2 matches Obsidian output ===\n' + written)

    // 与用户在 Obsidian 中看到的一致：DESC 顺序 2→1
    const timestamps = extractTimestampsWithEmoji(written)
    expect(timestamps).toEqual([ts2, ts1])

    // heading 和 content 正确
    expect(written).toContain('#### 2')
    expect(written).toContain('#### 1')
    expect(written).not.toContain('#### 3')
  })

  it('TC-Real-3: shuffled input - batchSavedAt uses first input item, not sorted', async () => {
    const prodTemplate = '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}'
    const ctx = makeMockContext({
      messageSortOrder: MessageSortOrder.DESC,
      wechatMessageTemplate: prodTemplate,
    })
    ctx.setFileContent('---\nsyncedIds: ' + createBloomFilter() + '\n---\n\n')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    // 乱序输入: msg3, msg1, msg2
    const items: MergeBatchItem[] = [
      { item: makeRealItem(REAL.item3), content: '' },
      { item: makeRealItem(REAL.item1), content: '' },
      { item: makeRealItem(REAL.item2), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    // 消息体排序仍然正确 (DESC: 3→2→1)
    const timestamps = extractTimestampsWithEmoji(ctx.getFileContent())
    expect(timestamps).toEqual([ts3, ts2, ts1])

    // batchMeta 来源 = batchItems[0].item = msg3（未排序数组第一个，不是 sort 后的）
    // 钉 savedAt + id 两个字段确认是 input 顺序而非 sort 顺序选 owner
    expect(ctx.enqueueFileForImageLocalization).toHaveBeenCalledWith(
      MOCK_FILE,
      expect.objectContaining({ savedAt: REAL.item3.savedAt, id: REAL.item3.id }),
    )
    expect(ctx.enqueueFileForAttachmentLocalization).toHaveBeenCalledWith(
      MOCK_FILE,
      expect.objectContaining({ savedAt: REAL.item3.savedAt, id: REAL.item3.id }),
    )
  })
})

describe('processBatch - empty file regression (msg3 lost)', () => {
  // Reproduces the exact bug: when the merge target file starts EMPTY (no frontmatter),
  // and the wechatMessageTemplate starts with "---" (horizontal rule), the old code's
  // Phase C (processFrontMatter) would misparse the first message's "---" as a frontmatter
  // delimiter, silently dropping the first message in sort order (msg3 in DESC mode).

  const REAL = {
    item1: {
      id: 'ec1da259-3457-4b6c-a824-bb0e5f44e846',
      title: '同步助手_20260330_1_文本',
      savedAt: '2026-03-30T09:42:19.801999+00:00',
      content: '1',
    },
    item2: {
      id: 'efdc45a0-7a20-46bb-b549-32bf89d97cf1',
      title: '同步助手_20260330_2_文本',
      savedAt: '2026-03-30T09:42:24.611401+00:00',
      content: '2',
    },
    item3: {
      id: 'dc9ca0ac-ee0d-45f3-bffd-a14ee348ab77',
      title: '同步助手_20260330_3_文本',
      savedAt: '2026-03-30T09:42:56.115386+00:00',
      content: '3',
    },
  }

  function makeRealItem(data: typeof REAL.item1): Item {
    return makeItem({
      ...data,
      url: '',
      slug: '',
      labels: [],
      highlights: [],
      updatedAt: data.savedAt,
    })
  }

  it('empty file + template starting with --- should preserve all 3 messages', async () => {
    const prodTemplate = '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}'
    const ctx = makeMockContext({
      messageSortOrder: MessageSortOrder.DESC,
      wechatMessageTemplate: prodTemplate,
    })
    // KEY: start with an EMPTY file (no frontmatter), simulating resolveOrCreateMergeTarget
    ctx.setFileContent('')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeRealItem(REAL.item1), content: '' },
      { item: makeRealItem(REAL.item2), content: '' },
      { item: makeRealItem(REAL.item3), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()

    // All 3 messages must be present (msg3 was lost before the fix)
    expect(written).toContain('#### 3')
    expect(written).toContain('#### 2')
    expect(written).toContain('#### 1')

    // 新契约：3 条各带内联标记，frontmatter 无 syncedIds
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(fm).toBeDefined()
    expect(fm?.syncedIds).toBeUndefined()
    expect(hasMarker(written, REAL.item1.id)).toBe(true)
    expect(hasMarker(written, REAL.item2.id)).toBe(true)
    expect(hasMarker(written, REAL.item3.id)).toBe(true)
  })

  it('empty file + ASC order should also preserve all 3 messages', async () => {
    const prodTemplate = '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}'
    const ctx = makeMockContext({
      messageSortOrder: MessageSortOrder.ASC,
      wechatMessageTemplate: prodTemplate,
    })
    ctx.setFileContent('')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeRealItem(REAL.item1), content: '' },
      { item: makeRealItem(REAL.item2), content: '' },
      { item: makeRealItem(REAL.item3), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()

    // All 3 messages must be present
    expect(written).toContain('#### 1')
    expect(written).toContain('#### 2')
    expect(written).toContain('#### 3')

    // 新契约：3 条各带内联标记，frontmatter 无 syncedIds
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(fm).toBeDefined()
    expect(fm?.syncedIds).toBeUndefined()
    expect(hasMarker(written, REAL.item1.id)).toBe(true)
    expect(hasMarker(written, REAL.item2.id)).toBe(true)
    expect(hasMarker(written, REAL.item3.id)).toBe(true)
  })

  it('round-trip: second batch correctly parses output of first batch', async () => {
    const prodTemplate = '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}'
    const ctx = makeMockContext({
      messageSortOrder: MessageSortOrder.DESC,
      wechatMessageTemplate: prodTemplate,
    })
    ctx.setFileContent('')
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    // Batch 1: msg1 + msg2
    await processor.processBatch([
      { item: makeRealItem(REAL.item1), content: '' },
      { item: makeRealItem(REAL.item2), content: '' },
    ], MOCK_FILE)

    // Batch 2: msg3 appended to output of batch 1
    await processor.processBatch([
      { item: makeRealItem(REAL.item3), content: '' },
    ], MOCK_FILE)

    const written = ctx.getFileContent()

    // All 3 messages present
    expect(written).toContain('#### 3')
    expect(written).toContain('#### 2')
    expect(written).toContain('#### 1')

    // round-trip：第二批能正确解析第一批的输出（内联标记跨批稳定），3 条都在
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(fm?.syncedIds).toBeUndefined()
    expect(hasMarker(written, REAL.item1.id)).toBe(true)
    expect(hasMarker(written, REAL.item2.id)).toBe(true)
    expect(hasMarker(written, REAL.item3.id)).toBe(true)
  })

  it('existing frontmatter file + ---prefixed template preserves all messages', async () => {
    const prodTemplate = '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}'
    const ctx = makeMockContext({
      messageSortOrder: MessageSortOrder.DESC,
      wechatMessageTemplate: prodTemplate,
    })
    // File already has frontmatter with user custom fields
    const existingFilter = bloomAddId(createBloomFilter(), UUID.W0)
    ctx.setFileContent(
      '---\nsyncedIds: ' + existingFilter + '\ntags:\n  - journal\n---\n\n' +
      '---\n#### existing\n## 📅 2026-03-23 09:00:00\nold msg'
    )
    const { MergeProcessor } = await import('../src/sync/MergeProcessor')
    const processor = new MergeProcessor(ctx as any)

    const items: MergeBatchItem[] = [
      { item: makeRealItem(REAL.item1), content: '' },
      { item: makeRealItem(REAL.item2), content: '' },
      { item: makeRealItem(REAL.item3), content: '' },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()

    // All 3 new messages + old message present
    expect(written).toContain('#### 3')
    expect(written).toContain('#### 2')
    expect(written).toContain('#### 1')
    expect(written).toContain('old msg')

    // User custom frontmatter preserved
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(fm.tags).toEqual(['journal'])

    // 新的 3 条用内联标记记录
    expect(hasMarker(written, REAL.item1.id)).toBe(true)
    expect(hasMarker(written, REAL.item2.id)).toBe(true)
    expect(hasMarker(written, REAL.item3.id)).toBe(true)
    // 迁移：已有文件带的 legacy Bloom（含旧 W0）保留作老消息回退去重
    expect(bloomHasId(fm.syncedIds as string, UUID.W0)).toBe(true)
  })
})
