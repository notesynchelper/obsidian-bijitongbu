/**
 * 图片下载进度「图片级」粒度回归测试
 *
 * 背景：旧实现进度条按【文件】计数（startPhaseProgress(总文件数) + 每文件回调
 * 一次），单篇多图笔记会卡在「处理图片 0/1」直到整篇下完才跳满 —— 弱网下右上角
 * 进度与真实下载严重背离（见 tests/real-obsidian/cases/weaknet-image-progress.case.js）。
 *
 * 修复后：分母 = countQueuedRemoteImages()（真实待下载图片数），processQueue 每
 * 下载完一张图回调一次。本测试用确定性 mock 在单测层钉死「图片级」粒度。
 */

import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { TFile } from 'obsidian'
import { downloadImage, isRemoteImage } from '../src/imageLocalizer/imageDownloader'
import {
  calculateMD5,
  detectImageFormat,
  saveImageToVault,
} from '../src/imageLocalizer/imageProcessor'
import { SyncNoticeManager } from '../src/sync/SyncNoticeManager'

jest.mock('../src/imageLocalizer/imageDownloader')
jest.mock('../src/imageLocalizer/imageProcessor')
jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('attachments'),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

const mockDownloadImage = downloadImage as jest.MockedFunction<typeof downloadImage>
const mockIsRemoteImage = isRemoteImage as jest.MockedFunction<typeof isRemoteImage>
const mockCalculateMD5 = calculateMD5 as jest.MockedFunction<typeof calculateMD5>
const mockDetectImageFormat = detectImageFormat as jest.MockedFunction<typeof detectImageFormat>
const mockSaveImageToVault = saveImageToVault as jest.MockedFunction<typeof saveImageToVault>

function createMockFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/\.md$/, '').split('/').pop() || ''
  return file
}

function imagesMarkdown(host: string, n: number): string {
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(`para ${i}`, '', `![alt-${i}](${host}/img-${i}.jpg)`, '')
  return lines.join('\n')
}

