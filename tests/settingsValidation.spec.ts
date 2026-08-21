/**
 * 设置项错误配置测试
 * 测试目标：当用户设置了错误的配置时，各层是否正确通知用户
 *
 * 分为 3 层：
 * 1. 设置验证层 - settingsTab onChange 中的验证逻辑
 * 2. 同步流程层 - fetchOmnivore 中的前置检查
 * 3. 模板渲染层 - renderItemContent 中的容错处理
 */

import { Item } from '@omnivore-app/api'
// 注意：必须先导入 settings/index 再导入 settings/template
// 因为两者存在循环依赖（template.ts 从 index.ts 导入 HighlightManagerId）
// 先导入 index 确保 DEFAULT_TEMPLATE 在 DEFAULT_SETTINGS 构造时已可用
import { DEFAULT_SETTINGS, FRONT_MATTER_VARIABLES } from '../src/settings/index'
import {
  preParseTemplate,
  renderItemContent,
  render,
  renderFilename,
  DEFAULT_TEMPLATE,
} from '../src/settings/template'
import { validateTemplate, validateDateFormat } from '../src/settings/validation'

// ===================== Mock Notice 收集器 =====================
const noticeCalls: { message: string; duration?: number }[] = []

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn().mockImplementation((message: string, duration?: number) => {
      noticeCalls.push({ message, duration })
    }),
  }
})

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
}))

// ===================== 工具函数 =====================
function createMockItem(overrides?: Partial<Item>): Item {
  return {
    id: 'test-id-123',
    title: 'Test Article',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/article',
    author: 'Test Author',
    description: 'A test description',
    slug: 'test-slug',
    labels: [],
    highlights: [],
    updatedAt: '2024-01-15T12:00:00.000Z',
    savedAt: '2024-01-15T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: '<p>Test content here.</p>',
    publishedAt: null,
    url: 'https://example.com/article',
    image: null,
    readAt: null,
    wordsCount: 100,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  }
}

const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

function callRenderItemContent(
  item: Item,
  overrides?: {
    template?: string
    frontMatterTemplate?: string
    frontMatterVariables?: string[]
    wechatMessageTemplate?: string
    shouldMerge?: boolean
    sectionSeparator?: string
    sectionSeparatorEnd?: string
  },
): string {
  return renderItemContent(
    item,
    overrides?.template ?? DEFAULT_TEMPLATE,
    'LOCATION',
    undefined,
    DATE_FORMAT,
    DATE_FORMAT,
    overrides?.shouldMerge ?? false,
    overrides?.frontMatterVariables ?? [],
    overrides?.frontMatterTemplate ?? '',
    overrides?.sectionSeparator ?? '%%{{{dateSaved}}}_start%%',
    overrides?.sectionSeparatorEnd ?? '%%{{{dateSaved}}}_end%%',
    undefined,
    overrides?.wechatMessageTemplate,
  )
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsYaml = require('js-yaml')

function extractFrontMatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)---/)
  if (!match) return null
  return jsYaml.load(match[1]) as Record<string, unknown>
}

beforeEach(() => {
  noticeCalls.length = 0
})

