/**
 * deleteArticleById 单测（设计 §4 + §10）
 *
 * 与 apiPathFallback.spec.ts 同款：通过覆盖 obsidian.requestUrl mock 间接测试。
 * 覆盖：
 *   (a) 发出的 body 含 deleteArticle mutation 且 variables.input.id 正确、头里有 x-api-key
 *   (b) 服务端返回 {data:{deleteArticle:{article:{id}}}} → true
 *   (c) 返回 {data:{deleteArticle:{errorCodes:['INTERNAL_ERROR']}}} → false 不抛
 *   (d) 网络抛错 / 非 2xx → false 不抛
 *   (e) noFallback：官方 endpoint primary 502 → 只打一次 POST，不切 base2，返回 false 不抛
 *   (f) 私有 endpoint：直接 POST 到 endpoint（不探测官方 base），头含 x-api-key
 */
import { deleteArticleById } from '../src/api'
import { __resetForTests } from '../src/endpointSelector'

const requestCalls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = []

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(
    async (opt: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
      requestCalls.push({
        url: opt.url,
        method: (opt.method ?? 'GET').toUpperCase(),
        headers: opt.headers ?? {},
        body: opt.body,
      })
      // 默认：GET 探测返回 200（让 selector 能选出 primary）；POST 默认成功删除
      return { status: 200, json: { count: 0 }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} }
    },
  ),
}))

const getMock = (): jest.Mock => (jest.requireMock('obsidian') as { requestUrl: jest.Mock }).requestUrl

const okDeleteJson = (id: string) => ({ data: { deleteArticle: { article: { id } } } })

beforeEach(() => {
  requestCalls.length = 0
  __resetForTests()
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          _data: new Map<string, string>(),
          getItem(k: string) { return this._data.get(k) ?? null },
          setItem(k: string, v: string) { this._data.set(k, v) },
          removeItem(k: string) { this._data.delete(k) },
        },
        setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
        clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      },
    })
  } catch { /* already defined */ }
})

describe('deleteArticleById — 官方域名', () => {
  it('(a)+(b) 发 deleteArticle mutation + 正确 input.id + x-api-key 头，成功 → true', async () => {
    getMock().mockImplementation(
      async (opt: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
        requestCalls.push({
          url: opt.url,
          method: (opt.method ?? 'GET').toUpperCase(),
          headers: opt.headers ?? {},
          body: opt.body,
        })
        if ((opt.method ?? 'GET').toUpperCase() === 'GET') {
          return { status: 200, json: { count: 0 }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} }
        }
        // POST 删除成功
        return {
          status: 200,
          json: okDeleteJson('art-123'),
          text: '', arrayBuffer: new ArrayBuffer(0), headers: {},
        }
      },
    )

    const ok = await deleteArticleById('https://obsidian.notebooksyncer.com/api/graphql', 'my-key', 'art-123')
    expect(ok).toBe(true)

    const post = requestCalls.find(c => c.method === 'POST')
    expect(post).toBeDefined()
    // 打到 /api/graphql（不是 REST DELETE）
    expect(post!.url).toMatch(/\/api\/graphql$/)
    // 鉴权头用 x-api-key
    expect(post!.headers['x-api-key']).toBe('my-key')
    expect(post!.headers['Content-Type']).toBe('application/json')
    // body 含 deleteArticle mutation + 正确 variables.input.id
    const parsed = JSON.parse(post!.body ?? '{}')
    expect(parsed.query).toContain('deleteArticle')
    expect(parsed.query).toMatch(/mutation/i)
    expect(parsed.variables.input.id).toBe('art-123')
  })

  it('(c) 返回 errorCodes:[INTERNAL_ERROR] → false 不抛', async () => {
    getMock().mockImplementation(
      async (opt: { url: string; method?: string }) => {
        if ((opt.method ?? 'GET').toUpperCase() === 'GET') {
          return { status: 200, json: { count: 0 }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} }
        }
        return {
          status: 200,
          json: { data: { deleteArticle: { errorCodes: ['INTERNAL_ERROR'] } } },
          text: '', arrayBuffer: new ArrayBuffer(0), headers: {},
        }
      },
    )
    let result: boolean | undefined
    await expect((async () => { result = await deleteArticleById('https://obsidian.notebooksyncer.com/api/graphql', 'k', 'art-x') })())
      .resolves.toBeUndefined()
    expect(result).toBe(false)
  })

  it('(c2) 缺 article（既无 id 又无 errorCodes）→ false', async () => {
    getMock().mockImplementation(
      async (opt: { url: string; method?: string }) => {
        if ((opt.method ?? 'GET').toUpperCase() === 'GET') {
          return { status: 200, json: { count: 0 }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} }
        }
        return {
          status: 200,
          json: { data: { deleteArticle: {} } },
          text: '', arrayBuffer: new ArrayBuffer(0), headers: {},
        }
      },
    )
    const ok = await deleteArticleById('https://obsidian.notebooksyncer.com/api/graphql', 'k', 'art-x')
    expect(ok).toBe(false)
  })

  it('(d) POST 抛网络错误 → false 不抛', async () => {
    getMock().mockImplementation(
      async (opt: { url: string; method?: string }) => {
        if ((opt.method ?? 'GET').toUpperCase() === 'GET') {
          return { status: 200, json: { count: 0 }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} }
        }
        throw new Error('ECONNRESET')
      },
    )
    const ok = await deleteArticleById('https://obsidian.notebooksyncer.com/api/graphql', 'k', 'art-x')
    expect(ok).toBe(false)
  })

  it('(e) noFallback：primary 502 → POST 只打一次（不切 base2），返回 false 不抛', async () => {
    const postCalls: string[] = []
    getMock().mockImplementation(
      async (opt: { url: string; method?: string }) => {
        const m = (opt.method ?? 'GET').toUpperCase()
        if (m === 'GET') {
          // probe 全 200，让 selector 选出 primary
          return { status: 200, json: { count: 0 }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} }
        }
        // POST 502
        postCalls.push(opt.url)
        return { status: 502, json: null, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} }
      },
    )
    const ok = await deleteArticleById('https://obsidian.notebooksyncer.com/api/graphql', 'k', 'art-x')
    expect(ok).toBe(false)
    // 关键：destructive 不 fallback，POST 只能打一次
    expect(postCalls).toHaveLength(1)
  })
})

