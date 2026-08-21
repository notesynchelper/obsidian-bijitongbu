// 单元测试：合并模式下「文章 frontmatter」单篇/多篇处理（工单 o56E764NDxeqPyRDgjUpVFUzqgjA）
//
// 修复前：ALL 合并模式把每篇文章（即使各自独占一个文件）的 frontmatter 收成只剩
//   `syncedIds`，title/author/source/url 全没。
// 修复后：
//   - 只含 1 篇文章的合并文件 → 保留该篇完整 frontmatter（author/source/url/id）+ syncedIds；
//   - 多篇真合并的 digest 文件 → 文件级 frontmatter 精简（不提单篇业务字段），各篇元数据
//     下沉到 section（callout 属性块）；
//   - 用户手填 frontmatter（如 tags）跨同步保留，绝不被剥离。

import { Item } from '@omnivore-app/api'
import { createBloomFilter, bloomAddId, bloomHasId } from '../src/compressIds'
import { MessageSortOrder } from '../src/settings'
import { MergeBatchItem, renderSectionMeta } from '../src/sync/MergeProcessor'
import {
  parseFrontMatterFromContent,
  removeFrontMatterFromContent,
} from '../src/util'
import { stringifyYaml } from 'obsidian'

// ⚠️ Bloom 用 UUID 前 8 字节算 h1、后 8 字节算 h2；前 8 字节相同的两个 UUID 会
// 互相假阳性。这里几个常量刻意彼此「全字节分散」，避免测试里出现 1-id Bloom 误命中
// （真实 v4 UUID 随机，几乎不会撞）。
const UUID = {
  A1: '11111111-1111-4111-8111-111111111111',
  A2: '22222222-2222-4222-8222-222222222222',
  A3: '33333333-3333-4333-8333-333333333333',
  FAR: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
}

function makeArticleItem(id: string, savedAt = '2026-03-23T10:00:00.000Z', title = 'Some Article'): Item {
  return {
    id,
    title,
    savedAt,
    updatedAt: savedAt,
    content: 'unused-body',
    url: 'https://example.com',
    slug: 'test',
    labels: [],
    highlights: [],
  } as unknown as Item
}

// 还原 renderItemContent（合并分支，修复后）对【文章】产出的 content：完整 fm + syncedIds + 正文。
function makeArticleContent(
  id: string,
  meta: Record<string, unknown>,
  bodyText: string,
): string {
  const fm: Record<string, unknown> = { id, ...meta, syncedIds: bloomAddId(createBloomFilter(), id) }
  return `---\n${stringifyYaml(fm)}---\n\n${bodyText}`
}

// Minimal SyncContext mock（与 MergeProcessorBatch.spec.ts 同款）。
function makeMockContext(settings: Record<string, unknown> = {}) {
  let fileContent = ''
  const ctx: any = {
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
        read: jest.fn(async () => fileContent),
        modify: jest.fn(async (_f: unknown, c: string) => { fileContent = c }),
        process: jest.fn(async (_f: unknown, fn: (d: string) => string) => {
          const r = fn(fileContent); fileContent = r; return r
        }),
      },
    },
    successTracker: { recordSuccess: jest.fn() },
    burnTracker: { recordCursor: jest.fn(), recordDelete: jest.fn() },
    diaryLinkProcessor: { addLink: jest.fn() },
    enqueueFileForImageLocalization: jest.fn(async () => {}),
    enqueueFileForAttachmentLocalization: jest.fn(async () => {}),
    addProcessedFile: jest.fn(),
    imageLocalizer: null,
    setFileContent(c: string) { fileContent = c },
    getFileContent() { return fileContent },
  }
  return ctx
}

const MOCK_FILE = { path: 'test/merge.md', basename: 'merge' } as any

async function newProcessor(ctx: any) {
  const { MergeProcessor } = await import('../src/sync/MergeProcessor')
  return new MergeProcessor(ctx)
}

