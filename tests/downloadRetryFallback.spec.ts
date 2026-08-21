/**
 * 下载重试 + 备用线路机制测试
 *
 * 主线路: maxRetries 次重试（共 maxRetries+1 次尝试）
 * 备用线路: relay/源站族内触发；顺序兜底，每节点最多重试 1 次（共 2 次尝试）
 *
 * 策略：
 * - 源站（pic.clipfx.app 等）失败 → relay 优先兜底（relay-1 → relay-2 → … → relay-N）
 * - relay 失败 → 其他 relay（按顺序）→ 源站 → 源站镜像（当前 pic 已无镜像）
 */

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  requestUrl: jest.fn(),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { requestUrl } from 'obsidian'
import {
  clampImageDownloadRetries,
  downloadImage,
  getFallbackUrls,
  IMAGE_REQUEST_TIMEOUT_MS,
  isCompleteImageResponse,
  MAX_IMAGE_DOWNLOAD_RETRIES,
} from '../src/imageLocalizer/imageDownloader'

const mockRequestUrl = requestUrl as jest.Mock

/** 构造成功响应 */
function successResponse(data?: ArrayBuffer) {
  return {
    status: 200,
    text: '',
    headers: { 'content-type': 'image/png' },
    arrayBuffer: data || new ArrayBuffer(10),
  }
}

// ============================================================
// URL 映射（集成层：验证共模块返回符合下游期望）
// ============================================================
describe('getFallbackUrls 映射（下游视角）', () => {
  test('pic.clipfx.app → relay-1/2/3/4（无镜像）', () => {
    expect(
      getFallbackUrls(
        'https://pic.clipfx.app/938429b3dce34f0b6dc9c4bbe042219c.png',
      ),
    ).toEqual([
      'https://relay-1.bijitongbu.site/p/938429b3dce34f0b6dc9c4bbe042219c.png',
      'https://relay-2.bijitongbu.site/p/938429b3dce34f0b6dc9c4bbe042219c.png',
      'https://relay-3.bijitongbu.site/p/938429b3dce34f0b6dc9c4bbe042219c.png',
      'https://relay-4.bijitongbu.site/p/938429b3dce34f0b6dc9c4bbe042219c.png',
    ])
  })

  test('relay-1/p/<k> → relay-2/3/4 → 源站（无镜像）', () => {
    expect(
      getFallbackUrls(
        'https://relay-1.bijitongbu.site/p/938429b3dce34f0b6dc9c4bbe042219c.png',
      ),
    ).toEqual([
      'https://relay-2.bijitongbu.site/p/938429b3dce34f0b6dc9c4bbe042219c.png',
      'https://relay-3.bijitongbu.site/p/938429b3dce34f0b6dc9c4bbe042219c.png',
      'https://relay-4.bijitongbu.site/p/938429b3dce34f0b6dc9c4bbe042219c.png',
      'https://pic.clipfx.app/938429b3dce34f0b6dc9c4bbe042219c.png',
    ])
  })

  test('media30d.clipfx.app → relay-1/2/3/4/m30', () => {
    expect(
      getFallbackUrls('https://media30d.clipfx.app/abc'),
    ).toEqual([
      'https://relay-1.bijitongbu.site/m30/abc',
      'https://relay-2.bijitongbu.site/m30/abc',
      'https://relay-3.bijitongbu.site/m30/abc',
      'https://relay-4.bijitongbu.site/m30/abc',
    ])
  })

  test('relay-1/m30/<k> → relay-2/3/4/m30 → media30d 源站', () => {
    expect(
      getFallbackUrls('https://relay-1.bijitongbu.site/m30/abc'),
    ).toEqual([
      'https://relay-2.bijitongbu.site/m30/abc',
      'https://relay-3.bijitongbu.site/m30/abc',
      'https://relay-4.bijitongbu.site/m30/abc',
      'https://media30d.clipfx.app/abc',
    ])
  })

  test('无匹配域名 → 空数组', () => {
    expect(getFallbackUrls('https://other.com/img.jpg')).toEqual([])
  })

  test('子路径正确映射', () => {
    expect(
      getFallbackUrls('https://pic.clipfx.app/abc/def/123.jpg'),
    ).toEqual([
      'https://relay-1.bijitongbu.site/p/abc/def/123.jpg',
      'https://relay-2.bijitongbu.site/p/abc/def/123.jpg',
      'https://relay-3.bijitongbu.site/p/abc/def/123.jpg',
      'https://relay-4.bijitongbu.site/p/abc/def/123.jpg',
    ])
  })
})

