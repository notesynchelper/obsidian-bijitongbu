/**
 * 同步覆盖图片本地化结果 — 修复验证
 *
 * 修复前的核心问题：
 * 1. 第一轮同步 → 图片本地化成功（远程 URL 替换为本地链接）
 * 2. 第二轮同步 → vault.modify 用 API 原始内容覆盖文件（远程 URL 回来了）
 * 3. ImageLocalizer 的 processedFiles 阻止对同一文件二次本地化
 * 4. 最终：本地图片文件存在，但 Markdown 中引用的仍是远程链接
 *
 * 修复策略：
 * - Bug A: 在 FileProcessor / MergeProcessor 写入前 replay 已知 url→localPath 映射
 * - Bug B: 移除 localizer/queue 的 processedFiles 早退，失败时可以自愈重跑
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

function mockSuccessfulImageProcess(md5: string, format: string, folder = 'attachments') {
  mockDownloadImage.mockResolvedValueOnce({
    success: true,
    data: new ArrayBuffer(100),
  })
  mockDetectImageFormat.mockReturnValueOnce(format)
  mockCalculateMD5.mockReturnValueOnce(`${md5}_MD5`)
  mockSaveImageToVault.mockResolvedValueOnce(`${folder}/${md5}_MD5.${format}`)
}

describe('同步覆盖图片本地化结果', () => {
  let localizer: ImageLocalizer

  /** 模拟 vault 中文件的实际内容，sync 和 localizer 的 modify/process 都读写这里 */
  let fileContent: string

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
    retryDelay: 10,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    fileContent = ''

    mockVault = {
      read: jest.fn().mockImplementation(() => Promise.resolve(fileContent)),
      modify: jest.fn().mockImplementation((_file: any, content: string) => {
        fileContent = content
        return Promise.resolve()
      }),
      process: jest.fn().mockImplementation(async (_file: any, fn: (data: string) => string) => {
        const result = fn(fileContent)
        fileContent = result
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

  /**
   * 模拟 FileProcessor 写入：用 API 原始内容覆盖文件
   */
  function simulateSyncWrite(file: TFile, apiContent: string): void {
    // FileProcessor.updateFileIfNeeded → vault.modify(file, newContent)
    fileContent = apiContent
  }

  /**
   * 模拟同步后的本地化入队 + 处理
   */
  async function simulateLocalization(file: TFile): Promise<void> {
    await localizer.enqueueFile(file)
    await localizer.processQueue()
  }

  // ============================================================
  // 用例 1: 核心复现 — 二次同步覆盖本地化结果（单文件模式）
  // ============================================================
  describe('用例 1: 二次同步覆盖本地化结果', () => {
    const REMOTE_URL = 'https://example.com/photo.jpg'
    const API_CONTENT = `# 文章标题\n\n![图片](${REMOTE_URL})\n\n正文内容`
    const LOCAL_LINK = '![[attachments/md5photo_MD5.jpg|图片]]'

    test('第一轮同步 + 本地化成功 → 文件包含本地链接', async () => {
      const file = createMockFile('notes/article.md')

      // 同步写入
      simulateSyncWrite(file, API_CONTENT)

      // 设置下载 mock + 执行本地化
      mockSuccessfulImageProcess('md5photo', 'jpg')
      await simulateLocalization(file)

      expect(fileContent).toContain(LOCAL_LINK)
      expect(fileContent).not.toContain(REMOTE_URL)
    })

    test('第二轮同步覆盖后 localizer 自愈恢复本地化结果', async () => {
      const file = createMockFile('notes/article.md')

      // === 第一轮同步 + 本地化 ===
      simulateSyncWrite(file, API_CONTENT)
      mockSuccessfulImageProcess('md5photo', 'jpg')
      await simulateLocalization(file)

      // 第一轮后本地化成功
      expect(fileContent).toContain(LOCAL_LINK)
      expect(fileContent).not.toContain(REMOTE_URL)

      // === 第二轮同步 (syncOnStart / 定时同步) ===
      // 这里直接写入原始内容，模拟 replay 未生效/未启用的情况下 FileProcessor 会产生的结果
      simulateSyncWrite(file, API_CONTENT)

      // 文件被覆盖回远程 URL
      expect(fileContent).toContain(REMOTE_URL)
      expect(fileContent).not.toContain(LOCAL_LINK)

      // 同步后 localizer 自愈：processedFiles 不再拦截，会重新下载并替换
      mockSuccessfulImageProcess('md5photo', 'jpg')
      await simulateLocalization(file)

      expect(fileContent).toContain(LOCAL_LINK)
      expect(fileContent).not.toContain(REMOTE_URL)
    })
  })

  // ============================================================
  // 用例 2: 合并模式下同样的覆盖问题
  // ============================================================
  describe('用例 2: 合并模式同步覆盖', () => {
    const REMOTE_URL = 'https://cdn.example.com/img.png'
    const API_CONTENT = `---\ntitle: 合并笔记\n---\n\n## 条目1\n![](${REMOTE_URL})\n`

    test('合并模式下 localizer 自愈重跑恢复本地化结果', async () => {
      const file = createMockFile('omnivore/merged.md')

      // === 第一轮同步（合并模式 vault.process 写入）===
      simulateSyncWrite(file, API_CONTENT)
      mockSuccessfulImageProcess('md5merge', 'png')
      await simulateLocalization(file)

      expect(fileContent).toContain('![[attachments/md5merge_MD5.png]]')
      expect(fileContent).not.toContain(REMOTE_URL)

      // === 第二轮同步（合并模式再次写入）===
      simulateSyncWrite(file, API_CONTENT)
      expect(fileContent).toContain(REMOTE_URL)

      // 自愈：processedFiles 不再拦截，再次触发下载
      mockSuccessfulImageProcess('md5merge', 'png')
      await simulateLocalization(file)

      expect(fileContent).toContain('![[attachments/md5merge_MD5.png]]')
      expect(fileContent).not.toContain(REMOTE_URL)
    })
  })

  // ============================================================
  // 用例 3: 部分成功后被覆盖 — 已成功的丢失，失败的也无法重试
  // ============================================================
  describe('用例 3: 部分成功 + 覆盖 = 全部丢失', () => {
    const URL_1 = 'https://example.com/1.jpg'
    const URL_2 = 'https://example.com/2.jpg'
    const URL_3 = 'https://example.com/3.jpg'
    const API_CONTENT = `![a](${URL_1})\n![b](${URL_2})\n![c](${URL_3})`

    test('部分成功被覆盖后 localizer 自愈全部重跑', async () => {
      const file = createMockFile('notes/partial.md')

      // === 第一轮: 图 1、3 成功，图 2 失败 ===
      simulateSyncWrite(file, API_CONTENT)
      mockSuccessfulImageProcess('md5_1', 'jpg')
      mockDownloadImage.mockResolvedValueOnce({ success: false, error: 'timeout' })
      mockSuccessfulImageProcess('md5_3', 'jpg')
      await simulateLocalization(file)

      // 第一轮后: 图 1、3 本地化，图 2 保持远程
      expect(fileContent).toContain('![[attachments/md5_1_MD5.jpg|a]]')
      expect(fileContent).toContain(`![b](${URL_2})`) // 图 2 失败
      expect(fileContent).toContain('![[attachments/md5_3_MD5.jpg|c]]')

      // === 第二轮同步: API 返回 3 张全是远程 URL ===
      simulateSyncWrite(file, API_CONTENT)

      // 自愈: 再次入队并处理，这次 3 张全部成功
      mockSuccessfulImageProcess('md5_1', 'jpg')
      mockSuccessfulImageProcess('md5_2', 'jpg')
      mockSuccessfulImageProcess('md5_3', 'jpg')
      await simulateLocalization(file)

      expect(fileContent).not.toContain(URL_1)
      expect(fileContent).not.toContain(URL_2)
      expect(fileContent).not.toContain(URL_3)
    })
  })

  // ============================================================
  // 用例 4: processedFiles 跨同步周期持久性
  // ============================================================
  describe('用例 4: processedFiles 跨同步持久', () => {
    test('【缺陷】同一 localizer 实例的 processedFiles 阻止已覆盖文件重新入队', async () => {
      const fileA = createMockFile('notes/a.md')
      const fileB = createMockFile('notes/b.md')
      const contentA = '![](https://example.com/a.jpg)'
      const contentB = '![](https://example.com/b.jpg)'

      // === 第一轮同步: 处理 file-A ===
      simulateSyncWrite(fileA, contentA)
      mockSuccessfulImageProcess('md5_a', 'jpg')
      await simulateLocalization(fileA)

      // === 第一轮同步: 处理 file-B ===
      simulateSyncWrite(fileB, contentB)
      mockSuccessfulImageProcess('md5_b', 'jpg')
      await simulateLocalization(fileB)

      expect(localizer.getQueueStats().processedCount).toBe(2)

      // === 第二轮同步: 两个文件都被覆盖回远程 URL ===
      // 模拟 sync 覆盖 file-A 后尝试入队
      simulateSyncWrite(fileA, contentA)
      await localizer.enqueueFile(fileA)

      // 模拟 sync 覆盖 file-B 后尝试入队
      simulateSyncWrite(fileB, contentB)
      await localizer.enqueueFile(fileB)

      // BUG: 两个文件都因 processedFiles 无法重新入队
      // 预期正确行为: 检测到文件仍有远程图片，应重新入队
      const stats = localizer.getQueueStats()
      expect(stats.queueSize).toBeGreaterThan(0)
    })
  })

  // ============================================================
  // 用例 5: clearProcessedMark 作为兼容接口仍然可用
  // ============================================================
  describe('用例 5: clearProcessedMark 兼容接口', () => {
    const REMOTE_URL = 'https://example.com/photo.jpg'
    const API_CONTENT = `![图片](${REMOTE_URL})`

    test('clearProcessedMark 调用后依然可以重新本地化', async () => {
      const file = createMockFile('notes/recoverable.md')

      // === 第一轮同步 + 本地化 ===
      simulateSyncWrite(file, API_CONTENT)
      mockSuccessfulImageProcess('md5rec', 'jpg')
      await simulateLocalization(file)

      expect(fileContent).toContain('![[attachments/md5rec_MD5.jpg|图片]]')
      expect(fileContent).not.toContain(REMOTE_URL)

      // === 第二轮同步覆盖 ===
      simulateSyncWrite(file, API_CONTENT)
      expect(fileContent).toContain(REMOTE_URL)

      // 手动调用 clearProcessedMark —— 作为兼容接口不应破坏后续流程
      localizer.clearProcessedMark(file.path)

      mockSuccessfulImageProcess('md5rec', 'jpg')
      await localizer.enqueueFile(file)
      expect(localizer.getQueueStats().queueSize).toBe(1)

      await localizer.processQueue()
      expect(fileContent).toContain('![[attachments/md5rec_MD5.jpg|图片]]')
      expect(fileContent).not.toContain(REMOTE_URL)
    })
  })

  // ============================================================
  // 用例 6: replayLocalizedUrls —— 写入前直接阻止远程 URL 落盘
  // ============================================================
  describe('用例 6: replayLocalizedUrls 在 sync 写入前替换已知 URL', () => {
    const REMOTE_URL = 'https://example.com/replay.jpg'
    const API_CONTENT = `# 标题\n\n![图片](${REMOTE_URL})\n`
    const LOCAL_LINK = '![[attachments/md5replay_MD5.jpg|图片]]'

    test('已本地化过的 URL 在 replay 后被替换为本地链接', async () => {
      const file = createMockFile('notes/replay.md')

      // 首次本地化，urlLocalMap 中记录映射
      simulateSyncWrite(file, API_CONTENT)
      mockSuccessfulImageProcess('md5replay', 'jpg')
      await simulateLocalization(file)

      expect(fileContent).toContain(LOCAL_LINK)

      // 让 vault.getAbstractFileByPath 命中"本地文件存在"
      mockVault.getAbstractFileByPath = jest.fn().mockImplementation(
        (path: string) => (path === 'attachments/md5replay_MD5.jpg' ? { path } : null),
      )
      ;(localizer as any).vault = mockVault as any

      // 模拟 sync 想要写入的原始 API 内容：经过 replay 后远程 URL 已被替换
      const replayed = localizer.replayLocalizedUrls(API_CONTENT, file.path)
      expect(replayed).toContain(LOCAL_LINK)
      expect(replayed).not.toContain(REMOTE_URL)
    })

    test('未知 URL 在 replay 中保持原样', () => {
      const file = createMockFile('notes/unknown.md')
      const content = '![x](https://unknown.example.com/x.jpg)'
      const replayed = localizer.replayLocalizedUrls(content, file.path)
      expect(replayed).toBe(content)
    })

    test('本地文件已被删除时 replay 回退为原远程链接', async () => {
      const file = createMockFile('notes/stale.md')
      const url = 'https://example.com/stale.jpg'
      const content = `![旧图](${url})`

      // 第一次本地化成功并回填映射
      simulateSyncWrite(file, content)
      mockDownloadImage.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(1) })
      mockDetectImageFormat.mockReturnValueOnce('jpg')
      mockCalculateMD5.mockReturnValueOnce('md5stale_MD5')
      mockSaveImageToVault.mockResolvedValueOnce('attachments/md5stale_MD5.jpg')
      await simulateLocalization(file)

      // vault 中该本地文件"不存在"（模拟用户删除）
      mockVault.getAbstractFileByPath = jest.fn().mockReturnValue(null)
      ;(localizer as any).vault = mockVault as any

      const replayed = localizer.replayLocalizedUrls(content, file.path)
      // 回退：remote URL 保留
      expect(replayed).toContain(url)
    })

    test('replay 不应改写 📎 前缀的附件同 URL 链接', async () => {
      const file = createMockFile('notes/mixed.md')
      const sharedUrl = 'https://sync.bijitongbu.site/mixed.bin'
      // 第一行是普通强制本地化链接，第二行是附件链接（带 📎）。
      // 本地化器只应处理第一行；replay 不能把第二行也改写。
      const content = [
        `[资源](${sharedUrl})`,
        `📎 [资源](${sharedUrl})`,
      ].join('\n')

      simulateSyncWrite(file, content)
      mockDownloadImage.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(1) })
      mockDetectImageFormat.mockReturnValueOnce('jpg')
      mockCalculateMD5.mockReturnValueOnce('md5mix_MD5')
      mockSaveImageToVault.mockResolvedValueOnce('attachments/md5mix_MD5.jpg')
      await simulateLocalization(file)

      // 第一行已变为 wiki 链接，第二行保留原样
      expect(fileContent).toContain('![[attachments/md5mix_MD5.jpg|资源]]')
      expect(fileContent).toContain(`📎 [资源](${sharedUrl})`)

      // replay 模拟 sync 二次写入原始内容
      mockVault.getAbstractFileByPath = jest.fn().mockImplementation((p: string) =>
        p === 'attachments/md5mix_MD5.jpg' ? { path: p } : null,
      )
      ;(localizer as any).vault = mockVault as any

      const replayed = localizer.replayLocalizedUrls(content, file.path)
      expect(replayed).toContain('![[attachments/md5mix_MD5.jpg|资源]]')
      // 📎 附件行必须原样保留
      expect(replayed).toContain(`📎 [资源](${sharedUrl})`)
    })

    test('两个笔记含有相同远程 URL 时各自独立映射', async () => {
      const fileA = createMockFile('notes/a.md')
      const fileB = createMockFile('notes/b.md')
      const sharedUrl = 'https://example.com/shared.jpg'
      const contentA = `![A](${sharedUrl})`
      const contentB = `![B](${sharedUrl})`

      // A 落到 "attachments/md5A_MD5.jpg"
      simulateSyncWrite(fileA, contentA)
      mockDownloadImage.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(1) })
      mockDetectImageFormat.mockReturnValueOnce('jpg')
      mockCalculateMD5.mockReturnValueOnce('md5A_MD5')
      mockSaveImageToVault.mockResolvedValueOnce('attachments/md5A_MD5.jpg')
      await simulateLocalization(fileA)

      // B 落到 "attachments/md5B_MD5.jpg"
      simulateSyncWrite(fileB, contentB)
      mockDownloadImage.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(1) })
      mockDetectImageFormat.mockReturnValueOnce('jpg')
      mockCalculateMD5.mockReturnValueOnce('md5B_MD5')
      mockSaveImageToVault.mockResolvedValueOnce('attachments/md5B_MD5.jpg')
      await simulateLocalization(fileB)

      // 让两个本地附件都"存在"
      mockVault.getAbstractFileByPath = jest.fn().mockImplementation((p: string) =>
        p === 'attachments/md5A_MD5.jpg' || p === 'attachments/md5B_MD5.jpg' ? { path: p } : null,
      )
      ;(localizer as any).vault = mockVault as any

      const replayedA = localizer.replayLocalizedUrls(contentA, fileA.path)
      const replayedB = localizer.replayLocalizedUrls(contentB, fileB.path)

      expect(replayedA).toContain('attachments/md5A_MD5.jpg')
      expect(replayedA).not.toContain('md5B_MD5')
      expect(replayedB).toContain('attachments/md5B_MD5.jpg')
      expect(replayedB).not.toContain('md5A_MD5')
    })
  })
})