describe('图片下载进度：图片级粒度（非文件级）', () => {
  let localizer: ImageLocalizer
  let mockVault: {
    read: jest.Mock
    modify: jest.Mock
    process: jest.Mock
    getAbstractFileByPath: jest.Mock
    createBinary: jest.Mock
    createFolder: jest.Mock
  }

  const defaultOptions = {
    enablePngToJpeg: false,
    jpegQuality: 85,
    attachmentFolder: 'attachments',
    folderDateFormat: 'yyyy-MM-dd',
    maxRetries: 2,
    retryDelay: 1,
  }

  beforeEach(() => {
    jest.clearAllMocks()

    mockVault = {
      read: jest.fn(),
      modify: jest.fn(),
      process: jest
        .fn()
        .mockImplementation(async (_file: any, fn: (data: string) => string) => {
          const content = await mockVault.read(_file)
          const result = fn(content)
          await mockVault.modify(_file, result)
          return result
        }),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      createBinary: jest.fn(),
      createFolder: jest.fn(),
    }

    localizer = new ImageLocalizer({ vault: mockVault } as any, defaultOptions)

    mockIsRemoteImage.mockImplementation(
      (url: string) => url.startsWith('http://') || url.startsWith('https://'),
    )

    // 每张图都成功下载 + 保存（distinct md5，避免按内容去重影响计数语义）
    let n = 0
    mockDownloadImage.mockResolvedValue({ success: true, data: new ArrayBuffer(10) })
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockImplementation(() => `md5_${n++}`)
    mockSaveImageToVault.mockImplementation(
      async (_v: any, folder: string, fileName: string) => `${folder}/${fileName}`,
    )
  })

  test('countQueuedRemoteImages 按图片数（8）统计，而非文件数（1）', async () => {
    const file = createMockFile('notes/multi.md')
    mockVault.read.mockResolvedValue(imagesMarkdown('http://h', 8))

    await localizer.enqueueFile(file)

    expect(localizer.getQueueStats().queueSize).toBe(1) // 仍是 1 个文件
    expect(await localizer.countQueuedRemoteImages()).toBe(8) // 但 8 张图
  })

  test('processQueue 每下载完一张图回调一次（单文件 8 图 → 8 次）', async () => {
    const file = createMockFile('notes/multi.md')
    mockVault.read.mockResolvedValue(imagesMarkdown('http://h', 8))

    await localizer.enqueueFile(file)
    const total = await localizer.countQueuedRemoteImages()

    let progressCalls = 0
    await localizer.processQueue(() => progressCalls++)

    expect(total).toBe(8)
    expect(progressCalls).toBe(8) // 图片级：8 次，而非文件级的 1 次
  })

  test('多文件（5 图 + 3 图）：分母=8，回调=8 次', async () => {
    const fileA = createMockFile('notes/a.md')
    const fileB = createMockFile('notes/b.md')
    mockVault.read.mockImplementation(async (f: TFile) =>
      f.path === 'notes/a.md' ? imagesMarkdown('http://h', 5) : imagesMarkdown('http://h', 3),
    )

    await localizer.enqueueFile(fileA)
    await localizer.enqueueFile(fileB)

    expect(await localizer.countQueuedRemoteImages()).toBe(8)

    let progressCalls = 0
    await localizer.processQueue(() => progressCalls++)
    expect(progressCalls).toBe(8)
  })

  test('无远程图片的文件：分母=0，无回调', async () => {
    const file = createMockFile('notes/plain.md')
    mockVault.read.mockResolvedValue('纯文本，没有任何远程图片。')

    await localizer.enqueueFile(file)
    expect(await localizer.countQueuedRemoteImages()).toBe(0)

    let progressCalls = 0
    await localizer.processQueue(() => progressCalls++)
    expect(progressCalls).toBe(0)
  })

  test('下载失败的图片也回调（进度推进，不会卡死）', async () => {
    const file = createMockFile('notes/multi.md')
    mockVault.read.mockResolvedValue(imagesMarkdown('http://h', 4))
    // 第 2 张失败，其余成功 —— 进度仍应推进 4 次
    mockDownloadImage
      .mockResolvedValueOnce({ success: true, data: new ArrayBuffer(10) })
      .mockResolvedValueOnce({ success: false, error: 'boom' })
      .mockResolvedValue({ success: true, data: new ArrayBuffer(10) })

    await localizer.enqueueFile(file)
    let progressCalls = 0
    await localizer.processQueue(() => progressCalls++)
    expect(progressCalls).toBe(4)
  })
})

describe('SyncNoticeManager 阶段进度条（图片级渲染 + 钳制）', () => {
  // 运行时用的是 src/__mocks__/obsidian.ts 的 Notice（带 .message），但 ts-jest
  // 按真实 obsidian.d.ts 的 Notice 类型（只有 messageEl）做类型检查 —— 故读消息
  // 时统一经此 helper 取 .message。
  const msgOf = (m: SyncNoticeManager): string =>
    (m['phaseNotice'] as unknown as { message: string }).message

  it('按 N 张图渲染「处理图片 k/N」，逐张推进', () => {
    const m = new SyncNoticeManager()
    m.startPhaseProgress('处理图片', 8)
    expect(msgOf(m)).toMatch(/处理图片 0\/8$/)

    for (let k = 1; k <= 8; k++) {
      m.onPhaseItemProcessed()
      expect(msgOf(m)).toMatch(new RegExp(`处理图片 ${k}/8$`))
    }
  })

  it('重试导致超额计数时显示钳制在 N/N（不出现 9/8）', () => {
    const m = new SyncNoticeManager()
    m.startPhaseProgress('处理图片', 8)
    for (let k = 0; k < 10; k++) m.onPhaseItemProcessed() // 多调 2 次
    expect(msgOf(m)).toMatch(/处理图片 8\/8$/)
    expect(msgOf(m)).not.toContain('9/8')
    expect(msgOf(m)).not.toContain('10/8')
  })
})