// ============================================================
// 主线路重试（maxRetries=2 → 3 次尝试）
// ============================================================
describe('主线路重试', () => {
  beforeEach(() => mockRequestUrl.mockReset())

  test('首次成功 → 直接返回，无重试', async () => {
    mockRequestUrl.mockResolvedValueOnce(successResponse())

    const result = await downloadImage('https://other.com/img.jpg', 2, 0)

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
    expect(mockRequestUrl.mock.calls[0][0].throw).toBe(false)
  })

  test('第1次失败，第2次成功 → 重试1次', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage('https://other.com/img.jpg', 2, 0)

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(2)
  })

  test('前2次失败，第3次成功 → 重试2次', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('error'))
      .mockRejectedValueOnce(new Error('error'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage('https://other.com/img.jpg', 2, 0)

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(3)
  })

  test('3次全部失败 → 返回 failure（非 relay/源站，无备用）', async () => {
    mockRequestUrl.mockRejectedValue(new Error('error'))

    const result = await downloadImage('https://other.com/img.jpg', 2, 0)

    expect(result.success).toBe(false)
    expect(mockRequestUrl).toHaveBeenCalledTimes(3)
  })
})

// ============================================================
// 备用线路触发：源站 → relay 优先
// ============================================================
describe('源站失败 → relay 优先兜底', () => {
  beforeEach(() => mockRequestUrl.mockReset())

  test('pic.clipfx.app 首次失败 → 下一次立即切 relay-1/p/<k>', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('error'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage(
      'https://pic.clipfx.app/abc123.png',
      2,
      0,
    )

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(2)
    expect(mockRequestUrl.mock.calls[1][0].url).toBe(
      'https://relay-1.bijitongbu.site/p/abc123.png',
    )
  })

  test('pic.clipfx.app 首次失败、第2次在备用成功', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('error'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage(
      'https://pic.clipfx.app/abc123.png',
      2,
      0,
    )

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(2)

    const urls = mockRequestUrl.mock.calls.map(
      (c: unknown[]) => (c[0] as { url: string }).url,
    )
    expect(urls).toEqual([
      'https://pic.clipfx.app/abc123.png',
      'https://relay-1.bijitongbu.site/p/abc123.png',
    ])
  })

  test('非 relay/源站域名 3次失败 → 不触发任何备用', async () => {
    mockRequestUrl.mockRejectedValue(new Error('error'))

    const result = await downloadImage(
      'https://cdn.example.com/img.jpg',
      2,
      0,
    )

    expect(result.success).toBe(false)
    expect(mockRequestUrl).toHaveBeenCalledTimes(3)
  })
})

