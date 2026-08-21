/**
 * EndpointSelector — 多入口自动测速与选择
 *
 * 背景：云空间后端对外提供多个接入域名（原主 CF Worker、国内加速 relay、旧备用），
 * 不同网络环境下延迟差异较大。本模块负责：
 *  1. 对候选池并发探测（GET /api/stats/article-count），首个成功者胜出
 *  2. 缓存选择结果到 localStorage，24h TTL
 *  3. 请求失败连续累计 → 清缓存，下次调用重测
 *  4. 向外提供"优先 base + 有序回退列表"两个原语，给 api.ts 的重试逻辑用
 *
 * 注意：本模块只影响 api.ts 中原本就硬编码忽略 settings.endpoint 的
 * `requestWithFallback` 路径。用户在设置里自定义过的 endpoint 不会被本模块覆盖，
 * getArticleCount / clearAllArticles 等仍走 settings.endpoint。
 */

import { requestUrl } from 'obsidian'
import { log, logError } from './logger'

/** 候选入口 base URL（不含 /api/... 后缀）。顺序 = 探测失败时的兜底优先级。
 *
 * 节点拓扑（2026-05 起）：
 *  - relay-1.bijitongbu.site/helper 国内 82.156.17.38（同 VPC 内网直连 omniserver 10.2.24.10）
 *  - relay-2.bijitongbu.site       国内 118.25.58.138（不同 VPC，公网回源 140.143.189.226:8880/8002）
 *  - graph.bijitongbu.site         国内 82.156.17.38（与 relay-1 同机，独立 server_name，IP 同 relay-1）
 *  - obsidian.notebooksyncer.com   CF 边缘（海外 anycast），晚间国内常抖
 *
 * 2026-05-12 改：把 CF 从首位挪到末位，按"独立故障域"排：
 *   relay-1（82.156.17.38）→ relay-2（118.25.58.138 独立 IP）→ graph（同 82.156.17.38，备 SNI 阻断）→ CF
 * raceProbe 首胜机制不变，海外用户 CF anycast 仍可能赢；只有 raceProbe 全挂时新顺序才生效。
 */
export const CANDIDATE_BASES: readonly string[] = [
  'https://relay-1.bijitongbu.site/helper',
  'https://relay-2.bijitongbu.site',
  'https://graph.bijitongbu.site',
  'https://obsidian.notebooksyncer.com',
] as const

/** 单端点探测超时（毫秒）。1.5s 偏严，国内首跳 TLS 常 1.5–3s 即便可用 */
export const PROBE_TIMEOUT_MS = 3000

/** 缓存有效期（毫秒）。24h 跨晨昏太长，凌晨选 CF 晚间整天卡 → 1h */
export const CACHE_TTL_MS = 60 * 60 * 1000

/** 连续整轮失败多少次后清缓存重测 */
export const FAILURE_THRESHOLD = 3

/** 首跳 network 错连续多少次清缓存（TLS/TCP/DNS/timeout） */
export const PRIMARY_MISS_THRESHOLD_NETWORK = 2

/** 首跳 gateway_err（502/503/504/404/405）连续多少次清缓存 */
export const PRIMARY_MISS_THRESHOLD_GATEWAY = 3

/** 错误分类，决定是否 fallback / 是否计入 primary miss */
export type FailureKind =
  | 'network'      // 无 HTTP status: TLS/TCP/DNS/timeout — base 链路死
  | 'gateway_err'  // 502/503/504/404/405 — base 网关/路径问题
  | 'app_5xx'      // 500/501 — omniserver 应用层挂（换 base 也错）
  | 'rate_limit'   // 429
  | 'business'     // 401/403/422 — 用户/数据问题，停 fallback

/** 把 error 或 http status 归类到 FailureKind。
 *  调用方既可能传 Error（含 status），也可能传裸 status 数字。 */
export const classifyError = (errOrStatus: unknown): FailureKind => {
  let status: number | undefined
  if (typeof errOrStatus === 'number') {
    status = errOrStatus
  } else if (errOrStatus && typeof errOrStatus === 'object') {
    const s = (errOrStatus as { status?: unknown }).status
    if (typeof s === 'number') status = s
  }
  if (typeof status !== 'number') return 'network'
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403 || status === 422) return 'business'
  if (status === 404 || status === 405) return 'gateway_err'
  if (status === 502 || status === 503 || status === 504) return 'gateway_err'
  if (status >= 500) return 'app_5xx'
  return 'gateway_err'  // 兜底其它 4xx（408/410/...）
}

const CACHE_KEY = 'notehelper:endpointCache'

export interface EndpointCache {
  base: string
  latencyMs: number
  chosenAt: number
}

export interface ProbeResult {
  base: string
  ok: boolean
  latencyMs: number
  error?: string
}

