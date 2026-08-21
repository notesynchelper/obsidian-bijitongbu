/**
 * 钉死 metaFromFrontmatter 的 alias 表语义：
 *   - 默认前置元数据模板（settings/index.ts:122）会写 author/source/url/saved
 *     这些短名，而非 author/siteName/originalUrl/dateSaved 长名
 *   - 既要吃短名（用户默认配置），也要吃长名（用户自定义 frontmatter），
 *     还要吃 snake_case 变体
 *   - URL alias 中 url 必须放最后兜底，不能抢占 originalUrl/originalArticleUrl
 *   - 非字符串值（number/boolean/array/object）应被静默拒收
 *   - Date 实例 (Obsidian parseYaml 无引号 ISO 的产物) 应转 ISO 字符串
 */

import { metaFromFrontmatter } from '../src/common/localizerItemMeta'

describe('metaFromFrontmatter alias 表', () => {
  test('默认前置元数据模板 (author/source/url/saved) → 全字段命中', () => {
    const fm = {
      author: 'Alice',
      source: 'example.com',
      url: 'https://example.com/post/1',
      saved: '2026-05-25T10:30:00.000Z',
      tags: ['同步'],
      id: 'note-id',
    }
    const m = metaFromFrontmatter(fm)
    expect(m).toEqual({
      id: 'note-id',
      savedAt: '2026-05-25T10:30:00.000Z',
      siteName: 'example.com',
      originalArticleUrl: 'https://example.com/post/1',
      url: 'https://example.com/post/1',
      author: 'Alice',
      description: undefined,
      publishedAt: undefined,
      readAt: undefined,
      archivedAt: undefined,
      updatedAt: undefined,
    })
  })

  test('长名 (siteName/originalUrl/dateSaved) 也能吃', () => {
    const fm = {
      siteName: 'other.com',
      originalUrl: 'https://other.com/x',
      dateSaved: '2026-05-25T10:00:00.000Z',
      author: 'Bob',
    }
    const m = metaFromFrontmatter(fm)
    expect(m.siteName).toBe('other.com')
    expect(m.originalArticleUrl).toBe('https://other.com/x')
    expect(m.savedAt).toBe('2026-05-25T10:00:00.000Z')
  })

  test('snake_case 变体也能吃', () => {
    const fm = {
      site_name: 'snake.com',
      original_url: 'https://snake.com/p',
      date_saved: '2026-05-25T11:00:00.000Z',
      date_published: '2026-05-20T00:00:00.000Z',
      date_read: '2026-05-25T12:00:00.000Z',
      date_archived: '2026-05-25T13:00:00.000Z',
      updated_at: '2026-05-25T14:00:00.000Z',
    }
    const m = metaFromFrontmatter(fm)
    expect(m.siteName).toBe('snake.com')
    expect(m.originalArticleUrl).toBe('https://snake.com/p')
    expect(m.savedAt).toBe('2026-05-25T11:00:00.000Z')
    expect(m.publishedAt).toBe('2026-05-20T00:00:00.000Z')
    expect(m.readAt).toBe('2026-05-25T12:00:00.000Z')
    expect(m.archivedAt).toBe('2026-05-25T13:00:00.000Z')
    expect(m.updatedAt).toBe('2026-05-25T14:00:00.000Z')
  })

  test('URL alias 顺序：originalUrl 抢在 url 之前', () => {
    const fm = {
      originalUrl: 'https://winner.com/p',
      url: 'https://loser.com/u',
    }
    const m = metaFromFrontmatter(fm)
    expect(m.originalArticleUrl).toBe('https://winner.com/p')
    // url 字段保留单独的兜底值（FILE 类型场景）
    expect(m.url).toBe('https://loser.com/u')
  })

  test('originalArticleUrl 比 originalUrl 更明确，应同样能匹配', () => {
    const fm = {
      originalArticleUrl: 'https://very-explicit.com/p',
      url: 'https://other.com/u',
    }
    const m = metaFromFrontmatter(fm)
    expect(m.originalArticleUrl).toBe('https://very-explicit.com/p')
  })

  test('只有 url、无 originalUrl 时 url 兜底进 originalArticleUrl', () => {
    const fm = { url: 'https://only-url.com/x' }
    const m = metaFromFrontmatter(fm)
    expect(m.originalArticleUrl).toBe('https://only-url.com/x')
    expect(m.url).toBe('https://only-url.com/x')
  })

  test('非字符串值（number/boolean/array/object）被拒收', () => {
    const fm = {
      author: 123,             // number
      source: true,            // boolean
      url: ['a', 'b'],         // array
      saved: { x: 1 },         // object
      id: 0,                   // 0 是 number，应拒收
    }
    const m = metaFromFrontmatter(fm as any)
    expect(m.author).toBeUndefined()
    expect(m.siteName).toBeUndefined()
    expect(m.originalArticleUrl).toBeUndefined()
    expect(m.savedAt).toBeUndefined()
    expect(m.id).toBeUndefined()
  })

  test('空字符串 / 全 whitespace 字符串也被拒收', () => {
    const fm = {
      author: '',
      source: '   ',
      url: '',
    }
    const m = metaFromFrontmatter(fm)
    expect(m.author).toBeUndefined()
    expect(m.siteName).toBeUndefined()
    expect(m.originalArticleUrl).toBeUndefined()
  })

  test('日期字段：Obsidian parseYaml 解出的 Date 对象 → ISO 字符串', () => {
    const fm = {
      saved: new Date('2026-05-25T10:30:00.000Z'),
      date_published: new Date('2026-05-20T00:00:00.000Z'),
    }
    const m = metaFromFrontmatter(fm)
    expect(m.savedAt).toBe('2026-05-25T10:30:00.000Z')
    expect(m.publishedAt).toBe('2026-05-20T00:00:00.000Z')
  })

  test('日期字段：Invalid Date 拒收', () => {
    const fm = { saved: new Date('not-a-date') }
    const m = metaFromFrontmatter(fm)
    expect(m.savedAt).toBeUndefined()
  })

  test('null / undefined frontmatter → 空 meta', () => {
    expect(metaFromFrontmatter(null)).toEqual({})
    expect(metaFromFrontmatter(undefined)).toEqual({})
  })

  test('前后空白被 trim', () => {
    const fm = {
      author: '  Alice  ',
      source: '\texample.com\n',
    }
    const m = metaFromFrontmatter(fm)
    expect(m.author).toBe('Alice')
    expect(m.siteName).toBe('example.com')
  })
})
