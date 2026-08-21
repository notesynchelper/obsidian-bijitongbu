/**
 * 图片/附件本地化后的 Markdown 样式测试
 *
 * 覆盖场景：
 * 1. generateMarkdownLink 生成的 wiki 链接格式
 * 2. generateMessageHeading 截断对不同内容类型的影响
 * 3. 模板渲染 + 本地化后的完整内容格式
 * 4. 本地化正则对 heading 残缺 pattern 的匹配行为
 */

import { Item } from '@omnivore-app/api'
import {
  generateMessageHeading,
  renderWeChatMessageSimple,
  extractHeadingPatternFromTemplate,
} from '../src/settings/template'

// 复制源码正则用于测试
const IMAGE_PATTERN =
  /!\[([^\]]*)\]\(([^)\n]+)\)|!\[\[([^\]\n]+)\]\]|<img[^>\n]+src=["']([^"'\n]+)["']/g
const ATTACHMENT_PATTERN =
  /📎\s*\[([^\]]+)\]\(([^)]+)\)(?:\s*\(([^)]+)\))?/g
const LINK_PATTERN = /(?<!!)\[([^\]]*)\]\(([^)\n]+)\)/g

const DEFAULT_WECHAT_TEMPLATE =
  '---\n#### {{{heading}}}\n## {{{dateSaved}}}\n{{{content}}}'

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'test-id-001',
    title: '同步助手_20260324_001_文本',
    savedAt: '2026-03-24T10:57:21.000Z',
    content: overrides.content ?? 'test content',
    url: 'https://example.com',
    slug: 'test',
    labels: [],
    highlights: [],
    updatedAt: '2026-03-24T10:57:21.000Z',
    siteName: null,
    originalArticleUrl: null,
    author: null,
    description: null,
    pageType: 'ARTICLE',
    publishedAt: null,
    image: null,
    readAt: null,
    wordsCount: null,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  } as Item
}

/** 模拟图片本地化的 generateMarkdownLink 逻辑 */
function imageGenerateMarkdownLink(
  alt: string | undefined,
  localPath: string,
): string {
  if (alt) {
    return `![[${localPath}|${alt}]]`
  }
  return `![[${localPath}]]`
}

/** 模拟附件本地化的 generateMarkdownLink 逻辑 */
function attachmentGenerateMarkdownLink(
  fileName: string,
  localPath: string,
  fileSize?: string,
): string {
  const sizeInfo = fileSize ? ` (${fileSize})` : ''
  return `📎 [[${localPath}|${fileName}]]${sizeInfo}`
}

/** 模拟本地化替换：将 content 中匹配到的 originalText 替换为 localText */
function simulateReplacement(
  content: string,
  original: string,
  local: string,
): string {
  return content.split(original).join(local)
}

// ============================================================
// 1. 图片本地化生成的 wiki 链接格式
// ============================================================
describe('图片本地化 generateMarkdownLink 格式', () => {
  test('无 alt: ![](url) -> ![[localPath]]', () => {
    const result = imageGenerateMarkdownLink(undefined, '笔记同步助手/images/abc123.jpg')
    expect(result).toBe('![[笔记同步助手/images/abc123.jpg]]')
  })

  test('有 alt: ![alt](url) -> ![[localPath|alt]]', () => {
    const result = imageGenerateMarkdownLink('我的图片', '笔记同步助手/images/abc123.jpg')
    expect(result).toBe('![[笔记同步助手/images/abc123.jpg|我的图片]]')
  })

  test('alt 含特殊字符: 保留原样', () => {
    const result = imageGenerateMarkdownLink('photo (1)', '笔记同步助手/images/abc.jpg')
    expect(result).toBe('![[笔记同步助手/images/abc.jpg|photo (1)]]')
  })

  test('普通链接本地化 [text](sync.bijitongbu.site) -> ![[path|text]]（添加 ! 前缀）', () => {
    // LINK_PATTERN 匹配的普通链接，本地化后变成图片嵌入
    const result = imageGenerateMarkdownLink('附件', '笔记同步助手/images/hash.jpg')
    expect(result).toBe('![[笔记同步助手/images/hash.jpg|附件]]')
    // 注意：原文是 [附件](url)，本地化后变成 ![[path|附件]]，语义从链接变为嵌入
  })
})

