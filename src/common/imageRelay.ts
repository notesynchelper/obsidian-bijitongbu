/**
 * 图床加速中继（relay）与源站的统一域名配置。
 *
 * 背景：自有图床 / S3 在 `relay-N.bijitongbu.site/<prefix>/<key>` 路径反代
 * 到对应源站，用于国内加速。插件在以下场景需要识别 / 兜底这些域名：
 *   - 强制本地化判定（普通 `[text](url)` 链接、无扩展名 URL）
 *   - 下载失败后的备用线路（双向：relay→源站、源站→relay 优先）
 *
 * 未来上线更多 `relay-N.bijitongbu.site` 节点时：
 *   - 直接往 RELAY_HOSTS push 新 hostname，fallback 链自动扩展。
 *   - 识别方面 RELAY_HOST_PATTERN 已覆盖所有 `relay-N.bijitongbu.site`，
 *     即使未纳入 RELAY_HOSTS 也会被视为"必须本地化"，只是不进 fallback 列表
 *     （避免盲发到未知主机）。
 */

/** 加速中继节点列表；顺序即尝试顺序（首个成功即返）。 */
export const RELAY_HOSTS: readonly string[] = [
  'relay-1.bijitongbu.site',
  'relay-2.bijitongbu.site',
  'relay-3.bijitongbu.site',
  'relay-4.bijitongbu.site',
]

/** 识别任意编号的 relay 节点（含 RELAY_HOSTS 未收录的前瞻节点）。 */
const RELAY_HOST_PATTERN = /^relay-\d+\.bijitongbu\.site$/

interface RelayFlavor {
  /** 出现在 relay URL 路径首段的前缀，如 'p' / 'm' / 'm30' */
  readonly pathPrefix: string
  /** 源站 hostname */
  readonly origin: string
  /** 源站的直连镜像（相同 path，备用兜底）；顺序 = 尝试顺序 */
  readonly originMirrors: readonly string[]
}

const FLAVORS: readonly RelayFlavor[] = [
  {
    pathPrefix: 'p',
    origin: 'pic.clipfx.app',
    originMirrors: [],
  },
  {
    pathPrefix: 'm',
    origin: 'media.clipfx.app',
    originMirrors: [],
  },
  {
    pathPrefix: 'm30',
    origin: 'media30d.clipfx.app',
    originMirrors: [],
  },
]

/**
 * "必定是图片"域名白名单：即使 URL 无后缀、或出现在普通 `[text](url)` 语法中，
 * 也强制当作图片下载本地化。
 *
 * 不收录 pic.clipfx.app / media.clipfx.app / 所有 relay 源站：
 * - pic 的图片通常带后缀，走 IMAGE_PATTERN 就够；
 * - media 是通用媒体（视频/音频/文件等），强制走图片管道会把 mp4 误存成 png；
 * - relay 的处理通过下面的 ALWAYS_LOCALIZE_RELAY_PREFIXES 做路径粒度的白名单。
 */
const ALWAYS_LOCALIZE_HOSTS: ReadonlySet<string> = new Set([
  'sync.bijitongbu.site',
  'media30d.clipfx.app',
])

/**
 * "绝不本地化"清单：管线 footer / UI 元素（积分充值二维码
 * `www.bijitongbu.site/qr/*`）。这些 <img> 是 HTML 排版的一部分（居中 / 定宽），
 * 原样保留就能正常渲染；改写成 wiki 嵌入反而会破坏所在的 HTML 块，且站点
 * 国内可达、无本地化加速价值。按 host + 路径前缀匹配，避免误豁免同站其它图片。
 */
const NEVER_LOCALIZE_PREFIXES: ReadonlyArray<{ host: string; pathPrefix: string }> = [
  { host: 'www.bijitongbu.site', pathPrefix: '/qr/' },
]

/** 判断 URL 是否属于绝不本地化的 UI 资源（无效 URL 返回 false）。 */
export function isNeverLocalizeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return NEVER_LOCALIZE_PREFIXES.some(
      (e) => parsed.hostname === e.host && parsed.pathname.startsWith(e.pathPrefix),
    )
  } catch {
    return false
  }
}

/**
 * 市场版合规：把服务端拼进正文的「积分充值二维码」推广图从内容里剥掉。
 *
 * Obsidian Developer policies 禁止在插件自身界面之外（= 用户笔记里）出现推广，
 * 市场版因此在渲染/写入 vault 前删除这些 <img> / markdown 图片引用。
 * 只删图、不注入任何替代文字（往笔记里塞引导话术同样属于界面外推广）；
 * 会员/充值入口统一放在插件设置页。周围的服务端说明文字原样保留。
 */
