/**
 * 问题4: IMAGE_PATTERN 正则漏匹配
 * 问题5: isRemoteImage URL 解析
 */

import { isRemoteImage } from '../src/imageLocalizer/imageDownloader'
import { isAlwaysLocalizeDomain } from '../src/common/imageRelay'

// 复制源码中的正则用于直接测试 (src/imageLocalizer/imageLocalizer.ts:28)
const IMAGE_PATTERN =
  /!\[([^\]]*)\]\(([^)\n]+)\)|!\[\[([^\]\n]+)\]\]|<img[^>\n]+src=["']([^"'\n]+)["']/g

// 复制源码中的普通链接正则 (src/imageLocalizer/imageLocalizer.ts)
const LINK_PATTERN = /(?<!!)\[([^\]]*)\]\(([^)\n]+)\)/g

/** 用与源码相同的逻辑检测图片 */
function detectImages(
  content: string,
): Array<{ url: string; fullMatch: string; alt?: string }> {
  const images: Array<{ url: string; fullMatch: string; alt?: string }> = []
  IMAGE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMAGE_PATTERN.exec(content)) !== null) {
    const [fullMatch, markdownAlt, markdownUrl, wikiUrl, htmlUrl] = match
    const url = markdownUrl || wikiUrl || htmlUrl
    if (!url) continue
    images.push({ url, fullMatch, alt: markdownAlt || undefined })
  }
  return images
}

// ============================================================
// 问题4: IMAGE_PATTERN 正则匹配
// ============================================================
describe('问题4: IMAGE_PATTERN 正则匹配', () => {
  beforeEach(() => {
    IMAGE_PATTERN.lastIndex = 0
  })

  test('标准 Markdown: ![alt](url)', () => {
    const images = detectImages('![photo](https://example.com/img.jpg)')
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('https://example.com/img.jpg')
    expect(images[0].alt).toBe('photo')
  })

  test('Wiki 格式: ![[url]]', () => {
    const images = detectImages('![[https://example.com/img.jpg]]')
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('https://example.com/img.jpg')
  })

  test('HTML img 双引号: <img src="url">', () => {
    const images = detectImages('<img src="https://example.com/img.jpg">')
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('https://example.com/img.jpg')
  })

  test("HTML img 单引号: <img src='url'>", () => {
    const images = detectImages("<img src='https://example.com/img.jpg'>")
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('https://example.com/img.jpg')
  })

  test('URL 含 %20 编码 → 正常匹配', () => {
    const images = detectImages(
      '![img](https://example.com/my%20image.jpg)',
    )
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('https://example.com/my%20image.jpg')
  })

  test('混合多种格式 → 全部检测', () => {
    const content = [
      '![md](https://a.com/1.jpg)',
      '![[https://b.com/2.jpg]]',
      '<img src="https://c.com/3.jpg">',
    ].join('\n')
    const images = detectImages(content)
    expect(images).toHaveLength(3)
  })

  test('空 alt 文本 → alt 为 undefined', () => {
    const images = detectImages('![](https://example.com/img.jpg)')
    expect(images).toHaveLength(1)
    expect(images[0].alt).toBeUndefined()
  })

  test('data URI 被正则匹配（由 isRemoteImage 过滤）', () => {
    const images = detectImages('![img](data:image/png;base64,iVBOR)')
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('data:image/png;base64,iVBOR')
  })

  // ---------- 缺陷验证 ----------

  test('【缺陷】URL 中含括号 → 被截断', () => {
    const content = '![img](https://example.com/image(1).jpg)'
    const images = detectImages(content)
    expect(images).toHaveLength(1)
    // BUG: [^)]+ 遇到第一个 ) 就停止，URL 被截断
    // 实际匹配到 'https://example.com/image(1'
    // 正确行为应该是 'https://example.com/image(1).jpg'
    expect(images[0].url).toBe('https://example.com/image(1')
  })

  test('【缺陷】URL 含多层括号 → 只取到第一个右括号前', () => {
    const content = '![img](https://example.com/path(a)(b).jpg)'
    const images = detectImages(content)
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('https://example.com/path(a')
  })

  test('残缺 ![](http:/ 不跨行吞掉后续真正图片', () => {
    const content = [
      '![](http:/',
      '## 📅 2026-03-10 10:45:58',
      '![](http://sync.bijitongbu.site/wecom31/2026/03/db97ce35b5f8de6de3d3ca7f6da7a4ad)',
    ].join('\n')
    const images = detectImages(content)
    // 第一行 ![](http:/ 匹配到 url="http:/"（不跨行）
    // 第三行匹配到完整 URL
    const urls = images.map(i => i.url)
    expect(urls).toContain('http://sync.bijitongbu.site/wecom31/2026/03/db97ce35b5f8de6de3d3ca7f6da7a4ad')
  })

  test('正常单行图片不受影响', () => {
    const content = '前文\n![](https://example.com/img.jpg)\n后文'
    const images = detectImages(content)
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('https://example.com/img.jpg')
  })
})