// ============================================================
// 2. 附件本地化生成的 wiki 链接格式
// ============================================================
describe('附件本地化 generateMarkdownLink 格式', () => {
  test('有文件大小: 📎 [[path|name]] (size)', () => {
    const result = attachmentGenerateMarkdownLink(
      'report.html',
      '笔记同步助手/attachments/report.html',
      '0.06MB',
    )
    expect(result).toBe('📎 [[笔记同步助手/attachments/report.html|report.html]] (0.06MB)')
  })

  test('无文件大小: 📎 [[path|name]]', () => {
    const result = attachmentGenerateMarkdownLink(
      'doc.pdf',
      '笔记同步助手/attachments/doc.pdf',
    )
    expect(result).toBe('📎 [[笔记同步助手/attachments/doc.pdf|doc.pdf]]')
  })

  test('文件名含中文: 📎 [[path|中文名.ppt]]', () => {
    const result = attachmentGenerateMarkdownLink(
      '会议纪要.ppt',
      '笔记同步助手/attachments/会议纪要.ppt',
      '2.4MB',
    )
    expect(result).toBe('📎 [[笔记同步助手/attachments/会议纪要.ppt|会议纪要.ppt]] (2.4MB)')
  })

  test('过期附件保留原链接并标记', () => {
    // 附件过期时的特殊输出
    const result = `📎 [report.html](http://example.com/file) ⚠️已过期`
    expect(result).toContain('📎')
    expect(result).toContain('⚠️已过期')
    expect(result).not.toContain('[[')
  })
})

// ============================================================
// 3. generateMessageHeading 对不同内容类型的截断行为
// ============================================================
describe('generateMessageHeading 截断行为与 markdown 语法', () => {
  test('普通文本内容: 正常截取前10字符', () => {
    const item = makeItem({ content: '今天的会议纪要总结如下' })
    expect(generateMessageHeading(item)).toBe('今天的会议纪要总结如')
  })

  test('图片内容 ![](url): heading 不应包含残缺的图片语法', () => {
    const item = makeItem({
      content: '![](http://sync.bijitongbu.site/wecom31/2026/03/hash)',
    })
    const heading = generateMessageHeading(item)
    // 期望: heading 应剥离 markdown 图片语法，不应出现未闭合的 ![](
    expect(heading).not.toContain('![](')
    expect(heading).not.toContain('![')
  })

  test('图片内容 ![](https://url): heading 不应包含残缺的图片语法', () => {
    const item = makeItem({
      content: '![](https://sync.bijitongbu.site/wecom31/2026/03/hash)',
    })
    const heading = generateMessageHeading(item)
    // 期望: 不应出现 ![](https: 这种残缺语法
    expect(heading).not.toContain('![](')
    expect(heading).not.toContain('![')
  })

  test('附件内容 📎 [name](url): heading 不应包含残缺的链接语法', () => {
    const item = makeItem({
      content: '📎 [report.html](http://example.com/file) (0.06MB)',
    })
    const heading = generateMessageHeading(item)
    // 期望: heading 应剥离 markdown 链接语法 [text](url)
    // 可以保留 📎 和文件名，但不应有未闭合的 [ 链接语法
    expect(heading).not.toMatch(/\[[^\]]*$/) // 不应以未闭合的 [ 结尾
  })

  test('HTML img 标签内容: 标签被剥离后截取', () => {
    const item = makeItem({
      content: '<img src="http://example.com/photo.jpg">',
    })
    const heading = generateMessageHeading(item)
    // HTML 标签被 replace(/<[^>]*>/g, '') 移除，内容变为空
    // <img src="http://example.com/photo.jpg"> 整个被移除
    expect(heading).toBe('消息') // 空内容回退为 '消息'
  })

  test('HTML 包裹的附件内容: 标签被剥离后截取纯文本', () => {
    const item = makeItem({
      content: '<p>📎 <a href="http://url">report.html</a> (0.06MB)</p>',
    })
    const heading = generateMessageHeading(item)
    // 剥离 HTML 后: "📎 report.html (0.06MB)"
    // 前10字符: "📎 report." (2+1+7=10)
    expect(heading).toBe('📎 report.')
  })

  test('空内容: 回退为 "消息"', () => {
    const item = makeItem({ content: '' })
    expect(generateMessageHeading(item)).toBe('消息')
  })

  test('null 内容: 回退为 "消息"', () => {
    const item = makeItem({ content: null as any })
    expect(generateMessageHeading(item)).toBe('消息')
  })

  test('纯 HTML 标签内容（无文本）: 回退为 "消息"', () => {
    const item = makeItem({ content: '<br><hr><div></div>' })
    expect(generateMessageHeading(item)).toBe('消息')
  })

  test('短内容不足10字符: 取全部', () => {
    const item = makeItem({ content: '你好' })
    expect(generateMessageHeading(item)).toBe('你好')
  })
})

