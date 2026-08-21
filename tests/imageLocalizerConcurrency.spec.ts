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

import { TFile } from 'obsidian'
import { downloadImage, isRemoteImage } from '../src/imageLocalizer/imageDownloader'
import {
  calculateMD5,
  detectImageFormat,
  saveImageToVault,
} from '../src/imageLocalizer/imageProcessor'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'

const mockDownloadImage = downloadImage as jest.MockedFunction<typeof downloadImage>
const mockIsRemoteImage = isRemoteImage as jest.MockedFunction<typeof isRemoteImage>
const mockCalculateMD5 = calculateMD5 as jest.MockedFunction<typeof calculateMD5>
const mockDetectImageFormat = detectImageFormat as jest.MockedFunction<typeof detectImageFormat>
const mockSaveImageToVault = saveImageToVault as jest.MockedFunction<typeof saveImageToVault>

describe('同篇图片有界并发', () => {
  it('第一张请求未返回时，后两张健康图已经发起请求', async () => {
    const urls = [
      'https://example.com/slow.jpg',
      'https://example.com/healthy-1.jpg',
      'https://example.com/healthy-2.jpg',
    ]
    const content = urls.map((url) => `![](${url})`).join('\n')
    const file = new TFile()
    file.path = 'Synced/concurrent.md'
    file.basename = 'concurrent'
    let releaseSlow: ((value: { success: true; data: ArrayBuffer }) => void) | undefined

    mockIsRemoteImage.mockReturnValue(true)
    mockDownloadImage.mockImplementation((url) => {
      if (url === urls[0]) {
        return new Promise((resolve) => {
          releaseSlow = resolve
        })
      }
      return Promise.resolve({ success: true, data: new ArrayBuffer(8) })
    })
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockImplementation(
      () => `hash-${mockCalculateMD5.mock.calls.length}_MD5`,
    )
    mockSaveImageToVault.mockImplementation(
      async (_vault, folder, name) => `${folder}/${name}`,
    )

    let currentContent = content
    const vault = {
      read: jest.fn(async () => currentContent),
      process: jest.fn(async (_file: TFile, transform: (text: string) => string) => {
        currentContent = transform(currentContent)
        return currentContent
      }),
      getAbstractFileByPath: jest.fn(() => null),
    }
    const localizer = new ImageLocalizer(
      { vault } as any,
      {
        enablePngToJpeg: false,
        jpegQuality: 85,
        attachmentFolder: 'attachments',
        folderDateFormat: 'yyyy-MM-dd',
        maxRetries: 1,
        retryDelay: 0,
      },
    )

    await localizer.enqueueFile(file)
    const processing = localizer.processQueue()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockDownloadImage.mock.calls.map((call) => call[0])).toEqual(urls)

    releaseSlow?.({ success: true, data: new ArrayBuffer(8) })
    await processing
    expect(currentContent).not.toContain('https://')
  })
})
