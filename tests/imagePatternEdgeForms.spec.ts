/**
 * 修复 5：覆盖 Obsidian 能渲染、旧 IMAGE_PATTERN 漏掉的 8 类图片写法。
 */

import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { scanImageSyntax } from '../src/imageLocalizer/imageSyntax'
import { extractRemoteImageUrls } from '../src/sync/burnResidual'
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
}))

const mockDownload = downloadImage as jest.MockedFunction<typeof downloadImage>
const mockIsRemote = isRemoteImage as jest.MockedFunction<typeof isRemoteImage>
const mockMd5 = calculateMD5 as jest.MockedFunction<typeof calculateMD5>
const mockFormat = detectImageFormat as jest.MockedFunction<typeof detectImageFormat>
const mockSave = saveImageToVault as jest.MockedFunction<typeof saveImageToVault>

describe('修复 5：图片边缘语法', () => {
  test('8 类写法全部扫描、本地化，并与 burnResidual 判定一致', async () => {
    const urls = [
      'https://h.test/upper.png',
      'https://h.test/multiline.png',
      'https://h.test/unquoted.png',
      'https://h.test/spaced.png',
      'https://h.test/greater.png',
      'https://h.test/alt.png',
      'https://h.test/a(1).png',
      'https://h.test/angle.png',
    ]
    let body = [
      `<IMG SRC="${urls[0]}">`,
      `<img\n  src="${urls[1]}">`,
      `<img src=${urls[2]}>`,
      `<img src = "${urls[3]}">`,
      `<img data-x="a>b" src="${urls[4]}">`,
      `![图1[大\\]扩]](${urls[5]})`,
      `![x](${urls[6]})`,
      `![x](<${urls[7]}>)`,
    ].join('\n')

    expect(scanImageSyntax(body).map((match) => match.url)).toEqual(urls)
    mockIsRemote.mockImplementation((url) => url.startsWith('https://'))
    expect(extractRemoteImageUrls(body)).toEqual(urls)

    const file = new TFile()
    file.path = 'edge.md'
    file.basename = 'edge'
    const vault = {
      read: jest.fn(async () => body),
      process: jest.fn(async (_file: TFile, fn: (content: string) => string) => {
        body = fn(body)
        return body
      }),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
    }
    const localizer = new ImageLocalizer(
      { vault } as any,
      {
        enablePngToJpeg: false,
        jpegQuality: 85,
        attachmentFolder: 'attachments',
        folderDateFormat: 'yyyy-MM-dd',
        maxRetries: 0,
        retryDelay: 0,
      },
    )
    mockDownload.mockResolvedValue({ success: true, data: new ArrayBuffer(4) })
    mockFormat.mockReturnValue('png')
    urls.forEach((_, index) => {
      mockMd5.mockReturnValueOnce(`md5-${index}`)
      mockSave.mockResolvedValueOnce(`attachments/edge-${index}.png`)
    })

    await expect(localizer.enqueueFile(file)).resolves.toBe('enqueued')
    await expect(localizer.processQueue()).resolves.toMatchObject({
      total: 1,
      succeeded: 1,
      failed: 0,
    })
    expect(body).not.toContain('https://h.test/')
    expect(body.match(/!\[\[/g)).toHaveLength(8)
    expect(mockSave).toHaveBeenCalledTimes(8)
  })
})