// ============================================================
// 问题5: isRemoteImage URL 判断
// ============================================================
describe('问题5: isRemoteImage URL 判断', () => {
  // --- 正常远程 URL → true ---
  test('https URL → true', () => {
    expect(isRemoteImage('https://example.com/img.jpg')).toBe(true)
  })

  test('http URL → true', () => {
    expect(isRemoteImage('http://example.com/img.jpg')).toBe(true)
  })

  test('含中文路径的 URL → true', () => {
    expect(isRemoteImage('https://example.com/图片.jpg')).toBe(true)
  })

  test('含查询参数的 URL → true', () => {
    expect(
      isRemoteImage('https://cdn.example.com/img.jpg?token=abc&w=100'),
    ).toBe(true)
  })

  test('含 hash 的 URL → true', () => {
    expect(isRemoteImage('https://example.com/img.jpg#section')).toBe(true)
  })

  // --- 本地路径 → false ---
  test('/ 开头 → false', () => {
    expect(isRemoteImage('/local/img.jpg')).toBe(false)
  })

  test('./ 开头 → false', () => {
    expect(isRemoteImage('./img.jpg')).toBe(false)
  })

  test('../ 开头 → false', () => {
    expect(isRemoteImage('../img.jpg')).toBe(false)
  })

  // --- 特殊协议 → false ---
  test('data URI → false', () => {
    expect(isRemoteImage('data:image/png;base64,abc')).toBe(false)
  })

  test('file: 协议 → false', () => {
    expect(isRemoteImage('file:///home/user/img.jpg')).toBe(false)
  })

  test('app: 协议 → false', () => {
    expect(isRemoteImage('app:local/img.jpg')).toBe(false)
  })

  test('vault: 协议 → false', () => {
    expect(isRemoteImage('vault:img.jpg')).toBe(false)
  })

  // --- 边界情况 ---
  test('空字符串 → false', () => {
    expect(isRemoteImage('')).toBe(false)
  })

  test('Obsidian 本地路径（无协议前缀）→ false', () => {
    // '笔记同步助手/images/abc.jpg' 不是合法 URL，new URL() 抛异常
    expect(isRemoteImage('笔记同步助手/images/abc_MD5.jpg')).toBe(false)
  })

  test('无协议前缀 → false（new URL 抛异常）', () => {
    expect(isRemoteImage('example.com/img.jpg')).toBe(false)
  })

  test('含空格的 URL → URL 构造器可正常解析 → true', () => {
    // Node.js URL constructor 会自动编码空格
    expect(isRemoteImage('https://example.com/my image.jpg')).toBe(true)
  })
})