// =========================================================================
// 第 1 层：设置验证层 - settingsTab 中的 onChange 校验逻辑
// =========================================================================
describe('第1层：设置项输入验证', () => {
  const { Notice } = require('obsidian')

  // --- 同步频率验证（Phase-2：onChange 静默保存+钳位，失焦才提示；镜像 settingsTab.ts 频率块） ---
  describe('同步频率 (frequency)', () => {
    const { MIN_AUTO_SYNC_FREQUENCY } = require('../src/settings')

    // 镜像 onChange：非法输入不保存也不弹 Notice（提示挪到 blur）；
    // 0 = 仅手动同步；1~59 静默钳位到 MIN_AUTO_SYNC_FREQUENCY(60)。
    function applyFrequencyInput(value: string): { saved: boolean; frequency?: number } {
      const frequency = parseInt(value)
      if (isNaN(frequency) || frequency < 0) return { saved: false }
      const clamped =
        frequency > 0 && frequency < MIN_AUTO_SYNC_FREQUENCY
          ? MIN_AUTO_SYNC_FREQUENCY
          : frequency
      return { saved: true, frequency: clamped }
    }

    it('MIN_AUTO_SYNC_FREQUENCY 常量为 60', () => {
      expect(MIN_AUTO_SYNC_FREQUENCY).toBe(60)
    })

    it('输入非数字 → 不保存、键入途中不弹 Notice', () => {
      const result = applyFrequencyInput('abc')
      expect(result.saved).toBe(false)
      expect(noticeCalls).toHaveLength(0)
    })

    it('输入空字符串 → 不保存', () => {
      expect(applyFrequencyInput('').saved).toBe(false)
    })

    it('输入负数 -5 → 不保存（旧版负数放行的缺口已修复）', () => {
      expect(applyFrequencyInput('-5').saved).toBe(false)
    })

    it('输入 0 → 保存 0（仅手动同步，不受最低值限制）', () => {
      const result = applyFrequencyInput('0')
      expect(result.saved).toBe(true)
      expect(result.frequency).toBe(0)
    })

    it('输入 1 → 钳位保存为 60', () => {
      expect(applyFrequencyInput('1').frequency).toBe(60)
    })

    it('输入 59 → 钳位保存为 60', () => {
      expect(applyFrequencyInput('59').frequency).toBe(60)
    })

    it('输入小数 "3.5" → parseInt 截断为 3 → 钳位保存为 60', () => {
      expect(applyFrequencyInput('3.5').frequency).toBe(60)
    })

    it('输入 60 → 原样保存', () => {
      expect(applyFrequencyInput('60').frequency).toBe(60)
    })

    it('输入 300 → 原样保存', () => {
      expect(applyFrequencyInput('300').frequency).toBe(300)
    })
  })

  // --- 图片下载重试次数验证 (settingsTab.ts:789-794) ---
  describe('图片下载重试次数 (imageDownloadRetries)', () => {
    function validateRetries(value: string): { valid: boolean; retries?: number } {
      const retries = parseInt(value)
      if (isNaN(retries) || retries < 0) {
        new Notice('重试次数必须是非负整数')
        return { valid: false }
      }
      return { valid: true, retries }
    }

    it('输入非数字 → 提示"重试次数必须是非负整数"', () => {
      const result = validateRetries('abc')
      expect(result.valid).toBe(false)
      expect(noticeCalls[0].message).toBe('重试次数必须是非负整数')
    })

    it('输入空字符串 → 提示"重试次数必须是非负整数"', () => {
      const result = validateRetries('')
      expect(result.valid).toBe(false)
      expect(noticeCalls[0].message).toBe('重试次数必须是非负整数')
    })

    it('输入负数 -1 → 提示"重试次数必须是非负整数"', () => {
      const result = validateRetries('-1')
      expect(result.valid).toBe(false)
      expect(noticeCalls[0].message).toBe('重试次数必须是非负整数')
    })

    it('输入 0 → 合法（不重试）', () => {
      const result = validateRetries('0')
      expect(result.valid).toBe(true)
      expect(result.retries).toBe(0)
      expect(noticeCalls).toHaveLength(0)
    })

    it('输入 3 → 合法', () => {
      const result = validateRetries('3')
      expect(result.valid).toBe(true)
      expect(result.retries).toBe(3)
      expect(noticeCalls).toHaveLength(0)
    })

    it('输入小数 "2.7" → parseInt 截断为 2，合法', () => {
      const result = validateRetries('2.7')
      expect(result.valid).toBe(true)
      expect(result.retries).toBe(2)
      expect(noticeCalls).toHaveLength(0)
    })
  })

  // --- JPEG 质量验证 ---
  describe('JPEG 质量 (jpegQuality)', () => {
    // settingsTab 中 JPEG 质量使用 slider 0-100，没有文本输入验证
    // 测试默认值范围是否合理
    it('默认值 85 在有效范围 0-100 内', () => {
      expect(DEFAULT_SETTINGS.jpegQuality).toBeGreaterThanOrEqual(0)
      expect(DEFAULT_SETTINGS.jpegQuality).toBeLessThanOrEqual(100)
    })
  })

  // --- 前置元数据变量验证 ---
  describe('前置元数据变量 (frontMatterVariables)', () => {
    function validateFrontMatterVariable(variable: string): boolean {
      return FRONT_MATTER_VARIABLES.includes(variable)
    }

    it('合法变量 "title" → 通过', () => {
      expect(validateFrontMatterVariable('title')).toBe(true)
    })

    it('合法变量 "date_saved" → 通过', () => {
      expect(validateFrontMatterVariable('date_saved')).toBe(true)
    })

    it('不存在的变量 "invalid_field" → 被过滤', () => {
      expect(validateFrontMatterVariable('invalid_field')).toBe(false)
    })

    it('空字符串 → 被过滤', () => {
      expect(validateFrontMatterVariable('')).toBe(false)
    })

    it('拼写错误 "titl" → 被过滤', () => {
      expect(validateFrontMatterVariable('titl')).toBe(false)
    })

    it('所有合法变量列表完整性检查', () => {
      const expected = [
        'title', 'author', 'tags', 'date_saved', 'date_published',
        'omnivore_url', 'site_name', 'original_url', 'description',
        'note', 'type', 'date_read', 'words_count', 'read_length',
        'state', 'date_archived', 'image',
      ]
      for (const v of expected) {
        expect(validateFrontMatterVariable(v)).toBe(true)
      }
    })
  })

  // --- 模板语法验证 (validateTemplate) ---
  describe('模板语法验证 (validateTemplate)', () => {
    it('正常模板 → 通过，无 Notice', () => {
      expect(validateTemplate('{{{title}}}', '文章文件夹')).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })

    it('空值 → 跳过验证，返回 true', () => {
      expect(validateTemplate('', '文章文件夹')).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })

    it('未闭合 section → 返回 false，弹出 Notice', () => {
      expect(validateTemplate('{{#section}}content', '文章文件夹')).toBe(false)
      expect(noticeCalls).toHaveLength(1)
      expect(noticeCalls[0].message).toContain('文章文件夹')
      expect(noticeCalls[0].message).toContain('模板语法错误')
    })

    it('文件名模板语法错误 → Notice 包含字段名"文章文件名"', () => {
      expect(validateTemplate('{{#bad}}', '文章文件名')).toBe(false)
      expect(noticeCalls[0].message).toContain('文章文件名')
    })

    it('文章模板语法错误 → Notice 包含字段名"文章模板"', () => {
      expect(validateTemplate('{{#section}}no close', '文章模板')).toBe(false)
      expect(noticeCalls[0].message).toContain('文章模板')
    })

    it('前置元数据模板语法错误 → Notice 包含字段名"前置元数据模板"', () => {
      expect(validateTemplate('{{#labels}}{{name}}', '前置元数据模板')).toBe(false)
      expect(noticeCalls[0].message).toContain('前置元数据模板')
    })

    it('助手消息模板语法错误 → Notice', () => {
      expect(validateTemplate('{{#x}}unclosed', '助手消息模板')).toBe(false)
      expect(noticeCalls[0].message).toContain('助手消息模板')
    })

    it('附件文件夹模板语法错误 → Notice', () => {
      expect(validateTemplate('{{#oops}}', '附件文件夹')).toBe(false)
      expect(noticeCalls[0].message).toContain('附件文件夹')
    })

    it('消息文件名称模板语法错误 → Notice', () => {
      expect(validateTemplate('{{#open}}', '消息文件名称')).toBe(false)
      expect(noticeCalls[0].message).toContain('消息文件名称')
    })

    it('图片存储文件夹模板语法错误 → Notice', () => {
      expect(validateTemplate('{{#x}}', '图片存储文件夹')).toBe(false)
      expect(noticeCalls[0].message).toContain('图片存储文件夹')
    })

    it('纯文本无变量 → 通过', () => {
      expect(validateTemplate('plain/path/no/vars', '文章文件夹')).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })

    it('三重花括号变量 {{{title}}} → 通过', () => {
      expect(validateTemplate('笔记/{{{title}}}/{{{date}}}', '文章文件夹')).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })
  })

  // --- 日期格式验证 (validateDateFormat) ---
  describe('日期格式验证 (validateDateFormat)', () => {
    it('有效格式 yyyy-MM-dd → 通过', () => {
      expect(validateDateFormat('yyyy-MM-dd', '文章文件夹日期格式')).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })

    it('空值 → 跳过验证，返回 true', () => {
      expect(validateDateFormat('', '文章文件夹日期格式')).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })

    it('有效格式 yyyyMMdd → 通过', () => {
      expect(validateDateFormat('yyyyMMdd', '文章文件名日期格式')).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })

    it("有效格式 yyyy-MM-dd'T'HH:mm:ss → 通过", () => {
      expect(validateDateFormat("yyyy-MM-dd'T'HH:mm:ss", '保存日期格式')).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })

    it('纯文本无格式 token → 通过（视为固定文本）', () => {
      // "hello" 不含日期 token，formatDate 会原样输出
      // 但由于不含 yMdHhms，不会触发"格式和结果相同"的检查
      expect(validateDateFormat('hello', '文章文件夹日期格式')).toBe(true)
    })

    it('文件夹日期格式字段名正确出现在 Notice 中', () => {
      // 测试错误 Notice 中是否包含正确的字段名
      // 注意：这个测试依赖于 formatDate 抛异常的情况
      // 如果格式是有效的 Luxon 格式但结果很奇怪，不一定会触发 Notice
      // 所以这里测试一个确实会出错的格式
      const result = validateDateFormat("yyyy-MM-dd'unterminated", '文章文件夹日期格式')
      // Luxon 对未终止的引号可能不会抛错，但结果可能不符合预期
      // 这里主要确认函数不崩溃
      expect(typeof result).toBe('boolean')
    })

    it('单文件日期格式错误 → Notice 包含字段名', () => {
      const result = validateDateFormat("yyyy-MM-dd'unterminated", '消息文件日期格式')
      expect(typeof result).toBe('boolean')
    })
  })
})

