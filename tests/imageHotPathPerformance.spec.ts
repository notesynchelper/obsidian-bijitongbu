jest.mock('../src/imageLocalizer/imageDownloader')
jest.mock('../src/imageLocalizer/imageProcessor')
jest.mock('../src/settings/template', () => ({
  render: jest.fn(),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import {
  downloadImage,
  isRemoteImage,
} from '../src/imageLocalizer/imageDownloader'
import {
  calculateMD5,
  convertPngToJpeg,
  detectImageFormat,
  saveImageToVault,
} from '../src/imageLocalizer/imageProcessor'
import { render } from '../src/settings/template'

const mockDownload = downloadImage as jest.MockedFunction<typeof downloadImage>
const mockIsRemote = isRemoteImage as jest.MockedFunction<typeof isRemoteImage>
const mockCalculateMD5 = calculateMD5 as jest.MockedFunction<typeof calculateMD5>
const mockConvert = convertPngToJpeg as jest.MockedFunction<typeof convertPngToJpeg>
const mockDetectFormat = detectImageFormat as jest.MockedFunction<typeof detectImageFormat>
const mockSave = saveImageToVault as jest.MockedFunction<typeof saveImageToVault>
const mockRender = render as jest.MockedFunction<typeof render>

const options = {
  enablePngToJpeg: false,
  jpegQuality: 85,
  attachmentFolder: 'attachments',
  folderDateFormat: 'yyyy-MM-dd',
  maxRetries: 1,
  retryDelay: 0,
}

function makeFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.split('/').pop()?.replace(/\.md$/, '') ?? path
  return file
}

function makeHarness() {
  const contents = new Map<string, string>()
  const files = new Map<string, TFile>()
  const vault = {
    read: jest.fn(async (file: TFile) => contents.get(file.path) ?? ''),
    process: jest.fn(
      async (file: TFile, transform: (content: string) => string) => {
        const next = transform(contents.get(file.path) ?? '')
        contents.set(file.path, next)
        return next
      },
    ),
    getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
  }
  mockSave.mockImplementation(async (_vault, folder, name) => {
    const path = `${folder}/${name}`
    const localFile = makeFile(path)
    files.set(path, localFile)
    return path
  })
  return {
    contents,
    files,
    vault,
    localizer: new ImageLocalizer({ vault } as never, options),
  }
}

describe('图片热路径性能保护', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsRemote.mockReturnValue(true)
    mockDownload.mockResolvedValue({
      success: true,
      data: new ArrayBuffer(8),
    })
    mockDetectFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockReturnValue('same_MD5')
    mockRender.mockReturnValue('attachments/shared')
  })

  test('同 URL、同目标目录、文件仍存在时跨笔记只下载和保存一次', async () => {
    const { contents, localizer } = makeHarness()
    const first = makeFile('Synced/first.md')
    const second = makeFile('Synced/second.md')
    const remote = 'https://cdn.example.com/shared-logo.jpg'
    contents.set(first.path, `![first](${remote})`)
    contents.set(second.path, `![second](${remote})`)

    await expect(localizer.localizeFile(first)).resolves.toBe(true)
    await expect(localizer.localizeFile(second)).resolves.toBe(true)

    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(contents.get(second.path)).toContain(
      '![[attachments/shared/same_MD5.jpg|second]]',
    )
    expect(localizer.getUrlLocalMap().get(second.path, remote)).toBe(
      'attachments/shared/same_MD5.jpg',
    )
  })

  test('同 URL 但笔记模板算出的目标目录不同则不得跨笔记复用', async () => {
    mockRender.mockImplementation((item) => `attachments/${item.title}`)
    const { contents, localizer } = makeHarness()
    const first = makeFile('Synced/first.md')
    const second = makeFile('Synced/second.md')
    const remote = 'https://cdn.example.com/shared-logo.jpg'
    contents.set(first.path, `![](${remote})`)
    contents.set(second.path, `![](${remote})`)

    await localizer.localizeFile(first)
    await localizer.localizeFile(second)

    expect(mockDownload).toHaveBeenCalledTimes(2)
    expect(mockSave).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'attachments/first',
      'same_MD5.jpg',
      expect.any(ArrayBuffer),
    )
    expect(mockSave).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'attachments/second',
      'same_MD5.jpg',
      expect.any(ArrayBuffer),
    )
  })

  test('会话缓存指向的文件已删除时失效并重新下载', async () => {
    const { contents, files, localizer } = makeHarness()
    const first = makeFile('Synced/first.md')
    const second = makeFile('Synced/second.md')
    const remote = 'https://cdn.example.com/shared-logo.jpg'
    contents.set(first.path, `![](${remote})`)
    contents.set(second.path, `![](${remote})`)

    await localizer.localizeFile(first)
    files.clear()
    await localizer.localizeFile(second)

    expect(mockDownload).toHaveBeenCalledTimes(2)
    expect(mockSave).toHaveBeenCalledTimes(2)
  })

  test('clearCache 只清会话复用状态，之后会重新下载', async () => {
    const { contents, localizer } = makeHarness()
    const first = makeFile('Synced/first.md')
    const second = makeFile('Synced/second.md')
    const remote = 'https://cdn.example.com/shared-logo.jpg'
    contents.set(first.path, `![](${remote})`)
    contents.set(second.path, `![](${remote})`)

    await localizer.localizeFile(first)
    localizer.clearCache()
    await localizer.localizeFile(second)

    expect(mockDownload).toHaveBeenCalledTimes(2)
  })

  test('3 路下载保持并发，但 PNG Canvas 转换最多同时一个', async () => {
    const { contents, localizer } = makeHarness()
    localizer.updateOptions({ ...options, enablePngToJpeg: true })
    mockDetectFormat.mockReturnValue('png')
    mockCalculateMD5.mockImplementation(
      () => `hash-${mockCalculateMD5.mock.calls.length}_MD5`,
    )

    let activeConversions = 0
    let maxActiveConversions = 0
    const releases: Array<() => void> = []
    mockConvert.mockImplementation(async (data) => {
      activeConversions++
      maxActiveConversions = Math.max(maxActiveConversions, activeConversions)
      await new Promise<void>((resolve) => releases.push(resolve))
      activeConversions--
      return data
    })

    const file = makeFile('Synced/pngs.md')
    const urls = [
      'https://cdn.example.com/one.png',
      'https://cdn.example.com/two.png',
      'https://cdn.example.com/three.png',
    ]
    contents.set(file.path, urls.map((url) => `![](${url})`).join('\n'))

    const processing = localizer.localizeFile(file)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockDownload).toHaveBeenCalledTimes(3)
    expect(mockConvert).toHaveBeenCalledTimes(1)

    for (let expectedCalls = 2; expectedCalls <= 3; expectedCalls++) {
      releases.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(mockConvert).toHaveBeenCalledTimes(expectedCalls)
    }
    releases.shift()?.()

    await expect(processing).resolves.toBe(true)
    expect(maxActiveConversions).toBe(1)
    expect(contents.get(file.path)).not.toContain('https://')
  })
})