// ============================================================
// 备用线路轮转（全线路共享 maxRetries+1 次机会）
// ============================================================
describe('备用线路重试', () => {
  beforeEach(() => mockRequestUrl.mockReset())

  test('pic.clipfx.app 主败 → 首个备用（relay-1/p）首次成功', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('error'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage(
      'https://pic.clipfx.app/abc.png',
      2,
      0,
    )

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(2)
    expect(mockRequestUrl.mock.calls[1][0].url).toBe(
      'https://relay-1.bijitongbu.site/p/abc.png',
    )
  })

  test('前 5 条线路均瞬态失败，第 6 次轮回主线路成功', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('error'))
      .mockRejectedValueOnce(new Error('error'))
      .mockRejectedValueOnce(new Error('error'))
      .mockRejectedValueOnce(new Error('error'))
      .mockRejectedValueOnce(new Error('error'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage(
      'https://pic.clipfx.app/abc.png',
      5,
      0,
    )

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(6)
    expect(mockRequestUrl.mock.calls[5][0].url).toBe(
      'https://pic.clipfx.app/abc.png',
    )
  })

  test('全线路瞬态失败 → 只消耗 maxRetries+1 次总机会', async () => {
    mockRequestUrl.mockRejectedValue(new Error('error'))

    const result = await downloadImage(
      'https://pic.clipfx.app/abc.png',
      2,
      0,
    )

    expect(result.success).toBe(false)
    expect(mockRequestUrl).toHaveBeenCalledTimes(3)
  })
})

// ============================================================
// 多备用线路顺序兜底
// ============================================================
describe('多备用线路顺序兜底（pic.clipfx.app）', () => {
  const PRIMARY_URL = 'https://pic.clipfx.app/abc123.png'
  const RELAY_1 = 'https://relay-1.bijitongbu.site/p/abc123.png'
  const RELAY_2 = 'https://relay-2.bijitongbu.site/p/abc123.png'
  const RELAY_3 = 'https://relay-3.bijitongbu.site/p/abc123.png'
  const RELAY_4 = 'https://relay-4.bijitongbu.site/p/abc123.png'

  beforeEach(() => mockRequestUrl.mockReset())

  test('primary 首败后 relay-1 首次成功 → 不再尝试 relay-2/3/4', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('p1'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage(PRIMARY_URL, 2, 0)

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(2)
    expect(mockRequestUrl.mock.calls[1][0].url).toBe(RELAY_1)
    const urls = mockRequestUrl.mock.calls.map(
      (c: unknown[]) => (c[0] as { url: string }).url,
    )
    expect(urls).not.toContain(RELAY_2)
    expect(urls).not.toContain(RELAY_3)
    expect(urls).not.toContain(RELAY_4)
  })

  test('primary + relay-1/2 全败 → relay-3 首次成功（共 4 次）', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('p1'))
      .mockRejectedValueOnce(new Error('r1-1'))
      .mockRejectedValueOnce(new Error('r2-1'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage(PRIMARY_URL, 3, 0)

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(4)
    expect(mockRequestUrl.mock.calls[1][0].url).toBe(RELAY_1)
    expect(mockRequestUrl.mock.calls[2][0].url).toBe(RELAY_2)
    expect(mockRequestUrl.mock.calls[3][0].url).toBe(RELAY_3)
  })

  test('primary + relay-1/2/3 全败 → relay-4 首次成功（共 5 次）', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('p1'))
      .mockRejectedValueOnce(new Error('r1-1'))
      .mockRejectedValueOnce(new Error('r2-1'))
      .mockRejectedValueOnce(new Error('r3-1'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage(PRIMARY_URL, 4, 0)

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(5)
    expect(mockRequestUrl.mock.calls[3][0].url).toBe(RELAY_3)
    expect(mockRequestUrl.mock.calls[4][0].url).toBe(RELAY_4)
  })

  test('全线路瞬态失败 → 3 次请求按主、relay-1、relay-2 轮转', async () => {
    mockRequestUrl.mockRejectedValue(new Error('down'))

    const result = await downloadImage(PRIMARY_URL, 2, 0)

    expect(result.success).toBe(false)
    expect(mockRequestUrl).toHaveBeenCalledTimes(3)

    const urls = mockRequestUrl.mock.calls.map(
      (c: unknown[]) => (c[0] as { url: string }).url,
    )
    expect(urls).toEqual([PRIMARY_URL, RELAY_1, RELAY_2])
  })
})

