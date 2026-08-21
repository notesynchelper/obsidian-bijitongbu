/**
 * 日记链接格式化测试
 * 测试双链前缀和显示文字截断功能
 */
import { truncateWithOmission } from '../src/util'

jest.mock('obsidian', () => ({
  App: jest.fn(),
  TFile: jest.fn(),
  normalizePath: (path: string) => path,
  Notice: jest.fn(),
}))

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
}))

interface MockLinkItem {
  targetFile: string
  displayTitle: string
  anchorHeading?: string
  isMessage: boolean
}

function generateWikiLink(
  linkItem: MockLinkItem,
  prefix: string,
  maxLength: number,
): string {
  let displayTitle = linkItem.displayTitle
  if (maxLength > 0) {
    displayTitle = truncateWithOmission(displayTitle, maxLength, '\u2026')
  }

  if (linkItem.isMessage && linkItem.anchorHeading) {
    return `${prefix}[[${linkItem.targetFile}#${linkItem.anchorHeading}|${displayTitle}]]`
  }
  return `${prefix}[[${linkItem.targetFile}|${displayTitle}]]`
}

describe('日记链接格式化', () => {
  describe('前缀配置', () => {
    const article: MockLinkItem = {
      targetFile: '2024/01/15/测试文章',
      displayTitle: '测试文章标题',
      isMessage: false,
    }
    const message: MockLinkItem = {
      targetFile: '同步助手_20240115',
      displayTitle: '微信消息摘要',
      anchorHeading: '微信消息摘要',
      isMessage: true,
    }

    it('默认前缀 "- " → 文章链接', () => {
      expect(generateWikiLink(article, '- ', 0)).toBe('- [[2024/01/15/测试文章|测试文章标题]]')
    })

    it('默认前缀 "- " → 消息链接（含锚点）', () => {
      expect(generateWikiLink(message, '- ', 0)).toBe('- [[同步助手_20240115#微信消息摘要|微信消息摘要]]')
    })

    it('留空前缀 → 直接输出 wikilink', () => {
      expect(generateWikiLink(article, '', 0)).toBe('[[2024/01/15/测试文章|测试文章标题]]')
    })

    it('自定义前缀 "> "', () => {
      expect(generateWikiLink(article, '> ', 0)).toBe('> [[2024/01/15/测试文章|测试文章标题]]')
    })

    it('前缀原样使用，不自动补空格', () => {
      expect(generateWikiLink(article, '-', 0)).toBe('-[[2024/01/15/测试文章|测试文章标题]]')
    })
  })

  describe('显示文字截断', () => {
    const longArticle: MockLinkItem = {
      targetFile: '2024/01/15/这是一篇非常长的文章标题用来测试截断功能',
      displayTitle: '这是一篇非常长的文章标题用来测试截断功能是否正确工作',
      isMessage: false,
    }

    it('maxLength = 0 → 不截断', () => {
      const result = generateWikiLink(longArticle, '- ', 0)
      expect(result).toContain('|这是一篇非常长的文章标题用来测试截断功能是否正确工作]]')
    })

    it('maxLength = 10 → 截断显示文字，文件名完整', () => {
      const result = generateWikiLink(longArticle, '- ', 10)
      // 文件名不被截断
      expect(result).toContain('[[2024/01/15/这是一篇非常长的文章标题用来测试截断功能')
      // displayTitle被截断(10个字符含omission)
      const match = result.match(/\|(.+?)\]\]/)
      expect(match).not.toBeNull()
      expect(match![1].length).toBeLessThanOrEqual(10)
    })

    it('displayTitle 短于 maxLength → 不截断', () => {
      const shortArticle: MockLinkItem = { targetFile: '测试', displayTitle: '短标题', isMessage: false }
      expect(generateWikiLink(shortArticle, '- ', 100)).toBe('- [[测试|短标题]]')
    })

    it('截断使用 U+2026 省略号', () => {
      const result = generateWikiLink(longArticle, '- ', 8)
      expect(result).toMatch(/\u2026\]\]$/)
    })

    it('消息链接截断 displayTitle，锚点不受影响', () => {
      const longMessage: MockLinkItem = {
        targetFile: '同步助手_20240115',
        displayTitle: '这是一条很长的微信消息内容摘要用来测试',
        anchorHeading: '这是一条很长的微信消息内容摘要用来测试',
        isMessage: true,
      }
      const result = generateWikiLink(longMessage, '- ', 10)
      // anchorHeading 不被截断
      expect(result).toContain('#这是一条很长的微信消息内容摘要用来测试|')
      // displayTitle 被截断
      const match = result.match(/\|(.+?)\]\]/)
      expect(match![1].length).toBeLessThanOrEqual(10)
    })
  })
})
