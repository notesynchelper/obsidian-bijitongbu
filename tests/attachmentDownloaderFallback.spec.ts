/**
 * 附件下载器 fallback 机制测试
 *
 * 预期行为：
 * - 主线路失败后，按 getFallbackUrls 顺序依次切换备用节点
 * - 单个备用节点最多重试 1 次（2 次尝试）
 * - 任一节点返回 NoSuchKey（expired）→ 立即短路，不再试其他节点
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
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'

const mockRequestUrl = requestUrl as jest.Mock

function successResponse(data?: ArrayBuffer) {
  return {
    status: 200,
    text: '',
    headers: { 'content-type': 'application/octet-stream' },
    arrayBuffer: data || new ArrayBuffer(32),
  }
}

/** 与 redcase 统一：模拟宿主在调用方拿到 response 前直接 reject 的 404。 */
function rejected404() {
  return new Error('Request failed, status 404')
}

// ============================================================
// 主线路成功：不触发任何 fallback
// ============================================================
describe('附件下载：主线路成功', () => {
  beforeEach(() => mockRequestUrl.mockReset())

  test('首次成功 → 不触发 fallback', async () => {
    mockRequestUrl.mockResolvedValueOnce(successResponse())

    const result = await downloadAttachment(
      'https://relay-1.bijitongbu.site/m30/abc',
      2,
      0,
    )

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
    expect(mockRequestUrl.mock.calls[0][0].throw).toBe(false)
  })
})

// ============================================================
// relay 主线路失败 → 源站兜底
// ============================================================
describe('附件下载：relay-1/m30 失败 → relay-2/3/4/m30 → media30d 兜底', () => {
  beforeEach(() => mockRequestUrl.mockReset())

  test('主 3 + relay-2/3/4 各 2 全败 → media30d 首次成功', async () => {
    mockRequestUrl
      // relay-1/m30 主线路 3 次失败
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      // relay-2/m30 fallback 2 次失败
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      // relay-3/m30 fallback 2 次失败
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      // relay-4/m30 fallback 2 次失败
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      // media30d fallback 首次成功
      .mockResolvedValueOnce(successResponse())

    const result = await downloadAttachment(
      'https://relay-1.bijitongbu.site/m30/abc',
      2,
      0,
    )

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(10)
    expect(mockRequestUrl.mock.calls[3][0].url).toBe(
      'https://relay-2.bijitongbu.site/m30/abc',
    )
    expect(mockRequestUrl.mock.calls[9][0].url).toBe(
      'https://media30d.clipfx.app/abc',
    )
  })

  test('主 + relay-2/3/4 + 源站全败 → 11 次请求（主 3 + relay-2/3/4 各 2 + 源站 2）', async () => {
    mockRequestUrl.mockRejectedValue(new Error('down'))

    const result = await downloadAttachment(
      'https://relay-1.bijitongbu.site/m30/abc',
      2,
      0,
    )

    expect(result.success).toBe(false)
    expect(mockRequestUrl).toHaveBeenCalledTimes(11)
  })
})

// ============================================================
// 源站主线路失败 → relay 优先兜底
// ============================================================
describe('附件下载：media30d 失败 → relay-1/m30 兜底', () => {
  beforeEach(() => mockRequestUrl.mockReset())

  test('主 3 次失败 → relay-1/m30 首次成功', async () => {
    mockRequestUrl
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(successResponse())

    const result = await downloadAttachment(
      'https://media30d.clipfx.app/abc',
      2,
      0,
    )

    expect(result.success).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(4)
    expect(mockRequestUrl.mock.calls[3][0].url).toBe(
      'https://relay-1.bijitongbu.site/m30/abc',
    )
  })
})