// ============================================================
// 强制本地化域名检测
// ============================================================
describe('强制本地化域名: sync.bijitongbu.site', () => {
  beforeEach(() => {
    LINK_PATTERN.lastIndex = 0
    IMAGE_PATTERN.lastIndex = 0
  })

  test('isAlwaysLocalizeDomain: sync.bijitongbu.site → true', () => {
    expect(isAlwaysLocalizeDomain('https://sync.bijitongbu.site/abc123')).toBe(true)
  })

  test('isAlwaysLocalizeDomain: 其他域名 → false', () => {
    expect(isAlwaysLocalizeDomain('https://example.com/img.jpg')).toBe(false)
  })

  test('isAlwaysLocalizeDomain: 无效 URL → false', () => {
    expect(isAlwaysLocalizeDomain('not-a-url')).toBe(false)
  })

  test('LINK_PATTERN: 匹配普通链接 [text](url)', () => {
    const content = '[资源](https://sync.bijitongbu.site/abc123)'
    const matches: Array<{ text: string; url: string }> = []
    let match: RegExpExecArray | null
    while ((match = LINK_PATTERN.exec(content)) !== null) {
      matches.push({ text: match[1], url: match[2] })
    }
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://sync.bijitongbu.site/abc123')
    expect(matches[0].text).toBe('资源')
  })

  test('LINK_PATTERN: 不匹配图片链接 ![text](url)', () => {
    const content = '![图片](https://sync.bijitongbu.site/abc123)'
    const matches: string[] = []
    let match: RegExpExecArray | null
    LINK_PATTERN.lastIndex = 0
    while ((match = LINK_PATTERN.exec(content)) !== null) {
      matches.push(match[2])
    }
    expect(matches).toHaveLength(0)
  })

  test('IMAGE_PATTERN 匹配图片语法中的 sync.bijitongbu.site 链接', () => {
    const content = '![](https://sync.bijitongbu.site/abc123)'
    const images = detectImages(content)
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('https://sync.bijitongbu.site/abc123')
  })

  test('混合场景：图片语法 + 普通链接均可检测', () => {
    const content = [
      '![](https://sync.bijitongbu.site/img1)',
      '[文件](https://sync.bijitongbu.site/file2)',
      '[其他](https://example.com/other)',
    ].join('\n')

    // IMAGE_PATTERN 检测到图片语法中的 URL
    const images = detectImages(content)
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('https://sync.bijitongbu.site/img1')

    // LINK_PATTERN 检测到普通链接
    LINK_PATTERN.lastIndex = 0
    const links: Array<{ url: string; text: string }> = []
    let match: RegExpExecArray | null
    while ((match = LINK_PATTERN.exec(content)) !== null) {
      if (isAlwaysLocalizeDomain(match[2])) {
        links.push({ url: match[2], text: match[1] })
      }
    }
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe('https://sync.bijitongbu.site/file2')
  })

  test('IMAGE_PATTERN 匹配 http 协议的 sync.bijitongbu.site 无后缀长路径', () => {
    const content = '![](http://sync.bijitongbu.site/wecom31/2026/03/db97ce35b5f8de6de3d3ca7f6da7a4ad)'
    const images = detectImages(content)
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe('http://sync.bijitongbu.site/wecom31/2026/03/db97ce35b5f8de6de3d3ca7f6da7a4ad')
    expect(images[0].alt).toBeUndefined()
    // isRemoteImage 也应该接受
    expect(isRemoteImage(images[0].url)).toBe(true)
    // isAlwaysLocalizeDomain 也应该识别
    expect(isAlwaysLocalizeDomain(images[0].url)).toBe(true)
  })

  test('URL 无图片后缀也能被 isRemoteImage 接受', () => {
    // 无后缀
    expect(isRemoteImage('https://sync.bijitongbu.site/abc123')).toBe(true)
    // 非图片后缀
    expect(isRemoteImage('https://sync.bijitongbu.site/file.dat')).toBe(true)
    // 带路径无后缀
    expect(isRemoteImage('https://sync.bijitongbu.site/path/to/resource')).toBe(true)
  })
})

// ============================================================
// media30d.clipfx.app 域名本地化行为
// ============================================================
describe('media30d.clipfx.app 域名本地化行为', () => {
  const CLIPFX_URL = 'https://media30d.clipfx.app/wecom4/2026/03/80eeb82f67ff93cf83dbe08d40db30f6494e257081bdf8e5c8603a3ab24ae3c8'

  beforeEach(() => {
    IMAGE_PATTERN.lastIndex = 0
    LINK_PATTERN.lastIndex = 0
    ATTACHMENT_PATTERN.lastIndex = 0
  })

  // 复制附件正则
  const ATTACHMENT_PATTERN = /📎\s*\[([^\]]+)\]\(([^)]+)\)(?:\s*\(([^)]+)\))?/g

  // --- isRemoteImage / isRemoteAttachment ---

  test('isRemoteImage: media30d.clipfx.app https URL -> true', () => {
    expect(isRemoteImage(CLIPFX_URL)).toBe(true)
  })

  test('isAlwaysLocalizeDomain: media30d.clipfx.app -> true（已加入强制列表）', () => {
    expect(isAlwaysLocalizeDomain(CLIPFX_URL)).toBe(true)
  })

  // --- 附件格式: 📎 [name](url) (size) ---

  test('ATTACHMENT_PATTERN 匹配 📎 [report.html](clipfx url) (0.06MB)', () => {
    const content = `📎 [report.html](${CLIPFX_URL}) (0.06MB)`
    ATTACHMENT_PATTERN.lastIndex = 0
    const match = ATTACHMENT_PATTERN.exec(content)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('report.html')
    expect(match![2]).toBe(CLIPFX_URL)
    expect(match![3]).toBe('0.06MB')
  })

  // --- 图片格式: ![](url) ---

  test('IMAGE_PATTERN 匹配 ![](clipfx url)', () => {
    const content = `![](${CLIPFX_URL})`
    const images = detectImages(content)
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe(CLIPFX_URL)
  })

  // --- 普通链接格式: [text](url) ---

  test('LINK_PATTERN 匹配 [text](clipfx url) 且在强制域名中，图片本地化会处理', () => {
    const content = `[report.html](${CLIPFX_URL})`
    LINK_PATTERN.lastIndex = 0
    const matches: Array<{ text: string; url: string }> = []
    let match: RegExpExecArray | null
    while ((match = LINK_PATTERN.exec(content)) !== null) {
      matches.push({ text: match[1], url: match[2] })
    }
    // LINK_PATTERN 能匹配到链接
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe(CLIPFX_URL)
    // 域名已在 ALWAYS_LOCALIZE_DOMAINS 中，图片本地化器会处理
    expect(isAlwaysLocalizeDomain(CLIPFX_URL)).toBe(true)
  })

  // --- 📎 前缀的链接不会被图片本地化器重复处理 ---

  test('📎 前缀的 clipfx 链接: 图片本地化器跳过，由附件本地化器处理', () => {
    const content = `📎 [report.html](${CLIPFX_URL}) (0.06MB)`

    // IMAGE_PATTERN 不匹配（📎 [text](url) 没有 ! 前缀）
    const images = detectImages(content)
    expect(images).toHaveLength(0)

    // LINK_PATTERN 匹配到了，但源码中有 📎 前缀检查会跳过
    LINK_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    const linkMatches: number[] = []
    while ((match = LINK_PATTERN.exec(content)) !== null) {
      linkMatches.push(match.index)
    }
    // LINK_PATTERN 能匹配 [report.html](url)
    expect(linkMatches).toHaveLength(1)
    // 但源码中 match.index 前方有 📎，会 continue 跳过
    const prefixStart = Math.max(0, linkMatches[0] - 10)
    const prefix = content.substring(prefixStart, linkMatches[0])
    expect(prefix).toContain('📎')

    // 最终: 只有 ATTACHMENT_PATTERN 会处理它
    ATTACHMENT_PATTERN.lastIndex = 0
    expect(ATTACHMENT_PATTERN.exec(content)).not.toBeNull()
  })
})

