/**
 * 守护测试：ImageLocalizer 的落图目录同样不能因段首点被 Obsidian 隐藏。
 *
 * 与 `redcase.dotLeadingHiddenNote.spec.ts` §4 同源，但那边只驱动了
 * AttachmentLocalizer。ImageLocalizer 是**另一条独立的**目录渲染路径
 * （`generateFolderPath` 各有一份），只修/只测其中一条，另一条照样会把图片落进
 * 隐藏目录 —— 图片本地化是绝大多数笔记都会走的路，这条守护不能少。
 *
 * 图片文件名本身是 `<md5>.<ext>`，天然不会以点开头，所以这里只钉目录段。
 */

import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { itemToLocalizerMeta, LocalizerItemMeta } from '../src/common/localizerItemMeta'
import { TFile } from 'obsidian'
import { downloadImage, isRemoteImage } from '../src/imageLocalizer/imageDownloader'
import {
  calculateMD5,
  detectImageFormat,
  saveImageToVault,
} from '../src/imageLocalizer/imageProcessor'

jest.mock('../src/imageLocalizer/imageDownloader')
jest.mock('../src/imageLocalizer/imageProcessor')
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

const mockDownloadImage = downloadImage as jest.MockedFunction<typeof downloadImage>
const mockIsRemoteImage = isRemoteImage as jest.MockedFunction<typeof isRemoteImage>
const mockCalculateMD5 = calculateMD5 as jest.MockedFunction<typeof calculateMD5>
const mockDetectImageFormat = detectImageFormat as jest.MockedFunction<typeof detectImageFormat>
const mockSaveImageToVault = saveImageToVault as jest.MockedFunction<typeof saveImageToVault>

/** 段首点的护卫前缀：只在前面补一个字符，原文保持可搜索 */
const G = '_'
const REMOTE_IMG = 'https://cdn.example.com/pic.jpg'

function createMockFile(p: string): TFile {
  const file = new TFile()
  file.path = p
  file.basename = p.replace(/\.md$/, '').split('/').pop() || ''
  return file
}

function buildItem(overrides?: Record<string, unknown>) {
  return {
    id: 'note-id-abc',
    title: 'My Note',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/post/1',
    author: 'Alice',
    description: null,
    slug: 'post-1',
    labels: null,
    highlights: null,
    updatedAt: null,
    savedAt: '2026-07-27T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: null,
    publishedAt: null,
    url: 'https://example.com/post/1',
    image: null,
    readAt: null,
    wordsCount: null,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  } as never
}

/** 端到端驱动 ImageLocalizer，返回 saveImageToVault 收到的 folder 参数 */
async function runImageLocalizer(
  template: string,
  meta: LocalizerItemMeta,
  noteBasename = 'My Note',
): Promise<string> {
  jest.clearAllMocks()
  mockIsRemoteImage.mockImplementation((url: string) => url.startsWith('http'))

  const vault: any = {
    read: jest.fn().mockResolvedValue(`![](${REMOTE_IMG})`),
    modify: jest.fn(),
    process: null as any,
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
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

  const localizer = new ImageLocalizer({ vault } as any, {
    enablePngToJpeg: false,
    jpegQuality: 85,
    attachmentFolder: template,
    folderDateFormat: 'yyyy-MM-dd',
    maxRetries: 1,
    retryDelay: 1,
  })

  mockDownloadImage.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(10) })
  mockDetectImageFormat.mockReturnValueOnce('jpg')
  mockCalculateMD5.mockReturnValueOnce('cafe')
  mockSaveImageToVault.mockImplementation(
    async (_v: any, folder: string, name: string) => `${folder}/${name}`,
  )

  await localizer.enqueueFile(createMockFile(`notes/${noteBasename}.md`), meta)
  await localizer.processQueue()
  expect(mockSaveImageToVault).toHaveBeenCalledTimes(1)
  return mockSaveImageToVault.mock.calls[0][1]
}

describe('ImageLocalizer 落图目录：段首点不得让图片隐身', () => {
  it('author 以点开头（`.NET 团队`）→ 目录段不隐身', async () => {
    const folder = await runImageLocalizer(
      '图片/{{{author}}}',
      itemToLocalizerMeta(buildItem({ author: '.NET 团队' })),
    )
    expect(folder.split('/').some((s) => s.startsWith('.'))).toBe(false)
    expect(folder).toBe(`图片/${G}.NET 团队`)
  })

  it('笔记标题段（file.basename）以点开头 → 目录段不隐身', async () => {
    const folder = await runImageLocalizer(
      '图片/{{{title}}}/images',
      itemToLocalizerMeta(buildItem()),
      '.NET 8 的新特性',
    )
    expect(folder.split('/').some((s) => s.startsWith('.'))).toBe(false)
    expect(folder).toBe(`图片/${G}.NET 8 的新特性/images`)
  })

  it('健康模板逐字节不变（回归护栏）', async () => {
    const folder = await runImageLocalizer(
      '笔记同步助手/images/{{{date}}}',
      itemToLocalizerMeta(buildItem()),
    )
    expect(folder).toBe('笔记同步助手/images/2026-07-27')
  })
})