// ============================================================
// expired 语义
// - 主线路是权威源站（pic/media/media30d/sync 及其配置的镜像，当前均无镜像） NoSuchKey → 立即 expired，不 fallback
// - 主线路是 relay NoSuchKey → 跨节点交叉验证（relay 单点可能故障）
// - 全部节点都 expired → 真过期
// - 混合失败 → pure failure（不污染 expired）
// ============================================================
describe('附件下载：expired 语义', () => {
  beforeEach(() => mockRequestUrl.mockReset())

  test('主线路是源站 NoSuchKey → 立即 expired，不走 fallback（源站是权威）', async () => {
    mockRequestUrl.mockRejectedValueOnce(rejected404())

    const result = await downloadAttachment(
      'https://media30d.clipfx.app/abc',
      2,
      0,
    )

    expect(result.success).toBe(false)
    expect(result.expired).toBe(true)
    // 源站权威：1 次 NoSuchKey 后就不再试 relay fallback
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
  })

  test('源站 NoSuchKey 即使 fallback 不健康也保持 expired', async () => {
    // 即使 fallback 会网络失败，源站的 404 也应该直接信任——不进入 fallback
    mockRequestUrl.mockRejectedValueOnce(rejected404())

    const result = await downloadAttachment(
      'https://media30d.clipfx.app/abc',
      2,
      0,
    )

    expect(result.expired).toBe(true)
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
  })

  test('主线路是 relay NoSuchKey → 继续 fallback（P2：不能单凭 relay 判定全网过期）', async () => {
    mockRequestUrl
      // relay-1/m30 主线路 1 次 NoSuchKey（attemptDownload 内部短路）
      .mockRejectedValueOnce(rejected404())
      // relay-2/m30 fallback 1 次 NoSuchKey（同样非权威，继续）
      .mockRejectedValueOnce(rejected404())
      // relay-3/m30 fallback 1 次 NoSuchKey（非权威，继续）
      .mockRejectedValueOnce(rejected404())
      // relay-4/m30 fallback 1 次 NoSuchKey（非权威，继续）
      .mockRejectedValueOnce(rejected404())
      // media30d fallback 首次成功
      .mockResolvedValueOnce(successResponse())

    const result = await downloadAttachment(
      'https://relay-1.bijitongbu.site/m30/abc',
      2,
      0,
    )

    expect(result.success).toBe(true)
    expect(result.expired).toBeUndefined()
    expect(mockRequestUrl).toHaveBeenCalledTimes(5)
    expect(mockRequestUrl.mock.calls[4][0].url).toBe(
      'https://media30d.clipfx.app/abc',
    )
  })

  test('relay 主线路 + 所有节点都 NoSuchKey → 真过期', async () => {
    mockRequestUrl.mockRejectedValue(rejected404())

    const result = await downloadAttachment(
      'https://relay-1.bijitongbu.site/m30/abc',
      2,
      0,
    )

    expect(result.success).toBe(false)
    expect(result.expired).toBe(true)
    // relay-1 主 1 + relay-2/3/4 fallback 各 1（均 NoSuchKey 短路）+ media30d fallback 1（NoSuchKey）= 5
    expect(mockRequestUrl).toHaveBeenCalledTimes(5)
  })

  test('源站主线路网络败 + 某 fallback NoSuchKey + 另一 fallback 成功 → success', async () => {
    // primary=pic.clipfx.app; fallback 顺序 = [relay-1/p, relay-2/p, relay-3/p, relay-4/p]
    mockRequestUrl
      // pic.clipfx.app 主线路 3 次网络错误
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      // relay-1/p 返回 NoSuchKey（节点故障，不应短路全链）
      .mockRejectedValueOnce(rejected404())
      // relay-2/p 同样 NoSuchKey（仍非权威）
      .mockRejectedValueOnce(rejected404())
      // relay-3/p 首次成功
      .mockResolvedValueOnce(successResponse())

    const result = await downloadAttachment(
      'https://pic.clipfx.app/abc.png',
      2,
      0,
    )

    expect(result.success).toBe(true)
    expect(result.expired).toBeUndefined()
    expect(mockRequestUrl).toHaveBeenCalledTimes(6)
    expect(mockRequestUrl.mock.calls[5][0].url).toBe(
      'https://relay-3.bijitongbu.site/p/abc.png',
    )
  })

  test('relay 主线路败 + 源站 fallback NoSuchKey → 立刻 expired，不再试后续节点', async () => {
    // 关键场景：primary 是 relay-1/p，fallback 顺序 = [relay-2/p, relay-3/p, relay-4/p, pic.clipfx.app]
    // 源站 pic.clipfx.app 作为 fallback 返回 NoSuchKey（权威 → 真过期）
    mockRequestUrl
      // relay-1/p 主线路 3 次网络错误
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      // relay-2/p fallback 2 次网络错（FALLBACK_MAX_RETRIES+1）
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      // relay-3/p fallback 2 次网络错
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      // relay-4/p fallback 2 次网络错
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      // 源站 pic.clipfx.app 返回 NoSuchKey
      .mockRejectedValueOnce(rejected404())

    const result = await downloadAttachment(
      'https://relay-1.bijitongbu.site/p/abc',
      2,
      0,
    )

    expect(result.expired).toBe(true)
    // 主线路 3 + relay-2/3/4 各 2 + 源站 1 = 10
    expect(mockRequestUrl).toHaveBeenCalledTimes(10)
    expect(mockRequestUrl.mock.calls[9][0].url).toBe(
      'https://pic.clipfx.app/abc',
    )
  })

  test('源站主线路网络败 + 仅 relay fallback NoSuchKey → pure failure（relay 不权威）', async () => {
    // media30d.clipfx.app 的 fallback 只有 relay-1/2/3/4/m30（无源站镜像），
    // 主线路网络错 + 各 relay NoSuchKey 没有权威源站确认，不能断言过期
    mockRequestUrl
      // media30d 主 3 次网络错
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      .mockRejectedValueOnce(new Error('net'))
      // relay-1/m30 NoSuchKey（非权威，继续）
      .mockRejectedValueOnce(rejected404())
      // relay-2/m30 NoSuchKey（仍非权威）
      .mockRejectedValueOnce(rejected404())
      // relay-3/m30 NoSuchKey（仍非权威）
      .mockRejectedValueOnce(rejected404())
      // relay-4/m30 NoSuchKey（仍非权威）
      .mockRejectedValueOnce(rejected404())

    const result = await downloadAttachment(
      'https://media30d.clipfx.app/abc',
      2,
      0,
    )

    expect(result.success).toBe(false)
    expect(result.expired).toBeUndefined()
    expect(mockRequestUrl).toHaveBeenCalledTimes(7)
  })
})

// ============================================================
// 非 relay/源站域名：无 fallback，行为等同无改造前
// ============================================================
describe('附件下载：未知域名无 fallback', () => {
  beforeEach(() => mockRequestUrl.mockReset())

  test('example.com 3 次失败 → 返回 failure，总 3 次请求', async () => {
    mockRequestUrl.mockRejectedValue(new Error('down'))

    const result = await downloadAttachment(
      'https://example.com/file.pdf',
      2,
      0,
    )

    expect(result.success).toBe(false)
    expect(result.expired).toBeUndefined()
    expect(mockRequestUrl).toHaveBeenCalledTimes(3)
  })
})