// ============================================================
// relay-N.bijitongbu.site 加速节点本地化行为
// ============================================================
describe('relay-1.bijitongbu.site 加速节点识别', () => {
  const RELAY_P = 'https://relay-1.bijitongbu.site/p/938429b3dce34f0b6dc9c4bbe042219c'
  const RELAY_M = 'https://relay-1.bijitongbu.site/m/abc'
  const RELAY_M30 = 'https://relay-1.bijitongbu.site/m30/xyz'

  beforeEach(() => {
    IMAGE_PATTERN.lastIndex = 0
    LINK_PATTERN.lastIndex = 0
  })

  test('isRemoteImage: relay URL → true', () => {
    expect(isRemoteImage(RELAY_P)).toBe(true)
    expect(isRemoteImage(RELAY_M)).toBe(true)
    expect(isRemoteImage(RELAY_M30)).toBe(true)
  })

  test('isAlwaysLocalizeDomain: relay-1/p 和 /m30 强制，/m 不强制', () => {
    expect(isAlwaysLocalizeDomain(RELAY_P)).toBe(true)
    expect(isAlwaysLocalizeDomain(RELAY_M30)).toBe(true)
    // /m/ 是通用媒体，避免把非图媒体误走图片管道
    expect(isAlwaysLocalizeDomain(RELAY_M)).toBe(false)
  })

  test('IMAGE_PATTERN 匹配 ![](relay-1/p/<k>) 无扩展名 URL', () => {
    // ![]() 语法下依靠 IMAGE_PATTERN + isRemoteImage 即可识别，
    // 不依赖 isAlwaysLocalizeDomain
    const content = `![](${RELAY_P})`
    const images = detectImages(content)
    expect(images).toHaveLength(1)
    expect(images[0].url).toBe(RELAY_P)
  })

  test('LINK_PATTERN 匹配 [text](relay-1/m30/<k>) 且在强制域名中', () => {
    const content = `[report.html](${RELAY_M30})`
    LINK_PATTERN.lastIndex = 0
    const matches: Array<{ text: string; url: string }> = []
    let match: RegExpExecArray | null
    while ((match = LINK_PATTERN.exec(content)) !== null) {
      matches.push({ text: match[1], url: match[2] })
    }
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe(RELAY_M30)
    expect(isAlwaysLocalizeDomain(RELAY_M30)).toBe(true)
  })

  test('未收录的 relay-N 前瞻：按路径决定', () => {
    // 前瞻 pattern：服务端切换到新节点时，客户端无需升级即可识别
    // /p/ 和 /m30/ 强制；/m/ 不强制
    expect(isAlwaysLocalizeDomain('https://relay-2.bijitongbu.site/p/x')).toBe(true)
    expect(isAlwaysLocalizeDomain('https://relay-2.bijitongbu.site/m30/x')).toBe(true)
    expect(isAlwaysLocalizeDomain('https://relay-42.bijitongbu.site/m30/y')).toBe(true)
    expect(isAlwaysLocalizeDomain('https://relay-42.bijitongbu.site/m/y')).toBe(false)
  })

  test('相似但非 relay-N 的域名不应命中', () => {
    expect(isAlwaysLocalizeDomain('https://relay.bijitongbu.site/p/x')).toBe(false)
    expect(isAlwaysLocalizeDomain('https://relay-a.bijitongbu.site/p/x')).toBe(false)
    expect(isAlwaysLocalizeDomain('https://relay-1.example.com/p/x')).toBe(false)
  })
})