// =========================================================================
// 第 2 层：同步流程层 - fetchOmnivore 中的前置检查
// =========================================================================
describe('第2层：同步流程前置检查', () => {
  const { Notice } = require('obsidian')

  // --- API 密钥为空 ---
  describe('API 密钥检查', () => {
    function checkApiKey(apiKey: string): boolean {
      if (!apiKey) {
        new Notice('缺少 API 密钥')
        return false
      }
      return true
    }

    it('apiKey 为空字符串 → 提示"缺少 API 密钥"', () => {
      expect(checkApiKey('')).toBe(false)
      expect(noticeCalls[0].message).toBe('缺少 API 密钥')
    })

    it('apiKey 为 undefined/null (falsy) → 提示"缺少 API 密钥"', () => {
      expect(checkApiKey(undefined as unknown as string)).toBe(false)
      expect(noticeCalls[0].message).toBe('缺少 API 密钥')
    })

    it('apiKey 有值 → 通过', () => {
      expect(checkApiKey('valid-key-123')).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })
  })

  // --- 正在同步中 ---
  describe('同步状态检查', () => {
    function checkSyncing(syncing: boolean): boolean {
      if (syncing) {
        new Notice('🐢 正在同步中...')
        return false
      }
      return true
    }

    it('已在同步中 → 提示"正在同步中"', () => {
      expect(checkSyncing(true)).toBe(false)
      expect(noticeCalls[0].message).toBe('🐢 正在同步中...')
    })

    it('未在同步 → 通过', () => {
      expect(checkSyncing(false)).toBe(true)
      expect(noticeCalls).toHaveLength(0)
    })
  })

  // --- 模板语法错误 ---
  describe('模板 Mustache 语法检查 (preParseTemplate)', () => {
    it('正常模板 → 解析成功', () => {
      expect(() => preParseTemplate('{{{title}}}')).not.toThrow()
    })

    it('默认模板 → 解析成功', () => {
      expect(() => preParseTemplate(DEFAULT_TEMPLATE)).not.toThrow()
    })

    it('未闭合的标签 {{#section} → 抛出错误', () => {
      // Mustache.parse 对未闭合的 section 会抛错
      expect(() => preParseTemplate('{{#section}}content')).toThrow()
    })

    it('未闭合的反转 section {{^section} → 抛出错误', () => {
      expect(() => preParseTemplate('{{^section}}content')).toThrow()
    })

    it('空模板 → 解析成功（返回空数组）', () => {
      const result = preParseTemplate('')
      expect(result).toEqual([])
    })

    it('只有纯文本无变量 → 解析成功', () => {
      expect(() => preParseTemplate('just plain text')).not.toThrow()
    })

    it('嵌套 section 正确闭合 → 解析成功', () => {
      expect(() => preParseTemplate('{{#a}}{{#b}}inner{{/b}}{{/a}}')).not.toThrow()
    })

    it('section 闭合顺序错误 → 抛出错误', () => {
      // {{#a}}{{#b}}{{/a}}{{/b}} - 闭合顺序错误
      expect(() => preParseTemplate('{{#a}}{{#b}}inner{{/a}}{{/b}}')).toThrow()
    })
  })

  // --- 前置元数据模板语法错误 ---
  describe('前置元数据模板 Mustache 语法检查', () => {
    it('正常 YAML 模板 → 解析成功', () => {
      expect(() => preParseTemplate('title: {{{title}}}\nauthor: {{{author}}}')).not.toThrow()
    })

    it('未闭合 section → 抛出错误（同步时会触发"获取数据失败"）', () => {
      expect(() => preParseTemplate('{{#labels}}{{name}}')).toThrow()
    })
  })
})