const ARTICLE_META = { author: 'Alice', source: 'blog.test', url: 'https://blog.test/x', saved: '2026-03-23' }

describe('renderSectionMeta', () => {
  it('renders a callout for business metadata', () => {
    const out = renderSectionMeta({ author: 'Alice', source: 'blog.test', url: 'https://blog.test/x' })
    expect(out).toContain('> [!note] 笔记属性')
    expect(out).toContain('> author: Alice')
    expect(out).toContain('> source: blog.test')
    expect(out).toContain('> url: https://blog.test/x')
  })

  it('hides internal keys (syncedIds/burnSyncedIds/messages) and id', () => {
    const out = renderSectionMeta({ id: 'abc', syncedIds: 'AAAA', burnSyncedIds: [], author: 'Bob' })
    expect(out).toContain('> author: Bob')
    expect(out).not.toContain('id:')
    expect(out).not.toContain('syncedIds')
    expect(out).not.toContain('burnSyncedIds')
  })

  it('joins array values (tags) with comma', () => {
    const out = renderSectionMeta({ tags: ['a', 'b', 'c'] })
    expect(out).toContain('> tags: a, b, c')
  })

  it('returns empty string when only internal/empty fields remain', () => {
    expect(renderSectionMeta({ id: 'x', syncedIds: 'AAAA' })).toBe('')
    expect(renderSectionMeta({ author: '', source: null })).toBe('')
    expect(renderSectionMeta({})).toBe('')
  })
})

