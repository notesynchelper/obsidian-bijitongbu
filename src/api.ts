import { Item, ItemFormat, Omnivore } from '@omnivore-app/api'
import { requestUrl } from 'obsidian'
import { getContentApiUrl } from './settings/local-test'
import { LOCAL_TEST_CONFIG } from './settings/local-test'
import { log, logError } from './logger'
import {
  classifyError,
  FailureKind,
  getOrderedFallbackBases,
  notifyRequestFailure,
  notifyRequestSuccess,
} from './endpointSelector'

/** 单 base 客户端超时（每个 base 单独计），按接口类型分级。
 *  withTimeout 只切控制流，不取消底层连接（requestUrl 无 abort 能力）。 */
export const TIMEOUTS = {
  probe: 3_000,                  // /api/stats/article-count GET 探测
  lightGet: 5_000,               // 其它简单 GET（如 /api/labels）
  graphqlSearch: 30_000,         // POST /api/graphql 可能返几 MB JSON
  destructive: 15_000,           // DELETE /api/articles/clear
} as const

/** fallback 总预算：所有 base 累计耗时不超过此值，超过即放弃。
 *  避免 4 base × graphqlSearch = 120s 的 UX 灾难。 */
export const FALLBACK_BUDGET_MS = {
  lightGet: 20_000,
  graphqlSearch: 60_000,
  destructive: 30_000,
} as const

/** 已知官方域名（hostname 精确匹配；不允许子串、后缀攻击、路径含等绕过）。 */
const OFFICIAL_HOSTNAMES = new Set([
  'obsidian.notebooksyncer.com',
  'relay-1.bijitongbu.site',
  'relay-2.bijitongbu.site',
  'graph.bijitongbu.site',
])

export const isOfficialEndpoint = (endpoint: string): boolean => {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return OFFICIAL_HOSTNAMES.has(host)
  } catch {
    return false
  }
}

/** 给 GET / DELETE 等无 body 的请求构造鉴权头。
 *  omniserver authenticatePullKey 中间件按 `x-api-key` 读，与 nginx helper-proxy 头透传一致。 */
const buildAuthHeaders = (apiKey: string): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['x-api-key'] = apiKey
  return headers
}

/** 把任意 rejection 原因归一成 Error。Error 实例原样透传（status 等附加字段
 *  保留）；非 Error 拒因若带数字 status（requestUrl throw 路径的裸对象），
 *  把 status 复制到新 Error 上，业务错误分类（401/403/422 不 fallback）依赖它。 */
const toError = (e: unknown): Error => {
  if (e instanceof Error) return e
  const err: Error & { status?: number } = new Error(String(e))
  const status = (e as { status?: unknown } | null | undefined)?.status
  if (typeof status === 'number') err.status = status
  return err
}

/** Promise.race 超时包装（不取消底层 requestUrl，只切控制流） */
const withTimeoutP = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`request timeout ${ms}ms`)), ms)
    p.then(
      (v) => { window.clearTimeout(timer); resolve(v) },
      (e: unknown) => { window.clearTimeout(timer); reject(toError(e)) },
    )
  })

/** 用 throw:false 让 4xx/5xx 走 resolve，由调用方按 status 分类。
 *  否则 throw 默认值会让 status 分支永远进不到（被 catch 吞掉）。 */