/**
 * 最小可注入依赖，便于单测替换。
 * 生产环境下 requestFn 对应 obsidian.requestUrl，storage 对应 window.localStorage，
 * now 对应 Date.now。
 */
export interface EndpointSelectorDeps {
  requestFn: (url: string, headers: Record<string, string>) => Promise<{ status: number }>
  storage: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
  }
  now: () => number
  timeoutMs?: number
}

/** 默认依赖（生产用） */
const defaultStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      /* noop：移动端/隐私模式偶发 */
    }
  },
  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key)
    } catch {
      /* noop */
    }
  },
}

const defaultRequestFn = async (
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number }> => {
  const resp = await requestUrl({ url, method: 'GET', headers })
  return { status: resp.status }
}

const defaultDeps: EndpointSelectorDeps = {
  requestFn: defaultRequestFn,
  storage: defaultStorage,
  now: () => Date.now(),
  timeoutMs: PROBE_TIMEOUT_MS,
}

/** 带超时的请求包装。requestFn 本身无 abort 能力，这里只做 Promise race。 */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`probe timeout ${ms}ms`)), ms)
    p.then(
      (v) => {
        window.clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        window.clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })

/**
 * 探测单个 base。返回结果不抛异常（ok=false 表示失败）。
 * 约定：只有 HTTP 200 才算"端点健康可用"。
 * 4xx（包括 404 路径未部署、401/403 鉴权）一律视为不健康 —— 否则会把一个
 * 实际上打不开 GraphQL 的 base 缓存为主入口，拖慢接下来 24h 的所有请求。
 */
export const probeEndpoint = async (
  base: string,
  apiKey: string,
  deps: EndpointSelectorDeps = defaultDeps,
): Promise<ProbeResult> => {
  const url = `${base}/api/stats/article-count`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) {
    headers['x-api-key'] = apiKey
  }
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  const start = deps.now()
  try {
    const resp = await withTimeout(deps.requestFn(url, headers), timeoutMs)
    const latencyMs = deps.now() - start
    const ok = resp.status === 200
    return { base, ok, latencyMs, error: ok ? undefined : `status=${resp.status}` }
  } catch (err) {
    const latencyMs = deps.now() - start
    const error = err instanceof Error ? err.message : String(err)
    return { base, ok: false, latencyMs, error }
  }
}

/**
 * 并发探测所有候选，返回第一个 ok=true 的 base；若全部失败返回 null。
 * 采用"首个成功立即 resolve"策略，不等待慢的端点。
 */
export const raceProbe = async (
  bases: readonly string[],
  apiKey: string,
  deps: EndpointSelectorDeps = defaultDeps,
): Promise<ProbeResult | null> => {
  if (bases.length === 0) return null
  return new Promise<ProbeResult | null>((resolve) => {
    let settled = false
    let remaining = bases.length
    const finish = (result: ProbeResult | null) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    bases.forEach((base) => {
      probeEndpoint(base, apiKey, deps).then(
        (r) => {
          if (r.ok) {
            finish(r)
            return
          }
          remaining -= 1
          if (remaining === 0) finish(null)
        },
        () => {
          // probeEndpoint 本身吞异常，理论上走不到这里；防御性处理
          remaining -= 1
          if (remaining === 0) finish(null)
        },
      )
    })
  })
}

const readCache = (deps: EndpointSelectorDeps): EndpointCache | null => {
  const raw = deps.storage.getItem(CACHE_KEY)
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as EndpointCache
    if (!obj || typeof obj.base !== 'string' || typeof obj.chosenAt !== 'number') return null
    if (deps.now() - obj.chosenAt > CACHE_TTL_MS) return null
    if (!CANDIDATE_BASES.includes(obj.base)) return null
    return obj
  } catch {
    return null
  }
}

const writeCache = (cache: EndpointCache, deps: EndpointSelectorDeps): void => {
  deps.storage.setItem(CACHE_KEY, JSON.stringify(cache))
}

/**
 * 获取当前应优先使用的 base：
 * - 命中缓存且未过期 → 用缓存
 * - 否则触发一次 raceProbe，写回缓存；全挂时返回 CANDIDATE_BASES[0]（不写缓存）
 */
export const selectFastestBase = async (
  apiKey: string,
  deps: EndpointSelectorDeps = defaultDeps,
): Promise<string> => {
  const cached = readCache(deps)
  if (cached) {
    log('🔧 endpointSelector 命中缓存:', cached.base)
    return cached.base
  }
  const result = await raceProbe(CANDIDATE_BASES, apiKey, deps)
  if (result) {
    writeCache({ base: result.base, latencyMs: result.latencyMs, chosenAt: deps.now() }, deps)
    // 换了新 primary，之前攒的 miss/failure 计数对它没意义，全部归零
    consecutiveFailures = 0
    primaryNetworkMisses = 0
    primaryGatewayMisses = 0
    log('🔧 endpointSelector 选中:', result.base, `${result.latencyMs}ms`)
    return result.base
  }
  logError('endpointSelector 所有候选都失败，回退默认:', CANDIDATE_BASES[0])
  return CANDIDATE_BASES[0]
}

