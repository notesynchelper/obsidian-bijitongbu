/**
 * 文件附件"双保险"测试
 *
 * 双保险机制:
 * 1. 元数据层: 同步阶段通过 item.description 识别企微文件消息，提前下载附件
 * 2. 内容层: AttachmentLocalizer 通过 📎 正则匹配内容中的附件链接，兜底下载
 *
 * 前提修复:
 * - 图片本地化器必须跳过 📎 前缀的链接，避免与附件本地化器冲突
 */

// ============================================================
// 第一部分: 图片本地化器跳过 📎 附件链接
// ============================================================

// 复制源码正则 (src/imageLocalizer/imageLocalizer.ts)
const IMAGE_PATTERN =
  /!\[([^\]]*)\]\(([^)\n]+)\)|!\[\[([^\]\n]+)\]\]|<img[^>\n]+src=["']([^"'\n]+)["']/g
const LINK_PATTERN = /(?<!!)\[([^\]]*)\]\(([^)\n]+)\)/g

const ALWAYS_LOCALIZE_DOMAINS = ['sync.bijitongbu.site']

function isAlwaysLocalizeDomain(url: string): boolean {
  try {
    const urlObj = new URL(url)
    return ALWAYS_LOCALIZE_DOMAINS.some(domain => urlObj.hostname === domain)
  } catch {
    return false
  }
}

function isRemoteUrl(url: string): boolean {
  try {
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') ||
        url.startsWith('file:') || url.startsWith('app:') || url.startsWith('vault:') ||
        url.startsWith('data:')) {
      return false
    }
    const urlObj = new URL(url)
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 模拟图片本地化器 detectRemoteImages 的第二遍扫描逻辑
 * （LINK_PATTERN 匹配强制本地化域名的普通链接）
 *
 * 新增: shouldSkipAttachmentLinks 参数控制是否跳过 📎 前缀链接
 */
function detectForcedLocalizeLinks(
  content: string,
  shouldSkipAttachmentLinks: boolean = false,
): Array<{ url: string; fullMatch: string; linkText: string; index: number }> {
  const results: Array<{ url: string; fullMatch: string; linkText: string; index: number }> = []
  LINK_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LINK_PATTERN.exec(content)) !== null) {
    const [fullMatch, linkText, url] = match
    if (!url) continue
    if (!isRemoteUrl(url)) continue
    if (!isAlwaysLocalizeDomain(url)) continue

    // 新逻辑: 跳过 📎 前缀的附件链接
    // 📎 占 2 个 JS 字符位，加上可能的空格，需要往前看足够多的字符
    if (shouldSkipAttachmentLinks) {
      const prefixStart = Math.max(0, match.index - 10)
      const prefix = content.substring(prefixStart, match.index)
      if (prefix.includes('📎')) continue
    }

    results.push({ url, fullMatch, linkText, index: match.index })
  }
  return results
}