// ============================================================
// 4. 模板渲染后的完整内容格式（本地化前）
// ============================================================
describe('wechatMessageTemplate 渲染后的内容格式', () => {
  const dateSavedFormat = 'yyyy-MM-dd HH:mm:ss'

  test('普通文本消息: 模板渲染正常', () => {
    const item = makeItem({ content: '今天开会讨论了新功能的设计方案' })
    const rendered = renderWeChatMessageSimple(item, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)

    expect(rendered).toContain('---')
    expect(rendered).toContain('#### 今天开会讨论了新功')
    expect(rendered).toContain('## 2026-03-24 10:57:21')
    expect(rendered).toContain('今天开会讨论了新功能的设计方案')
  })

  test('图片消息: heading 不应包含残缺的图片语法', () => {
    const imageUrl = 'http://sync.bijitongbu.site/wecom31/2026/03/hash123'
    const item = makeItem({ content: `![](${imageUrl})` })
    const rendered = renderWeChatMessageSimple(item, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)

    // 期望: heading 行不应包含残缺的 ![](
    const headingLine = rendered.split('\n').find(l => l.startsWith('####'))!
    expect(headingLine).not.toContain('![](')
    // content 行仍应包含完整的图片链接（本地化前）
    expect(rendered).toContain(`![](${imageUrl})`)
  })

  test('附件消息: heading 不应包含残缺的链接语法', () => {
    const item = makeItem({
      content: '📎 [report.html](http://example.com/file) (0.06MB)',
    })
    const rendered = renderWeChatMessageSimple(item, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)

    // 期望: heading 行不应包含未闭合的 [ 链接语法
    const headingLine = rendered.split('\n').find(l => l.startsWith('####'))!
    expect(headingLine).not.toMatch(/\[[^\]]*$/)
    // content 行仍应包含完整的附件链接（本地化前）
    expect(rendered).toContain('📎 [report.html](http://example.com/file) (0.06MB)')
  })

  test('模板 --- 分隔符位于每条消息开头', () => {
    const item = makeItem({ content: 'hello' })
    const rendered = renderWeChatMessageSimple(item, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)

    // 第一行应该是 ---
    const lines = rendered.split('\n')
    expect(lines[0]).toBe('---')
  })
})

// ============================================================
// 5. 本地化正则对 heading 中残缺 pattern 的匹配行为
// ============================================================
describe('本地化正则对 heading 残缺 pattern 的匹配', () => {
  beforeEach(() => {
    IMAGE_PATTERN.lastIndex = 0
    ATTACHMENT_PATTERN.lastIndex = 0
    LINK_PATTERN.lastIndex = 0
  })

  test('IMAGE_PATTERN 不匹配残缺的 ![](http:/ （无闭合括号）', () => {
    const headingLine = '#### ![](http:/'
    IMAGE_PATTERN.lastIndex = 0
    const match = IMAGE_PATTERN.exec(headingLine)
    expect(match).toBeNull()
  })

  test('IMAGE_PATTERN 不匹配残缺的 ![](https:（无闭合括号）', () => {
    const headingLine = '#### ![](https:'
    IMAGE_PATTERN.lastIndex = 0
    const match = IMAGE_PATTERN.exec(headingLine)
    expect(match).toBeNull()
  })

  test('ATTACHMENT_PATTERN 不匹配残缺的 📎 [report（无闭合链接）', () => {
    const headingLine = '#### 📎 [report'
    ATTACHMENT_PATTERN.lastIndex = 0
    const match = ATTACHMENT_PATTERN.exec(headingLine)
    expect(match).toBeNull()
  })

  test('IMAGE_PATTERN 匹配 body 中完整的 ![](url)', () => {
    const bodyLine = '![](http://sync.bijitongbu.site/wecom31/2026/03/hash123)'
    IMAGE_PATTERN.lastIndex = 0
    const match = IMAGE_PATTERN.exec(bodyLine)
    expect(match).not.toBeNull()
    expect(match![2]).toBe('http://sync.bijitongbu.site/wecom31/2026/03/hash123')
  })

  test('ATTACHMENT_PATTERN 匹配 body 中完整的 📎 [name](url) (size)', () => {
    const bodyLine = '📎 [report.html](http://example.com/file) (0.06MB)'
    ATTACHMENT_PATTERN.lastIndex = 0
    const match = ATTACHMENT_PATTERN.exec(bodyLine)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('report.html')
    expect(match![2]).toBe('http://example.com/file')
    expect(match![3]).toBe('0.06MB')
  })
})

