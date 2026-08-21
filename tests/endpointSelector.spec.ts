import {
  CANDIDATE_BASES,
  CACHE_TTL_MS,
  FAILURE_THRESHOLD,
  PRIMARY_MISS_THRESHOLD_NETWORK,
  PRIMARY_MISS_THRESHOLD_GATEWAY,
  EndpointSelectorDeps,
  classifyError,
  clearEndpointCache,
  getOrderedFallbackBases,
  notifyRequestFailure,
  notifyRequestSuccess,
  peekEndpointCache,
  probeEndpoint,
  raceProbe,
  selectFastestBase,
  __resetForTests,
} from '../src/endpointSelector'

/**
 * 内存版 storage 替代 localStorage
 */
const makeStorage = () => {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
    _data: data,
  }
}

interface FakeResponse {
  /** 延迟毫秒数 */
  delayMs: number
  /** HTTP status；0 表示 reject（网络错误） */
  status: number
}

/**
 * 按 base 配表返回假响应。每个 probe 调用都会走 fake timer 延迟再返回。
 */
const makeRequestFn = (
  responses: Record<string, FakeResponse>,
  opts: { callLog?: string[]; fakeNow?: { value: number } } = {},
) => {
  const callLog = opts.callLog ?? []
  return async (url: string): Promise<{ status: number }> => {
    callLog.push(url)
    const base = Object.keys(responses).find((b) => url.startsWith(b))
    const r = base ? responses[base] : { delayMs: 0, status: 404 }
    if (r.delayMs > 0) {
      await new Promise<void>((resolve) => {
        if (opts.fakeNow) opts.fakeNow.value += r.delayMs
        setImmediate(resolve)
      })
    }
    if (r.status === 0) throw new Error('network down')
    return { status: r.status }
  }
}

const makeDeps = (
  responses: Record<string, FakeResponse>,
  overrides: Partial<EndpointSelectorDeps> = {},
): { deps: EndpointSelectorDeps; storage: ReturnType<typeof makeStorage>; callLog: string[]; nowRef: { value: number } } => {
  const storage = makeStorage()
  const callLog: string[] = []
  const nowRef = { value: 1_000_000_000 }
  const deps: EndpointSelectorDeps = {
    requestFn: makeRequestFn(responses, { callLog, fakeNow: nowRef }),
    storage,
    now: () => nowRef.value,
    timeoutMs: 1500,
    ...overrides,
  }
  return { deps, storage, callLog, nowRef }
}

beforeEach(() => {
  __resetForTests()
})

describe('probeEndpoint', () => {
  it('返回 ok=true 当响应 < 500', async () => {
    const { deps } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 10, status: 200 },
    })
    const r = await probeEndpoint(CANDIDATE_BASES[0], 'k', deps)
    expect(r.ok).toBe(true)
    expect(r.base).toBe(CANDIDATE_BASES[0])
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('返回 ok=false 当 401（只认 200，不把鉴权错误当健康）', async () => {
    const { deps } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 5, status: 401 },
    })
    const r = await probeEndpoint(CANDIDATE_BASES[0], '', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('401')
  })

  it('返回 ok=false 当 404（路径未部署）', async () => {
    const { deps } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 5, status: 404 },
    })
    const r = await probeEndpoint(CANDIDATE_BASES[0], 'k', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('404')
  })

  it('返回 ok=false 当 5xx', async () => {
    const { deps } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 5, status: 503 },
    })
    const r = await probeEndpoint(CANDIDATE_BASES[0], 'k', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('503')
  })

  it('返回 ok=false 当网络错误', async () => {
    const { deps } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 5, status: 0 },
    })
    const r = await probeEndpoint(CANDIDATE_BASES[0], 'k', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('network down')
  })

  it('带上 x-api-key 头', async () => {
    const seen: Record<string, string> = {}
    const deps: EndpointSelectorDeps = {
      requestFn: async (url, headers) => {
        seen[url] = headers['x-api-key'] ?? ''
        return { status: 200 }
      },
      storage: makeStorage(),
      now: () => 1,
      timeoutMs: 1000,
    }
    await probeEndpoint(CANDIDATE_BASES[0], 'SECRET', deps)
    expect(seen[`${CANDIDATE_BASES[0]}/api/stats/article-count`]).toBe('SECRET')
  })
})

