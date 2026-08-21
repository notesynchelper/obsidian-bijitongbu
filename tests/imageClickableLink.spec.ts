/**
 * 可点击图片（image 嵌在 markdown 链接里）本地化回归测试
 *
 * Bug：文章 HTML `<a href><img></a>` 经 HTML→Markdown 会变成
 *   `[![alt](imgUrl)](linkUrl)`（可点击图片，点击看大图/跳原文）。
 * 旧逻辑只把内层图片改写成 wiki 嵌入，外层链接 wrapper 原样保留 →
 *   `[![[localPath|alt]]](linkUrl)`。Obsidian 不渲染「套在链接里的 ![[]] 嵌入」，
 *   阅读视图只剩一个外链箭头图标，图片不显示（real-obsidian 截图实测）。
 *   且外层那条远程 URL 还没被本地化。
 *
 * 修复：检测到内层图片被外层 `[...](url)` 紧贴包裹时，把整个 wrapper 一并吞掉，
 *   替换成独立的 `![[localPath|alt]]` 嵌入（丢弃外层 click-through，保证图片能显示）。
 */

import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { TFile } from 'obsidian'
import { downloadImage, isRemoteImage } from '../src/imageLocalizer/imageDownloader'
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
  mockDownloadImage.mockResolvedValueOnce({ success: true, data: new ArrayBuffer(100) })
  mockDetectImageFormat.mockReturnValueOnce(format)
  mockCalculateMD5.mockReturnValueOnce(`${md5}_MD5`)
  mockSaveImageToVault.mockResolvedValueOnce(`${folder}/${md5}_MD5.${format}`)
}

describe('可点击图片（image 套在 markdown 链接里）本地化', () => {
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

  test('[![alt](img)](外链) → 独立 ![[local|alt]]，不留外层链接、不产生 [![[', async () => {
    const file = createMockFile('notes/test.md')
    const img = 'https://example.com/photo.jpg'
    const outer = 'https://example.com/article-page'
    const content = `正文：\n\n[![点击看图](${img})](${outer})\n\n尾部`

    mockVault.read.mockResolvedValue(content)
    mockSuccessfulImageProcess('clk1', 'jpg')

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    expect(mockVault.modify).toHaveBeenCalledTimes(1)
    const modified = mockVault.modify.mock.calls[0][1] as string

    // 图片远程 URL 必须没了
    expect(modified).not.toContain(img)
    // 外层链接 URL 也不该残留
    expect(modified).not.toContain(outer)
    // 不能产生「嵌入套在链接里」的坏结构
    expect(modified).not.toContain('[![[')
    // 应是独立嵌入
    expect(modified).toContain('![[attachments/clk1_MD5.jpg|点击看图]]')
    // 周围文字保留
    expect(modified).toContain('正文：')
    expect(modified).toContain('尾部')
    // 整行就是裸嵌入（外层 [ ]( ) 被吞掉）
    expect(modified).toContain('\n\n![[attachments/clk1_MD5.jpg|点击看图]]\n\n')
  })

  test('[![alt](img)](img) 外链=图片自身（点击看大图最常见形态） → 独立 ![[local|alt]]', async () => {
    const file = createMockFile('notes/test.md')
    const img = 'https://example.com/photo.jpg'
    const content = `[![看大图](${img})](${img})`

    mockVault.read.mockResolvedValue(content)
    mockSuccessfulImageProcess('clk2', 'jpg')

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    const modified = mockVault.modify.mock.calls[0][1] as string
    expect(modified).not.toContain(img)
    expect(modified).not.toContain('[![[')
    expect(modified).toBe('![[attachments/clk2_MD5.jpg|看大图]]')
  })

  test('[<img src="img">](外链) HTML 图片套链接 → 独立 ![[local]]', async () => {
    const file = createMockFile('notes/test.md')
    const img = 'https://example.com/photo.jpg'
    const outer = 'https://example.com/page'
    const content = `[<img src="${img}">](${outer})`

    mockVault.read.mockResolvedValue(content)
    mockSuccessfulImageProcess('clk3', 'jpg')

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    const modified = mockVault.modify.mock.calls[0][1] as string
    expect(modified).not.toContain(img)
    expect(modified).not.toContain(outer)
    expect(modified).not.toContain('[![[')
    expect(modified).toBe('![[attachments/clk3_MD5.jpg]]')
  })

  test('回归：普通图片紧跟在 [文字] 链接后，不应被误吞外层', async () => {
    // `[see](page) ![alt](img)` —— 图片前面虽然有链接，但图片没有被链接包裹，
    // 不能触发 wrapper 吞并；这里图片紧邻在 `] ` 之后（不是 `[` 之后），更不该触发。
    const file = createMockFile('notes/test.md')
    const img = 'https://example.com/photo.jpg'
    const content = `[see](https://example.com/page) ![alt](${img})`

    mockVault.read.mockResolvedValue(content)
    mockSuccessfulImageProcess('clk4', 'jpg')

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    const modified = mockVault.modify.mock.calls[0][1] as string
    expect(modified).not.toContain(img)
    // 普通图片照常替换为独立嵌入
    expect(modified).toContain('![[attachments/clk4_MD5.jpg|alt]]')
    // 前面那条普通链接（非强制本地化域名）原样保留
    expect(modified).toContain('[see](https://example.com/page)')
  })
})