const safeRequest = async (
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<{ status: number; json: unknown; text: string; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> => {
  return withTimeoutP(
    requestUrl({ url, ...options, throw: false }) as unknown as Promise<{
      status: number
      json: unknown
      text: string
      arrayBuffer: ArrayBuffer
      headers: Record<string, string>
    }>,
    timeoutMs,
  )
}

/** 带故障容错的 GraphQL 请求：按 endpointSelector 给出的"优先 base + 有序回退"依次尝试。
 *
 *  v3 改动：
 *   - per-base 超时（默认 graphqlSearch 30s），不再无限等
 *   - 总预算 budget（默认 60s），避免 4 × 30s = 120s
 *   - throw:false 集中按 status 分类（business 401/403/422 立即抛；gateway_err/network/app_5xx 继续 fallback）
 */
const requestWithFallback = async (
  options: { method: string; headers: Record<string, string>; body: string },
  apiKey?: string,
  perBaseTimeout: number = TIMEOUTS.graphqlSearch,
  budgetMs: number = FALLBACK_BUDGET_MS.graphqlSearch,
): Promise<ReturnType<typeof requestUrl>> => {
  const bases = await getOrderedFallbackBases(apiKey ?? '')
  const deadline = Date.now() + budgetMs
  let lastError: unknown = null
  let primaryFailureKind: FailureKind | undefined

  for (let i = 0; i < bases.length; i++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      log(`requestWithFallback 总预算 ${budgetMs}ms 耗尽，停止 fallback`)
      break
    }
    const stepTimeout = Math.min(perBaseTimeout, remaining)
    const base = bases[i]
    const url = `${base}/api/graphql`
    try {
      const resp = await safeRequest(url, options, stepTimeout)
      if (resp.status >= 200 && resp.status < 300) {
        notifyRequestSuccess(i === 0, primaryFailureKind)
        return resp
      }
      const err = Object.assign(new Error(`HTTP ${resp.status}`), {
        status: resp.status,
      })
      const kind = classifyError(err)
      if (i === 0) primaryFailureKind = kind
      if (kind === 'business') {
        log(`入口 ${base} 业务错误 ${resp.status}，不再 fallback`)
        // i===0：primary 自己 business，base 通了 nginx，清零计数
        // i>0：primary 已在前几跳挂掉，把它的真实失败类型上报给计数器（不是当前的 business）
        notifyRequestSuccess(i === 0, i === 0 ? undefined : primaryFailureKind)
        throw err
      }
      log(`入口 ${base} HTTP ${resp.status}（${kind}），尝试下一个`)
      lastError = err
    } catch (error) {
      // safeRequest 用 throw:false，进 catch 多半是 network（timeout/TLS/DNS）
      // 但 business 已经在 try 内 throw，要透传过去
      const status = (error as { status?: number })?.status
      if (typeof status === 'number' && classifyError(status) === 'business') {
        throw error
      }
      const kind = classifyError(error)
      if (i === 0) primaryFailureKind = kind
      log(`入口 ${base} 网络错误（${kind}），尝试下一个: ${error}`)
      lastError = error
    }
  }
  notifyRequestFailure()
  throw lastError == null ? new Error('所有入口均不可达') : toError(lastError)
}

/** 非 GraphQL 路径的 fallback 工具：用于 getArticleCount / clearAllArticles 等
 *  统一返回 .json（response body 解析后的对象）
 *
 *  noFallback=true：只打 primary 一次。
 *    用于 destructive 操作（DELETE 等非幂等请求）：withTimeoutP 不取消底层连接，
 *    primary 超时后底层 DELETE 可能仍在跑；若此时切到 base2 重发，服务端可能执行两次，
 *    用户看到的 deletedCount 与真实结果不一致。 */
const apiPathFallback = async <T>(
  path: string,
  options: { method: string; headers: Record<string, string>; body?: string },
  apiKey: string,
  perBaseTimeout: number = TIMEOUTS.lightGet,
  budgetMs: number = FALLBACK_BUDGET_MS.lightGet,
  noFallback = false,
): Promise<T> => {
  const allBases = await getOrderedFallbackBases(apiKey)
  const bases = noFallback ? allBases.slice(0, 1) : allBases
  const deadline = Date.now() + budgetMs
  let lastError: unknown = null
  let primaryFailureKind: FailureKind | undefined

  for (let i = 0; i < bases.length; i++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      log(`apiPathFallback 总预算 ${budgetMs}ms 耗尽，停止 fallback`)
      break
    }
    const stepTimeout = Math.min(perBaseTimeout, remaining)
    const base = bases[i]
    const url = `${base}${path}`
    try {
      const resp = await safeRequest(url, options, stepTimeout)
      if (resp.status >= 200 && resp.status < 300) {
        notifyRequestSuccess(i === 0, primaryFailureKind)
        return resp.json as T
      }
      const err = Object.assign(new Error(`HTTP ${resp.status}`), {
        status: resp.status,
      })
      const kind = classifyError(err)
      if (i === 0) primaryFailureKind = kind
      if (kind === 'business') {
        log(`入口 ${base}${path} 业务错误 ${resp.status}，不再 fallback`)
        // 同 requestWithFallback：i>0 时把首跳真实失败类型上报，否则会让坏 primary 长期不清
        notifyRequestSuccess(i === 0, i === 0 ? undefined : primaryFailureKind)
        throw err
      }
      log(`入口 ${base}${path} HTTP ${resp.status}（${kind}），尝试下一个`)
      lastError = err
    } catch (error) {
      const status = (error as { status?: number })?.status
      if (typeof status === 'number' && classifyError(status) === 'business') {
        throw error
      }
      const kind = classifyError(error)
      if (i === 0) primaryFailureKind = kind
      log(`入口 ${base}${path} 网络错误（${kind}），尝试下一个: ${error}`)
      lastError = error
    }
  }
  notifyRequestFailure()
  throw lastError == null ? new Error('所有入口均不可达') : toError(lastError)
}