describe('deleteArticleById — 私有 endpoint', () => {
  it('(f) 直接 POST 到 endpoint，x-api-key 头，成功 → true', async () => {
    getMock().mockImplementation(
      async (opt: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
        requestCalls.push({
          url: opt.url,
          method: (opt.method ?? 'GET').toUpperCase(),
          headers: opt.headers ?? {},
          body: opt.body,
        })
        if (opt.url === 'https://my-private.example.com/api/graphql') {
          return { status: 200, json: okDeleteJson('p-1'), text: '', arrayBuffer: new ArrayBuffer(0), headers: {} }
        }
        throw new Error('should not reach official base for private endpoint')
      },
    )
    const ok = await deleteArticleById('https://my-private.example.com/api/graphql', 'priv-key', 'p-1')
    expect(ok).toBe(true)
    // 不应探测任何官方 base
    expect(requestCalls.every(c => c.url.startsWith('https://my-private.example.com'))).toBe(true)
    const post = requestCalls.find(c => c.method === 'POST')
    expect(post).toBeDefined()
    expect(post!.url).toBe('https://my-private.example.com/api/graphql')
    expect(post!.headers['x-api-key']).toBe('priv-key')
    const parsed = JSON.parse(post!.body ?? '{}')
    expect(parsed.query).toContain('deleteArticle')
    expect(parsed.variables.input.id).toBe('p-1')
  })

  it('(f2) 私有 endpoint 非 2xx → false 不抛', async () => {
    getMock().mockImplementation(
      async (opt: { url: string }) => {
        if (opt.url === 'https://my-private.example.com/api/graphql') {
          return { status: 500, json: null, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} }
        }
        throw new Error('unexpected url')
      },
    )
    const ok = await deleteArticleById('https://my-private.example.com/api/graphql', 'priv-key', 'p-1')
    expect(ok).toBe(false)
  })

  it('(f3) 私有 endpoint errorCodes → false 不抛', async () => {
    getMock().mockImplementation(
      async (opt: { url: string }) => {
        if (opt.url === 'https://my-private.example.com/api/graphql') {
          return {
            status: 200,
            json: { data: { deleteArticle: { errorCodes: ['BAD_REQUEST'] } } },
            text: '', arrayBuffer: new ArrayBuffer(0), headers: {},
          }
        }
        throw new Error('unexpected url')
      },
    )
    const ok = await deleteArticleById('https://my-private.example.com/api/graphql', 'priv-key', 'p-1')
    expect(ok).toBe(false)
  })
})