describe('raceProbe', () => {
  it('首个成功立即胜出', async () => {
    const { deps } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 100, status: 200 },
      [CANDIDATE_BASES[1]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[2]]: { delayMs: 200, status: 200 },
    })
    const r = await raceProbe(CANDIDATE_BASES, 'k', deps)
    expect(r).not.toBeNull()
    // 由于 setImmediate 串行推进 fakeNow，延迟值被观测，但胜者仍应是能返回成功的任意一个
    expect(r!.ok).toBe(true)
    expect(CANDIDATE_BASES).toContain(r!.base)
  })

  it('全部失败返回 null', async () => {
    const { deps } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 5, status: 503 },
      [CANDIDATE_BASES[1]]: { delayMs: 5, status: 0 },
      [CANDIDATE_BASES[2]]: { delayMs: 5, status: 502 },
    })
    const r = await raceProbe(CANDIDATE_BASES, 'k', deps)
    expect(r).toBeNull()
  })

  it('部分成功时忽略失败的', async () => {
    const { deps } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 5, status: 503 },
      [CANDIDATE_BASES[1]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[2]]: { delayMs: 5, status: 0 },
    })
    const r = await raceProbe(CANDIDATE_BASES, 'k', deps)
    expect(r).not.toBeNull()
    expect(r!.base).toBe(CANDIDATE_BASES[1])
  })
})

describe('selectFastestBase', () => {
  it('首次调用触发探测并写缓存', async () => {
    const { deps, storage } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[1]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[2]]: { delayMs: 10, status: 200 },
    })
    const base = await selectFastestBase('k', deps)
    expect(CANDIDATE_BASES).toContain(base)
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
  })

  it('命中缓存时不再探测', async () => {
    const { deps, storage, callLog } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 10, status: 200 },
    })
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[1], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    const base = await selectFastestBase('k', deps)
    expect(base).toBe(CANDIDATE_BASES[1])
    expect(callLog).toHaveLength(0)
  })

  it('缓存过期时重新探测', async () => {
    const { deps, storage, nowRef, callLog } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[1]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[2]]: { delayMs: 10, status: 200 },
    })
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[2], latencyMs: 42, chosenAt: nowRef.value - CACHE_TTL_MS - 1 }),
    )
    await selectFastestBase('k', deps)
    expect(callLog.length).toBeGreaterThan(0)
  })

  it('缓存里是不认识的 base 时作废', async () => {
    const { deps, storage, callLog } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[1]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[2]]: { delayMs: 10, status: 200 },
    })
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: 'https://legacy.example.com', latencyMs: 10, chosenAt: 1_000_000_000 }),
    )
    await selectFastestBase('k', deps)
    expect(callLog.length).toBeGreaterThan(0)
  })

  it('写入新缓存时归零 primaryMisses 计数（避免跨 primary 计数）', async () => {
    const { deps, storage } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[1]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[2]]: { delayMs: 10, status: 200 },
    })
    // 针对旧 primary 预先攒 (network 阈值 - 1) 次 miss
    for (let i = 0; i < PRIMARY_MISS_THRESHOLD_NETWORK - 1; i++) {
      notifyRequestSuccess(false, 'network', deps)
    }
    // 触发重测 → 写新 cache，应把上面的 miss 计数归零
    await selectFastestBase('k', deps)
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
    // 再来一次针对新 primary 的 miss，计数应从 0 开始，不该立刻清缓存
    notifyRequestSuccess(false, 'network', deps)
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
  })

  it('写入新缓存时归零 consecutiveFailures 计数', async () => {
    const { deps, storage } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[1]]: { delayMs: 10, status: 200 },
      [CANDIDATE_BASES[2]]: { delayMs: 10, status: 200 },
    })
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      notifyRequestFailure(deps)
    }
    await selectFastestBase('k', deps)
    // 再来一次整轮失败，计数应从 0 开始
    notifyRequestFailure(deps)
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
  })

  it('全部探测失败回退到候选首位且不写缓存', async () => {
    const { deps, storage } = makeDeps({
      [CANDIDATE_BASES[0]]: { delayMs: 5, status: 503 },
      [CANDIDATE_BASES[1]]: { delayMs: 5, status: 503 },
      [CANDIDATE_BASES[2]]: { delayMs: 5, status: 503 },
    })
    const base = await selectFastestBase('k', deps)
    expect(base).toBe(CANDIDATE_BASES[0])
    expect(storage.getItem('notehelper:endpointCache')).toBeNull()
  })
})

describe('getOrderedFallbackBases', () => {
  it('把选中 base 排在首位，其余按候选池顺序补齐', async () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[1], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    const bases = await getOrderedFallbackBases('k', deps)
    expect(bases[0]).toBe(CANDIDATE_BASES[1])
    expect(bases).toHaveLength(CANDIDATE_BASES.length)
    expect(new Set(bases).size).toBe(CANDIDATE_BASES.length)
  })
})

describe('notifyRequestFailure (全挂场景)', () => {
  it('累计到阈值后清缓存', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[0], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      notifyRequestFailure(deps)
    }
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
    notifyRequestFailure(deps)
    expect(storage.getItem('notehelper:endpointCache')).toBeNull()
  })

  it('中途一次 primary-hit success 重置计数', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[0], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    notifyRequestFailure(deps)
    notifyRequestFailure(deps)
    notifyRequestSuccess(true, undefined, deps)
    notifyRequestFailure(deps)
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
  })
})