// 工具函数
const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => window.setTimeout(resolve, ms))

// 请求错误类型
interface RequestError extends Error {
  status?: number
}

export enum HighlightColors {
  Yellow = 'yellow',
  Red = 'red',
  Green = 'green',
  Blue = 'blue',
}

interface GetContentResponse {
  data: {
    libraryItemId: string
    downloadUrl: string
    error?: string
  }[]
}

// 本地Mock服务器的搜索响应接口
interface LocalSearchResponse {
  data: {
    search: {
      items: Item[]
      pageInfo: {
        hasNextPage: boolean
        hasPreviousPage: boolean
        startCursor: string
        endCursor: string
        totalCount: number
      }
    }
  }
}

// Omnivore兼容格式的响应接口
interface OmnivoreCompatibleResponse {
  edges: Array<{ node: Item }>
  pageInfo: {
    hasNextPage: boolean
    hasPreviousPage: boolean
    startCursor: string
    endCursor: string
    totalCount: number
  }
}

// 文章数量 API 响应
interface ArticleCountResponse {
  count: number
}

// 清空文章 API 响应
interface ClearArticlesApiResponse {
  success: boolean
  deletedCount: number
  message: string
}

// VIP 配置 API 响应
interface VipConfigResponse {
  success: boolean
  data: Array<{
    vip_type: string
    endtime?: string
  }>
}

const baseUrl = (endpoint: string) => endpoint.replace(/\/api\/graphql$/, '')

// 自定义服务器搜索函数（返回Omnivore兼容格式）
const searchCustomServerItems = async (
  endpoint: string,
  after: number,
  first: number,
  query: string,
  apiKey?: string
): Promise<OmnivoreCompatibleResponse> => {
  const searchQuery = `
    query Search($after: Int, $first: Int, $query: String) {
      search(after: $after, first: $first, query: $query) {
        items {
          id
          title
          author
          content
          originalUrl
          savedAt
          updatedAt
          publishedAt
          description
          siteName
          slug
          image
          pageType
          contentReader
          wordsCount
          readingProgressPercent
          isArchived
          archivedAt
          readAt
          highlights {
            id
            type
            quote
            prefix
            suffix
            patch
            annotation
            createdAt
            updatedAt
            highlightPositionPercent
            shortId
          }
          labels {
            id
            name
            color
            user_id
            created_at
            updated_at
          }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
          totalCount
        }
      }
    }`

  const variables = {
    after,
    first,
    query,
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey) {
    headers['x-api-key'] = apiKey
  }

  const response = await requestWithFallback({
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: searchQuery,
      variables,
    }),
  }, apiKey)

  return response.json as OmnivoreCompatibleResponse
}