export function stripPromoQrImages(content: string): string {
  if (!content || !content.includes('bijitongbu.site/qr/')) return content

  // HTML 形式：<img ... src="https://www.bijitongbu.site/qr/..." ...>
  let out = content.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\bsrc\s*=\s*["']?([^"'\s>]+)/i)
    return m && isNeverLocalizeUrl(m[1]) ? '' : tag
  })

  // Markdown 形式：![alt](https://www.bijitongbu.site/qr/... "title")
  out = out.replace(
    /!\[[^\]]*\]\(\s*<?([^()\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g,
    (whole, url: string) => (isNeverLocalizeUrl(url) ? '' : whole),
  )

  return out
}

/**
 * relay 路径前缀白名单：仅当 relay URL 命中这些前缀时才强制本地化。
 * - 'p'   对齐 pic.clipfx.app 的"纯图片通道"语义，覆盖无后缀 `[caption](relay-N/p/<hash>)` 场景
 * - 'm30' 对齐 media30d 源站的历史强制行为
 * - 'm'   未收录：/m/ 是通用媒体（视频/音频/文件），强制走图片管道会把 mp4 误存成 png
 */
const ALWAYS_LOCALIZE_RELAY_PREFIXES: ReadonlySet<string> = new Set(['p', 'm30'])

/**
 * 判断 URL 是否属于必须强制本地化的域名。
 * - 白名单 hostname 直接命中
 * - relay-N.bijitongbu.site 需要同时命中白名单路径前缀
 * - 无效 URL 返回 false
 */
export function isAlwaysLocalizeDomain(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname
  if (ALWAYS_LOCALIZE_HOSTS.has(host)) return true
  if (RELAY_HOST_PATTERN.test(host)) {
    const prefix = parsed.pathname.match(/^\/([^/]+)\//)?.[1]
    if (!prefix) return false
    return ALWAYS_LOCALIZE_RELAY_PREFIXES.has(prefix)
  }
  return false
}

/** hostname 版本（无路径信息）仅做 hostname 白名单检查，relay 判定会返回 false。 */
export function isAlwaysLocalizeHost(hostname: string): boolean {
  return ALWAYS_LOCALIZE_HOSTS.has(hostname)
}

/**
 * 判断 hostname 是否为"权威源站"——即该站点返回的 NoSuchKey 可以直接信为真过期。
 *
 * 包含：
 *   - 三类 clipfx 源站（pic / media / media30d）及它们配置的直连镜像（当前均无）
 *   - sync.bijitongbu.site（企微消息直链，无上游源）
 *
 * 不包含 relay-N：relay 是反向代理，可能因节点自身 cache/重写故障返 404，
 * 这种单点信号不足以证明对象真的不存在。
 */
export function isOriginHost(hostname: string): boolean {
  if (hostname === 'sync.bijitongbu.site') return true
  for (const f of FLAVORS) {
    if (hostname === f.origin) return true
    if (f.originMirrors.includes(hostname)) return true
  }
  return false
}

/**
 * 下载主线路失败时，按顺序尝试的备用 URL 列表。
 *
 * 路由规则：
 *   - `https://relay-K.bijitongbu.site/{prefix}/<key>` →
 *       其他 relay（按 relayHosts 顺序，跳过自身）
 *     → 源站 `origin/<key>`
 *     → 源站镜像 `originMirrors[i]/<key>`
 *   - `https://{origin}/<key>` →
 *       所有 relay（按 relayHosts 顺序）的 `{prefix}/<key>`（"relay 优先"策略）
 *     → 源站镜像 `originMirrors[i]/<key>`
 *   - 其他：返回 []
 *
 * query / fragment 按原样透传到每个备用 URL。
 * 无 key（如 `https://pic.clipfx.app/` 或 `https://relay-1.bijitongbu.site/p/`）返回 []。
 *
 * @param relayHosts 可选覆盖（默认用模块级 RELAY_HOSTS）。仅给测试用来模拟未来多节点场景。
 */
export function getFallbackUrls(
  url: string,
  relayHosts: readonly string[] = RELAY_HOSTS,
): string[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }

  if (RELAY_HOST_PATTERN.test(parsed.hostname)) {
    return fallbackFromRelay(parsed, relayHosts)
  }

  const flavor = FLAVORS.find((f) => f.origin === parsed.hostname)
  if (flavor) {
    return fallbackFromOrigin(parsed, flavor, relayHosts)
  }

  return []
}

function fallbackFromRelay(u: URL, relayHosts: readonly string[]): string[] {
  // 路径首段做 prefix，剩余整段做 key（key 允许多级 path）
  const m = u.pathname.match(/^\/([^/]+)\/(.+)$/)
  if (!m) return []
  const [, prefix, key] = m
  const flavor = FLAVORS.find((f) => f.pathPrefix === prefix)
  if (!flavor) return []

  const suffix = u.search + u.hash
  const out: string[] = []

  for (const host of relayHosts) {
    if (host === u.hostname) continue
    out.push(`${u.protocol}//${host}/${prefix}/${key}${suffix}`)
  }

  out.push(`${u.protocol}//${flavor.origin}/${key}${suffix}`)
  for (const mirror of flavor.originMirrors) {
    out.push(`${u.protocol}//${mirror}/${key}${suffix}`)
  }

  return out
}

function fallbackFromOrigin(
  u: URL,
  flavor: RelayFlavor,
  relayHosts: readonly string[],
): string[] {
  const key = u.pathname.replace(/^\//, '')
  if (!key) return []

  const suffix = u.search + u.hash
  const out: string[] = []

  for (const host of relayHosts) {
    out.push(`${u.protocol}//${host}/${flavor.pathPrefix}/${key}${suffix}`)
  }

  for (const mirror of flavor.originMirrors) {
    out.push(`${u.protocol}//${mirror}/${key}${suffix}`)
  }

  return out
}
