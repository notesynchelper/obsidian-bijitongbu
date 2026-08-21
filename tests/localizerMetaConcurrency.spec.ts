/**
 * 钉死 meta-in-task 设计点：
 *   1. 同文件二次 enqueue：第二次的 meta 会覆盖队列中已有 task 的 meta
 *      （last-write-wins，与历史 fileSavedAtMap 二次 set 覆盖 savedAt 同语义）
 *   2. 不同文件交叉 enqueue：A/B 各自的 meta 不会串线
 *
 * 这两条共同消除了 codex review §1（fileMetaMap 共享状态竞态）的隐患。
 */

import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import {
  LocalizerItemMeta,
} from '../src/common/localizerItemMeta'
import { TFile } from 'obsidian'
import {
  downloadImage,
  isRemoteImage,
} from '../src/imageLocalizer/imageDownloader'
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

function createMockFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/\.md$/, '').split('/').pop() || ''
  return file
}

function makeVault(byPath: Map<string, string>) {
  const vault: any = {
    read: jest.fn((file: TFile) => Promise.resolve(byPath.get(file.path) || '')),
    modify: jest.fn(),
    process: null as any,
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
    createBinary: jest.fn(),
    createFolder: jest.fn(),
  }
  vault.process = jest
    .fn()
    .mockImplementation(async (file: any, fn: (s: string) => string) => {
      const c = await vault.read(file)
      const r = fn(c)
      await vault.modify(file, r)
      return r
    })
  return vault
}

const DATE = '2026-05-25'
const SAVED_AT = '2026-05-25T10:30:00.000Z'

describe('§A 同文件二次 enqueue：meta last-write-wins', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsRemoteImage.mockImplementation(
      (u: string) => u.startsWith('http://') || u.startsWith('https://'),
    )
  })

  test('第二次 enqueue 提供的 meta 覆盖排队中 task 的 meta', async () => {
    const file = createMockFile('notes/a.md')
    const vault = makeVault(new Map([[file.path, '![](https://x/1.jpg)']]))
    const localizer = new ImageLocalizer({ vault } as any, {
      enablePngToJpeg: false,
      jpegQuality: 85,
      attachmentFolder: '{{{siteName}}}/{{{title}}}',
      folderDateFormat: DATE,
      maxRetries: 1,
      retryDelay: 1,
    })

    mockDownloadImage.mockResolvedValueOnce({
      success: true,
      data: new ArrayBuffer(10),
    })
    mockDetectImageFormat.mockReturnValueOnce('jpg')
    mockCalculateMD5.mockReturnValueOnce('m1')
    mockSaveImageToVault.mockImplementation(
      async (_v: any, folder: string, name: string) => `${folder}/${name}`,
    )

    const metaV1: LocalizerItemMeta = { savedAt: SAVED_AT, siteName: 'first.com' }
    const metaV2: LocalizerItemMeta = { savedAt: SAVED_AT, siteName: 'second.com' }

    // enqueue 两次：先 V1 入队，再 V2 触发 "已在队列" 早退路径但覆盖 meta
    await localizer.enqueueFile(file, metaV1)
    await localizer.enqueueFile(file, metaV2)
    await localizer.processQueue()

    expect(mockSaveImageToVault).toHaveBeenCalledTimes(1)
    const [, folder] = mockSaveImageToVault.mock.calls[0]
    // 用第二次的 siteName
    expect(folder).toBe('second.com/a')
  })

  test('第二次 enqueue 不传 meta 时保留第一次的 meta（不丢）', async () => {
    const file = createMockFile('notes/b.md')
    const vault = makeVault(new Map([[file.path, '![](https://x/1.jpg)']]))
    const localizer = new ImageLocalizer({ vault } as any, {
      enablePngToJpeg: false,
      jpegQuality: 85,
      attachmentFolder: '{{{siteName}}}/{{{title}}}',
      folderDateFormat: DATE,
      maxRetries: 1,
      retryDelay: 1,
    })

    mockDownloadImage.mockResolvedValueOnce({
      success: true,
      data: new ArrayBuffer(10),
    })
    mockDetectImageFormat.mockReturnValueOnce('jpg')
    mockCalculateMD5.mockReturnValueOnce('m1')
    mockSaveImageToVault.mockImplementation(
      async (_v: any, folder: string, name: string) => `${folder}/${name}`,
    )

    await localizer.enqueueFile(file, {
      savedAt: SAVED_AT,
      siteName: 'keep.me',
    })
    await localizer.enqueueFile(file) // 不传 meta，已有 meta 不应被清掉
    await localizer.processQueue()

    const [, folder] = mockSaveImageToVault.mock.calls[0]
    expect(folder).toBe('keep.me/b')
  })
})

describe('§B 不同文件交叉 enqueue：meta 不串线', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsRemoteImage.mockImplementation(
      (u: string) => u.startsWith('http://') || u.startsWith('https://'),
    )
  })

  test('A、B 两文件分别走各自 meta，落盘 folder 各自正确', async () => {
    const fileA = createMockFile('notes/a.md')
    const fileB = createMockFile('notes/b.md')
    const vault = makeVault(
      new Map([
        [fileA.path, '![](https://x/a.jpg)'],
        [fileB.path, '![](https://x/b.jpg)'],
      ]),
    )
    const localizer = new ImageLocalizer({ vault } as any, {
      enablePngToJpeg: false,
      jpegQuality: 85,
      attachmentFolder: '{{{siteName}}}/{{{author}}}/{{{title}}}',
      folderDateFormat: DATE,
      maxRetries: 1,
      retryDelay: 1,
    })

    mockDownloadImage.mockResolvedValue({
      success: true,
      data: new ArrayBuffer(10),
    })
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockReturnValueOnce('mA').mockReturnValueOnce('mB')
    mockSaveImageToVault.mockImplementation(
      async (_v: any, folder: string, name: string) => `${folder}/${name}`,
    )

    await localizer.enqueueFile(fileA, {
      savedAt: SAVED_AT,
      siteName: 'site-a.com',
      author: 'Alice',
    })
    await localizer.enqueueFile(fileB, {
      savedAt: SAVED_AT,
      siteName: 'site-b.com',
      author: 'Bob',
    })
    await localizer.processQueue()

    expect(mockSaveImageToVault).toHaveBeenCalledTimes(2)
    const folders = mockSaveImageToVault.mock.calls.map((c) => c[1]).sort()
    // 两个 folder 各自带正确的 siteName/author
    expect(folders).toEqual(['site-a.com/Alice/a', 'site-b.com/Bob/b'])
  })
})
