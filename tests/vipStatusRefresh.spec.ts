/**
 * 会员状态「手动刷新」TDD。
 *
 * 背景：插件设置页的会员状态走 GET /user-config，而 CF 端给 /user-config 套了
 * 15s 缓存回放型限流（worker.js RATE_LIMIT_WINDOW_MS）。后果：用户实际会员状态
 * 已在服务端变更，但插件连续查询窗口内只会拿到旧缓存 → 显示不更新。
 *
 * 本 spec：
 *   §1 characterization —— 复现「自动状态」陈旧：CF 缓存冻结期间，连续调用
 *       fetchVipStatus 仍返回旧状态（即便真实状态已变）。这条在现有代码上就通过，
 *       用来「钉住」我们要解决的现象。
 *   §2 RED —— 新增 fetchVipStatusFresh 走 /user-config/refresh（不走缓存），
 *       点刷新能立刻拿到变更后的状态。实现前该函数不存在 → 红。
 *   §3 RED —— /user-config/refresh 触发防刷限流返回 429 时，fetchVipStatusFresh
 *       返回 { rateLimited: true }，UI 据此提示「刷新过于频繁」。实现前红。
 *   §4 RED —— fetchVipStatusFresh 支持 base 覆盖（E2E 本地 mock 用），默认打生产域名。
 */

type Vip = { vip_type: string; endtime?: string }

// jest.mock 工厂会被 hoist 到 import 之上，只能引用以 `mock` 开头的外部变量。
const mockBackend: {
  cached: Vip[] // GET /user-config 返回（模拟被 CF 15s 缓存冻结的「自动状态」）
  fresh: Vip[] // GET /user-config/refresh 返回（不走缓存的「实时状态」）
  refreshHits: number
  refreshLimit: number // 命中此值后 /user-config/refresh 返回 429（模拟防刷）
  calls: { url: string; method: string }[]
} = {
  cached: [],
  fresh: [],
  refreshHits: 0,
  refreshLimit: Number.POSITIVE_INFINITY,
  calls: [],
}

function jsonResp(status: number, body: unknown) {
  return {
    status,
    json: body,
    text: JSON.stringify(body),
    arrayBuffer: new ArrayBuffer(0),
    headers: { 'content-type': 'application/json' },
  }
}

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(async (opt: { url: string; method?: string }) => {
    const method = (opt.method ?? 'GET').toUpperCase()
    mockBackend.calls.push({ url: opt.url, method })
    const u = new URL(opt.url)
    if (u.pathname === '/user-config') {
      return jsonResp(200, { success: true, data: mockBackend.cached })
    }
    if (u.pathname === '/user-config/refresh') {
      mockBackend.refreshHits += 1
      if (mockBackend.refreshHits > mockBackend.refreshLimit) {
        return jsonResp(429, { error: '刷新过于频繁，请稍后再试' })
      }
      return jsonResp(200, { success: true, data: mockBackend.fresh })
    }
    return jsonResp(404, { error: 'not found' })
  }),
}))

// 用 require + any 取模块，避免「实现前没有该导出」时 TS 编译直接报错——
// 我们要的是运行时断言失败的「红」，而不是编译失败。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const api: any = require('../src/api')

const FUTURE = '2099-12-31T00:00:00.000Z'
const KEY = 'test-api-key'

beforeEach(() => {
  mockBackend.cached = []
  mockBackend.fresh = []
  mockBackend.refreshHits = 0
  mockBackend.refreshLimit = Number.POSITIVE_INFINITY
  mockBackend.calls = []
})

describe('§1 自动状态因 CF 缓存而陈旧（characterization）', () => {
  it('CF 缓存冻结期间，连续 fetchVipStatus 返回旧状态——即便真实状态已升级', async () => {
    // 初始：试用会员
    mockBackend.cached = [{ vip_type: 'obtrail', endtime: FUTURE }]

    const first = await api.fetchVipStatus(KEY)
    expect(first.vipType).toBe('obtrail')

    // 服务端把用户升级成正式会员（fresh 变了），但 /user-config 仍被 CF 缓存冻结成旧值
    mockBackend.fresh = [{ vip_type: 'obvip', endtime: FUTURE }]
    // （mockBackend.cached 不变，模拟 15s 窗口内回放旧缓存）

    const second = await api.fetchVipStatus(KEY)
    // bug 现象：自动状态仍是试用，没跟上升级
    expect(second.vipType).toBe('obtrail')

    // 而且打的是 /user-config（被缓存的那个端点）
    expect(mockBackend.calls.every((c) => new URL(c.url).pathname === '/user-config')).toBe(true)
  })
})

describe('§2 手动刷新走 /user-config/refresh 立刻拿到变更后的状态', () => {
  it('fetchVipStatusFresh 存在且是函数', () => {
    expect(typeof api.fetchVipStatusFresh).toBe('function')
  })

  it('自动状态陈旧时，点刷新能拿到升级后的正式会员', async () => {
    mockBackend.cached = [{ vip_type: 'obtrail', endtime: FUTURE }] // 自动状态：旧（试用）
    mockBackend.fresh = [{ vip_type: 'obvip', endtime: FUTURE }] // 实时状态：新（正式）

    // 自动状态仍旧
    const auto = await api.fetchVipStatus(KEY)
    expect(auto.vipType).toBe('obtrail')

    // 手动刷新 → 实时
    const fresh = await api.fetchVipStatusFresh(KEY)
    expect(fresh.vipType).toBe('obvip')
    expect(fresh.isValid).toBe(true)

    // 确认刷新确实打了 /user-config/refresh
    const refreshCalls = mockBackend.calls.filter(
      (c) => new URL(c.url).pathname === '/user-config/refresh',
    )
    expect(refreshCalls.length).toBe(1)
  })
})

describe('§3 刷新触发防刷限流 → rateLimited', () => {
  it('/user-config/refresh 返回 429 时，结果带 rateLimited:true', async () => {
    mockBackend.fresh = [{ vip_type: 'obvip', endtime: FUTURE }]
    mockBackend.refreshLimit = 0 // 第一次刷新就 429

    const res = await api.fetchVipStatusFresh(KEY)
    expect(res.rateLimited).toBe(true)
    // 限流时不应误标为网络异常
    expect(res.networkError).toBeFalsy()
  })
})

describe('§4 base 覆盖（E2E 本地 mock 用），默认生产域名', () => {
  it('默认打 obsidian.notebooksyncer.com', async () => {
    mockBackend.fresh = [{ vip_type: 'obvip', endtime: FUTURE }]
    await api.fetchVipStatusFresh(KEY)
    expect(mockBackend.calls[0].url).toBe(
      'https://obsidian.notebooksyncer.com/user-config/refresh',
    )
  })

  it('传入 base 覆盖时打覆盖域名', async () => {
    mockBackend.fresh = [{ vip_type: 'obvip', endtime: FUTURE }]
    await api.fetchVipStatusFresh(KEY, 'http://127.0.0.1:8799')
    expect(mockBackend.calls[0].url).toBe('http://127.0.0.1:8799/user-config/refresh')
  })

  it('fetchVipStatus 也支持 base 覆盖', async () => {
    mockBackend.cached = [{ vip_type: 'obvip', endtime: FUTURE }]
    await api.fetchVipStatus(KEY, 'http://127.0.0.1:8799')
    expect(mockBackend.calls[0].url).toBe('http://127.0.0.1:8799/user-config')
  })
})
