/**
 * 端到端钉死：AttachmentLocalizer 也支持完整模板变量集（与 ImageLocalizer 同 bug）。
 *
 * 注意：附件 localizer 的 detect/download/save 链路与图片不同，
 * 直接 mock 整条 attachmentDownloader 即可。本测试只关心
 * saveAttachmentToVault 拿到的 folderPath，等价于 ImageLocalizer 的
 * saveImageToVault 第二参 capture 套路。
 */

import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import {
  itemToLocalizerMeta,
} from '../src/common/localizerItemMeta'
import { TFile } from 'obsidian'
import {
  downloadAttachment,
  isRemoteAttachment,
} from '../src/attachmentLocalizer/attachmentDownloader'

jest.mock('../src/attachmentLocalizer/attachmentDownloader')
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))
jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return { ...actual, Notice: jest.fn() }
})

const mockDownloadAttachment = downloadAttachment as jest.MockedFunction<
  typeof downloadAttachment
>
const mockIsRemoteAttachment = isRemoteAttachment as jest.MockedFunction<
  typeof isRemoteAttachment
>

const SAVED_AT = '2026-05-25T10:30:00.000Z'
const PUBLISHED_AT = '2026-05-20T08:00:00.000Z'
const DATE_FORMAT = 'yyyy-MM-dd'
const NOTE_TITLE = 'My Note'
const ATTACH_URL = 'https://cdn.example.com/file.pdf'
const ATTACH_FILENAME = 'report.pdf'
const NOTE_CONTENT = `## 附件\n📎 [${ATTACH_FILENAME}](${ATTACH_URL}) (1MB)\n`

function createMockFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/\.md$/, '').split('/').pop() || ''
  return file
}

/**
 * 端到端驱动 AttachmentLocalizer，捕获 createBinary 的 folder 段。
 * 附件 localizer 没有独立 saveAttachmentToVault mock 入口，所以走 vault
 * stub，自己拼路径。
 */
async function runAttachmentLocalizerWithMeta(
  template: string,
  meta?: ReturnType<typeof itemToLocalizerMeta>,
): Promise<string> {
  jest.clearAllMocks()
  mockIsRemoteAttachment.mockReturnValue(true)

  const captured: { folder: string } = { folder: '' }
  const vault: any = {
    read: jest.fn().mockResolvedValue(NOTE_CONTENT),
    modify: jest.fn(),
    process: null as any,
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
    // createBinary(filePath, data) —— 路径上 folder + '/' + sanitizedFilename
    createBinary: jest.fn(async (filePath: string) => {
      captured.folder = filePath.replace(/\/[^/]+$/, '')
    }),
    createFolder: jest.fn(),
  }
  vault.process = jest
    .fn()
    .mockImplementation(async (_f: any, fn: (s: string) => string) => {
      const c = await vault.read(_f)
      const r = fn(c)
      await vault.modify(_f, r)
      return r
    })

  const localizer = new AttachmentLocalizer(
    { vault } as any,
    {
      attachmentFolder: template,
      folderDateFormat: DATE_FORMAT,
      maxRetries: 1,
      retryDelay: 1,
    },
  )

  mockDownloadAttachment.mockResolvedValueOnce({
    success: true,
    data: new ArrayBuffer(10),
  })

  const file = createMockFile(`notes/${NOTE_TITLE}.md`)
  await localizer.enqueueFile(file, meta)
  await localizer.processQueue()
  return captured.folder
}

function buildRealItem() {
  return {
    id: 'note-id-abc',
    title: NOTE_TITLE,
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/post/1',
    author: 'Alice',
    description: null,
    slug: 'post-1',
    labels: null,
    highlights: null,
    updatedAt: null,
    savedAt: SAVED_AT,
    pageType: 'ARTICLE',
    content: null,
    publishedAt: PUBLISHED_AT,
    url: 'https://example.com/post/1',
    image: null,
    readAt: null,
    wordsCount: null,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
  } as any
}

describe('AttachmentLocalizer 模板变量支持', () => {
  test('用户原报告：附件文件夹模板含 {{{siteName}}} 段', async () => {
    const folder = await runAttachmentLocalizerWithMeta(
      '同步/{{{siteName}}}/{{{date}}}/{{{title}}}/attachments',
      itemToLocalizerMeta(buildRealItem()),
    )
    expect(folder).toBe(`同步/example.com/2026-05-25/${NOTE_TITLE}/attachments`)
  })

  test('附件 folder 同时支持 author + publishedAt 年', async () => {
    const folder = await runAttachmentLocalizerWithMeta(
      '附件/{{{author}}}/{{{yearPublished}}}/{{{title}}}',
      itemToLocalizerMeta(buildRealItem()),
    )
    expect(folder).toBe(`附件/Alice/2026/${NOTE_TITLE}`)
  })

  test('不传 meta（兼容路径）→ siteName 段折叠回旧行为', async () => {
    const folder = await runAttachmentLocalizerWithMeta(
      '兜底/{{{siteName}}}/{{{title}}}',
    )
    expect(folder).toBe(`兜底/${NOTE_TITLE}`)
  })

  test('兼容 overload：传 savedAt 字符串依旧工作', async () => {
    const folder = await runAttachmentLocalizerWithMeta(
      '兜底/{{{date}}}/{{{title}}}',
      SAVED_AT as any,
    )
    expect(folder).toBe(`兜底/2026-05-25/${NOTE_TITLE}`)
  })
})
