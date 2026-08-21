/**
 * 图片本地化完整流程测试
 * 覆盖: 检测 → 下载 → 保存 → 替换链接 → 写回文件
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

/** 模拟一次成功的图片下载+保存流程 */
function mockSuccessfulImageProcess(md5: string, format: string, folder = 'attachments') {
  mockDownloadImage.mockResolvedValueOnce({
    success: true,
    data: new ArrayBuffer(100),
  })
  mockDetectImageFormat.mockReturnValueOnce(format)
  mockCalculateMD5.mockReturnValueOnce(`${md5}_MD5`)
  mockSaveImageToVault.mockResolvedValueOnce(`${folder}/${md5}_MD5.${format}`)
}

describe('图片本地化完整流程', () => {
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

    localizer = new ImageLocalizer({ vault: mockVault } as any, defaultOptions)

    mockIsRemoteImage.mockImplementation(
      (url: string) => url.startsWith('http://') || url.startsWith('https://'),
    )
  })

  // ============================================================
  // 核心场景: sync.bijitongbu.site 无后缀图片
  // ============================================================
  describe('sync.bijitongbu.site 无后缀图片本地化', () => {
    test('![](http://sync.bijitongbu.site/wecom31/.../hash) → 下载+替换为 wiki 链接', async () => {
      const file = createMockFile('notes/test.md')
      const url = 'http://sync.bijitongbu.site/wecom31/2026/03/db97ce35b5f8de6de3d3ca7f6da7a4ad'
      const content = `一些文字\n![](${url})\n更多文字`

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('abc123', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modified = mockVault.modify.mock.calls[0][1] as string
      // 原链接应被替换
      expect(modified).not.toContain(url)
      // 应替换为 wiki 链接（无 alt → 无 |alt 后缀）
      expect(modified).toContain('![[attachments/abc123_MD5.jpg]]')
      // 其他文字不变
      expect(modified).toContain('一些文字')
      expect(modified).toContain('更多文字')
    })

    test('多张 sync.bijitongbu.site 图片全部替换', async () => {
      const file = createMockFile('notes/test.md')
      const url1 = 'http://sync.bijitongbu.site/wecom31/2026/03/aaa'
      const url2 = 'http://sync.bijitongbu.site/wecom31/2026/03/bbb'
      const content = `![](${url1})\n段落\n![](${url2})`

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5aaa', 'jpg')
      mockSuccessfulImageProcess('md5bbb', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).not.toContain(url1)
      expect(modified).not.toContain(url2)
      expect(modified).toContain('![[attachments/md5aaa_MD5.jpg]]')
      expect(modified).toContain('![[attachments/md5bbb_MD5.jpg]]')
    })

    test('普通链接 [text](sync.bijitongbu.site/...) 也被本地化并替换', async () => {
      const file = createMockFile('notes/test.md')
      const url = 'https://sync.bijitongbu.site/wecom31/2026/03/hash123'
      const content = `[附件](${url})`

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('hash1', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).not.toContain(url)
      // 普通链接的 linkText 作为 alt
      expect(modified).toContain('![[attachments/hash1_MD5.jpg|附件]]')
    })
  })

  // ============================================================
  // 各种图片语法的替换
  // ============================================================
  describe('不同图片语法的链接替换', () => {
    test('![alt](url) 有 alt → 替换为 ![[local|alt]]', async () => {
      const file = createMockFile('notes/test.md')
      const content = '![我的图片](https://example.com/photo.jpg)'

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5photo', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toBe('![[attachments/md5photo_MD5.jpg|我的图片]]')
    })

    test('![](url) 空 alt → 替换为 ![[local]]（无 alt 后缀）', async () => {
      const file = createMockFile('notes/test.md')
      const content = '![](https://example.com/photo.jpg)'

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5photo', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toBe('![[attachments/md5photo_MD5.jpg]]')
    })

    test('![[url]] wiki 格式 → 替换为 ![[local]]', async () => {
      const file = createMockFile('notes/test.md')
      const content = '![[https://example.com/photo.jpg]]'

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5photo', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toBe('![[attachments/md5photo_MD5.jpg]]')
    })

    test('<img src="url"> HTML 格式 → 整标签吞掉，不残留 ">"（2026-06-12 修复）', async () => {
      const file = createMockFile('notes/test.md')
      const content = '<img src="https://example.com/photo.jpg">'

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5photo', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      // 历史缺陷：IMAGE_PATTERN 的 <img> 分支只匹配到 src 闭合引号，替换后
      // 残留 ">"。修复后整个标签被吞掉；独占一行（HTML 块上下文）时嵌入用
      // 空行提为独立 markdown 块，保证 Obsidian 渲染。
      expect(modified).toBe('\n\n![[attachments/md5photo_MD5.jpg]]\n\n')
    })
  })

  // ============================================================
  // 替换正确性
  // ============================================================
  describe('替换正确性验证', () => {
    test('同一 URL 出现多次 → 全部替换', async () => {
      const file = createMockFile('notes/test.md')
      const url = 'https://example.com/photo.jpg'
      const content = `![](${url})\n文字\n![](${url})`

      mockVault.read.mockResolvedValue(content)
      // processImage 会对同一 URL 第二次使用 MD5 缓存，但第一次需要下载
      mockSuccessfulImageProcess('md5dup', 'jpg')
      // 第二次同 URL: processImage 走 md5Cache，checkLocalImageExists
      // 由于 getAbstractFileByPath 返回 null，会重新下载
      mockSuccessfulImageProcess('md5dup', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      // split().join() 会替换所有出现的位置
      expect(modified).toBe('![[attachments/md5dup_MD5.jpg]]\n文字\n![[attachments/md5dup_MD5.jpg]]')
      expect(modified).not.toContain(url)
    })

    test('不同格式混合 → 各自正确替换', async () => {
      const file = createMockFile('notes/test.md')
      const content = [
        '![alt1](https://a.com/1.jpg)',
        '![[https://b.com/2.png]]',
        '<img src="https://c.com/3.gif">',
      ].join('\n')

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5_1', 'jpg')
      mockSuccessfulImageProcess('md5_2', 'png')
      mockSuccessfulImageProcess('md5_3', 'gif')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toContain('![[attachments/md5_1_MD5.jpg|alt1]]')
      expect(modified).toContain('![[attachments/md5_2_MD5.png]]')
      expect(modified).toContain('![[attachments/md5_3_MD5.gif]]')
      // 不包含任何原始远程 URL
      expect(modified).not.toContain('https://a.com')
      expect(modified).not.toContain('https://b.com')
      expect(modified).not.toContain('https://c.com')
    })

    test('非图片内容不受影响', async () => {
      const file = createMockFile('notes/test.md')
      const content = [
        '# 标题',
        '这是正文 [普通链接](https://example.com)',
        '![](https://cdn.example.com/img.jpg)',
        '> 引用块',
        '- 列表项',
      ].join('\n')

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5img', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toContain('# 标题')
      expect(modified).toContain('[普通链接](https://example.com)')
      expect(modified).toContain('![[attachments/md5img_MD5.jpg]]')
      expect(modified).toContain('> 引用块')
      expect(modified).toContain('- 列表项')
    })

    test('格式为 unknown → 扩展名用 png', async () => {
      const file = createMockFile('notes/test.md')
      const content = '![](https://example.com/mystery-file)'

      mockVault.read.mockResolvedValue(content)
      mockDownloadImage.mockResolvedValueOnce({
        success: true,
        data: new ArrayBuffer(100),
      })
      mockDetectImageFormat.mockReturnValueOnce('unknown')
      mockCalculateMD5.mockReturnValueOnce('md5mystery_MD5')
      mockSaveImageToVault.mockResolvedValueOnce('attachments/md5mystery_MD5.png')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toBe('![[attachments/md5mystery_MD5.png]]')
    })
  })

  // ============================================================
  // 部分失败场景下的替换
  // ============================================================
  describe('部分失败时的替换行为', () => {
    test('3 张图: 第 2 张下载失败 → 仅替换第 1、3 张，第 2 张保持原样', async () => {
      const file = createMockFile('notes/test.md')
      const content = [
        '![a](https://example.com/1.jpg)',
        '![b](https://example.com/2.jpg)',
        '![c](https://example.com/3.jpg)',
      ].join('\n')

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5_1', 'jpg')
      mockDownloadImage.mockResolvedValueOnce({ success: false, error: 'timeout' })
      mockSuccessfulImageProcess('md5_3', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toContain('![[attachments/md5_1_MD5.jpg|a]]')
      expect(modified).toContain('![b](https://example.com/2.jpg)')
      expect(modified).toContain('![[attachments/md5_3_MD5.jpg|c]]')
    })

    test('全部下载失败 → vault.modify 不调用', async () => {
      const file = createMockFile('notes/test.md')
      const content = '![](https://example.com/1.jpg)\n![](https://example.com/2.jpg)'

      mockVault.read.mockResolvedValue(content)
      mockDownloadImage.mockResolvedValue({ success: false, error: 'HTTP 500' })

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      expect(mockVault.modify).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // 二次读取一致性
  // ============================================================
  describe('detectRemoteImages 与 localizeFile 的双重读取', () => {
    test('两次 vault.read 返回相同内容 → 替换正常', async () => {
      const file = createMockFile('notes/test.md')
      const content = '![](https://example.com/img.jpg)'

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5ok', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // enqueueFile 读 1 次（detectRemoteImages），localizeFile 读 1 次（detectRemoteImages），vault.process 内部读 1 次
      expect(mockVault.read).toHaveBeenCalledTimes(3)
      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toBe('![[attachments/md5ok_MD5.jpg]]')
    })

    test('【潜在问题】localizeFile 两次读取之间文件被外部修改 → 替换可能失效', async () => {
      const file = createMockFile('notes/test.md')
      const originalContent = '![](https://example.com/img.jpg)'
      // 外部进程在 detectRemoteImages 之后、vault.read(content) 之前修改了文件
      const modifiedByExternal = '外部修改的内容，图片链接已不同 ![](https://other.com/new.jpg)'

      // enqueueFile 阶段: 读到原始内容
      mockVault.read.mockResolvedValueOnce(originalContent)
      // localizeFile → detectRemoteImages: 读到原始内容
      mockVault.read.mockResolvedValueOnce(originalContent)
      // localizeFile → content = vault.read: 读到被外部修改的内容
      mockVault.read.mockResolvedValueOnce(modifiedByExternal)

      mockSuccessfulImageProcess('md5img', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // detectRemoteImages 检测到 https://example.com/img.jpg
      // 但 content 已变，split(originalText) 找不到匹配
      // vault.modify 仍会被调用（replacements.length > 0），但 content 实际未变
      if (mockVault.modify.mock.calls.length > 0) {
        const modified = mockVault.modify.mock.calls[0][1] as string
        // split().join() 找不到原始文本 → content 不变 → 写回了外部修改的内容但图片未替换
        expect(modified).toContain('https://other.com/new.jpg')
        // 原始 URL 不在新内容中，所以 split 无效果
        expect(modified).not.toContain('![[attachments/')
      }
    })
  })

  // ============================================================
  // media30d.clipfx.app 域名：无 📎 前缀的普通链接
  // ============================================================
  describe('media30d.clipfx.app 无前缀普通链接', () => {
    const CLIPFX_URL = 'https://media30d.clipfx.app/wecom4/2026/03/80eeb82f67ff93cf83dbe08d40db30f6494e257081bdf8e5c8603a3ab24ae3c8'

    test('[report.html](clipfx url) 无 📎 前缀: 图片本地化器会处理', async () => {
      const file = createMockFile('notes/test.md')
      const content = `[report.html](${CLIPFX_URL})`

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('clipfx_md5', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // media30d.clipfx.app 已加入 ALWAYS_LOCALIZE_DOMAINS
      // LINK_PATTERN 匹配到且 isAlwaysLocalizeDomain 为 true，会下载本地化
      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toContain('![[attachments/clipfx_md5_MD5.jpg|report.html]]')
    })

    test('对比: [report.html](sync.bijitongbu.site url) 无 📎 前缀会被处理', async () => {
      const file = createMockFile('notes/test2.md')
      const syncUrl = 'https://sync.bijitongbu.site/wecom31/2026/03/hash123'
      const content = `[report.html](${syncUrl})`

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('sync_md5', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // sync.bijitongbu.site 在 ALWAYS_LOCALIZE_DOMAINS 中，会被处理
      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toContain('![[attachments/sync_md5_MD5.jpg|report.html]]')
    })
  })

  // ============================================================
  // relay-1.bijitongbu.site 加速节点：新 URL 形式端到端
  // ============================================================
  describe('relay-1 加速节点 URL 端到端', () => {
    test('![](relay-1/p/<k>) 无扩展名 → 走图片本地化', async () => {
      const file = createMockFile('notes/relay.md')
      const url = 'https://relay-1.bijitongbu.site/p/abc123hash'
      const content = `前文\n![](${url})\n后文`

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('relay_md5', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).not.toContain(url)
      expect(modified).toContain('![[attachments/relay_md5_MD5.jpg]]')
    })

    test('[report.html](relay-1/m30/<k>) 无 📎 → 强制本地化', async () => {
      const file = createMockFile('notes/relay-link.md')
      const url = 'https://relay-1.bijitongbu.site/m30/deadbeef'
      const content = `[report.html](${url})`

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('relaym30_md5', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toContain(
        '![[attachments/relaym30_md5_MD5.jpg|report.html]]',
      )
    })

    test('relay 与源站 URL 共存 → 各自独立本地化', async () => {
      const file = createMockFile('notes/mixed.md')
      const legacyUrl = 'https://pic.clipfx.app/legacy.png'
      const newUrl = 'https://relay-1.bijitongbu.site/p/newhash'
      const content = `![old](${legacyUrl})\n段落\n![new](${newUrl})`

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('legacy_md5', 'png')
      mockSuccessfulImageProcess('new_md5', 'png')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).not.toContain(legacyUrl)
      expect(modified).not.toContain(newUrl)
      expect(modified).toContain('![[attachments/legacy_md5_MD5.png|old]]')
      expect(modified).toContain('![[attachments/new_md5_MD5.png|new]]')
    })

    test('前瞻：未收录的 relay-42 URL 同样被本地化（pattern 识别）', async () => {
      const file = createMockFile('notes/future.md')
      const url = 'https://relay-42.bijitongbu.site/p/futurehash'
      const content = `![](${url})`

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('future_md5', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toBe('![[attachments/future_md5_MD5.jpg]]')
    })
  })

  // ============================================================
  // 真实场景: sync 后文件被覆盖
  // ============================================================
  describe('同步竞态场景', () => {
    test('localizeFile 完成后文件被 sync 覆盖 → 自愈重新入队', async () => {
      const file = createMockFile('notes/synced.md')
      const content = '![](http://sync.bijitongbu.site/wecom31/2026/03/abc123)'

      mockVault.read.mockResolvedValue(content)
      mockSuccessfulImageProcess('md5abc', 'jpg')

      await localizer.enqueueFile(file)
      await localizer.processQueue()

      // localizeFile 成功替换并 modify 了
      expect(mockVault.modify).toHaveBeenCalledTimes(1)
      const modified = mockVault.modify.mock.calls[0][1] as string
      expect(modified).toBe('![[attachments/md5abc_MD5.jpg]]')

      const stats = localizer.getQueueStats()
      expect(stats.processedCount).toBe(1)

      // 模拟 sync 覆盖后，文件又有远程图片；自愈允许重新入队
      mockVault.read.mockResolvedValue(content)
      await localizer.enqueueFile(file)
      expect(localizer.getQueueStats().queueSize).toBe(1)
    })
  })
})