// 本地Mock服务器搜索函数
const searchLocalItems = async (
  endpoint: string,
  after: number,
  first: number,
  query: string,
  apiKey?: string
): Promise<LocalSearchResponse> => {
  const searchQuery = `
    query Search($after: Int, $first: Int, $query: String) {
      search(after: $after, first: $first, query: $query) {
        items {
          id
          title
          author
          content
          originalUrl
          savedAt
          updatedAt
          isArchived
          highlights {
            id
            quote
            note
          }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
          totalCount
        }
      }
    }
  `

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // 如果在本地测试模式且提供了API密钥，则添加认证头
  if (LOCAL_TEST_CONFIG.ENABLE_LOCAL_TEST && apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const response = await requestUrl({
    url: endpoint,
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: searchQuery,
      variables: { after, first, query }
    })
  })

  return response.json as LocalSearchResponse
}

const getContent = async (
  endpoint: string,
  apiKey: string,
  libraryItemIds: string[],
): Promise<GetContentResponse> => {
  const response = await requestUrl({
    url: getContentApiUrl(endpoint),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ libraryItemIds, format: 'highlightedMarkdown' }),
  })

  return response.json as GetContentResponse
}

const downloadFromUrl = async (url: string): Promise<string> => {
  try {
    // polling until download is ready or failed
    const response = await requestUrl({
      url,
    })
    return response.text
  } catch (error) {
    // retry after 1 second if download returns 404
    const reqError = error as RequestError
    if (reqError.status === 404) {
      await sleep(1000)
      return downloadFromUrl(url)
    }

    throw error
  }
}

const fetchContentForItems = async (
  endpoint: string,
  apiKey: string,
  items: Item[],
) => {
  const content = await getContent(
    endpoint,
    apiKey,
    items.map((a) => a.id),
  )

  await Promise.allSettled(
    content.data.map(async (c) => {
      if (c.error) {
        logError('Error fetching content', c.error)
        return
      }

      const item = items.find((i) => i.id === c.libraryItemId)
      if (!item) {
        logError('Item not found', c.libraryItemId)
        return
      }

      // timeout if download takes too long
      item.content = await Promise.race([
        downloadFromUrl(c.downloadUrl),
        new Promise<string>(
          (_, reject) => window.setTimeout(() => reject(new Error('Timeout')), 600_000), // 10 minutes
        ),
      ])
    }),
  )
}

