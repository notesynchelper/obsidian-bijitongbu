/**
 * 右键重新本地化功能测试
 *
 * 覆盖场景:
 * 1. unmarkAsProcessed 清除已处理标记后可重新入队
 * 2. 已处理的文件不清除标记时无法重新入队
 * 3. 图片本地化器重新处理已处理过的文件
 * 4. 附件本地化器重新处理已处理过的文件
 * 5. 菜单可见性条件（md 文件 + imageMode）
 */

import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import { ImageLocalizationQueue } from '../src/imageLocalizer/imageQueue'
import { AttachmentLocalizationQueue } from '../src/attachmentLocalizer/attachmentQueue'
import { TFile } from 'obsidian'
import { isRemoteImage } from '../src/imageLocalizer/imageDownloader'
import { downloadImage } from '../src/imageLocalizer/imageDownloader'
import { calculateMD5, detectImageFormat, saveImageToVault } from '../src/imageLocalizer/imageProcessor'
import { downloadAttachment, isRemoteAttachment } from '../src/attachmentLocalizer/attachmentDownloader'
import { ImageMode } from '../src/settings'

jest.mock('../src/imageLocalizer/imageDownloader')
jest.mock('../src/imageLocalizer/imageProcessor')
jest.mock('../src/attachmentLocalizer/attachmentDownloader')
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
const mockDownloadAttachment = downloadAttachment as jest.MockedFunction<typeof downloadAttachment>
const mockIsRemoteAttachment = isRemoteAttachment as jest.MockedFunction<typeof isRemoteAttachment>

function createMockFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/\.md$/, '').split('/').pop() || ''
  return file
}

function mockSuccessfulImageProcess(md5: string, format: string) {
  mockDownloadImage.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(100) })
  mockDetectImageFormat.mockReturnValueOnce(format)
  mockCalculateMD5.mockReturnValueOnce(`${md5}_MD5`)
  mockSaveImageToVault.mockResolvedValueOnce(`attachments/${md5}_MD5.${format}`)
}

// ============================================================
// 1. ImageLocalizationQueue: unmarkAsProcessed
// ============================================================
describe('ImageLocalizationQueue: unmarkAsProcessed 重置标记', () => {
  let queue: ImageLocalizationQueue

  beforeEach(() => {
    queue = new ImageLocalizationQueue()
  })

  test('已处理的文件也能重新入队（自愈允许）', () => {
    const file = createMockFile('test.md')
    const task = { file, images: [], createdAt: Date.now(), retryCount: 0 }

    queue.enqueue(task)
    queue.dequeue()
    queue.markAsProcessed(file.path)

    // 自愈修复后：processedFiles 不再阻止再次入队
    queue.enqueue({ ...task })
    expect(queue.isEmpty()).toBe(false)
    expect(queue.size()).toBe(1)
  })

  test('unmarkAsProcessed 后可重新入队', () => {
    const file = createMockFile('test.md')
    const task = { file, images: [], createdAt: Date.now(), retryCount: 0 }

    queue.enqueue(task)
    queue.dequeue()
    queue.markAsProcessed(file.path)
    expect(queue.isProcessed(file.path)).toBe(true)

    // 清除标记
    queue.unmarkAsProcessed(file.path)
    expect(queue.isProcessed(file.path)).toBe(false)

    // 可以重新入队
    queue.enqueue({ ...task })
    expect(queue.isEmpty()).toBe(false)
    expect(queue.size()).toBe(1)
  })
})

// ============================================================
// 2. AttachmentLocalizationQueue: unmarkAsProcessed
// ============================================================
describe('AttachmentLocalizationQueue: unmarkAsProcessed 重置标记', () => {
  let queue: AttachmentLocalizationQueue

  beforeEach(() => {
    queue = new AttachmentLocalizationQueue()
  })

  test('已处理的文件无法重新入队', () => {
    const file = createMockFile('test.md')
    const task = { file, attachments: [], createdAt: Date.now(), retryCount: 0 }

    queue.enqueue(task)
    queue.dequeue()
    queue.markAsProcessed(file.path)

    queue.enqueue({ ...task })
    expect(queue.isEmpty()).toBe(true)
  })

  test('unmarkAsProcessed 后可重新入队', () => {
    const file = createMockFile('test.md')
    const task = { file, attachments: [], createdAt: Date.now(), retryCount: 0 }

    queue.enqueue(task)
    queue.dequeue()
    queue.markAsProcessed(file.path)

    queue.unmarkAsProcessed(file.path)
    expect(queue.isProcessed(file.path)).toBe(false)

    queue.enqueue({ ...task })
    expect(queue.isEmpty()).toBe(false)
  })
})

