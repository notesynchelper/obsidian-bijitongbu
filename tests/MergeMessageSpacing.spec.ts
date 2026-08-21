import { Item } from '@omnivore-app/api'
// marked@4.3.0 does not publish TypeScript declarations, so keep the import typed locally.
// @ts-expect-error TS7016 -- runtime API is covered by the narrow interface below.
import { marked as untypedMarked } from 'marked'
import { MessageSortOrder } from '../src/settings'
import { MergeBatchItem } from '../src/sync/MergeProcessor'
import { BurnDeleteTracker } from '../src/sync/BurnDeleteTracker'

interface MarkdownToken {
  type: string
  depth?: number
  text?: string
}

const marked = untypedMarked as {
  lexer: (markdown: string) => MarkdownToken[]
}

const ID1 = '550e8400-e29b-41d4-a716-446655440001'
const ID2 = '550e8400-e29b-41d4-a716-446655440002'
const FILE = {
  path: 'Synced/merge.md',
  basename: 'merge',
} as unknown as import('obsidian').TFile

function makeMessage(id: string, savedAt: string, content: string): Item {
  return {
    id,
    title: '同步助手_20260812_001_文本',
    savedAt,
    updatedAt: savedAt,
    content,
    url: 'https://example.com',
    slug: 'message',
    labels: [],
    highlights: [],
    siteName: '企业微信',
  } as unknown as Item
}

function makeArticle(id: string, savedAt: string): Item {
  return {
    ...makeMessage(id, savedAt, ''),
    title: '普通文章',
    siteName: 'example.com',
  } as unknown as Item
}

function makeContext(
  settings: Record<string, unknown> = {},
  initialContent = '',
) {
  let fileContent = initialContent
  return {
    burnTracker: new BurnDeleteTracker(),
    imageLocalizer: null,
    settings: {
      messageSortOrder: MessageSortOrder.ASC,
      dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
      wechatMessageTemplate:
        '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}',
      mergeFileTemplate: '',
      sectionSeparator: '',
      sectionSeparatorEnd: '',
      burnAfterReading: false,
      burnAfterReadingEnabledAt: '',
      deviceSyncCursors: {},
      pendingBurnDeletes: [],
      ...settings,
    },
    app: {
      vault: {
        process: jest.fn(
          async (_file: unknown, fn: (data: string) => string) => {
            fileContent = fn(fileContent)
            return fileContent
          },
        ),
      },
    },
    successTracker: { recordSuccess: jest.fn() },
    diaryLinkProcessor: { addLink: jest.fn() },
    enqueueFileForImageLocalization: jest.fn(async () => {}),
    enqueueFileForAttachmentLocalization: jest.fn(async () => {}),
    addProcessedFile: jest.fn(),
    getFileContent: () => fileContent,
  }
}

async function process(
  ctx: ReturnType<typeof makeContext>,
  items: MergeBatchItem[],
) {
  const { MergeProcessor } = await import('../src/sync/MergeProcessor')
  await new MergeProcessor(ctx as never).processBatch(items, FILE)
}

async function processTwoMessages(
  ctx: ReturnType<typeof makeContext>,
  batching: 'same-batch' | 'cross-batch',
) {
  const first = {
    item: makeMessage(ID1, '2026-08-12T09:00:00.000Z', '第一条正文'),
    content: '',
  }
  const second = {
    item: makeMessage(ID2, '2026-08-12T10:00:00.000Z', '第二条正文'),
    content: '',
  }
  if (batching === 'same-batch') {
    await process(ctx, [first, second])
  } else {
    await process(ctx, [first])
    await process(ctx, [second])
  }
}

function bodyOf(content: string): string {
  const empty = content.match(/^---\r?\n---(?:\r?\n+|$)/)
  if (empty) return content.slice(empty[0].length)
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/)
  return frontmatter ? content.slice(frontmatter[0].length) : content
}