// ============================================================
// relay 作为主线路：relay-1 → 源站
// ============================================================
describe('relay-1 主线路兜底回源站', () => {
  const RELAY_URL = 'https://relay-1.bijitongbu.site/p/0a62fc33.png'
  const RELAY_2_URL = 'https://relay-2.bijitongbu.site/p/0a62fc33.png'
  const RELAY_3_URL = 'https://relay-3.bijitongbu.site/p/0a62fc33.png'
  const RELAY_4_URL = 'https://relay-4.bijitongbu.site/p/0a62fc33.png'
  const ORIGIN_URL = 'https://pic.clipfx.app/0a62fc33.png'

  beforeEach(() => mockRequestUrl.mockReset())

  test('relay-1/2/3/4 全败 → 源站首次成功', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('r1'))
      .mockRejectedValueOnce(new Error('r2'))
      .mockRejectedValueOnce(new Error('r3'))
      .mockRejectedValueOnce(new Error('r4'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage(RELAY_URL, 4, 0)

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(5)
    expect(mockRequestUrl.mock.calls[1][0].url).toBe(RELAY_2_URL)
    expect(mockRequestUrl.mock.calls[2][0].url).toBe(RELAY_3_URL)
    expect(mockRequestUrl.mock.calls[3][0].url).toBe(RELAY_4_URL)
    expect(mockRequestUrl.mock.calls[4][0].url).toBe(ORIGIN_URL)
  })

  test('瞬态全败 → 只消耗 3 次总机会', async () => {
    mockRequestUrl.mockRejectedValue(new Error('down'))

    const result = await downloadImage(RELAY_URL, 2, 0)

    expect(result.success).toBe(false)
    expect(mockRequestUrl).toHaveBeenCalledTimes(3)

    const urls = mockRequestUrl.mock.calls.map(
      (c: unknown[]) => (c[0] as { url: string }).url,
    )
    expect(urls).toEqual([RELAY_URL, RELAY_2_URL, RELAY_3_URL])
  })
})

// ============================================================
// relay-1/m30/<k> → media30d.clipfx.app 单节点兜底
// ============================================================
describe('relay-1/m30 → relay-2/3/4/m30 → media30d 源站兜底', () => {
  beforeEach(() => mockRequestUrl.mockReset())

  test('relay-1/2/3/4/m30 全败 → media30d 首次成功', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('r1'))
      .mockRejectedValueOnce(new Error('r2'))
      .mockRejectedValueOnce(new Error('r3'))
      .mockRejectedValueOnce(new Error('r4'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadImage(
      'https://relay-1.bijitongbu.site/m30/abc',
      4,
      0,
    )

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(5)
    expect(mockRequestUrl.mock.calls[1][0].url).toBe(
      'https://relay-2.bijitongbu.site/m30/abc',
    )
    expect(mockRequestUrl.mock.calls[4][0].url).toBe(
      'https://media30d.clipfx.app/abc',
    )
  })

  test('relay/m30 瞬态全败 → 只消耗 3 次总机会', async () => {
    mockRequestUrl.mockRejectedValue(new Error('down'))

    const result = await downloadImage(
      'https://relay-1.bijitongbu.site/m30/abc',
      2,
      0,
    )

    expect(result.success).toBe(false)
    expect(mockRequestUrl).toHaveBeenCalledTimes(3)
  })
})