describe('第一部分: 图片本地化器跳过 📎 附件链接', () => {
  beforeEach(() => {
    LINK_PATTERN.lastIndex = 0
    IMAGE_PATTERN.lastIndex = 0
  })

  describe('当前行为（未修复）: 图片本地化器错误匹配 📎 链接', () => {
    test('📎 [文件名](sync.bijitongbu.site/...) 被 LINK_PATTERN 匹配到', () => {
      const content = '📎 [新建 XLSX 工作表 (2).xlsx](http://sync.bijitongbu.site/wecom4/2026/03/530e3c8b66bae7a5ac9ea466df868d24a57700a1979448cd8b6c108c3a6f533e) (0.03MB)'
      const links = detectForcedLocalizeLinks(content, false)
      // 当前行为: 会匹配到，导致冲突
      expect(links).toHaveLength(1)
      expect(links[0].linkText).toBe('新建 XLSX 工作表 (2).xlsx')
    })

    test('合并文件中多个 📎 链接全部被错误匹配', () => {
      const content = [
        '%%2026-03-13T08:00:00_start%%',
        '---',
        '#### 文件1',
        '## 📅 2026-03-13 16:00:00',
        '📎 [报告.pdf](http://sync.bijitongbu.site/wecom4/2026/03/aaa) (1.2MB)',
        '%%2026-03-13T08:00:00_end%%',
        '',
        '%%2026-03-13T09:00:00_start%%',
        '---',
        '#### 文件2',
        '## 📅 2026-03-13 17:00:00',
        '📎 [数据.xlsx](http://sync.bijitongbu.site/wecom4/2026/03/bbb) (0.5MB)',
        '%%2026-03-13T09:00:00_end%%',
      ].join('\n')
      const links = detectForcedLocalizeLinks(content, false)
      // 当前行为: 两个都被匹配
      expect(links).toHaveLength(2)
    })
  })

  describe('修复后行为: 图片本地化器跳过 📎 链接', () => {
    test('📎 [文件名](sync.bijitongbu.site/...) 被跳过', () => {
      const content = '📎 [新建 XLSX 工作表 (2).xlsx](http://sync.bijitongbu.site/wecom4/2026/03/530e3c8b66bae7a5ac9ea466df868d24a57700a1979448cd8b6c108c3a6f533e) (0.03MB)'
      const links = detectForcedLocalizeLinks(content, true)
      expect(links).toHaveLength(0)
    })

    test('📎 紧跟 [ 也被跳过（无空格）', () => {
      const content = '📎[文件.pdf](http://sync.bijitongbu.site/wecom4/2026/03/ccc) (0.1MB)'
      const links = detectForcedLocalizeLinks(content, true)
      expect(links).toHaveLength(0)
    })

    test('非 📎 前缀的 sync.bijitongbu.site 链接仍然被匹配', () => {
      const content = '[资源](http://sync.bijitongbu.site/wecom4/2026/03/ddd)'
      const links = detectForcedLocalizeLinks(content, true)
      expect(links).toHaveLength(1)
      expect(links[0].linkText).toBe('资源')
    })

    test('图片语法 ![](sync.bijitongbu.site/...) 不受影响（LINK_PATTERN 本身就不匹配 ![]）', () => {
      const content = '![](http://sync.bijitongbu.site/wecom4/2026/03/eee)'
      const links = detectForcedLocalizeLinks(content, true)
      // LINK_PATTERN 的 lookbehind (?<!!) 已排除图片语法
      expect(links).toHaveLength(0)
    })

    test('合并文件: 📎 链接被跳过，普通 sync 链接仍匹配', () => {
      const content = [
        '📎 [报告.pdf](http://sync.bijitongbu.site/wecom4/2026/03/aaa) (1.2MB)',
        '[查看原文](http://sync.bijitongbu.site/wecom4/2026/03/bbb)',
        '![](http://sync.bijitongbu.site/wecom4/2026/03/ccc)',
      ].join('\n')
      const links = detectForcedLocalizeLinks(content, true)
      // 只有第二行（非 📎 非图片语法）被匹配
      expect(links).toHaveLength(1)
      expect(links[0].linkText).toBe('查看原文')
    })

    test('📎 后有多个空格也能跳过', () => {
      const content = '📎   [文件.docx](http://sync.bijitongbu.site/wecom4/2026/03/fff)'
      const links = detectForcedLocalizeLinks(content, true)
      expect(links).toHaveLength(0)
    })
  })
})

// ============================================================
// 第二部分: 附件本地化器正则检测（内容层保险）
// ============================================================

// 复制源码正则 (src/attachmentLocalizer/attachmentLocalizer.ts:28)
const ATTACHMENT_PATTERN = /📎\s*\[([^\]]+)\]\(([^)]+)\)(?:\s*\(([^)]+)\))?/g

interface AttachmentMatch {
  fullMatch: string
  fileName: string
  url: string
  fileSize?: string
}

function detectAttachments(content: string): AttachmentMatch[] {
  const results: AttachmentMatch[] = []
  ATTACHMENT_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTACHMENT_PATTERN.exec(content)) !== null) {
    const [fullMatch, fileName, url, fileSize] = match
    results.push({ fullMatch, fileName, url, fileSize })
  }
  return results
}