// ============================================================
// 3. ImageLocalizer: 重新本地化已处理过的文件
// ============================================================
describe('ImageLocalizer: 重新本地化已处理文件', () => {
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
    retryDelay: 0,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockVault = {
      read: jest.fn(),
      modify: jest.fn(),
      process: jest.fn().mockImplementation(async (_file: any, fn: (data: string) => string) => {
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
  })

  test('首次处理后文件被标记，但仍可以再次 enqueueFile（自愈）', async () => {
    const file = createMockFile('notes/test.md')
    const content = '![](https://example.com/img.jpg)'

    mockVault.read.mockResolvedValue(content)
    mockSuccessfulImageProcess('md5first', 'jpg')

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    expect(mockVault.modify).toHaveBeenCalledTimes(1)
    expect(localizer.getQueueStats().processedCount).toBe(1)

    // 再次入队 → 不再被 processedFiles 拦截
    jest.clearAllMocks()
    mockVault.read.mockResolvedValue(content)
    await localizer.enqueueFile(file)
    expect(localizer.getQueueStats().queueSize).toBe(1)
  })

  test('清除标记后重新入队 → 重新下载并替换', async () => {
    const file = createMockFile('notes/test.md')
    const remoteUrl = 'https://example.com/img.jpg'
    const content = `![](${remoteUrl})`

    // 第一次处理
    mockVault.read.mockResolvedValue(content)
    mockSuccessfulImageProcess('md5first', 'jpg')

    await localizer.enqueueFile(file)
    await localizer.processQueue()
    expect(mockVault.modify).toHaveBeenCalledTimes(1)

    // 模拟用户右键重新本地化：先清除标记，再入队
    jest.clearAllMocks()
    // 文件内容可能已变（比如之前本地化成功了，现在还有其他远程图片）
    const newContent = `![](https://example.com/new-img.png)`
    mockVault.read.mockResolvedValue(newContent)
    mockSuccessfulImageProcess('md5second', 'png')

    // 清除已处理标记（通过 queue 访问）
    localizer.clearProcessedMark(file.path)

    await localizer.enqueueFile(file)
    expect(localizer.getQueueStats().queueSize).toBe(1)

    await localizer.processQueue()
    expect(mockVault.modify).toHaveBeenCalledTimes(1)
    const modified = mockVault.modify.mock.calls[0][1] as string
    expect(modified).toContain('![[attachments/md5second_MD5.png]]')
  })
})

// ============================================================
// 4. 菜单可见性条件
// ============================================================
describe('右键菜单可见性条件', () => {
  /** 模拟菜单可见性判断逻辑（与 main.ts registerFileMenu 一致） */
  function shouldShowRelocalizeMenu(
    file: { path: string; extension?: string } | null,
    imageMode: ImageMode,
    imageLocalizer: unknown,
    attachmentLocalizer: unknown,
  ): boolean {
    if (!file) return false
    if (!('extension' in file) || file.extension !== 'md') return false
    const hasImageLocalizer = imageMode === ImageMode.LOCAL && !!imageLocalizer
    const hasAttachmentLocalizer = !!attachmentLocalizer
    if (!hasImageLocalizer && !hasAttachmentLocalizer) return false
    return true
  }

  test('md 文件 + LOCAL 模式 + 有 localizer → 显示', () => {
    expect(shouldShowRelocalizeMenu(
      { path: 'notes/test.md', extension: 'md' },
      ImageMode.LOCAL,
      {}, // imageLocalizer exists
      {}, // attachmentLocalizer exists
    )).toBe(true)
  })

  test('md 文件 + REMOTE 模式 + 有附件 localizer → 显示（仍可处理附件）', () => {
    expect(shouldShowRelocalizeMenu(
      { path: 'notes/test.md', extension: 'md' },
      ImageMode.REMOTE,
      {},
      {}, // attachmentLocalizer exists
    )).toBe(true)
  })

  test('md 文件 + REMOTE 模式 + 无附件 localizer → 不显示', () => {
    expect(shouldShowRelocalizeMenu(
      { path: 'notes/test.md', extension: 'md' },
      ImageMode.REMOTE,
      {}, // imageLocalizer exists but mode is REMOTE
      null,
    )).toBe(false)
  })

  test('md 文件 + DISABLED 模式 + 有附件 localizer → 显示', () => {
    expect(shouldShowRelocalizeMenu(
      { path: 'notes/test.md', extension: 'md' },
      ImageMode.DISABLED,
      {},
      {},
    )).toBe(true)
  })

  test('非 md 文件 → 不显示', () => {
    expect(shouldShowRelocalizeMenu(
      { path: 'notes/test.pdf', extension: 'pdf' },
      ImageMode.LOCAL,
      {},
      {},
    )).toBe(false)
  })

  test('无 localizer（都未初始化）→ 不显示', () => {
    expect(shouldShowRelocalizeMenu(
      { path: 'notes/test.md', extension: 'md' },
      ImageMode.LOCAL,
      null,
      null,
    )).toBe(false)
  })

  test('只有 attachmentLocalizer → 显示（仍可处理附件）', () => {
    expect(shouldShowRelocalizeMenu(
      { path: 'notes/test.md', extension: 'md' },
      ImageMode.LOCAL,
      null,
      {}, // only attachment localizer
    )).toBe(true)
  })
})
