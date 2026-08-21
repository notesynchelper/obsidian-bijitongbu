/**
 * 图片本地化队列行为（含 2026-07 修复后的正确语义）
 *
 * 修复前遗留缺陷（本文件曾用「通过 = 确认缺陷」钉住旧的坏行为）：
 *   问题1: localizeFile 内部吞掉单图失败、恒返回 true → 全部下载失败也被标记 processed，
 *          续传记录被清、永不重试。
 *   问题3: 下载/保存失败静默丢弃。
 * 修复后正确语义（见 tests/relayImageNotReady.repro.spec.ts）：
 *   - 有任一远程图未本地化 → localizeFile 返回 false → 文件【不】标记 processed；
 *   - 失败任务【保留】在续传清单里，交由后续同步 / 重启重试（图床未就绪属瞬态）；
 *   - 成功的图仍即时替换，失败的图保留远程链接。
 * 问题2（已修复的自愈）：仍成立——只要文件里还有远程图就允许重新入队。
 */

import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
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

// Mock 依赖模块
jest.mock('../src/imageLocalizer/imageDownloader')
jest.mock('../src/imageLocalizer/imageProcessor')
jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('test-folder'),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

const mockDownloadImage = downloadImage as jest.MockedFunction<
  typeof downloadImage
>
const mockIsRemoteImage = isRemoteImage as jest.MockedFunction<
  typeof isRemoteImage
>
const mockCalculateMD5 = calculateMD5 as jest.MockedFunction<
  typeof calculateMD5
>
const mockDetectImageFormat = detectImageFormat as jest.MockedFunction<
  typeof detectImageFormat
>
const mockSaveImageToVault = saveImageToVault as jest.MockedFunction<
  typeof saveImageToVault
>

/** 创建 mock TFile */
function createMockFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/\.md$/, '').split('/').pop() || ''
  return file
}