// ============================================================
// 6. 模拟完整的 模板渲染 → 本地化替换 流程
// ============================================================
describe('模板渲染 + 本地化替换后的最终 MD 格式', () => {
  const dateSavedFormat = 'yyyy-MM-dd HH:mm:ss'

  test('图片消息: 本地化后 heading 不应残留原始 markdown 碎片', () => {
    const imageUrl = 'http://sync.bijitongbu.site/wecom31/2026/03/hash123'
    const item = makeItem({ content: `![](${imageUrl})` })
    const rendered = renderWeChatMessageSimple(item, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)

    // 模拟图片本地化替换
    const originalText = `![](${imageUrl})`
    const localText = '![[笔记同步助手/images/abc123.jpg]]'
    const afterLocalize = simulateReplacement(rendered, originalText, localText)

    // body 中的图片已被替换为 wiki 链接
    expect(afterLocalize).toContain('![[笔记同步助手/images/abc123.jpg]]')
    expect(afterLocalize).not.toContain(imageUrl)

    // 期望: heading 中不应有残缺的图片语法碎片
    const headingLine = afterLocalize.split('\n').find(l => l.startsWith('####'))!
    expect(headingLine).not.toContain('![](')
  })

  test('附件消息: 本地化后 heading 不应残留原始 markdown 碎片', () => {
    const attachmentUrl = 'http://example.com/wecom4/2025/12/file123'
    const originalContent = `📎 [report.html](${attachmentUrl}) (0.06MB)`
    const item = makeItem({ content: originalContent })
    const rendered = renderWeChatMessageSimple(item, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)

    // 模拟附件本地化替换
    const localText = '📎 [[笔记同步助手/attachments/report.html|report.html]] (0.06MB)'
    const afterLocalize = simulateReplacement(rendered, originalContent, localText)

    // body 中的附件已被替换为 wiki 链接
    expect(afterLocalize).toContain('📎 [[笔记同步助手/attachments/report.html|report.html]] (0.06MB)')
    expect(afterLocalize).not.toContain(attachmentUrl)

    // 期望: heading 中不应有未闭合的 [ 链接语法
    const headingLine = afterLocalize.split('\n').find(l => l.startsWith('####'))!
    expect(headingLine).not.toMatch(/\[[^\]]*$/)
  })

  test('图片消息: 本地化后 heading 和 body 应一致无残缺语法', () => {
    const imageUrl = 'https://sync.bijitongbu.site/wecom31/2026/03/hash'
    const item = makeItem({ content: `![](${imageUrl})` })
    const rendered = renderWeChatMessageSimple(item, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)

    const afterLocalize = simulateReplacement(
      rendered,
      `![](${imageUrl})`,
      '![[笔记同步助手/images/md5hash.jpg]]',
    )

    const lines = afterLocalize.split('\n')
    const headingLine = lines.find(l => l.startsWith('####'))!

    // 期望: heading 中不应包含残缺的 ![](https: 碎片
    expect(headingLine).not.toContain('![](')
    expect(headingLine).not.toContain('![')
  })

  test('普通文本消息: 无 markdown 语法，本地化不影响 heading', () => {
    const item = makeItem({ content: '这是一条普通的聊天消息内容' })
    const rendered = renderWeChatMessageSimple(item, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)

    // heading 和 body 都是纯文本，无残缺语法
    expect(rendered).toContain('#### 这是一条普通的聊天消')
    expect(rendered).toContain('这是一条普通的聊天消息内容')

    // 无远程 URL，本地化不会有任何替换
    IMAGE_PATTERN.lastIndex = 0
    expect(IMAGE_PATTERN.exec(rendered)).toBeNull()
    ATTACHMENT_PATTERN.lastIndex = 0
    expect(ATTACHMENT_PATTERN.exec(rendered)).toBeNull()
  })

  test('多图片消息: 本地化后 heading 不应残留截断碎片', () => {
    const url1 = 'http://sync.bijitongbu.site/wecom31/2026/03/aaa'
    const url2 = 'http://sync.bijitongbu.site/wecom31/2026/03/bbb'
    const item = makeItem({ content: `![](${url1})\n![](${url2})` })
    const rendered = renderWeChatMessageSimple(item, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)

    let afterLocalize = simulateReplacement(rendered, `![](${url1})`, '![[images/aaa.jpg]]')
    afterLocalize = simulateReplacement(afterLocalize, `![](${url2})`, '![[images/bbb.jpg]]')

    // body 中两张图片都已替换
    expect(afterLocalize).toContain('![[images/aaa.jpg]]')
    expect(afterLocalize).toContain('![[images/bbb.jpg]]')
    expect(afterLocalize).not.toContain(url1)
    expect(afterLocalize).not.toContain(url2)

    // 期望: heading 不应有残缺的图片语法
    const headingLine = afterLocalize.split('\n').find(l => l.startsWith('####'))!
    expect(headingLine).not.toContain('![](')
  })
})