describe('合并消息块间距', () => {
  test('默认 marker 路径：同批边界保留 hr，不把上一条末行吞成 setext H2', async () => {
    const ctx = makeContext()
    await processTwoMessages(ctx, 'same-batch')

    const body = bodyOf(ctx.getFileContent())
    expect(body).toContain(
      `第一条正文\n<!--nh:${ID1}-->\n- - -\n#### 第二条正文`,
    )
    expect(body).not.toContain(`<!--nh:${ID1}-->\n\n- - -`)
    const tokens = marked.lexer(body)
    expect(
      tokens.some(
        (token) =>
          token.type === 'heading' &&
          token.depth === 2 &&
          (token.text?.includes('第一条正文') ||
            token.text?.includes('第二条正文')),
      ),
    ).toBe(false)
    expect(tokens.some((token) => token.type === 'hr')).toBe(true)
  })

  test('左侧以 type-6 HTML block 结尾时退回双换行，右侧 hr 和 heading 独立解析', async () => {
    const ctx = makeContext()
    await process(ctx, [
      {
        item: makeMessage(
          ID1,
          '2026-08-12T09:00:00.000Z',
          '<div>表格或富文本</div>',
        ),
        content: '',
      },
      {
        item: makeMessage(ID2, '2026-08-12T10:00:00.000Z', '第二条正文'),
        content: '',
      },
    ])

    const body = bodyOf(ctx.getFileContent())
    expect(body).toContain(`</div>\n<!--nh:${ID1}-->\n\n- - -\n#### 第二条正文`)
    const tokens = marked.lexer(body)
    expect(tokens.some((token) => token.type === 'hr')).toBe(true)
    expect(
      tokens.some(
        (token) =>
          token.type === 'heading' &&
          token.depth === 4 &&
          token.text?.includes('第二条正文'),
      ),
    ).toBe(true)
  })

  test('左侧以插件生成的 small 时间戳结尾时仍保持单换行', async () => {
    const ctx = makeContext({ disableMessageMarkers: true })
    await process(ctx, [
      {
        item: makeMessage(
          ID1,
          '2026-08-12T09:00:00.000Z',
          '正文\n**2026/08/12 09:00:00**',
        ),
        content: '',
      },
      {
        item: makeMessage(ID2, '2026-08-12T10:00:00.000Z', '第二条正文'),
        content: '',
      },
    ])

    const body = bodyOf(ctx.getFileContent())
    expect(body).toContain('</small>\n- - -\n#### 第二条正文')
    expect(body).not.toContain('</small>\n\n- - -')
  })

  test.each(['-', '-   '])(
    '模板首行 `%s` 没有实际列表内容时退回双换行',
    async (firstLine) => {
      const ctx = makeContext({
        disableMessageMarkers: true,
        wechatMessageTemplate: `${firstLine}\n{{{content}}}`,
      })
      await processTwoMessages(ctx, 'same-batch')

      const body = bodyOf(ctx.getFileContent())
      expect(body).toContain(`第一条正文\n\n${firstLine}\n第二条正文`)
      expect(
        marked
          .lexer(body)
          .some(
            (token) =>
              token.type === 'heading' && token.text?.includes('第一条正文'),
          ),
      ).toBe(false)
    },
  )

  test.each([
    { order: 'ASC', sortOrder: MessageSortOrder.ASC },
    { order: 'DESC', sortOrder: MessageSortOrder.DESC },
  ])(
    '默认 marker 路径：跨批次 $order 边界保留 hr，不产生消息正文 H2',
    async ({ sortOrder }) => {
      const ctx = makeContext({ messageSortOrder: sortOrder })
      await processTwoMessages(ctx, 'cross-batch')

      const body = bodyOf(ctx.getFileContent())
      const tokens = marked.lexer(body)
      expect(body).toContain('\n- - -\n####')
      expect(
        tokens.some(
          (token) =>
            token.type === 'heading' &&
            token.depth === 2 &&
            (token.text?.includes('第一条正文') ||
              token.text?.includes('第二条正文')),
        ),
      ).toBe(false)
      expect(tokens.some((token) => token.type === 'hr')).toBe(true)
    },
  )

  test('正文尾部的多余换行和空白会在追加 marker 前去掉', async () => {
    const ctx = makeContext()
    await process(ctx, [
      {
        item: makeMessage(ID1, '2026-08-12T09:00:00.000Z', '第一条\n\n\n \t'),
        content: '',
      },
      {
        item: makeMessage(ID2, '2026-08-12T10:00:00.000Z', '第二条'),
        content: '',
      },
    ])

    const body = bodyOf(ctx.getFileContent())
    expect(body).toContain(`第一条\n<!--nh:${ID1}-->\n- - -\n#### 第二条`)
    expect(body).not.toContain(`第一条\n\n<!--nh:${ID1}-->`)
  })

  test.each([
    {
      mode: 'noMarkers',
      batching: 'same-batch' as const,
      settings: { disableMessageMarkers: true },
    },
    {
      mode: 'burn',
      batching: 'same-batch' as const,
      settings: {
        burnAfterReading: true,
        burnAfterReadingEnabledAt: '2026-08-01T00:00:00.000Z',
      },
    },
    {
      mode: 'noMarkers cross-batch',
      batching: 'cross-batch' as const,
      settings: { disableMessageMarkers: true },
    },
    {
      mode: 'burn cross-batch',
      batching: 'cross-batch' as const,
      settings: {
        burnAfterReading: true,
        burnAfterReadingEnabledAt: '2026-08-01T00:00:00.000Z',
      },
    },
  ])(
    '$mode：边界仍是 thematic break，不把上一条末行解析成 setext H2',
    async ({ settings, batching }) => {
      const ctx = makeContext(settings)
      await processTwoMessages(ctx, batching)

      const body = bodyOf(ctx.getFileContent())
      expect(body).toContain('第一条正文\n- - -\n#### 第二条正文')
      const tokens = marked.lexer(body)
      expect(
        tokens.some(
          (token) =>
            token.type === 'heading' &&
            token.depth === 2 &&
            (token.text?.includes('第一条正文') ||
              token.text?.includes('第二条正文')),
        ),
      ).toBe(false)
      expect(tokens.some((token) => token.type === 'hr')).toBe(true)
    },
  )

  test.each(['same-batch', 'cross-batch'] as const)(
    '纯文本模板：%s 边界退回双换行，两条消息是独立 paragraph',
    async (batching) => {
      const ctx = makeContext({
        disableMessageMarkers: true,
        wechatMessageTemplate: '📅 {{{dateSaved}}}\n{{{content}}}',
      })
      await processTwoMessages(ctx, batching)

      const body = bodyOf(ctx.getFileContent())
      expect(body).toContain('第一条正文\n\n📅')
      const paragraphs = marked
        .lexer(body)
        .filter((token) => token.type === 'paragraph')
      expect(paragraphs).toHaveLength(2)
      expect(paragraphs[0].text).toContain('第一条正文')
      expect(paragraphs[1].text).toContain('第二条正文')
    },
  )

  test.each(['same-batch', 'cross-batch'] as const)(
    '=== 模板：%s 边界退回双换行，不把上一条正文解析成 setext H1',
    async (batching) => {
      const ctx = makeContext({
        disableMessageMarkers: true,
        wechatMessageTemplate: '===\n{{{content}}}',
      })
      await processTwoMessages(ctx, batching)

      const body = bodyOf(ctx.getFileContent())
      expect(body).toContain('第一条正文\n\n===\n第二条正文')
      const tokens = marked.lexer(body)
      expect(tokens.filter((token) => token.type === 'paragraph')).toHaveLength(
        2,
      )
      expect(
        tokens.some(
          (token) =>
            token.type === 'heading' &&
            token.depth === 1 &&
            token.text?.includes('第一条正文'),
        ),
      ).toBe(false)
    },
  )

  test.each([
    { order: 'ASC', sortOrder: MessageSortOrder.ASC },
    { order: 'DESC', sortOrder: MessageSortOrder.DESC },
  ])('文件头与首条消息之间在 $order 下仍是双换行', async ({ sortOrder }) => {
    const ctx = makeContext(
      {
        messageSortOrder: sortOrder,
        mergeFileTemplate: '# 文件头',
      },
      '# 文件头\n',
    )
    await process(ctx, [
      {
        item: makeMessage(ID1, '2026-08-12T09:00:00.000Z', '第一条'),
        content: '',
      },
    ])

    expect(bodyOf(ctx.getFileContent())).toMatch(
      /^# 文件头\n\n---\n#### 第一条/,
    )
  })

  test('文章跨批次合并仍使用双换行', async () => {
    const ctx = makeContext()
    await process(ctx, [
      { item: makeArticle(ID1, '2026-08-12T09:00:00.000Z'), content: '文章一' },
    ])
    await process(ctx, [
      { item: makeArticle(ID2, '2026-08-12T10:00:00.000Z'), content: '文章二' },
    ])

    const body = bodyOf(ctx.getFileContent())
    expect(body).toContain('文章一\n\n文章二')
    expect(
      marked.lexer(body).filter((token) => token.type === 'paragraph'),
    ).toHaveLength(2)
  })
})