describe('ImageLocalizer 缺陷验证', () => {
  let localizer: ImageLocalizer
  let mockVault: {
    read: jest.Mock
    modify: jest.Mock
    process: jest.Mock
    getAbstractFileByPath: jest.Mock
    createBinary: jest.Mock
    createFolder: jest.Mock
  }
  let mockApp: { vault: typeof mockVault }

  const defaultOptions = {
    enablePngToJpeg: false,
    jpegQuality: 85,
    attachmentFolder: 'images',
    folderDateFormat: 'yyyy-MM-dd',
    maxRetries: 2,
    retryDelay: 10,
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

    mockApp = { vault: mockVault }
    localizer = new ImageLocalizer(mockApp as any, defaultOptions)

    // 默认: isRemoteImage 对 http(s) 返回 true
    mockIsRemoteImage.mockImplementation(
      (url: string) =>
        url.startsWith('http://') || url.startsWith('https://'),
    )
  })

  // ============================================================
  // 问题1: 重试机制是死代码
  // ============================================================
  describe('问题1: 全部下载失败 → 不标记 processed（修复后）', () => {
    test('全部下载失败 → 文件【不】被标记为 processed，留待后续重试', async () => {
      const file = createMockFile('test/article.md')
      const content =
        '![img1](https://example.com/1.jpg)\n![img2](https://example.com/2.jpg)'

      mockVault.read.mockResolvedValue(content)
      mockDownloadImage.mockResolvedValue({
        success: false,
        error: 'HTTP 500',
      })

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const stats = localizer.getQueueStats()
      // 修复后：所有图下载失败 → localizeFile 返回 false → 不标记 processed。
      expect(stats.processedCount).toBe(0)
      // 会话内不再立即重排狂刷（交给后续同步 / 重启重挂），故队列此刻为空。
      expect(stats.queueSize).toBe(0)
    })

    test('processQueue 阶段 vault.read 抛异常 → 视作整文件级失败，保留续传不标记 processed', async () => {
      const file = createMockFile('test/article.md')
      const contentWithImages =
        '![img](https://example.com/1.jpg)'

      // enqueueFile 阶段正常读取
      mockVault.read.mockResolvedValueOnce(contentWithImages)
      // localizeFile 阶段 vault.read 抛异常
      mockVault.read.mockRejectedValueOnce(new Error('File not found'))

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const stats = localizer.getQueueStats()
      // 修复后（codex 应修#6）：localizeFile 自管 read，读失败如实上报为整文件级失败 →
      // 返回 false → 不标记 processed、保留续传记录待重试（不再吞成「无图完成」）。
      expect(stats.processedCount).toBe(0)
    })
  })

  // ============================================================
  // 问题2: 已标记 processed 的文件不会重新入队（已修复：自愈）
  // ============================================================
  describe('问题2: 已标记 processed 的文件可以重新入队（自愈）', () => {
    test('下载全失败后再次 enqueueFile → 可重新入队重试', async () => {
      const file = createMockFile('test/article.md')
      const content = '![img](https://example.com/1.jpg)'

      mockVault.read.mockResolvedValue(content)
      mockDownloadImage.mockResolvedValue({
        success: false,
        error: 'timeout',
      })

      // 第一次: 入队 → 处理（全失败）→ 被标记 processed
      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // 第二次: 尝试重新入队（自愈允许）
      await localizer.enqueueFile(file)

      const stats = localizer.getQueueStats()
      // 修复后：文件仍有远程图片 → 允许再次入队
      expect(stats.queueSize).toBe(1)
      // 第一次全失败不再标记 processed（修复后语义）
      expect(stats.processedCount).toBe(0)
    })

    test('部分成功后再次 enqueueFile → 可重新入队处理剩余远程图片', async () => {
      const file = createMockFile('test/article.md')
      const content =
        '![img1](https://example.com/1.jpg)\n![img2](https://example.com/2.jpg)'

      mockVault.read.mockResolvedValue(content)
      // img1 成功, img2 失败
      mockDownloadImage
        .mockResolvedValueOnce({
          success: true,
          data: new ArrayBuffer(10),
        })
        .mockResolvedValueOnce({ success: false, error: 'HTTP 403' })

      mockDetectImageFormat.mockReturnValue('jpg')
      mockCalculateMD5.mockReturnValue('md5_1_MD5')
      mockSaveImageToVault.mockResolvedValue('images/md5_1_MD5.jpg')

      // 第一次处理: img1 替换成功, img2 保持远程 URL
      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // 模拟修改后的文件内容（img1 已替换, img2 仍为远程）
      mockVault.read.mockResolvedValue(
        '![[images/md5_1_MD5.jpg|img1]]\n![img2](https://example.com/2.jpg)',
      )

      // 第二次: 尝试重新入队
      await localizer.enqueueFile(file)

      const stats = localizer.getQueueStats()
      // 修复后：文件中仍有未本地化的 img2，允许重新入队
      expect(stats.queueSize).toBe(1)
    })

    test('全部成功的文件，再次 enqueueFile 时 detectRemoteImages 返回空 → 正确跳过', async () => {
      const file = createMockFile('test/done.md')
      // 文件中没有远程图片（全部已本地化）
      const content = '![[images/abc_MD5.jpg|img1]]\n![[images/def_MD5.jpg|img2]]'

      mockVault.read.mockResolvedValue(content)

      await localizer.enqueueFile(file)

      const stats = localizer.getQueueStats()
      // 正确行为: 没有远程图片 → 不入队
      expect(stats.queueSize).toBe(0)
      expect(stats.processedCount).toBe(0)
    })
  })

  // ============================================================
  // 问题3: 图片下载静默失败
  // ============================================================
  describe('问题3: 图片下载静默失败', () => {
    test('部分下载失败 → 仅替换成功的图片，失败的保持原样', async () => {
      const file = createMockFile('test/article.md')
      const content =
        '![img1](https://example.com/1.jpg)\n![img2](https://example.com/2.jpg)\n![img3](https://example.com/3.jpg)'

      mockVault.read.mockResolvedValue(content)

      // img1 成功, img2 失败, img3 成功
      mockDownloadImage
        .mockResolvedValueOnce({
          success: true,
          data: new ArrayBuffer(10),
        })
        .mockResolvedValueOnce({ success: false, error: 'HTTP 403' })
        .mockResolvedValueOnce({
          success: true,
          data: new ArrayBuffer(10),
        })

      mockDetectImageFormat.mockReturnValue('jpg')
      mockCalculateMD5
        .mockReturnValueOnce('md5_1_MD5')
        .mockReturnValueOnce('md5_3_MD5')
      mockSaveImageToVault
        .mockResolvedValueOnce('test-folder/md5_1_MD5.jpg')
        .mockResolvedValueOnce('test-folder/md5_3_MD5.jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // vault.modify 应被调用（有成功的替换）
      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modifiedContent = mockVault.modify.mock.calls[0][1] as string

      // img1 被替换为本地链接
      expect(modifiedContent).toContain('![[test-folder/md5_1_MD5.jpg|img1]]')
      // img2 保持远程 URL（下载失败）
      expect(modifiedContent).toContain(
        '![img2](https://example.com/2.jpg)',
      )
      // img3 被替换为本地链接
      expect(modifiedContent).toContain('![[test-folder/md5_3_MD5.jpg|img3]]')
    })

    test('全部下载失败 → vault.modify 不被调用', async () => {
      const file = createMockFile('test/article.md')
      const content =
        '![img1](https://example.com/1.jpg)\n![img2](https://example.com/2.jpg)'

      mockVault.read.mockResolvedValue(content)
      mockDownloadImage.mockResolvedValue({
        success: false,
        error: 'HTTP 500',
      })

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // 没有成功的替换 → vault.modify 不应被调用
      expect(mockVault.modify).not.toHaveBeenCalled()
    })

    test('下载成功但 saveImageToVault 抛异常 → 该图片被跳过', async () => {
      const file = createMockFile('test/article.md')
      const content = '![img](https://example.com/1.jpg)'

      mockVault.read.mockResolvedValue(content)
      mockDownloadImage.mockResolvedValue({
        success: true,
        data: new ArrayBuffer(10),
      })
      mockDetectImageFormat.mockReturnValue('jpg')
      mockCalculateMD5.mockReturnValue('md5_1_MD5')
      mockSaveImageToVault.mockRejectedValue(new Error('Disk full'))

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // 保存失败 → 没有替换 → vault.modify 不被调用
      expect(mockVault.modify).not.toHaveBeenCalled()

      // 修复后：保存失败 = 该图未本地化 → localizeFile 返回 false → 不标记 processed，
      // 保留续传记录待后续重试。
      const stats = localizer.getQueueStats()
      expect(stats.processedCount).toBe(0)
    })
  })
})