/**
 * 返回按"优先 base 先，再按候选池顺序"去重后的回退列表，供 api.ts 逐一重试。
 */
export const getOrderedFallbackBases = async (
  apiKey: string,
  deps: EndpointSelectorDeps = defaultDeps,
): Promise<string[]> => {
  const primary = await selectFastestBase(apiKey, deps)
  const rest = CANDIDATE_BASES.filter((b) => b !== primary)
  return [primary, ...rest]
}

/**
 * 模块内存态计数器（进程重启归零）。
 * - consecutiveFailures: 整轮（所有 base 都挂）连续失败次数
 * - primaryNetworkMisses: 首跳 network 错连续次数（达到 PRIMARY_MISS_THRESHOLD_NETWORK 清缓存）
 * - primaryGatewayMisses: 首跳 gateway_err 错连续次数（达到 PRIMARY_MISS_THRESHOLD_GATEWAY 清缓存）
 *
 * 不计 miss 的情况：
 *   - app_5xx：所有 base 都反代到同一 omniserver，换 base 也错
 *   - rate_limit：限流，等窗口过更靠谱
 *   - business：用户错（apiKey 不对等），与 base 无关
 */
let consecutiveFailures = 0
let primaryNetworkMisses = 0
let primaryGatewayMisses = 0

/**
 * 上游请求失败时调用（"所有 base 都轮过一遍还是失败"才算）。
 * 累计到阈值后清缓存，下次 selectFastestBase 会重新探测。
 */
export const notifyRequestFailure = (deps: EndpointSelectorDeps = defaultDeps): void => {
  consecutiveFailures += 1
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    log('🔧 endpointSelector 连续失败阈值触发，清缓存')
    deps.storage.removeItem(CACHE_KEY)
    consecutiveFailures = 0
    primaryNetworkMisses = 0
    primaryGatewayMisses = 0
  }
}

/**
 * 请求成功时调用。primaryHit=true 表示靠有序列表中首个 base 成功；
 * false 表示绕过首个 base 靠 fallback 成功（间接说明首个 base 当前不可用）。
 *
 * primaryFailureKind: 当 primaryHit=false 时，传入 primary 那次失败的类型。
 *   按类型分级累计 miss：
 *     - 'network'：链路死，2 次清缓存
 *     - 'gateway_err'：网关/路径问题，3 次清缓存（容忍瞬时 nginx 重启）
 *     - 'app_5xx' / 'rate_limit' / 'business'：不计
 */
export const notifyRequestSuccess = (
  primaryHit: boolean,
  primaryFailureKind?: FailureKind,
  deps: EndpointSelectorDeps = defaultDeps,
): void => {
  consecutiveFailures = 0
  if (primaryHit) {
    primaryNetworkMisses = 0
    primaryGatewayMisses = 0
    return
  }
  if (primaryFailureKind === 'network') {
    primaryNetworkMisses += 1
    if (primaryNetworkMisses >= PRIMARY_MISS_THRESHOLD_NETWORK) {
      log(`🔧 endpointSelector 首跳 network 错 ${primaryNetworkMisses} 次，清缓存`)
      deps.storage.removeItem(CACHE_KEY)
      primaryNetworkMisses = 0
      primaryGatewayMisses = 0
    }
  } else if (primaryFailureKind === 'gateway_err') {
    primaryGatewayMisses += 1
    if (primaryGatewayMisses >= PRIMARY_MISS_THRESHOLD_GATEWAY) {
      log(`🔧 endpointSelector 首跳 gateway_err ${primaryGatewayMisses} 次，清缓存`)
      deps.storage.removeItem(CACHE_KEY)
      primaryNetworkMisses = 0
      primaryGatewayMisses = 0
    }
  }
  // app_5xx / rate_limit / business / undefined: 不计 miss
}

/** 手动清空缓存（内部工具，当前未对外暴露 UI） */
export const clearEndpointCache = (deps: EndpointSelectorDeps = defaultDeps): void => {
  deps.storage.removeItem(CACHE_KEY)
  consecutiveFailures = 0
  primaryNetworkMisses = 0
  primaryGatewayMisses = 0
}

/** 只读获取当前缓存（设置页展示用） */
export const peekEndpointCache = (deps: EndpointSelectorDeps = defaultDeps): EndpointCache | null =>
  readCache(deps)

/** 测试用：重置内部计数器 */
export const __resetForTests = (): void => {
  consecutiveFailures = 0
  primaryNetworkMisses = 0
  primaryGatewayMisses = 0
}
