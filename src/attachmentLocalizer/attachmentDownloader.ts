/**
 * 附件下载器
 * 负责从网络下载附件，支持重试机制、过期文件检测、以及 relay/源站备用线路
 */

import { requestUrl } from 'obsidian'
import { log, logError } from '../logger'
import { AttachmentDownloadResult } from './types'
import { getFallbackUrls, isOriginHost } from '../common/imageRelay'

/** 单个备用节点最大重试次数（主线路失败后的每个 fallback 节点） */
const FALLBACK_MAX_RETRIES = 1
const ATTACHMENT_REQUEST_TIMEOUT_MS = 5_000
const ATTACHMENT_RETRY_DELAY_CAP_MS = 2_000
const MAX_ATTACHMENT_DOWNLOAD_RETRIES = 5

/**
 * 延迟函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 检查响应是否为XML错误（文件过期）
 * @param text 响应文本
 * @returns 是否为NoSuchKey错误
 */
function isExpiredFileError(text: string): boolean {
  // 检查是否包含 NoSuchKey 错误的XML标记
  return text.includes('<Code>NoSuchKey</Code>') ||
         text.includes('<Message>The specified key does not exist.</Message>')
}

function getHeaderCI(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return ''
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] || ''
  }
  return ''
}

function isNotFoundStatus(status: number): boolean {
  return status === 404 || status === 410
}

function errorHasNotFoundStatus(error: Error): boolean {
  return /(?:status|HTTP)\s*(?:404|410)\b/i.test(error.message)
}

/** 拦截 CDN 登录页、人机校验页和 JSON 错误页，避免按原扩展名落盘。 */
function isPlaceholderResponse(
  data: ArrayBuffer | undefined,
  text: string,
  contentType: string,
): boolean {
  const ct = contentType.trim().toLowerCase()
  let head = text.slice(0, 256).trimStart().toLowerCase()
  if (!head && data && data.byteLength > 0) {
    try {
      head = new TextDecoder('utf-8')
        .decode(new Uint8Array(data).slice(0, 256))
        .trimStart()
        .toLowerCase()
    } catch {
      head = ''
    }
  }
  if (ct.startsWith('text/html') || ct.startsWith('application/xhtml')) return true
  if (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body')
  ) {
    return true
  }
  return (
    (ct.startsWith('application/json') || ct.startsWith('application/ld+json')) &&
    (head.startsWith('{') || head.startsWith('['))
  )
}

async function requestAttachment(url: string) {
  let timeoutId: number | null = null
  const requestPromise = requestUrl({
    url,
    method: 'GET',
    throw: false,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error(`请求超时（${ATTACHMENT_REQUEST_TIMEOUT_MS}ms）`)),
      ATTACHMENT_REQUEST_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([requestPromise, timeoutPromise])
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId)
  }
}

/**
 * 单线路下载（带重试，指数退避）
 *
 * 三种返回值：
 * - success: true                          → 下载成功
 * - success: false, expired: true          → 服务端返回 NoSuchKey（真过期，不应继续尝试其他节点）
 * - success: false, expired: undefined     → 网络/HTTP 错误，调用方可走 fallback
 */
async function attemptDownload(
  url: string,
  maxRetries: number,
  retryDelay: number,
): Promise<AttachmentDownloadResult> {
  let lastError: Error | null = null
  const retries = Math.min(
    MAX_ATTACHMENT_DOWNLOAD_RETRIES,
    Math.max(0, Number.isFinite(maxRetries) ? Math.floor(maxRetries) : 0),
  )

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      log(`尝试下载附件 (${attempt + 1}/${retries + 1}): ${url}`)

      const response = await requestAttachment(url)

      // 检查响应状态
      if (response.status !== 200) {
        const responseText = response.text || ''
        if (isNotFoundStatus(response.status) || isExpiredFileError(responseText)) {
          log(`附件已过期（NoSuchKey）: ${url}`)
          return {
            success: false,
            error: '文件已过期，无法下载',
            expired: true,
          }
        }
        throw new Error(`HTTP ${response.status}: ${responseText}`)
      }

      // 有些服务器可能返回200但内容是XML错误
      const contentType = getHeaderCI(response.headers, 'content-type')
      if (contentType.includes('xml') || contentType.includes('text')) {
        const responseText = response.text || ''
        if (isExpiredFileError(responseText)) {
          log(`附件已过期（NoSuchKey）: ${url}`)
          return {
            success: false,
            error: '文件已过期，无法下载',
            expired: true,
          }
        }
      }
      if (isPlaceholderResponse(response.arrayBuffer, response.text || '', contentType)) {
        throw new Error(
          `响应体是占位/登录页（HTTP 200, content-type=${contentType || 'n/a'}）`,
        )
      }

      log(`附件下载成功: ${url}`)

      return {
        success: true,
        data: response.arrayBuffer,
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // 真·过期短路：任一节点返回 NoSuchKey 都等同于全网过期
      const errorMsg = lastError.message || ''
      if (
        errorHasNotFoundStatus(lastError) ||
        errorMsg.includes('NoSuchKey') ||
        errorMsg.includes('does not exist')
      ) {
        log(`附件已过期: ${url}`)
        return {
          success: false,
          error: '文件已过期，无法下载',
          expired: true,
        }
      }

      logError(`下载附件失败 (${attempt + 1}/${retries + 1}): ${url}`, error)

      if (attempt < retries) {
        const delay = Math.min(
          ATTACHMENT_RETRY_DELAY_CAP_MS,
          Math.max(0, retryDelay) * Math.pow(2, attempt),
        )
        log(`${delay}ms 后重试...`)
        await sleep(delay)
      }
    }
  }

  return {
    success: false,
    error: lastError?.message || '下载失败',
  }
}