// ============================================================
// 7. 多条消息合并后的本地化替换行为
// ============================================================
describe('合并多条消息后的本地化替换行为', () => {
  const dateSavedFormat = 'yyyy-MM-dd HH:mm:ss'

  test('图片消息 + 文本消息合并: 图片 body 替换不影响文本消息', () => {
    const imageUrl = 'http://sync.bijitongbu.site/wecom31/2026/03/hash'
    const imageItem = makeItem({
      content: `![](${imageUrl})`,
      savedAt: '2026-03-24T10:57:10.000Z',
    })
    const textItem = makeItem({
      content: '这是一条普通文本消息',
      savedAt: '2026-03-24T10:57:21.000Z',
    })

    const rendered1 = renderWeChatMessageSimple(imageItem, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)
    const rendered2 = renderWeChatMessageSimple(textItem, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)
    const merged = `${rendered1}\n\n${rendered2}`

    // 模拟图片本地化
    const afterLocalize = simulateReplacement(
      merged,
      `![](${imageUrl})`,
      '![[笔记同步助手/images/hash.jpg]]',
    )

    // 图片消息 body 替换
    expect(afterLocalize).toContain('![[笔记同步助手/images/hash.jpg]]')
    // 期望: 图片消息 heading 不应有残缺语法
    const imageHeading = afterLocalize.split('\n').filter(l => l.startsWith('####'))[0]
    expect(imageHeading).not.toContain('![](')
    // 文本消息完全不受影响
    expect(afterLocalize).toContain('#### 这是一条普通文本消')
    expect(afterLocalize).toContain('这是一条普通文本消息')
  })

  test('附件消息 + 图片消息合并: 各自独立替换', () => {
    const attachUrl = 'http://example.com/wecom4/2025/12/file'
    const imageUrl = 'http://sync.bijitongbu.site/wecom31/2026/03/img'

    const attachItem = makeItem({
      content: `📎 [doc.pdf](${attachUrl}) (1.2MB)`,
      savedAt: '2026-03-24T10:57:21.000Z',
    })
    const imageItem = makeItem({
      content: `![](${imageUrl})`,
      savedAt: '2026-03-24T10:57:10.000Z',
    })

    const rendered1 = renderWeChatMessageSimple(attachItem, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)
    const rendered2 = renderWeChatMessageSimple(imageItem, dateSavedFormat, DEFAULT_WECHAT_TEMPLATE)
    const merged = `${rendered1}\n\n${rendered2}`

    // 附件本地化
    let afterLocalize = simulateReplacement(
      merged,
      `📎 [doc.pdf](${attachUrl}) (1.2MB)`,
      '📎 [[笔记同步助手/attachments/doc.pdf|doc.pdf]] (1.2MB)',
    )
    // 图片本地化
    afterLocalize = simulateReplacement(
      afterLocalize,
      `![](${imageUrl})`,
      '![[笔记同步助手/images/img.jpg]]',
    )

    // 两个 body 都替换成功
    expect(afterLocalize).toContain('📎 [[笔记同步助手/attachments/doc.pdf|doc.pdf]] (1.2MB)')
    expect(afterLocalize).toContain('![[笔记同步助手/images/img.jpg]]')

    // 期望: 两个 heading 都不应有残缺语法
    const headings = afterLocalize.split('\n').filter(l => l.startsWith('####'))
    for (const h of headings) {
      expect(h).not.toContain('![](')
      expect(h).not.toMatch(/\[[^\]]*$/) // 不应以未闭合的 [ 结尾
    }
  })
})