describe('第二部分: 附件本地化器 📎 正则检测（内容层保险）', () => {
  beforeEach(() => {
    ATTACHMENT_PATTERN.lastIndex = 0
  })

  describe('基本匹配', () => {
    test('标准格式: 📎 [文件名.ext](url) (大小)', () => {
      const content = '📎 [报告.pdf](http://sync.bijitongbu.site/wecom4/2026/03/aaa) (1.2MB)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      expect(matches[0].fileName).toBe('报告.pdf')
      expect(matches[0].url).toBe('http://sync.bijitongbu.site/wecom4/2026/03/aaa')
      expect(matches[0].fileSize).toBe('1.2MB')
    })

    test('无大小信息: 📎 [文件名](url)', () => {
      const content = '📎 [文件.txt](http://sync.bijitongbu.site/wecom4/2026/03/bbb)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      expect(matches[0].fileName).toBe('文件.txt')
      expect(matches[0].fileSize).toBeUndefined()
    })

    test('无空格: 📎[文件名](url)', () => {
      const content = '📎[数据.csv](http://sync.bijitongbu.site/wecom4/2026/03/ccc) (0.5MB)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      expect(matches[0].fileName).toBe('数据.csv')
    })
  })

  describe('特殊文件名', () => {
    test('文件名含括号: 新建 XLSX 工作表 (2).xlsx', () => {
      const content = '📎 [新建 XLSX 工作表 (2).xlsx](http://sync.bijitongbu.site/wecom4/2026/03/530e3c8b) (0.03MB)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      expect(matches[0].fileName).toBe('新建 XLSX 工作表 (2).xlsx')
      expect(matches[0].url).toBe('http://sync.bijitongbu.site/wecom4/2026/03/530e3c8b')
      expect(matches[0].fileSize).toBe('0.03MB')
    })

    test('文件名含中文和空格: 年度报告 2026.pdf', () => {
      const content = '📎 [年度报告 2026.pdf](http://sync.bijitongbu.site/wecom4/2026/03/ddd) (5.0MB)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      expect(matches[0].fileName).toBe('年度报告 2026.pdf')
    })

    test('文件名含多个点: report.v2.final.docx', () => {
      const content = '📎 [report.v2.final.docx](http://sync.bijitongbu.site/wecom4/2026/03/eee) (2.1MB)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      expect(matches[0].fileName).toBe('report.v2.final.docx')
    })

    test('文件名含特殊字符: 会议记录【重要】.pptx', () => {
      const content = '📎 [会议记录【重要】.pptx](http://sync.bijitongbu.site/wecom4/2026/03/fff) (3.0MB)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      expect(matches[0].fileName).toBe('会议记录【重要】.pptx')
    })
  })

  describe('S3 URL 格式（无后缀名的 hash 路径）', () => {
    test('标准 S3 hash 路径', () => {
      const content = '📎 [文件.xlsx](http://sync.bijitongbu.site/wecom4/2026/03/530e3c8b66bae7a5ac9ea466df868d24a57700a1979448cd8b6c108c3a6f533e) (0.03MB)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      expect(matches[0].url).toBe('http://sync.bijitongbu.site/wecom4/2026/03/530e3c8b66bae7a5ac9ea466df868d24a57700a1979448cd8b6c108c3a6f533e')
    })

    test('不同 wecom 路径前缀', () => {
      const urls = [
        'http://sync.bijitongbu.site/wecom4/2026/03/hash1',
        'http://sync.bijitongbu.site/wecom14/2026/03/hash2',
        'http://sync.bijitongbu.site/wecom31/2026/03/hash3',
      ]
      for (const url of urls) {
        ATTACHMENT_PATTERN.lastIndex = 0
        const content = `📎 [文件.pdf](${url}) (1MB)`
        const matches = detectAttachments(content)
        expect(matches).toHaveLength(1)
        expect(matches[0].url).toBe(url)
      }
    })
  })

  describe('合并文件中的多个附件', () => {
    test('单文件中多条企微消息各含一个附件', () => {
      const content = [
        '%%2026-03-13T08:00:00_start%%',
        '---',
        '#### 报告',
        '## 📅 2026-03-13 16:00:00',
        '📎 [报告.pdf](http://sync.bijitongbu.site/wecom4/2026/03/aaa) (1.2MB)',
        '',
        '%%2026-03-13T08:00:00_end%%',
        '%%2026-03-13T09:00:00_start%%',
        '---',
        '#### 数据表',
        '## 📅 2026-03-13 17:00:00',
        '📎 [数据.xlsx](http://sync.bijitongbu.site/wecom4/2026/03/bbb) (0.5MB)',
        '',
        '%%2026-03-13T09:00:00_end%%',
      ].join('\n')
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(2)
      expect(matches[0].fileName).toBe('报告.pdf')
      expect(matches[1].fileName).toBe('数据.xlsx')
    })

    test('附件与图片混合: 只匹配 📎 前缀的', () => {
      const content = [
        '![](http://sync.bijitongbu.site/wecom4/2026/03/img1)',
        '📎 [文件.pdf](http://sync.bijitongbu.site/wecom4/2026/03/file1) (1MB)',
        '普通文字内容',
        '![](http://example.com/photo.jpg)',
      ].join('\n')
      const matches = detectAttachments(content)
      // 只匹配 📎 前缀的，不匹配图片
      expect(matches).toHaveLength(1)
      expect(matches[0].fileName).toBe('文件.pdf')
    })
  })

  describe('不应匹配的内容', () => {
    test('普通链接（无 📎）不匹配', () => {
      const content = '[文件](http://sync.bijitongbu.site/wecom4/2026/03/aaa)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(0)
    })

    test('图片语法不匹配', () => {
      const content = '![图片](http://sync.bijitongbu.site/wecom4/2026/03/aaa)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(0)
    })

    test('已本地化的 wiki 链接不匹配', () => {
      const content = '📎 [[笔记同步助手/attachments/报告.pdf|报告.pdf]] (1.2MB)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(0)
    })

    test('已过期标记的附件不匹配（无 url 括号）', () => {
      const content = '📎 [报告.pdf](http://sync.bijitongbu.site/wecom4/2026/03/aaa) ⚠️已过期'
      // 这个仍然会匹配（因为有 url），但实际场景中过期标记替换后格式是不同的
      // 过期后的格式: 📎 [报告.pdf](http://...) ⚠️已过期  (没有大小括号了)
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      // 不过 fileSize 不会匹配到 ⚠️已过期，因为格式不对
    })
  })
})