/** 判断 URL 的 hostname 是否为权威源站（NoSuchKey 可直接信为真过期）。 */
function isOriginUrl(url: string): boolean {
  try {
    return isOriginHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * 下载附件（带重试、relay/源站 fallback、过期检测）
 *
 * 流程：
 * 1. 主线路尝试 maxRetries+1 次（指数退避）；任一 attempt 成功即返。
 * 2. 主线路 NoSuchKey 的处理分两种：
 *    - 主线路是权威源站（pic/media/media30d/镜像/sync）→ 直接返回 expired，不再 fallback
 *      （源站的 404 就是真相，不需要跨节点再次验证）
 *    - 主线路是 relay 反向代理 → 不短路，继续按 fallback 跨节点交叉验证
 *      （relay 可能因单点 cache/重写故障返 404，不能单凭一个节点断定对象真的不存在）
 * 3. 主线路非 expired 失败后按 getFallbackUrls 顺序切换每个备用节点，每节点最多 FALLBACK_MAX_RETRIES+1 次尝试。
 * 4. 所有节点都走完：
 *    - 全部 attempt 都 expired → expired
 *    - 混合失败（部分 NoSuchKey + 部分网络错）→ 纯 failure，避免 relay 单点 NoSuchKey
 *      污染上游"已过期"标记逻辑
 *
 * @param url 附件URL
 * @param maxRetries 主线路最大重试次数
 * @param retryDelay 重试延迟（毫秒）
 * @returns 下载结果
 */
export async function downloadAttachment(
  url: string,
  maxRetries: number = 3,
  retryDelay: number = 1000,
): Promise<AttachmentDownloadResult> {
  const attempts: AttachmentDownloadResult[] = []

  const primary = await attemptDownload(url, maxRetries, retryDelay)
  if (primary.success) return primary
  attempts.push(primary)

  // 权威源站的 NoSuchKey 直接信；relay 的 NoSuchKey 需要跨节点交叉验证
  if (primary.expired && isOriginUrl(url)) {
    return primary
  }

  const fallbackUrls = getFallbackUrls(url)
  for (const fbUrl of fallbackUrls) {
    log(`主线路下载失败，尝试备用线路: ${fbUrl}`)
    const r = await attemptDownload(fbUrl, FALLBACK_MAX_RETRIES, retryDelay)
    if (r.success) return r
    // 权威源站 fallback 的 NoSuchKey 同样权威——立刻短路，避免被后续节点的网络错误
    // 掩盖掉真实的过期信号（否则上游就不会给笔记打"⚠️已过期"标记）
    if (r.expired && isOriginUrl(fbUrl)) return r
    attempts.push(r)
  }

  // 全部节点都明确返回 NoSuchKey → 认定真过期；否则返回"最后一次失败"
  // 并抹掉 expired 字段，避免单节点 NoSuchKey 污染上游判定
  if (attempts.every((a) => a.expired)) {
    return attempts[0]
  }
  const last = attempts[attempts.length - 1]
  return { success: false, error: last.error }
}

/**
 * 检查 URL 是否为远程附件
 * @param url 附件URL
 * @returns 是否为远程附件
 */
export function isRemoteAttachment(url: string): boolean {
  try {
    // 排除本地路径
    if (
      url.startsWith('/') ||
      url.startsWith('./') ||
      url.startsWith('../') ||
      url.startsWith('file:') ||
      url.startsWith('app:') ||
      url.startsWith('vault:')
    ) {
      return false
    }

    // 排除 data URI
    if (url.startsWith('data:')) {
      return false
    }

    // 检查是否为 HTTP/HTTPS URL
    const urlObj = new URL(url)
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:'
  } catch {
    // URL 解析失败，不是有效的网络URL
    return false
  }
}