// ============================================================
// 8. 本地化后的 wiki 链接在 Obsidian 中的语义
// ============================================================
describe('本地化后 wiki 链接的 Obsidian 语义', () => {
  test('图片 ![[path]] 是嵌入（embed），会内联显示图片', () => {
    const link = imageGenerateMarkdownLink(undefined, '笔记同步助手/images/abc.jpg')
    // ![[...]] 是 Obsidian 的嵌入语法，图片会直接渲染
    expect(link.startsWith('![[')).toBe(true)
    expect(link.endsWith(']]')).toBe(true)
  })

  test('附件 📎 [[path|name]] 是内部链接（internal link），不会嵌入', () => {
    const link = attachmentGenerateMarkdownLink('doc.pdf', '笔记同步助手/attachments/doc.pdf')
    // [[...]] 没有 ! 前缀，是内部链接，点击会打开文件
    expect(link).toContain('[[')
    expect(link).not.toMatch(/^!\[\[/)
    // 以 📎 开头
    expect(link.startsWith('📎 [[')).toBe(true)
  })

  test('LINK_PATTERN 匹配的普通链接本地化后变为图片嵌入（语义变化）', () => {
    // 原始: [资源](https://sync.bijitongbu.site/file) - 这是链接
    // 本地化后: ![[path|资源]] - 这变成了嵌入
    const original = '[资源](https://sync.bijitongbu.site/file)'
    const localized = imageGenerateMarkdownLink('资源', '笔记同步助手/images/hash.jpg')

    // 原始没有 ! 前缀
    expect(original.startsWith('!')).toBe(false)
    // 本地化后有 ! 前缀（语义从链接变为嵌入）
    expect(localized.startsWith('!')).toBe(true)
  })
})

// ============================================================
// 9. 边界场景
// ============================================================
describe('边界场景', () => {
  const dateSavedFormat = 'yyyy-MM-dd HH:mm:ss'

  test('content 只有一个 emoji 📎: heading 为 📎 无残缺语法', () => {
    const item = makeItem({ content: '📎' })
    const heading = generateMessageHeading(item)
    expect(heading).toBe('📎')
    // 不含任何链接语法字符
    expect(heading).not.toContain('[')
    expect(heading).not.toContain('(')
  })

  test('content 是已本地化的 wiki 链接: heading 不应包含残缺 wiki 语法', () => {
    // 如果内容已经是 wiki 链接格式（理论上不应出现，但做防御性测试）
    const item = makeItem({ content: '![[笔记同步助手/images/abc.jpg]]' })
    const heading = generateMessageHeading(item)
    // 期望: 不应包含未闭合的 ![[ 语法
    expect(heading).not.toContain('![[')
  })

  test('content 是已本地化的附件 wiki 链接: heading 不应包含残缺语法', () => {
    const item = makeItem({
      content: '📎 [[笔记同步助手/attachments/report.html|report.html]] (0.06MB)',
    })
    const heading = generateMessageHeading(item)
    // 期望: 不应包含未闭合的 [[ 语法
    expect(heading).not.toContain('[[')
  })

  test('IMAGE_PATTERN 对残缺 heading ![](https: 在多行上下文中不跨行匹配', () => {
    const content = [
      '#### ![](https:',
      '## 2026-03-24 10:57:10',
      '![[笔记同步助手/images/abc.jpg]]',
    ].join('\n')

    IMAGE_PATTERN.lastIndex = 0
    const matches: string[] = []
    let m: RegExpExecArray | null
    while ((m = IMAGE_PATTERN.exec(content)) !== null) {
      matches.push(m[0])
    }

    // heading 行的 ![](https: 不会跨行匹配到下一行内容
    // 第三行的 ![[...]] 也不匹配 IMAGE_PATTERN 的 markdown 分支（因为是 wiki 格式）
    // ![[...]] 匹配的是 IMAGE_PATTERN 的 wiki 分支: !\[\[([^\]\n]+)\]\]
    expect(matches).toHaveLength(1)
    expect(matches[0]).toBe('![[笔记同步助手/images/abc.jpg]]')
  })

  test('ATTACHMENT_PATTERN 不匹配已本地化的 📎 [[path|name]] 格式', () => {
    const localizedContent = '📎 [[笔记同步助手/attachments/report.html|report.html]] (0.06MB)'
    ATTACHMENT_PATTERN.lastIndex = 0
    const match = ATTACHMENT_PATTERN.exec(localizedContent)
    // 📎 [[...]] 不匹配 📎\s*\[([^\]]+)\]\(([^)]+)\) 因为是 [[ 而非 [text](url)
    expect(match).toBeNull()
  })
})