describe('MergeProcessor: single-article file keeps full frontmatter (工单修复)', () => {
  it('fresh file with one article -> full fm (author/source/url/id) + syncedIds, no callout', async () => {
    const ctx = makeMockContext()
    ctx.setFileContent('')  // 新建空文件
    const processor = await newProcessor(ctx)

    const items: MergeBatchItem[] = [
      { item: makeArticleItem(UUID.A1), content: makeArticleContent(UUID.A1, ARTICLE_META, 'article body A') },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(fm.author).toBe('Alice')
    expect(fm.source).toBe('blog.test')
    expect(fm.url).toBe('https://blog.test/x')
    expect(fm.id).toBe(UUID.A1)
    expect(typeof fm.syncedIds).toBe('string')
    expect(bloomHasId(fm.syncedIds as string, UUID.A1)).toBe(true)
    // 正文里不应再塞一份属性 callout（属性都在文件级）
    expect(removeFrontMatterFromContent(written)).not.toContain('> [!note] 笔记属性')
    expect(written).toContain('article body A')
  })

  it('re-sync of the same single article keeps full fm and stays single', async () => {
    const ctx = makeMockContext()
    // 现有文件 = 上一轮写出的单篇完整 fm
    ctx.setFileContent(
      `---\n${stringifyYaml({ id: UUID.A1, author: 'Alice', source: 'blog.test', url: 'https://blog.test/x', syncedIds: bloomAddId(createBloomFilter(), UUID.A1) })}---\n\narticle body A`,
    )
    const processor = await newProcessor(ctx)

    const items: MergeBatchItem[] = [
      { item: makeArticleItem(UUID.A1), content: makeArticleContent(UUID.A1, { ...ARTICLE_META, author: 'Alice-v2' }, 'article body A v2') },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    expect(fm.author).toBe('Alice-v2')   // 文章字段刷新
    expect(fm.id).toBe(UUID.A1)
    expect(bloomHasId(fm.syncedIds as string, UUID.A1)).toBe(true)
    expect(removeFrontMatterFromContent(written)).not.toContain('> [!note] 笔记属性')
  })
})

describe('MergeProcessor: multi-article digest sinks metadata to sections', () => {
  it('two distinct articles in one file -> minimal file fm + per-section callouts', async () => {
    const ctx = makeMockContext()
    ctx.setFileContent('')  // 同名文件，两篇塌进来
    const processor = await newProcessor(ctx)

    const items: MergeBatchItem[] = [
      { item: makeArticleItem(UUID.A1, '2026-03-23T10:00:00.000Z'), content: makeArticleContent(UUID.A1, { author: 'Alice', source: 'a.test', url: 'https://a.test/1' }, 'body-A') },
      { item: makeArticleItem(UUID.A2, '2026-03-23T11:00:00.000Z'), content: makeArticleContent(UUID.A2, { author: 'Bob', source: 'b.test', url: 'https://b.test/2' }, 'body-B') },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    // 文件级 frontmatter 精简：只有 syncedIds，不把某一篇的 author/source/url 提到文件级
    expect(typeof fm.syncedIds).toBe('string')
    expect(fm.author).toBeUndefined()
    expect(fm.source).toBeUndefined()
    expect(fm.url).toBeUndefined()
    expect(fm.id).toBeUndefined()
    // 两篇元数据下沉到 section（callout 属性块）
    const sectionBody = removeFrontMatterFromContent(written)
    expect(sectionBody).toContain('> [!note] 笔记属性')
    expect(sectionBody).toContain('> author: Alice')
    expect(sectionBody).toContain('> author: Bob')
    expect(sectionBody).toContain('body-A')
    expect(sectionBody).toContain('body-B')
    // 去重覆盖两篇
    expect(bloomHasId(fm.syncedIds as string, UUID.A1)).toBe(true)
    expect(bloomHasId(fm.syncedIds as string, UUID.A2)).toBe(true)
  })

  it('preserves user-customized file frontmatter (tags) when adding an article to a digest', async () => {
    const ctx = makeMockContext()
    // 现有 digest 文件：minimal fm + 用户手填 tags，正文已有别的内容
    ctx.setFileContent(
      `---\n${stringifyYaml({ syncedIds: bloomAddId(createBloomFilter(), UUID.A3), tags: ['journal'] })}---\n\n> [!note] 笔记属性\n> author: Old\n\nexisting body`,
    )
    const processor = await newProcessor(ctx)

    const items: MergeBatchItem[] = [
      { item: makeArticleItem(UUID.A1, '2026-03-23T12:00:00.000Z'), content: makeArticleContent(UUID.A1, { author: 'Newbie', source: 'n.test', url: 'https://n.test/1' }, 'new body') },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    // 用户手填 tags 必须保留
    expect(fm.tags).toEqual(['journal'])
    // 没有把新文章的 author 提升到文件级
    expect(fm.author).toBeUndefined()
    // 新文章元数据进 section
    expect(removeFrontMatterFromContent(written)).toContain('> author: Newbie')
    expect(written).toContain('new body')
    expect(written).toContain('existing body')
  })
})

describe('MergeProcessor: single-article file gains a 2nd article (first-article-primary, 零数据丢失)', () => {
  it('keeps article-1 frontmatter (incl. user-typed keys) at file level untouched; new article gets a section callout', async () => {
    const ctx = makeMockContext()
    // 现有「单篇完整 fm」文件：首篇 A1 + 用户手填 note/aliases + Bloom 只有 A1
    ctx.setFileContent(
      `---\n${stringifyYaml({
        id: UUID.A1,
        author: 'Alice',
        source: 'a.test',
        url: 'https://a.test/1',
        note: 'user-hand-typed',
        aliases: ['my-alias'],
        syncedIds: bloomAddId(createBloomFilter(), UUID.A1),
      })}---\n\noriginal A body`,
    )
    const processor = await newProcessor(ctx)

    // 来一篇【不同】文章 FAR（同一个文件路径）→ 过渡为多篇
    const items: MergeBatchItem[] = [
      { item: makeArticleItem(UUID.FAR, '2026-03-23T12:00:00.000Z'), content: makeArticleContent(UUID.FAR, { author: 'Bob', source: 'b.test', url: 'https://b.test/2' }, 'B body') },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const written = ctx.getFileContent()
    const fm = parseFrontMatterFromContent(written) as Record<string, unknown>
    // 数据安全铁律：首篇属性 + 用户手填字段（含 aliases 这类真·Obsidian 属性）原封不动保留在文件级
    expect(fm.id).toBe(UUID.A1)
    expect(fm.author).toBe('Alice')
    expect(fm.note).toBe('user-hand-typed')
    expect(fm.aliases).toEqual(['my-alias'])
    // 去重覆盖两篇
    expect(bloomHasId(fm.syncedIds as string, UUID.A1)).toBe(true)
    expect(bloomHasId(fm.syncedIds as string, UUID.FAR)).toBe(true)

    const sectionBody = removeFrontMatterFromContent(written)
    // 首篇正文保留
    expect(sectionBody).toContain('original A body')
    // 新文章 B 的 section callout + 正文
    expect(sectionBody).toContain('> [!note] 笔记属性')
    expect(sectionBody).toContain('> author: Bob')
    expect(sectionBody).toContain('B body')
  })
})

describe('MergeProcessor: transitioned (first-article-primary) file does not drift on re-sync', () => {
  it('re-syncing a multi file whose fm still has the primary id does NOT overwrite file-level fm with articleItems[0]', async () => {
    const ctx = makeMockContext()
    // 「首篇为主」过渡后的多篇文件：文件级仍保留首篇 A1 的属性 + id；Bloom 含 A1+FAR；
    // 正文里 FAR 有自己的 section callout。
    ctx.setFileContent(
      `---\n${stringifyYaml({
        id: UUID.A1,
        author: 'Alice',
        source: 'a.test',
        url: 'https://a.test/1',
        syncedIds: bloomAddId(bloomAddId(createBloomFilter(), UUID.A1), UUID.FAR),
      })}---\n\noriginal A body\n\n> [!note] 笔记属性\n> author: Bob\n\nFAR body`,
    )
    const processor = await newProcessor(ctx)

    // 重同步：本批同时含 FAR、A1（都已 seen），且 FAR 排在前（articleItems[0]）。
    const items: MergeBatchItem[] = [
      { item: makeArticleItem(UUID.FAR, '2026-03-23T13:00:00.000Z'), content: makeArticleContent(UUID.FAR, { author: 'Bob', source: 'b.test', url: 'https://b.test/2' }, 'FAR body') },
      { item: makeArticleItem(UUID.A1, '2026-03-23T10:00:00.000Z'), content: makeArticleContent(UUID.A1, { author: 'Alice', source: 'a.test', url: 'https://a.test/1' }, 'original A body') },
    ]
    await processor.processBatch(items, MOCK_FILE)

    const fm = parseFrontMatterFromContent(ctx.getFileContent()) as Record<string, unknown>
    // 文件级 fm 不漂移：仍是首篇 A1 的，绝不被 articleItems[0]=FAR(Bob) 覆盖
    expect(fm.id).toBe(UUID.A1)
    expect(fm.author).toBe('Alice')
    expect(fm.source).toBe('a.test')
    expect(bloomHasId(fm.syncedIds as string, UUID.A1)).toBe(true)
    expect(bloomHasId(fm.syncedIds as string, UUID.FAR)).toBe(true)
  })
})

describe('renderSectionMeta: skips non-scalar values (no [object Object])', () => {
  it('drops nested objects and object-arrays, keeps scalars and scalar arrays', () => {
    const out = renderSectionMeta({
      author: 'Alice',
      tags: ['a', 'b'],
      nested: { x: 1 },
      objarr: [{ y: 2 }],
    })
    expect(out).toContain('> author: Alice')
    expect(out).toContain('> tags: a, b')
    expect(out).not.toContain('[object Object]')
    expect(out).not.toContain('nested')
    expect(out).not.toContain('objarr')
  })
})