export const getItems = async (
  endpoint: string,
  apiKey: string,
  after = 0,
  first = 10,
  updatedAt = '',
  query = '',
  includeContent = false,
  format: ItemFormat = 'html',
): Promise<[Item[], boolean]> => {
  // 调试日志脱敏：绝不输出完整 API key（避免用户提交诊断日志时泄密）
  log('🔧 getItems调用参数:', { endpoint, apiKey: apiKey ? apiKey.slice(0, 4) + '***' : '', after, first, updatedAt, query })

  // 在本地测试模式下，如果用户没有设置API密钥，则使用默认测试密钥
  if (LOCAL_TEST_CONFIG.ENABLE_LOCAL_TEST && (!apiKey || apiKey.trim() === '')) {
    apiKey = LOCAL_TEST_CONFIG.TEST_API_KEY
    log('🔧 本地测试模式：使用默认测试API密钥')
  }

  log('🔧 检查endpoint:', endpoint)
  log('🔧 是否官方域名:', isOfficialEndpoint(endpoint))

  // 本地测试模式优先（开发环境）
  if (LOCAL_TEST_CONFIG.ENABLE_LOCAL_TEST) {
    log('🔧 使用本地Mock服务器获取数据')

    try {
      const searchQuery = `${updatedAt ? 'updated:' + updatedAt : ''} sort:saved-asc ${query}`.trim()
      const response = await searchLocalItems(endpoint, after, first, searchQuery, apiKey)

      const items = response.data.search.items
      const hasNextPage = response.data.search.pageInfo.hasNextPage

      if (includeContent && items.length > 0) {
        try {
          await fetchContentForItems(endpoint, apiKey, items)
        } catch (error) {
          logError('Error fetching content from local server', error)
        }
      }

      return [items, hasNextPage]
    } catch (error) {
      logError('本地Mock服务器连接失败:', error)
      throw error
    }
  }

  // 官方域名：走 endpointSelector fallback（不限于 obsidian.notebooksyncer.com，
  // 也含 relay-1/relay-2/graph）
  if (isOfficialEndpoint(endpoint)) {
    log('🔧 使用官方服务器（fallback）获取数据')

    try {
      const searchQuery = `${updatedAt ? 'updated:' + updatedAt : ''} sort:saved-asc ${query}`.trim()
      const response = await searchCustomServerItems(endpoint, after, first, searchQuery, apiKey)

      log('🔧 自定义服务器响应:', response)
      log('🔧 response.edges:', response.edges)
      log('🔧 response.pageInfo:', response.pageInfo)

      if (!response.edges) {
        logError('🔧 response.edges is undefined, full response:', JSON.stringify(response, null, 2))
        throw new Error('服务器响应格式错误：缺少edges字段')
      }

      const items = response.edges.map((e) => e.node)
      const hasNextPage = response.pageInfo.hasNextPage

      log(`🔧 自定义服务器获取到 ${items.length} 篇文章`)
      log(`🔧 includeContent: ${includeContent}`)

      if (includeContent && items.length > 0) {
        log('🔧 自定义服务器跳过内容获取（内容已在GraphQL响应中）')
        // 对于自定义服务器，跳过额外的内容获取，因为内容已经在GraphQL响应中
        // try {
        //   log('🔧 开始获取文章内容...')
        //   await fetchContentForItems(endpoint, apiKey, items)
        //   log('🔧 文章内容获取完成')
        // } catch (error) {
        //   logError('🔧 获取文章内容失败:', error)
        // }
      }

      log('🔧 准备返回数据')
      return [items, hasNextPage]
    } catch (error) {
      logError('官方服务器连接失败:', error)
      throw error
    }
  }

  // 私有 endpoint（自部署 / 测试 server / 企业内）：保留原 Omnivore SDK 直连
  // 不静默接管到候选池，避免劫持用户的私有部署
  const omnivore = new Omnivore({
    authToken: apiKey,
    baseUrl: baseUrl(endpoint),
    timeoutMs: 10000, // 10 seconds
  })

  const response = await omnivore.items.search({
    after,
    first,
    query: `${updatedAt ? 'updated:' + updatedAt : ''} sort:saved-asc ${query}`,
    includeContent: false,
    format,
  })

  const items = response.edges.map((e) => e.node)
  if (includeContent && items.length > 0) {
    try {
      await fetchContentForItems(endpoint, apiKey, items)
    } catch (error) {
      logError('Error fetching content', error)
    }
  }

  return [items, response.pageInfo.hasNextPage]
}

