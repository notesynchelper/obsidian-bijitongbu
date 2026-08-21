/**
 * 图片 / 附件本地化器生成路径模板时所需的 Item 上下文最小子集。
 *
 * 历史 bug：localizer 的 generateFolderPath 构造一个除 title/savedAt 外全是
 * null 的 stub Item 喂 render()，导致用户在 attachmentFolder 模板里写的
 * {{{siteName}}} {{{author}}} {{{originalUrl}}} {{{publishedAt 系列}}}
 * {{{readAt 系列}}} {{{archivedAt 系列}}} {{{updatedAt 拆解}}} {{{id}}}
 * {{{state}}} 全部渲染为空串或 'unknown'/'INBOX' 占位。修法：
 *
 *   sync 流水线 (FileProcessor / MergeProcessor) 手里有真实 Item，
 *   走 itemToLocalizerMeta() 抽出本接口字段，沿 enqueueFile 喂到任务，
 *   generateFolderPath(file, task.meta) 用之。
 *
 *   relocalize（右键重新本地化）手里没有 Item，走 metaFromFrontmatter()
 *   从笔记 frontmatter 按 alias 表回填。
 */

import { Item } from '@omnivore-app/api'
import { isWeChatMessage } from '../settings/template'

export interface LocalizerItemMeta {
  // —— 标识 & URL 族 ——
  id?: string
  slug?: string
  siteName?: string | null
  originalArticleUrl?: string | null
  /** url 字段：FILE 类型常见无 originalArticleUrl，但 url 有值。siteName/originalUrl 兜底用 */
  url?: string
  // —— 内容元数据 ——
  author?: string | null
  description?: string | null
  image?: string | null
  pageType?: Item['pageType']
  wordsCount?: number | null
  // —— 时间族（全部 ISO 字符串） ——
  savedAt?: string
  publishedAt?: string | null
  readAt?: string | null
  archivedAt?: string | null
  updatedAt?: string | null
  // —— 状态族 ——
  isArchived?: boolean
  readingProgressPercent?: number
  /**
   * 是否为企微消息（按真实 Item.title 的「同步助手_」前缀判定）。
   * localizer 的 generateFolderPath 用 file.basename 当 title，若用户改了
   * singleFileName 文件名模板（去掉「同步助手_」前缀），从 basename 反推会误判；
   * 故 sync 管线在此带上「用真实标题算好的」结果，render 的 {{#isMessage}} 分流
   * 优先用它，不再依赖渲染后的文件名。relocalize 无真实 Item 时留空，回退反推。
   */
  isMessage?: boolean
}

/** sync 流水线手里的真实 Item → meta，全字段填满。 */
export function itemToLocalizerMeta(item: Item): LocalizerItemMeta {
  return {
    id: item.id,
    slug: item.slug,
    siteName: item.siteName,
    originalArticleUrl: item.originalArticleUrl,
    url: item.url,
    author: item.author,
    description: item.description,
    image: item.image,
    pageType: item.pageType,
    wordsCount: item.wordsCount,
    savedAt: item.savedAt ?? undefined,
    publishedAt: item.publishedAt,
    readAt: item.readAt,
    archivedAt: item.archivedAt,
    updatedAt: item.updatedAt,
    isArchived: item.isArchived,
    readingProgressPercent: item.readingProgressPercent,
    // 用真实标题判定，避免 localizer 从 file.basename 反推时被自定义文件名模板带偏
    isMessage: isWeChatMessage(item),
  }
}

/**
 * 从 Obsidian frontmatter 提取字符串。拒收 number / boolean / array / object /
 * Date（Date 不是路径段会用到的形态；Obsidian 会把无引号的 ISO 直接 parse 成
 * Date 对象，这种情况由 pickDateString 处理）。
 */
function pickString(
  fm: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = fm[k]
    if (typeof v === 'string') {
      const trimmed = v.trim()
      if (trimmed) return trimmed
    }
  }
  return undefined
}

/**
 * frontmatter 时间字段：string ISO 或 Date 都能吃；返回标准 ISO 字符串。
 * （Obsidian parseYaml 对无引号 ISO 会产出 Date，对带引号字符串保留 string。）
 */
function pickDateString(
  fm: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = fm[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString()
  }
  return undefined
}

/**
 * 从笔记 frontmatter 重建 localizer meta（右键"重新本地化"用）。
 *
 * 默认前置元数据模板（settings/index.ts:122）是
 *   `author: {{{author}}}\nsource: {{{siteName}}}\nurl: {{{originalUrl}}}\nsaved: {{{dateSaved}}}\n...`
 * 所以 frontmatter key 是 author / source / url / saved —— 不是
 * siteName / originalUrl / dateSaved。这里 alias 表覆盖：
 *   - 默认模板字段（短名）
 *   - 直接用 Item 字段名（长名）
 *   - 部分 snake_case 变体
 * 顺序按"更明确的语义优先"，url 兜底放最后避免抢占 originalUrl。
 */
export function metaFromFrontmatter(
  fm: Record<string, unknown> | undefined | null,
): LocalizerItemMeta {
  if (!fm) return {}
  return {
    id: pickString(fm, 'id'),
    savedAt: pickDateString(fm, 'saved', 'dateSaved', 'date_saved'),
    siteName: pickString(fm, 'source', 'siteName', 'site_name'),
    // 注意：url 放最后兜底，否则会抢占更明确的 originalUrl/originalArticleUrl
    originalArticleUrl: pickString(
      fm,
      'originalUrl',
      'originalArticleUrl',
      'original_url',
      'url',
    ),
    url: pickString(fm, 'url'),
    author: pickString(fm, 'author'),
    description: pickString(fm, 'description'),
    publishedAt: pickDateString(fm, 'datePublished', 'date_published', 'published'),
    readAt: pickDateString(fm, 'dateRead', 'date_read', 'read'),
    archivedAt: pickDateString(fm, 'dateArchived', 'date_archived', 'archived'),
    updatedAt: pickDateString(fm, 'updatedAt', 'updated_at', 'updated'),
    // pageType / image / wordsCount / state 默认不入 frontmatter，缺即缺
  }
}