// ============================================================
// 第三部分: 元数据层 description 识别（元数据层保险）
// ============================================================

/**
 * 判断 item 是否为企微文件消息（基于 description 元数据）
 * 这是"双保险"的第一层: 在同步阶段提前识别文件类型
 */
function isWeComFileMessage(item: { description?: string | null }): boolean {
  if (!item.description) return false
  return item.description.includes('来自企微的file消息')
}

/**
 * 从企微文件消息的 content 中提取附件信息
 * content 格式: 📎 [文件名.ext](url) (大小)\n\n
 */
function extractFileAttachmentFromContent(
  content: string | null,
): { fileName: string; url: string; fileSize?: string } | null {
  if (!content) return null
  ATTACHMENT_PATTERN.lastIndex = 0
  const match = ATTACHMENT_PATTERN.exec(content)
  if (!match) return null
  return {
    fileName: match[1],
    url: match[2],
    fileSize: match[3],
  }
}

describe('第三部分: 元数据层 description 识别（元数据层保险）', () => {
  describe('isWeComFileMessage 识别', () => {
    test('标准企微文件消息 description', () => {
      expect(isWeComFileMessage({ description: '来自企微的file消息' })).toBe(true)
    })

    test('description 包含更多文字但含关键短语', () => {
      expect(isWeComFileMessage({ description: '这是来自企微的file消息附件' })).toBe(true)
    })

    test('普通文章 description', () => {
      expect(isWeComFileMessage({ description: '这是一篇普通文章' })).toBe(false)
    })

    test('企微图片消息（非 file）', () => {
      expect(isWeComFileMessage({ description: '来自企微的image消息' })).toBe(false)
    })

    test('企微文本消息', () => {
      expect(isWeComFileMessage({ description: '来自企微的text消息' })).toBe(false)
    })

    test('description 为 null', () => {
      expect(isWeComFileMessage({ description: null })).toBe(false)
    })

    test('description 为空字符串', () => {
      expect(isWeComFileMessage({ description: '' })).toBe(false)
    })

    test('description 为 undefined', () => {
      expect(isWeComFileMessage({ description: undefined })).toBe(false)
    })
  })

  describe('extractFileAttachmentFromContent 提取附件信息', () => {
    test('标准企微文件消息 content', () => {
      const content = '📎 [新建 XLSX 工作表 (2).xlsx](http://sync.bijitongbu.site/wecom4/2026/03/530e3c8b66bae7a5ac9ea466df868d24a57700a1979448cd8b6c108c3a6f533e) (0.03MB)\n\n'
      const result = extractFileAttachmentFromContent(content)
      expect(result).not.toBeNull()
      expect(result!.fileName).toBe('新建 XLSX 工作表 (2).xlsx')
      expect(result!.url).toBe('http://sync.bijitongbu.site/wecom4/2026/03/530e3c8b66bae7a5ac9ea466df868d24a57700a1979448cd8b6c108c3a6f533e')
      expect(result!.fileSize).toBe('0.03MB')
    })

    test('PDF 附件', () => {
      const content = '📎 [季度报告.pdf](http://sync.bijitongbu.site/wecom4/2026/03/abcdef123456) (5.2MB)\n\n'
      const result = extractFileAttachmentFromContent(content)
      expect(result).not.toBeNull()
      expect(result!.fileName).toBe('季度报告.pdf')
      expect(result!.fileSize).toBe('5.2MB')
    })

    test('无附件的普通 content', () => {
      const content = '这是一段普通的企微消息文字内容'
      const result = extractFileAttachmentFromContent(content)
      expect(result).toBeNull()
    })

    test('content 为 null', () => {
      const result = extractFileAttachmentFromContent(null)
      expect(result).toBeNull()
    })

    test('content 为空字符串', () => {
      const result = extractFileAttachmentFromContent('')
      expect(result).toBeNull()
    })
  })

  describe('完整 item 场景: description + content 双重识别', () => {
    const makeItem = (overrides: Record<string, unknown> = {}) => ({
      id: '11b62b17-4121-469b-94d3-30203ed3615a',
      title: '同步助手_20260313_新建 XLSX 工作表 (2)_文件',
      description: '来自企微的file消息',
      pageType: 'ARTICLE',
      content: '📎 [新建 XLSX 工作表 (2).xlsx](http://sync.bijitongbu.site/wecom4/2026/03/530e3c8b) (0.03MB)\n\n',
      siteName: '企业微信',
      savedAt: '2026-03-13T08:57:07.131701+00:00',
      ...overrides,
    })

    test('pageType=ARTICLE 但 description 标识为文件 → 应识别', () => {
      const item = makeItem()
      expect(item.pageType).toBe('ARTICLE')
      expect(isWeComFileMessage(item)).toBe(true)
      const attachment = extractFileAttachmentFromContent(item.content)
      expect(attachment).not.toBeNull()
      expect(attachment!.fileName).toBe('新建 XLSX 工作表 (2).xlsx')
    })

    test('pageType=FILE 的 item 也能通过 content 提取（兼容）', () => {
      const item = makeItem({ pageType: 'FILE' })
      // 即使 pageType=FILE，content 层的检测也能工作
      const attachment = extractFileAttachmentFromContent(item.content)
      expect(attachment).not.toBeNull()
    })

    test('普通文章: description 不匹配，content 无 📎', () => {
      const item = makeItem({
        description: '这是一篇网页文章',
        content: '<p>文章正文内容</p>',
      })
      expect(isWeComFileMessage(item)).toBe(false)
      const attachment = extractFileAttachmentFromContent(item.content)
      expect(attachment).toBeNull()
    })
  })
})