export const getArticleCount = async (
  endpoint: string,
  apiKey: string,
): Promise<number> => {
  log('🔧 getArticleCount调用参数:', { endpoint, apiKey: apiKey ? '***' : '(空)' })

  if (LOCAL_TEST_CONFIG.ENABLE_LOCAL_TEST && (!apiKey || apiKey.trim() === '')) {
    apiKey = LOCAL_TEST_CONFIG.TEST_API_KEY
    log('🔧 本地测试模式：使用默认测试API密钥')
  }

  // 官方域名：走 fallback 候选池
  if (isOfficialEndpoint(endpoint)) {
    try {
      const data = await apiPathFallback<ArticleCountResponse>(
        '/api/stats/article-count',
        { method: 'GET', headers: buildAuthHeaders(apiKey) },
        apiKey,
        TIMEOUTS.lightGet,
        FALLBACK_BUDGET_MS.lightGet,
      )
      log('🔧 获取文章数量响应:', data)
      return data.count || 0
    } catch (error) {
      logError('获取文章数量失败:', error)
      throw error
    }
  }

  // 私有 endpoint：保留原直连逻辑（不接管），鉴权头与改造前一致用 Authorization: Bearer
  try {
    const apiUrl = endpoint.replace('/api/graphql', '/api/stats/article-count')
    log('🔧 请求URL（私有 endpoint）:', apiUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const response = await requestUrl({
      url: apiUrl,
      method: 'GET',
      headers,
    })
    const data = response.json as ArticleCountResponse
    return data.count || 0
  } catch (error) {
    logError('获取文章数量失败:', error)
    throw error
  }
}

export const clearAllArticles = async (
  endpoint: string,
  apiKey: string,
): Promise<{ success: boolean; deletedCount: number; message: string }> => {
  log('🔧 clearAllArticles调用参数:', { endpoint, apiKey: apiKey ? '***' : '(空)' })

  if (LOCAL_TEST_CONFIG.ENABLE_LOCAL_TEST && (!apiKey || apiKey.trim() === '')) {
    apiKey = LOCAL_TEST_CONFIG.TEST_API_KEY
    log('🔧 本地测试模式：使用默认测试API密钥')
  }

  // 官方域名：走候选池但 **不 fallback**（destructive 重试有重复删除风险，withTimeoutP
  // 不取消底层连接，primary 超时时底层 DELETE 可能仍在执行）
  if (isOfficialEndpoint(endpoint)) {
    try {
      const data = await apiPathFallback<ClearArticlesApiResponse>(
        '/api/articles/clear',
        { method: 'DELETE', headers: buildAuthHeaders(apiKey) },
        apiKey,
        TIMEOUTS.destructive,
        FALLBACK_BUDGET_MS.destructive,
        true, // noFallback：destructive 只打 primary 一次
      )
      log('🔧 清空文章响应:', data)
      return data
    } catch (error) {
      logError('清空文章失败:', error)
      throw error
    }
  }

  // 私有 endpoint：保留原直连逻辑（不接管），鉴权头用改造前的 Authorization: Bearer
  try {
    const apiUrl = endpoint.replace('/api/graphql', '/api/articles/clear')
    log('🔧 请求URL（私有 endpoint）:', apiUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const response = await requestUrl({
      url: apiUrl,
      method: 'DELETE',
      headers,
    })
    return response.json as ClearArticlesApiResponse
  } catch (error) {
    logError('清空文章失败:', error)
    throw error
  }
}

// deleteArticle mutation 的 GraphQL 响应（成功 / 业务错误两种形态）
interface DeleteArticleResponse {
  data?: {
    deleteArticle?: {
      article?: { id?: string }
      errorCodes?: string[]
    }
  }
  errors?: unknown[]
}

/** 阅后即焚：硬删单篇云端文章（per-article）。
 *
 *  - **GraphQL `deleteArticle` mutation**（POST `${base}/api/graphql`），不是 REST DELETE。
 *  - 官方域名走 apiPathFallback，但 **noFallback=true（只打 primary）**：理由同 clearAllArticles
 *    —— withTimeoutP 不取消底层连接，primary 超时后底层请求可能仍在执行；切 base2 重发会重复执行。
 *    删除失败留孤儿本就是接受的软失败，不为它引多 base 重试。
 *  - 鉴权与 search 一致用 `x-api-key`（omniserver authenticatePullKey 既收 Bearer 也收 x-api-key）。
 *  - 成功判定：`data.deleteArticle.article.id` 存在 → true；出现 errorCodes / 缺 article / 抛异常 → false。
 *  - **绝不抛**：全 try/catch，失败返回 false（记 log）。apiPathFallback 在 4xx/5xx 会自己 throw，catch 即可。
 *
 *  @returns true=服务端此后无此 id；false=失败（留孤儿，本轮不再纠缠）
 */
export const deleteArticleById = async (
  endpoint: string,
  apiKey: string,
  articleId: string,
): Promise<boolean> => {
  const query = `mutation Del($input: DeleteArticleInput!) {
  deleteArticle(input: $input) {
    ... on DeleteArticleSuccess {
      article {
        id
      }
    }
    ... on DeleteArticleError {
      errorCodes
    }
  }
}`
  const variables = { input: { id: articleId } }
  const body = JSON.stringify({ query, variables })

  // 官方域名：走候选池但 noFallback（destructive 重发有重复删除风险，同 clearAllArticles）
  if (isOfficialEndpoint(endpoint)) {
    try {
      const data = await apiPathFallback<DeleteArticleResponse>(
        '/api/graphql',
        { method: 'POST', headers: buildAuthHeaders(apiKey), body },
        apiKey,
        TIMEOUTS.destructive,
        FALLBACK_BUDGET_MS.destructive,
        true, // noFallback：destructive 只打 primary 一次
      )
      const id = data?.data?.deleteArticle?.article?.id
      const errorCodes = data?.data?.deleteArticle?.errorCodes
      if (errorCodes && errorCodes.length > 0) {
        logError('阅后即焚删除返回 errorCodes:', articleId, errorCodes)
        return false
      }
      if (typeof id === 'string' && id.length > 0) {
        log('🔧 阅后即焚已删除文章:', id)
        return true
      }
      logError('阅后即焚删除响应缺少 article.id:', articleId, data)
      return false
    } catch (error) {
      logError('阅后即焚删除失败（官方域名）:', articleId, error)
      return false
    }
  }

  // 私有 endpoint（本身就是 /api/graphql）：直接 requestUrl POST，鉴权头同 search（x-api-key）
  try {
    const response = await requestUrl({
      url: endpoint,
      method: 'POST',
      headers: buildAuthHeaders(apiKey),
      body,
      throw: false,
    })
    if (response.status < 200 || response.status >= 300) {
      logError('阅后即焚删除失败（私有 endpoint）非 2xx:', articleId, response.status)
      return false
    }
    const data = response.json as DeleteArticleResponse
    const id = data?.data?.deleteArticle?.article?.id
    const errorCodes = data?.data?.deleteArticle?.errorCodes
    if (errorCodes && errorCodes.length > 0) {
      logError('阅后即焚删除返回 errorCodes（私有 endpoint）:', articleId, errorCodes)
      return false
    }
    if (typeof id === 'string' && id.length > 0) {
      log('🔧 阅后即焚已删除文章（私有 endpoint）:', id)
      return true
    }
    logError('阅后即焚删除响应缺少 article.id（私有 endpoint）:', articleId, data)
    return false
  } catch (error) {
    logError('阅后即焚删除失败（私有 endpoint）:', articleId, error)
    return false
  }
}

// VIP 状态接口定义
export interface VipStatus {
  vipType: 'obtrail' | 'obvip' | 'obvvip' | 'none'
  endTime?: string
  isValid: boolean
  displayText: string
  networkError?: boolean
  // 仅手动刷新（fetchVipStatusFresh）会置位：服务端防刷限流返回 429。
  // UI 据此提示「刷新过于频繁」，且不应把它当作 networkError。
  rateLimited?: boolean
}

// VIP 状态查询的默认（生产）域名。E2E 用 baseOverride 指到本地 mock；
// 生产用户永远不传，恒打生产。
const VIP_API_BASE = 'https://obsidian.notebooksyncer.com'

// 把 /user-config[/refresh] 的 JSON 响应解析成 VipStatus（自动/手动两条路共用）。
const parseVipConfigResponse = (vipResponse: VipConfigResponse): VipStatus => {
  if (vipResponse.success && vipResponse.data && vipResponse.data.length > 0) {
    const vipData = vipResponse.data[0]
    const vipType = vipData.vip_type as 'obtrail' | 'obvip' | 'obvvip'
    const endTime = vipData.endtime

    // 判断是否过期
    const isValid = endTime ? new Date(endTime) > new Date() : false

    // 生成显示文本
    const vipTypeNames = {
      obtrail: '试用会员',
      obvip: '正式会员',
      obvvip: '头等舱会员',
    }

    const typeName = vipTypeNames[vipType] || '未知类型'
    const expiredSuffix = isValid ? '' : '（已过期）'
    const timeStr = endTime
      ? new Date(endTime).toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : ''

    const displayText = `${typeName}${expiredSuffix} | 到期时间：${timeStr}`

    return { vipType, endTime, isValid, displayText }
  }

  // 没有VIP信息
  return {
    vipType: 'none',
    isValid: false,
    displayText: '未开通会员',
  }
}

// 查询 VIP 状态（自动/页面加载/原有「刷新」按钮）。
// 走 /user-config —— CF 端套 15s 缓存回放型限流，连续查不变更（有意保留，省上游）。
export const fetchVipStatus = async (
  apiKey: string,
  baseOverride?: string,
): Promise<VipStatus> => {
  log('🔧 fetchVipStatus调用参数:', { apiKey: apiKey ? '***' : '(空)' })

  if (!apiKey || apiKey.trim() === '') {
    return {
      vipType: 'none',
      isValid: false,
      displayText: '请输入密钥',
    }
  }

  try {
    const apiUrl = `${baseOverride || VIP_API_BASE}/user-config`
    log('🔧 请求URL:', apiUrl)

    const response = await requestUrl({
      url: apiUrl,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
    })

    log('🔧 VIP状态响应:', response.json)
    return parseVipConfigResponse(response.json as VipConfigResponse)
  } catch (error) {
    logError('查询VIP状态失败:', error)
    return {
      vipType: 'none',
      isValid: false,
      displayText: '网络异常',
      networkError: true,
    }
  }
}

// 手动刷新 VIP 状态（设置页「刷新高级权益状态」大按钮）。
// 走 /user-config/refresh —— CF 端不走缓存、直查 CosmosDB 拿实时状态，
// 但有「相对宽松」的防刷限流（10 分钟内 10 次/apiKey）；超限返回 429 →
// 这里置 rateLimited，UI 提示「刷新过于频繁」而不覆盖当前显示。
export const fetchVipStatusFresh = async (
  apiKey: string,
  baseOverride?: string,
): Promise<VipStatus> => {
  log('🔧 fetchVipStatusFresh调用参数:', { apiKey: apiKey ? '***' : '(空)' })

  if (!apiKey || apiKey.trim() === '') {
    return {
      vipType: 'none',
      isValid: false,
      displayText: '请输入密钥',
    }
  }

  try {
    const apiUrl = `${baseOverride || VIP_API_BASE}/user-config/refresh`
    log('🔧 刷新请求URL:', apiUrl)

    const response = await requestUrl({
      url: apiUrl,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      // 防刷 429 是正常业务码，不要让 requestUrl 直接抛
      throw: false,
    })

    if (response.status === 429) {
      return {
        vipType: 'none',
        isValid: false,
        displayText: '刷新过于频繁，请稍后再试',
        rateLimited: true,
      }
    }

    if (response.status < 200 || response.status >= 300) {
      logError('刷新VIP状态失败，HTTP状态:', response.status)
      return {
        vipType: 'none',
        isValid: false,
        displayText: '网络异常',
        networkError: true,
      }
    }

    log('🔧 刷新VIP状态响应:', response.json)
    return parseVipConfigResponse(response.json as VipConfigResponse)
  } catch (error) {
    logError('刷新VIP状态失败:', error)
    return {
      vipType: 'none',
      isValid: false,
      displayText: '网络异常',
      networkError: true,
    }
  }
}

// 市场版：二维码不再从网络加载 ——「购买高级权益」二维码以静态资产打包在
// src/assets/vipQrImage.ts（政策禁止动态加载推广内容）；群二维码降级为文字引导。
