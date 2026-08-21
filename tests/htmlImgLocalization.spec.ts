/**
 * HTML <img> 标签本地化回归测试
 *
 * Bug（2026-06-12 用户反馈「文章图片打不开，但在图片文件夹可以打开图片」）：
 *   X mention 链路（修复前）等管线会把 `<p><img src="…" alt="" /></p>` 的
 *   HTML 直接内联进 .md。旧版 IMAGE_PATTERN 对 HTML 形态只匹配到 src 引号
 *   为止，替换成 wiki 嵌入后：
 *     1. 残留 ` alt="" /></p>` 以正文形式漏出（用户看到乱码）；
 *     2. `![[…]]` 落在 HTML 块内部 —— Obsidian 不解析 HTML 块内的 markdown
 *        语法，图片下载到了 vault 但正文渲染不出来。
 *
 * 修复：
 *   - HTML <img> 吞掉整个标签（至闭合 `>`），不留属性残渣；
 *   - 从标签提取 alt 作为 wiki 别名；
 *   - 独子 `<p><img/></p>` 连 <p> 包装一起吞；
 *   - HTML 块上下文（行首是 `<`）时用空行把嵌入提为独立 markdown 块
 *     （空行终结 HTML block，嵌入恢复渲染）；
 *   - www.bijitongbu.site（积分充值二维码等 UI 元素）绝不本地化 ——
 *     它作为 HTML 排版原样渲染没问题，改写反而破坏。
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

describe('HTML <img> 标签本地化', () => {
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

  async function run(content: string): Promise<string> {
    const file = createMockFile('notes/test.md')
    mockVault.read.mockResolvedValue(content)
    await localizer.enqueueFile(file)
    await localizer.processQueue()
    if (mockVault.modify.mock.calls.length === 0) return content
    return mockVault.modify.mock.calls[0][1] as string
  }

  test('x_v2 形态：<p><img … alt="" /></p> 独子包装整体替换，无属性残渣', async () => {
    const img = 'https://pbs.twimg.com/media/HKYpiVnaYAA7WL2.jpg'
    const content = `<article class="x-main"><p>正文文字</p><p><img src="${img}" alt="" /></p></article>`
    mockSuccessfulImageProcess('xv2', 'jpg')

    const modified = await run(content)

    expect(modified).not.toContain(img)
    // 整个 <p><img/></p> 被吞掉：不留 alt 残渣、不留空 <p> 包装
    expect(modified).not.toContain('alt=""')
    expect(modified).not.toContain('<p></p>')
    expect(modified).not.toContain('/></p>')
    // HTML 块上下文 → 嵌入用空行隔离成独立 markdown 块（否则 Obsidian 不渲染）
    expect(modified).toContain('\n\n![[attachments/xv2_MD5.jpg]]\n\n')
    // 周边 HTML 原样保留
    expect(modified).toContain('<p>正文文字</p>')
    expect(modified).toContain('</article>')
  })

  test('HTML alt 属性提取为 wiki 别名', async () => {
    const img = 'https://example.com/cover.jpg'
    const content = `<p><img src="${img}" alt="封面" /></p>`
    mockSuccessfulImageProcess('cover', 'jpg')

    const modified = await run(content)

    expect(modified).toContain('![[attachments/cover_MD5.jpg|封面]]')
    expect(modified).not.toContain('alt="封面"')
  })

  test('img 有兄弟内容时只吞 img 标签本身，<p> 文字保留', async () => {
    const img = 'https://example.com/chart.png'
    const content = `<p style="margin:0.9em 0;">前置说明<img src="${img}" width="100%"> <em>图注</em></p>`
    mockSuccessfulImageProcess('chart', 'png')

    const modified = await run(content)

    expect(modified).not.toContain(img)
    expect(modified).not.toContain('width="100%"')
    expect(modified).toContain('前置说明')
    expect(modified).toContain('<em>图注</em>')
    // 行首是 `<`（HTML 块）→ 嵌入仍需空行提出来
    expect(modified).toContain('\n\n![[attachments/chart_MD5.png]]\n\n')
  })

  test('markdown 段落内联 <img> 保持内联替换（不加空行）', async () => {
    const img = 'https://example.com/inline.jpg'
    const content = `正文开头 <img src="${img}"> 正文继续`
    mockSuccessfulImageProcess('inline', 'jpg')

    const modified = await run(content)

    expect(modified).toBe('正文开头 ![[attachments/inline_MD5.jpg]] 正文继续')
  })

  test('www.bijitongbu.site（积分充值二维码）绝不本地化', async () => {
    const content =
      '<sub>请扫码充值</sub>\n\n' +
      '<p align="center"><img src="https://www.bijitongbu.site/qr/kuaikan.png" width="25%" alt="积分充值二维码"></p>'

    const modified = await run(content)

    // 不下载、不改写
    expect(mockDownloadImage).not.toHaveBeenCalled()
    expect(modified).toBe(content)
  })

  test('可点击图片 [<img …>](外链) wrapper 吞并行为不回归', async () => {
    const img = 'https://example.com/click.jpg'
    const content = `[<img src="${img}" />](https://example.com/page)`
    mockSuccessfulImageProcess('click', 'jpg')

    const modified = await run(content)

    expect(modified).not.toContain(img)
    expect(modified).not.toContain('](https://example.com/page)')
    expect(modified).toContain('![[attachments/click_MD5.jpg]]')
  })
})