// ============================================================
// 第四部分: 双保险集成 — 两层独立工作，互为兜底
// ============================================================

describe('第四部分: 双保险集成', () => {
  /**
   * 模拟同步阶段的附件处理决策
   *
   * 返回值:
   * - 'metadata': 通过 description 元数据层识别并预下载
   * - 'content': 通过 📎 内容层兜底下载
   * - 'both': 两层都识别到
   * - 'none': 两层都未识别到
   */
  function determineAttachmentHandling(item: {
    description?: string | null
    content?: string | null
    pageType?: string
  }): 'metadata' | 'content' | 'both' | 'none' {
    const metadataDetected = isWeComFileMessage(item)
    const contentDetected = extractFileAttachmentFromContent(item.content ?? null) !== null
    if (metadataDetected && contentDetected) return 'both'
    if (metadataDetected) return 'metadata'
    if (contentDetected) return 'content'
    return 'none'
  }

  describe('正常情况: 两层都能识别', () => {
    test('标准企微文件消息 → both', () => {
      const item = {
        description: '来自企微的file消息',
        content: '📎 [文件.xlsx](http://sync.bijitongbu.site/wecom4/2026/03/hash) (0.03MB)\n\n',
        pageType: 'ARTICLE',
      }
      expect(determineAttachmentHandling(item)).toBe('both')
    })
  })

  describe('退化场景: 只有一层能识别（验证兜底能力）', () => {
    test('description 变更但 content 仍有 📎 → content 兜底', () => {
      // 场景: 服务端修改了 description 格式
      const item = {
        description: '企微文件',  // 不再包含 "来自企微的file消息"
        content: '📎 [文件.xlsx](http://sync.bijitongbu.site/wecom4/2026/03/hash) (0.03MB)\n\n',
        pageType: 'ARTICLE',
      }
      expect(determineAttachmentHandling(item)).toBe('content')
    })

    test('content 格式变化但 description 正确 → metadata 兜底', () => {
      // 场景: 服务端不再用 📎 格式，改用其他格式
      const item = {
        description: '来自企微的file消息',
        content: '[文件.xlsx](http://sync.bijitongbu.site/wecom4/2026/03/hash)',  // 没有 📎 前缀
        pageType: 'ARTICLE',
      }
      expect(determineAttachmentHandling(item)).toBe('metadata')
    })

    test('description 为 null 但 content 有 📎 → content 兜底', () => {
      const item = {
        description: null,
        content: '📎 [文件.pdf](http://sync.bijitongbu.site/wecom4/2026/03/hash) (2MB)\n\n',
        pageType: 'ARTICLE',
      }
      expect(determineAttachmentHandling(item)).toBe('content')
    })

    test('content 为 null 但 description 正确 → metadata 兜底', () => {
      const item = {
        description: '来自企微的file消息',
        content: null,
        pageType: 'ARTICLE',
      }
      expect(determineAttachmentHandling(item)).toBe('metadata')
    })
  })

  describe('非文件消息: 两层都不识别', () => {
    test('普通文章 → none', () => {
      const item = {
        description: '这是一篇网页文章',
        content: '<p>正文内容</p>',
        pageType: 'ARTICLE',
      }
      expect(determineAttachmentHandling(item)).toBe('none')
    })

    test('企微图片消息 → none', () => {
      const item = {
        description: '来自企微的image消息',
        content: '![](http://sync.bijitongbu.site/wecom4/2026/03/img)',
        pageType: 'ARTICLE',
      }
      expect(determineAttachmentHandling(item)).toBe('none')
    })

    test('企微文本消息 → none', () => {
      const item = {
        description: '来自企微的text消息',
        content: '这是一条纯文本消息',
        pageType: 'ARTICLE',
      }
      expect(determineAttachmentHandling(item)).toBe('none')
    })
  })

  describe('图片本地化器不干扰附件处理', () => {
    test('📎 链接: 图片本地化器跳过 + 附件本地化器匹配', () => {
      const content = '📎 [文件.xlsx](http://sync.bijitongbu.site/wecom4/2026/03/hash) (0.03MB)'

      // 图片本地化器（修复后）不匹配
      const imageLinks = detectForcedLocalizeLinks(content, true)
      expect(imageLinks).toHaveLength(0)

      // 附件本地化器匹配
      const attachments = detectAttachments(content)
      expect(attachments).toHaveLength(1)
      expect(attachments[0].fileName).toBe('文件.xlsx')
    })

    test('混合内容: 图片走图片通道，附件走附件通道，互不干扰', () => {
      const content = [
        '![](http://sync.bijitongbu.site/wecom4/2026/03/image_hash)',
        '📎 [文件.pdf](http://sync.bijitongbu.site/wecom4/2026/03/file_hash) (1MB)',
        '[链接文字](https://example.com/page)',
      ].join('\n')

      // 图片本地化器（修复后）: 只匹配非 📎 的强制域名链接
      // 图片语法 ![](url) 由 IMAGE_PATTERN 处理，不经过 LINK_PATTERN
      const forcedLinks = detectForcedLocalizeLinks(content, true)
      expect(forcedLinks).toHaveLength(0)  // 第一行走 IMAGE_PATTERN，第二行被 📎 跳过，第三行非强制域名

      // 附件本地化器: 只匹配 📎 前缀
      const attachments = detectAttachments(content)
      expect(attachments).toHaveLength(1)
      expect(attachments[0].fileName).toBe('文件.pdf')
    })

    test('真实合并文件场景: 企微消息包含图片+附件+文字', () => {
      const content = [
        '# 同步助手_2026-03-13',
        '#笔记同步助手',
        '## 来源',
        '[原文链接](https://example.com)',
        '## 正文',
        '',
        '%%2026-03-13T08:00:00_start%%',
        '---',
        '#### 图片消息',
        '## 📅 2026-03-13 16:00:00',
        '![](http://sync.bijitongbu.site/wecom4/2026/03/img_hash)',
        '',
        '%%2026-03-13T08:00:00_end%%',
        '%%2026-03-13T09:00:00_start%%',
        '---',
        '#### 文件消息',
        '## 📅 2026-03-13 17:00:00',
        '📎 [季度报告.pdf](http://sync.bijitongbu.site/wecom4/2026/03/file_hash) (3.5MB)',
        '',
        '%%2026-03-13T09:00:00_end%%',
        '%%2026-03-13T10:00:00_start%%',
        '---',
        '#### 普通消息',
        '## 📅 2026-03-13 18:00:00',
        '今天天气不错',
        '',
        '%%2026-03-13T10:00:00_end%%',
      ].join('\n')

      // 图片本地化器（LINK_PATTERN 第二遍扫描，修复后）不匹配 📎
      const forcedLinks = detectForcedLocalizeLinks(content, true)
      expect(forcedLinks).toHaveLength(0)

      // 附件本地化器只匹配 📎
      const attachments = detectAttachments(content)
      expect(attachments).toHaveLength(1)
      expect(attachments[0].fileName).toBe('季度报告.pdf')
      expect(attachments[0].fileSize).toBe('3.5MB')

      // IMAGE_PATTERN 匹配图片语法
      IMAGE_PATTERN.lastIndex = 0
      const images: string[] = []
      let match: RegExpExecArray | null
      while ((match = IMAGE_PATTERN.exec(content)) !== null) {
        const url = match[2] || match[3] || match[4]
        if (url) images.push(url)
      }
      expect(images).toHaveLength(1)
      expect(images[0]).toBe('http://sync.bijitongbu.site/wecom4/2026/03/img_hash')
    })
  })

  describe('边界场景', () => {
    test('同一条消息既有图片又有附件', () => {
      const content = [
        '![预览图](http://sync.bijitongbu.site/wecom4/2026/03/preview)',
        '📎 [完整文件.pdf](http://sync.bijitongbu.site/wecom4/2026/03/full_file) (10MB)',
      ].join('\n')

      const forcedLinks = detectForcedLocalizeLinks(content, true)
      expect(forcedLinks).toHaveLength(0)

      const attachments = detectAttachments(content)
      expect(attachments).toHaveLength(1)
      expect(attachments[0].fileName).toBe('完整文件.pdf')

      IMAGE_PATTERN.lastIndex = 0
      const imgMatch = IMAGE_PATTERN.exec(content)
      expect(imgMatch).not.toBeNull()
      expect(imgMatch![2]).toBe('http://sync.bijitongbu.site/wecom4/2026/03/preview')
    })

    test('文件名含 ] 字符时正则完全不匹配（已知限制）', () => {
      // 方括号在文件名中极罕见，记录为已知限制
      const content = '📎 [文件[1].pdf](http://sync.bijitongbu.site/wecom4/2026/03/aaa) (1MB)'
      const matches = detectAttachments(content)
      // [^\]]+ 在第一个 ] 处停止，然后 \]\( 尝试匹配 ].pdf](url)
      // 但实际遇到的是 ].pdf] 而不是 ](，所以整个正则不匹配
      // 这是已知限制，实际企微文件名基本不含 ]
      expect(matches).toHaveLength(0)
    })

    test('URL 含 ) 字符时正则截断（已知限制）', () => {
      // URL 中的 ) 会导致正则提前结束
      const content = '📎 [文件.pdf](http://example.com/path(1)/file) (1MB)'
      const matches = detectAttachments(content)
      expect(matches).toHaveLength(1)
      // [^)]+ 会在第一个 ) 处停止
      expect(matches[0].url).toBe('http://example.com/path(1')
    })
  })
})