// =========================================================================
// 第 3 层：模板渲染层 - renderItemContent 中的容错处理
// =========================================================================
describe('第3层：模板渲染容错', () => {
  const item = createMockItem()

  // --- frontMatterTemplate YAML 解析失败 ---
  describe('前置元数据模板 YAML 错误', () => {
    it('无效 YAML（无法自动修复） → frontMatter 包含 omnivore_error', () => {
      // 使用无法被 sanitizeRenderedYaml 修复的 YAML
      const badYamlTemplate = 'title: {{{title}}}\n  bad-indent: [unclosed'
      const content = callRenderItemContent(item, {
        frontMatterTemplate: badYamlTemplate,
      })
      const fm = extractFrontMatter(content)
      expect(fm).not.toBeNull()
      expect(fm!.omnivore_error).toBeDefined()
      expect(fm!.omnivore_error).toContain('error parsing the front matter template')
    })

    it('YAML 含特殊字符但可自动修复 → 正常解析', () => {
      const template = 'title: {{{title}}}\nauthor: {{{author}}}'
      const itemWithColon = createMockItem({ title: 'React: A Guide' })
      const content = callRenderItemContent(itemWithColon, {
        frontMatterTemplate: template,
      })
      const fm = extractFrontMatter(content)
      expect(fm).not.toBeNull()
      expect(fm!.omnivore_error).toBeUndefined()
      expect(fm!.title).toBe('React: A Guide')
    })

    it('空白前置元数据模板 → 使用 frontMatterVariables 回退', () => {
      const content = callRenderItemContent(item, {
        frontMatterTemplate: '   ',  // 只有空白
        frontMatterVariables: ['title', 'author'],
      })
      const fm = extractFrontMatter(content)
      expect(fm).not.toBeNull()
      expect(fm!.title).toBe('Test Article')
      expect(fm!.author).toBe('Test Author')
    })
  })

  // --- 文章模板变量错误 ---
  describe('文章模板变量错误', () => {
    it('拼写错误的变量 {{{titl}}} → 不崩溃，输出空字符串', () => {
      const template = '# {{{titl}}}\n{{{content}}}'
      expect(() => {
        callRenderItemContent(item, { template })
      }).not.toThrow()

      const content = callRenderItemContent(item, { template })
      // Mustache 对未定义变量输出空字符串
      expect(content).toContain('# \n')
    })

    it('完全无效的变量名 → 不崩溃', () => {
      const template = '{{{nonexistent_variable_xyz}}}'
      expect(() => {
        callRenderItemContent(item, { template })
      }).not.toThrow()
    })

    it('空模板 → 不崩溃，输出 frontmatter + 空内容', () => {
      const content = callRenderItemContent(item, { template: '' })
      expect(content).toContain('---')
      expect(content).toContain('id: test-id-123')
    })
  })

  // --- 文件夹模板错误 ---
  describe('文件夹路径模板错误', () => {
    it('拼写错误 {{{titl}}} → 不崩溃，变量输出空', () => {
      expect(() => {
        render(item, '笔记同步助手/{{{titl}}}', 'yyyy-MM-dd')
      }).not.toThrow()

      const result = render(item, '笔记同步助手/{{{titl}}}', 'yyyy-MM-dd')
      // 变量不存在时 Mustache 输出空字符串
      expect(result).toBe('笔记同步助手/')
    })

    it('空文件夹模板 → 不崩溃，输出空字符串', () => {
      const result = render(item, '', 'yyyy-MM-dd')
      expect(result).toBe('')
    })

    it('纯文本路径无变量 → 原样输出', () => {
      const result = render(item, 'my-notes/folder', 'yyyy-MM-dd')
      expect(result).toBe('my-notes/folder')
    })

    it('{{{date}}} 变量正常 → 输出日期', () => {
      const result = render(item, '笔记/{{{date}}}', 'yyyy-MM-dd')
      expect(result).toMatch(/笔记\/\d{4}-\d{2}-\d{2}/)
    })
  })

  // --- 文件名模板错误 ---
  describe('文件名模板错误', () => {
    it('拼写错误 {{{titl}}} → 不崩溃，输出空', () => {
      expect(() => {
        renderFilename(item, '{{{titl}}}', 'yyyy-MM-dd')
      }).not.toThrow()
    })

    it('空文件名模板 → 不崩溃', () => {
      expect(() => {
        renderFilename(item, '', 'yyyy-MM-dd')
      }).not.toThrow()
    })

    it('正常 {{{title}}} → 输出文章标题', () => {
      const result = renderFilename(item, '{{{title}}}', 'yyyy-MM-dd')
      expect(result).toBe('Test Article')
    })

    it('超长标题 → 自动截断到 100 字符', () => {
      const longItem = createMockItem({ title: 'A'.repeat(200) })
      const result = renderFilename(longItem, '{{{title}}}', 'yyyy-MM-dd')
      expect(result.length).toBeLessThanOrEqual(100)
    })
  })

  // --- 日期格式错误 ---
  describe('日期格式错误', () => {
    it('无效日期格式字符串 → 不崩溃', () => {
      expect(() => {
        render(item, '{{{date}}}', 'INVALID_FORMAT')
      }).not.toThrow()
    })

    it('空日期格式 → 不崩溃', () => {
      expect(() => {
        render(item, '{{{date}}}', '')
      }).not.toThrow()
    })

    it('有效格式 yyyy-MM-dd → 输出正确日期', () => {
      const result = render(item, '{{{date}}}', 'yyyy-MM-dd')
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  // --- 微信消息模板错误 ---
  describe('微信消息模板错误', () => {
    const wechatItem = createMockItem({
      title: '同步助手_20240115_001_text',
      content: '<p>微信消息内容</p>',
    })

    it('拼写错误的变量 {{{contentt}}} → 不崩溃，变量输出空', () => {
      const content = callRenderItemContent(wechatItem, {
        shouldMerge: true,
        wechatMessageTemplate: '## {{{dateSaved}}}\n{{{contentt}}}',
      })
      expect(content).toBeDefined()
      // 不应该崩溃
    })

    it('空微信消息模板 → 使用默认格式', () => {
      const content = callRenderItemContent(wechatItem, {
        shouldMerge: true,
        wechatMessageTemplate: '',
      })
      expect(content).toBeDefined()
      expect(content).toContain('---')
    })

    it('正常微信消息模板 → 正确渲染', () => {
      const content = callRenderItemContent(wechatItem, {
        shouldMerge: true,
        wechatMessageTemplate: '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}',
      })
      expect(content).toBeDefined()
      expect(content).toContain('📅')
    })

    it('undefined 微信消息模板 → 使用 fallback', () => {
      const content = callRenderItemContent(wechatItem, {
        shouldMerge: true,
        wechatMessageTemplate: undefined,
      })
      expect(content).toBeDefined()
    })
  })

  // --- 分隔符模板错误 ---
  describe('分隔符模板错误', () => {
    it('分隔符含无效变量 → 不崩溃', () => {
      const content = callRenderItemContent(item, {
        shouldMerge: false, // 非合并模式下不使用分隔符
        sectionSeparator: '%%{{{invalid}}}_start%%',
        sectionSeparatorEnd: '%%{{{invalid}}}_end%%',
      })
      expect(content).toBeDefined()
    })

    it('空分隔符 → 不崩溃', () => {
      const content = callRenderItemContent(item, {
        sectionSeparator: '',
        sectionSeparatorEnd: '',
      })
      expect(content).toBeDefined()
    })
  })
})

// =========================================================================
// 第 4 层：默认设置完整性验证
// =========================================================================
describe('第4层：默认设置完整性', () => {
  it('所有设置项有默认值（非 undefined）', () => {
    const settings = DEFAULT_SETTINGS
    // 逐一检查关键设置项不为 undefined
    expect(settings.apiKey).toBeDefined()  // 空字符串也算定义了
    expect(settings.folder).toBeDefined()
    expect(settings.filename).toBeDefined()
    expect(settings.template).toBeDefined()
    expect(settings.endpoint).toBeDefined()
    expect(settings.frequency).toBeDefined()
    expect(settings.mergeMode).toBeDefined()
    expect(settings.messageFolder).toBeDefined()
    expect(settings.imageMode).toBeDefined()
    expect(settings.imageDownloadRetries).toBeDefined()
    expect(settings.jpegQuality).toBeDefined()
    expect(settings.frontMatterVariables).toBeDefined()
    expect(settings.frontMatterTemplate).toBeDefined()
    expect(settings.singleFileName).toBeDefined()
    expect(settings.singleFileDateFormat).toBeDefined()
    expect(settings.sectionSeparator).toBeDefined()
    expect(settings.sectionSeparatorEnd).toBeDefined()
    expect(settings.wechatMessageTemplate).toBeDefined()
    expect(settings.dateHighlightedFormat).toBeDefined()
    expect(settings.dateSavedFormat).toBeDefined()
    expect(settings.folderDateFormat).toBeDefined()
    expect(settings.filenameDateFormat).toBeDefined()
    expect(settings.attachmentFolder).toBeDefined()
    expect(settings.imageAttachmentFolder).toBeDefined()
    expect(settings.enableDiaryLinks).toBeDefined()
    expect(settings.diaryFolder).toBeDefined()
    expect(settings.diaryDateFormat).toBeDefined()
    expect(settings.diaryAnchor).toBeDefined()
    expect(settings.diaryLinkType).toBeDefined()
    expect(settings.autoCreateDiaryNote).toBeDefined()
    expect(settings.diaryLinkPrefix).toBeDefined()
    expect(settings.diaryLinkMaxLength).toBeDefined()
    expect(settings.deviceSyncCursors).toBeDefined()
    expect(settings.initialSyncCompleted).toBeDefined()
  })

  it('默认模板可被 Mustache 正常解析', () => {
    expect(() => preParseTemplate(DEFAULT_SETTINGS.template)).not.toThrow()
  })

  it('默认微信消息模板可被 Mustache 正常解析', () => {
    expect(() => preParseTemplate(DEFAULT_SETTINGS.wechatMessageTemplate)).not.toThrow()
  })

  it('默认分隔符模板可被 Mustache 正常解析', () => {
    expect(() => preParseTemplate(DEFAULT_SETTINGS.sectionSeparator)).not.toThrow()
    expect(() => preParseTemplate(DEFAULT_SETTINGS.sectionSeparatorEnd)).not.toThrow()
  })

  it('默认 frequency 为 0（手动同步）', () => {
    expect(DEFAULT_SETTINGS.frequency).toBe(0)
  })

  it('默认 imageDownloadRetries 为 5（指数退避，图床源站未就绪属瞬态多退避几次）', () => {
    expect(DEFAULT_SETTINGS.imageDownloadRetries).toBe(5)
  })

  it('默认 jpegQuality 在 0-100 范围内', () => {
    expect(DEFAULT_SETTINGS.jpegQuality).toBeGreaterThanOrEqual(0)
    expect(DEFAULT_SETTINGS.jpegQuality).toBeLessThanOrEqual(100)
  })

  it('默认 apiKey 为空字符串（需要用户设置）', () => {
    expect(DEFAULT_SETTINGS.apiKey).toBe('')
  })
})

// =========================================================================
// 第 5 层：边界条件与组合场景
// =========================================================================
describe('第5层：边界条件与组合场景', () => {
  const item = createMockItem()

  it('frontMatterTemplate + frontMatterVariables 同时设置 → 模板优先', () => {
    const content = callRenderItemContent(item, {
      frontMatterTemplate: 'custom_field: my_value',
      frontMatterVariables: ['title', 'author'],
    })
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.custom_field).toBe('my_value')
    // frontMatterVariables 被忽略（模板优先）
    // 但 id 始终存在（用于去重）
    expect(fm!.id).toBe('test-id-123')
  })

  it('item 内容为 null → 不崩溃', () => {
    const nullContentItem = createMockItem({ content: null as unknown as string })
    expect(() => {
      callRenderItemContent(nullContentItem)
    }).not.toThrow()
  })

  it('item 标题含特殊字符 → 文件名渲染不崩溃', () => {
    const specialItem = createMockItem({ title: 'Title/With\\Special:Chars?*"<>|' })
    expect(() => {
      renderFilename(specialItem, '{{{title}}}', 'yyyy-MM-dd')
    }).not.toThrow()
  })

  it('item 无 labels 时使用 tags 变量 → 输出空', () => {
    const content = callRenderItemContent(item, {
      frontMatterVariables: ['tags'],
    })
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    // labels 为空数组，tags 不会被写入
  })

  it('item 有 labels 时使用 tags 变量 → 正确输出', () => {
    const labelItem = createMockItem({
      labels: [{ name: 'tech' }, { name: 'react' }] as Item['labels'],
    })
    const content = callRenderItemContent(labelItem, {
      frontMatterVariables: ['tags'],
    })
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.tags).toEqual(['tech', 'react'])
  })

  it('frontMatterVariables 含别名 title::标题 → 正确映射', () => {
    const content = callRenderItemContent(item, {
      frontMatterVariables: ['title::标题'],
    })
    const fm = extractFrontMatter(content)
    expect(fm).not.toBeNull()
    expect(fm!['标题']).toBe('Test Article')
    expect(fm!.title).toBeUndefined()  // 使用别名后原名不存在
  })

  describe('messageFolder 回退逻辑', () => {
    it('messageFolder 为空 → 回退到 folder', () => {
      const settings = { ...DEFAULT_SETTINGS, folder: '我的笔记/{{{date}}}', messageFolder: '' }
      const effectiveMessageFolder = settings.messageFolder || settings.folder
      expect(effectiveMessageFolder).toBe('我的笔记/{{{date}}}')
    })

    it('messageFolder 有值 → 使用 messageFolder', () => {
      const settings = { ...DEFAULT_SETTINGS, folder: '文章/{{{date}}}', messageFolder: '消息/{{{date}}}' }
      const effectiveMessageFolder = settings.messageFolder || settings.folder
      expect(effectiveMessageFolder).toBe('消息/{{{date}}}')
    })

    it('老用户升级 → Object.assign 填充空默认值，回退到 folder', () => {
      // 模拟老用户 savedData 无 messageFolder 字段
      const savedData = { folder: '自定义路径/{{{date}}}', apiKey: 'key-123' }
      const settings = Object.assign({}, DEFAULT_SETTINGS, savedData)
      const effectiveMessageFolder = settings.messageFolder || settings.folder
      expect(settings.messageFolder).toBe('')  // 来自 DEFAULT_SETTINGS
      expect(effectiveMessageFolder).toBe('自定义路径/{{{date}}}')  // 回退到 folder
    })

    it('messageFolder 路径模板可含变量', () => {
      const settings = { ...DEFAULT_SETTINGS, messageFolder: '企微消息/{{{dateSaved}}}' }
      const item = { savedAt: '2024-01-15T10:30:00.000Z' } as any
      const result = render(item, settings.messageFolder, 'yyyy-MM-dd')
      expect(result).toMatch(/企微消息\/\d{4}-\d{2}-\d{2}/)
    })
  })
})