describe('永久错误、完整性、超时与设置硬上限', () => {
  beforeEach(() => {
    mockRequestUrl.mockReset()
    jest.useRealTimers()
  })

  test('relay 单点 404 会跨节点验证，权威源站 404 后立即结束', async () => {
    mockRequestUrl.mockResolvedValue({
      status: 404,
      text: '',
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    })

    const result = await downloadImage(
      'https://relay-1.bijitongbu.site/p/missing.png',
      0,
      0,
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('status 404')
    expect(mockRequestUrl).toHaveBeenCalledTimes(5)
    expect(mockRequestUrl.mock.calls[4][0].url).toBe(
      'https://pic.clipfx.app/missing.png',
    )
  })

  test('半截 PNG 与 Content-Length 不一致都不能被接受', () => {
    const partialPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]).buffer
    expect(isCompleteImageResponse(partialPng)).toBe(false)
    expect(
      isCompleteImageResponse(new Uint8Array([1, 2, 3]).buffer, {
        'Content-Length': '4',
      }),
    ).toBe(false)
  })

  test('PNG 的 IEND 后有 8 字节尾随数据仍完整，缺少 IEND 仍不完整', () => {
    const pngWithTrailingBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
      0xae, 0x42, 0x60, 0x82,
      0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33,
    ]).buffer
    const pngWithoutIend = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
      0x01, 0x02, 0x03, 0x04,
    ]).buffer

    expect(isCompleteImageResponse(pngWithTrailingBytes)).toBe(true)
    expect(isCompleteImageResponse(pngWithoutIend)).toBe(false)
  })

  test('JPEG 的 EOI 后有填充仍完整，缺少 EOI 仍不完整', () => {
    const jpegWithTrailingBytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9, 0x00, 0x00,
    ]).buffer
    const jpegWithoutEoi = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04,
    ]).buffer

    expect(isCompleteImageResponse(jpegWithTrailingBytes)).toBe(true)
    expect(isCompleteImageResponse(jpegWithoutEoi)).toBe(false)
  })

  test('WebP 声明长度小于实长时完整，大于实长时不完整', () => {
    const webpWithTrailingBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50, 0xaa, 0xbb, 0xcc, 0xdd,
    ]).buffer
    const truncatedWebp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]).buffer

    expect(isCompleteImageResponse(webpWithTrailingBytes)).toBe(true)
    expect(isCompleteImageResponse(truncatedWebp)).toBe(false)
  })

  test('GIF、BMP 与 SVG 同样允许结束位置后的少量尾随数据', () => {
    const gifWithTrailingBytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x3b, 0x00, 0x00,
    ]).buffer
    const bmpWithTrailingBytes = new Uint8Array([
      0x42, 0x4d, 0x06, 0x00, 0x00, 0x00, 0xaa, 0xbb,
    ]).buffer
    const svgWithTrailingBytes = new TextEncoder()
      .encode('<svg><rect/></svg>trailing')
      .buffer

    expect(isCompleteImageResponse(gifWithTrailingBytes)).toBe(true)
    expect(isCompleteImageResponse(bmpWithTrailingBytes)).toBe(true)
    expect(isCompleteImageResponse(svgWithTrailingBytes)).toBe(true)
  })

  test('downloadImage 收到合法 HTTP 200 的半截 PNG 仍返回失败', async () => {
    const partialPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]).buffer
    mockRequestUrl.mockResolvedValue({
      status: 200,
      text: '',
      headers: { 'content-type': 'image/png' },
      arrayBuffer: partialPng,
    })

    await expect(
      downloadImage('https://cdn.example.com/partial.png', 0, 0),
    ).resolves.toMatchObject({ success: false })
  })

  test('老配置与调用参数都会 clamp 到 5 次重试', async () => {
    expect(clampImageDownloadRetries(100)).toBe(MAX_IMAGE_DOWNLOAD_RETRIES)
    mockRequestUrl.mockRejectedValue(new Error('down'))
    await downloadImage('https://cdn.example.com/x.png', 100, 0)
    expect(mockRequestUrl).toHaveBeenCalledTimes(MAX_IMAGE_DOWNLOAD_RETRIES + 1)
  })

  test('永久不返回的 requestUrl 会在单请求超时后收敛', async () => {
    jest.useFakeTimers()
    mockRequestUrl.mockImplementation(() => new Promise(() => undefined))
    const pending = downloadImage('https://cdn.example.com/x.png', 0, 0)
    await jest.advanceTimersByTimeAsync(IMAGE_REQUEST_TIMEOUT_MS)
    await expect(pending).resolves.toMatchObject({ success: false })
  })
})