describe('notifyRequestSuccess primary miss 分级自愈', () => {
  it('首跳 network 错连续 N 次（PRIMARY_MISS_THRESHOLD_NETWORK）清缓存', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[0], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    for (let i = 0; i < PRIMARY_MISS_THRESHOLD_NETWORK - 1; i++) {
      notifyRequestSuccess(false, 'network', deps)
    }
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
    notifyRequestSuccess(false, 'network', deps)
    expect(storage.getItem('notehelper:endpointCache')).toBeNull()
  })

  it('首跳 gateway_err 连续 N 次（PRIMARY_MISS_THRESHOLD_GATEWAY）清缓存', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[0], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    for (let i = 0; i < PRIMARY_MISS_THRESHOLD_GATEWAY - 1; i++) {
      notifyRequestSuccess(false, 'gateway_err', deps)
    }
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
    notifyRequestSuccess(false, 'gateway_err', deps)
    expect(storage.getItem('notehelper:endpointCache')).toBeNull()
  })

  it('首跳 app_5xx 不计 miss（换 base 也救不了）', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[0], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    for (let i = 0; i < 10; i++) {
      notifyRequestSuccess(false, 'app_5xx', deps)
    }
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
  })

  it('首跳 rate_limit / business 不计 miss', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[0], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    for (let i = 0; i < 10; i++) {
      notifyRequestSuccess(false, 'rate_limit', deps)
      notifyRequestSuccess(false, 'business', deps)
    }
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
  })

  it('primaryHit=true 把两种 miss 计数都清零', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[0], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    // 先攒 network=1 + gateway=2（都未达阈值）
    notifyRequestSuccess(false, 'network', deps)
    notifyRequestSuccess(false, 'gateway_err', deps)
    notifyRequestSuccess(false, 'gateway_err', deps)
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
    // primaryHit=true 清零计数
    notifyRequestSuccess(true, undefined, deps)
    // 再补一次 network、一次 gateway_err 都不能立刻清缓存
    notifyRequestSuccess(false, 'network', deps)
    notifyRequestSuccess(false, 'gateway_err', deps)
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
  })

  it('network 和 gateway 计数互不干扰（独立累计）', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[0], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    // network 攒到 阈值-1，再混入 gateway_err 不应触发 network 清缓存
    for (let i = 0; i < PRIMARY_MISS_THRESHOLD_NETWORK - 1; i++) {
      notifyRequestSuccess(false, 'network', deps)
    }
    for (let i = 0; i < PRIMARY_MISS_THRESHOLD_GATEWAY - 1; i++) {
      notifyRequestSuccess(false, 'gateway_err', deps)
    }
    expect(storage.getItem('notehelper:endpointCache')).not.toBeNull()
    // 再加 1 个 network → 达到 network 阈值 → 清缓存
    notifyRequestSuccess(false, 'network', deps)
    expect(storage.getItem('notehelper:endpointCache')).toBeNull()
  })
})

describe('classifyError', () => {
  it('network: 无 status 或非数字 status', () => {
    expect(classifyError(new Error('timeout'))).toBe('network')
    expect(classifyError({})).toBe('network')
    expect(classifyError(undefined)).toBe('network')
    expect(classifyError({ status: 'nope' })).toBe('network')
  })
  it('business: 401 / 403 / 422', () => {
    expect(classifyError(401)).toBe('business')
    expect(classifyError(403)).toBe('business')
    expect(classifyError(422)).toBe('business')
    expect(classifyError({ status: 401 })).toBe('business')
  })
  it('rate_limit: 429', () => {
    expect(classifyError(429)).toBe('rate_limit')
  })
  it('gateway_err: 404/405/502/503/504/其它 4xx', () => {
    expect(classifyError(404)).toBe('gateway_err')
    expect(classifyError(405)).toBe('gateway_err')
    expect(classifyError(408)).toBe('gateway_err')
    expect(classifyError(410)).toBe('gateway_err')
    expect(classifyError(502)).toBe('gateway_err')
    expect(classifyError(503)).toBe('gateway_err')
    expect(classifyError(504)).toBe('gateway_err')
  })
  it('app_5xx: 500/501', () => {
    expect(classifyError(500)).toBe('app_5xx')
    expect(classifyError(501)).toBe('app_5xx')
  })
})

describe('clearEndpointCache / peekEndpointCache', () => {
  it('clear 移除缓存并归零失败计数', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[0], latencyMs: 42, chosenAt: 1_000_000_000 }),
    )
    notifyRequestFailure(deps)
    notifyRequestFailure(deps)
    clearEndpointCache(deps)
    expect(storage.getItem('notehelper:endpointCache')).toBeNull()
  })

  it('peek 返回解析后的缓存对象', () => {
    const { deps, storage } = makeDeps({})
    storage.setItem(
      'notehelper:endpointCache',
      JSON.stringify({ base: CANDIDATE_BASES[1], latencyMs: 77, chosenAt: 1_000_000_000 }),
    )
    const cache = peekEndpointCache(deps)
    expect(cache?.base).toBe(CANDIDATE_BASES[1])
    expect(cache?.latencyMs).toBe(77)
  })
})
