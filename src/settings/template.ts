import { Item, ItemType } from '@omnivore-app/api'
import Mustache from 'mustache'
import { Notice, parseYaml, stringifyYaml } from 'obsidian'
import {
  compareHighlightsInFile,
  formatDate,
  formatHighlightQuote,
  getHighlightLocation,
  removeFrontMatterFromContent,
  siteNameFromUrl,
  snakeToCamelCase,
  truncateWithOmission,
} from '../util'
import { HighlightManagerId } from '.'
import { logError } from '../logger'
import { bloomFromIds } from '../compressIds'
import { maskTemplaterTags } from '../sync/templaterRelay'

type FunctionMap = {
  [key: string]: () => (
    text: string,
    render: (text: string) => string,
  ) => string
}

/**
 * YAML 特殊字符正则：冒号+空格、#注释、流式标记[]{}、引号、换行、
 * 以及 YAML 会自动转换类型的值（布尔、null）
 */
const YAML_NEEDS_QUOTING = /[:[\]{}#&*!|>'"%@`\n\r]/

const YAML_RESERVED_WORDS = new Set([
  'true', 'false', 'yes', 'no', 'on', 'off', 'null', '~',
  'TRUE', 'FALSE', 'YES', 'NO', 'ON', 'OFF', 'NULL',
  'True', 'False', 'Yes', 'No', 'On', 'Off', 'Null',
])

/**
 * 对 Mustache 渲染后的 YAML 文本进行安全化处理：
 * 逐行检查 key: value 格式，对未加引号且含特殊字符的值自动添加双引号
 */
export const sanitizeRenderedYaml = (rendered: string): string => {
  return rendered
    .split('\n')
    .map((line) => {
      // 匹配 "key: value" 格式（key 不含特殊字符）
      const match = line.match(/^(\s*[\w][\w.\- ]*\s*:)\s*(.+)$/)
      if (!match) return line
      const [, keyPart, valuePart] = match
      const trimmed = valuePart.trim()

      // 空值不处理
      if (!trimmed) return line

      // 已经用引号包裹的不处理
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ) {
        return line
      }

      // 检查是否需要加引号
      if (YAML_NEEDS_QUOTING.test(trimmed) || YAML_RESERVED_WORDS.has(trimmed)) {
        const escaped = trimmed
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
        return `${keyPart} "${escaped}"`
      }

      return line
    })
    .join('\n')
}

/**
 * 前置模板合法性校验结果。供设置面板实时提示使用。
 *  - valid: false 表示该模板在同步时会触发 omnivore_error，用户字段会丢失
 *  - sanitized: true 表示首次 YAML 解析失败，走了 sanitize 兜底成功
 *    （此时 valid=true，但建议用户手动加引号）
 */
export interface FrontMatterValidation {
  valid: boolean
  error: string | null
  sanitized: boolean
}

/** 构造一个覆盖常用字段的小样 view（延迟构造避开 functionMap 声明顺序问题） */
const buildValidationView = () => ({
  id: 'preview-id',
  title: 'Sample Title',
  author: 'Sample Author',
  siteName: 'example.com',
  originalUrl: 'https://example.com/article',
  omnivoreUrl: 'https://omnivore.app/me/sample',
  description: 'Sample description',
  content: 'Sample content',
  note: '',
  image: 'https://example.com/cover.jpg',
  fileAttachment: 'attachments/sample.pdf',
  dateSaved: '2024-01-15',
  datePublished: '2024-01-10',
  dateRead: '2024-01-16',
  dateArchived: '',
  updatedAt: '2024-01-15T12:00:00Z',
  yearSaved: '2024', monthSaved: '01', daySaved: '15',
  yearPublished: '2024', monthPublished: '01', dayPublished: '10',
  yearRead: '2024', monthRead: '01', dayRead: '16',
  yearArchived: '', monthArchived: '', dayArchived: '',
  yearUpdated: '2024', monthUpdated: '01', dayUpdated: '15',
  type: 'ARTICLE',
  state: 'COMPLETED',
  wordsCount: 100,
  readLength: 1,
  labels: [{ name: 'sample' }],
  highlights: [],
  ...functionMap,
})

/**
 * 校验前置元数据模板能否被 YAML 正常解析。用于设置面板实时提示。
 * 与 renderItemContent 的 front matter 分支保持同样的流水线:
 *   Mustache.render → parseYaml → sanitize 兜底 → 失败
 */
export const validateFrontMatterTemplate = (
  template: string,
): FrontMatterValidation => {
  if (!template || !template.trim()) {
    return { valid: true, error: null, sanitized: false }
  }
  let rendered = ''
  try {
    rendered = Mustache.render(template, buildValidationView())
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { valid: false, error: `Mustache 渲染失败: ${msg}`, sanitized: false }
  }
  if (!rendered.trim()) {
    return { valid: true, error: null, sanitized: false }
  }
  try {
    const parsed = parseYaml(rendered) as unknown
    if (parsed === null || parsed === undefined) {
      return { valid: true, error: null, sanitized: false }
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        valid: false,
        error: 'YAML 解析结果不是对象（插件会忽略所有字段）',
        sanitized: false,
      }
    }
    return { valid: true, error: null, sanitized: false }
  } catch {
    try {
      parseYaml(sanitizeRenderedYaml(rendered))
      return { valid: true, error: null, sanitized: true }
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2)
      return { valid: false, error: `YAML 解析失败: ${msg}`, sanitized: false }
    }
  }
}

/** 旧版默认模板，仅用于迁移比对 */
export const OLD_DEFAULT_TEMPLATE = `# {{{title}}}
#笔记同步助手
## 来源
[原文链接]({{{originalUrl}}})
## 正文
{{{content}}}`

export const DEFAULT_TEMPLATE = `{{{content}}}`

export interface LabelView {
  name: string
}

export interface HighlightView {
  text: string
  highlightUrl: string
  highlightID: string
  dateHighlighted?: string
  note?: string
  labels?: LabelView[]
  color: string
  positionPercent: number
  positionAnchorIndex: number
}

export type ArticleView =
  | {
      id: string
      title: string
      omnivoreUrl: string
      siteName: string
      originalUrl?: string
      author: string
      labels?: LabelView[]
      dateSaved: string
      highlights: HighlightView[]
      content?: string
      datePublished?: string
      fileAttachment?: string
      description?: string
      note?: string
      type: ItemType
      /** 是否为企微消息；与 View.isMessage 同源，供正文模板按内容类型分支 */
      isMessage: boolean
      dateRead?: string
      wordsCount?: number
      readLength?: number
      state: string
      dateArchived?: string
      image?: string
      updatedAt?: string
      yearSaved: string
      monthSaved: string
      daySaved: string
      yearPublished?: string
      monthPublished?: string
      dayPublished?: string
      yearRead?: string
      monthRead?: string
      dayRead?: string
      yearArchived?: string
      monthArchived?: string
      dayArchived?: string
      yearUpdated?: string
      monthUpdated?: string
      dayUpdated?: string
    }
  | FunctionMap

/**
 * 文件夹 / 文件名 / 附件夹 / 图片夹 / 消息夹模板的 render view 类型。
 *
 * 包含 {@link DateView} 的全部字段（date/dateSaved + 全系列 year/month/day
 * 拆分），这样文件夹模板里可以直接写 `{{{yearSaved}}}/{{{monthSaved}}}`
 * 之类的变量 —— 这是 TEMPLATE-VARIABLES.md 明确承诺的能力，但旧版 view
 * 漏了这些字段，Mustache 渲染成空串导致路径塌陷。
 *
 * 另外补了 dateArchived 的格式化版（renderItemContent 里 dateArchived 是
 * 原始 ISO；这里是通过 dateFormat 格式化过的字符串，方便用作文件夹名）。
 */
export type View =
  | ({
      id: string
      title: string
      omnivoreUrl: string
      siteName: string
      originalUrl: string
      author: string
      type: ItemType
      state: string
      /**
       * 是否为企微消息（= isWeChatMessage(item)，按标题前缀「同步助手_」判定）。
       * 让路径/文件名模板可用 Mustache section 把文章与消息分流到不同文件夹，例如：
       *   笔记同步助手/{{#isMessage}}messages{{/isMessage}}{{^isMessage}}articles{{/isMessage}}/images
       */
      isMessage: boolean
      /** 格式化后的归档时间；与 ArticleView.dateArchived（原始 ISO）故意不同 */
      dateArchived?: string
    } & DateView)
  | FunctionMap

enum ItemState {
  Inbox = 'INBOX',
  Reading = 'READING',
  Completed = 'COMPLETED',
  Archived = 'ARCHIVED',
}

const getItemState = (item: Item): string => {
  if (item.isArchived) {
    return ItemState.Archived
  }
  if (item.readingProgressPercent > 0) {
    return item.readingProgressPercent === 100
      ? ItemState.Completed
      : ItemState.Reading
  }

  return ItemState.Inbox
}

function lowerCase() {
  return function (text: string, render: (text: string) => string) {
    return render(text).toLowerCase()
  }
}

function upperCase() {
  return function (text: string, render: (text: string) => string) {
    return render(text).toUpperCase()
  }
}

function upperCaseFirst() {
  return function (text: string, render: (text: string) => string) {
    const str = render(text)
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
  }
}

function formatDateFunc() {
  return function (text: string, render: (text: string) => string) {
    // get the date and format from the text
    // expected: {{dateSaved}},yyyy-MM-dd (comma-separated)
    if (!text.includes(',')) {
      const hint = text.trim()
      const msg = `formatDate 模板格式错误：缺少逗号分隔符。当前写法：{{#formatDate}}${hint}{{/formatDate}}，正确写法示例：{{#formatDate}}{{dateSaved}},yyyy-MM-dd{{/formatDate}}`
      new Notice(msg, 10000)
      logError(msg)
      return ''
    }
    const [dateVariable, format] = text.split(',', 2)
    const date = render(dateVariable)
    if (!date) {
      return ''
    }
    // format the date
    return formatDate(date, format)
  }
}

/**
 * mapValue：把一个变量的渲染值按「规则表」映射成另一个值，给属性（frontmatter）
 * 模板做「平台名 → 业务分类」这类转换用。Mustache 原生没有 if/replace/contains，
 * 这个 helper 用最小语法补上「精确映射 + 通配(contains) + 兜底」。
 *
 * 写法：
 *   {{#mapValue}}<取值表达式>|<规则表>{{/mapValue}}
 *   例：{{#mapValue}}{{{siteName}}}|抖音=视频转图文,*播客*=播客整理,*=其他{{/mapValue}}
 *
 * - <取值表达式> 先经 Mustache 渲染（所以能写 {{{siteName}}}），渲染后首尾空白被裁剪。
 * - <规则表> 是逗号分隔的 `pattern=result`：
 *     · 精确：  抖音=视频转图文       —— value 完全等于「抖音」时命中
 *     · 通配：  *播客*=播客整理        —— value 含「播客」时命中（contains）
 *     · 兜底：  *=其他                —— 上面都不命中时用它
 * - 命中优先级（与规则书写顺序无关）：精确 > 通配 > 兜底 > 原值。
 *
 * 容错：
 * - 没有 `|` 分隔符 → 直接返回渲染后的取值（当成「没配规则」处理，不抛错）。
 * - 局限（已知，平台名/分类名场景够用）：pattern 不能含 `=`，pattern/result 不能含
 *   `,`（都是分隔符）；result 可含 `=`（只按首个 `=` 切分）。通配仅支持 `*xxx*`
 *   两端星号的 contains，不支持前缀/后缀/正则。
 */
function mapValueFunc() {
  return function (text: string, render: (text: string) => string) {
    // 先在「模板原文」上按首个 `|` 切语法分隔符，再分别渲染取值表达式与规则表。
    // 这样取值渲染后即便含 `|`（如 title="Foo | Bar"）也不会被误当分隔符截断。
    const sepIdx = text.indexOf('|')
    if (sepIdx === -1) {
      // 没配规则，原样返回渲染后的取值
      return render(text).trim()
    }
    const value = render(text.slice(0, sepIdx)).trim()
    const rulesStr = render(text.slice(sepIdx + 1))

    const wildcardRules: Array<{ needle: string; result: string }> = []
    let defaultResult: string | undefined

    for (const rawRule of rulesStr.split(',')) {
      const rule = rawRule.trim()
      if (!rule) {
        continue
      }
      const eq = rule.indexOf('=')
      if (eq === -1) {
        // 没有 `=` 的项无意义，跳过
        continue
      }
      const pattern = rule.slice(0, eq).trim()
      const result = rule.slice(eq + 1).trim()
      if (pattern === '*') {
        // 兜底（最后才用，不抢占精确/通配）
        defaultResult = result
      } else if (
        pattern.length >= 2 &&
        pattern.startsWith('*') &&
        pattern.endsWith('*')
      ) {
        // 通配 *xxx* → contains（先收集，精确没命中时再按顺序判定）
        wildcardRules.push({ needle: pattern.slice(1, -1), result })
      } else if (pattern === value) {
        // 精确命中：立即返回 → 天然优先于通配/兜底，且与书写顺序无关
        return result
      }
    }

    // 精确未命中 → 按书写顺序找第一个 contains 命中的通配规则
    for (const w of wildcardRules) {
      if (w.needle && value.includes(w.needle)) {
        return w.result
      }
    }

    // 都没命中 → 兜底（若配了），否则原样返回取值
    return defaultResult !== undefined ? defaultResult : value
  }
}

const functionMap: FunctionMap = {
  lowerCase,
  upperCase,
  upperCaseFirst,
  formatDate: formatDateFunc,
  mapValue: mapValueFunc,
}

/**
 * 共享的「日期 + 日期拆解」view 字段集合。
 *
 * 所有 render 入口（文件夹、文件名、附件夹、图片夹、消息夹，以及正文/前置
 * 元数据）都经过 {@link buildDateView} 拿到一致的变量集，避免两边手写 new
 * Date().getXxx() 而遗漏字段。
 *
 * 说明：
 * - date 是 dateSaved 的别名，保留历史文档承诺。
 * - dateArchived / dateUpdated 不在此接口里，由各调用方自行决定如何暴露
 *   （render 把它们格式化后给文件夹模板；renderItemContent 给出的是原始
 *    ISO 串，因为前置元数据通常需要机器可解析的日期）。
 * - year/month/day 拆分字段使用本地时区 4/2/2 位补零，不受 dateFormat 参数
 *   影响；这正是用户在文件夹路径里写 `{{{yearSaved}}}/{{{monthSaved}}}`
 *   时期望的行为。
 */
export interface DateView {
  date: string
  dateSaved: string
  datePublished?: string
  dateRead?: string
  yearSaved: string
  monthSaved: string
  daySaved: string
  yearPublished?: string
  monthPublished?: string
  dayPublished?: string
  yearArchived?: string
  monthArchived?: string
  dayArchived?: string
  yearRead?: string
  monthRead?: string
  dayRead?: string
  yearUpdated?: string
  monthUpdated?: string
  dayUpdated?: string
}

/** 从 ISO 字符串提取年/月/日（本地时区，两位补零）；传 null 得到三个 undefined */
function splitDateParts(
  iso: string | null | undefined,
): { y?: string; m?: string; d?: string } {
  if (!iso) return {}
  const dt = new Date(iso)
  return {
    y: dt.getFullYear().toString(),
    m: (dt.getMonth() + 1).toString().padStart(2, '0'),
    d: dt.getDate().toString().padStart(2, '0'),
  }
}

/**
 * 统一构造日期相关 view 字段。两个 render 入口共享。
 *
 * dateFormat 参数仅作用于整串 date/dateSaved/datePublished/dateRead 的格式化；
 * year/month/day 部分始终是本地时区 4/2/2 位补零。
 */
export function buildDateView(item: Item, dateFormat: string): DateView {
  const dateSaved = formatDate(item.savedAt, dateFormat)
  const datePublished = item.publishedAt
    ? formatDate(item.publishedAt, dateFormat).trim()
    : undefined
  const dateRead = item.readAt
    ? formatDate(item.readAt, dateFormat).trim()
    : undefined

  const saved = splitDateParts(item.savedAt)
  const published = splitDateParts(item.publishedAt)
  const archived = splitDateParts(item.archivedAt)
  const read = splitDateParts(item.readAt)
  const updated = splitDateParts(item.updatedAt)

  return {
    date: dateSaved,
    dateSaved,
    datePublished,
    dateRead,
    // savedAt 在 Item 上是必填字段，拆解结果一定有值
    yearSaved: saved.y as string,
    monthSaved: saved.m as string,
    daySaved: saved.d as string,
    yearPublished: published.y,
    monthPublished: published.m,
    dayPublished: published.d,
    yearArchived: archived.y,
    monthArchived: archived.m,
    dayArchived: archived.d,
    yearRead: read.y,
    monthRead: read.m,
    dayRead: read.d,
    yearUpdated: updated.y,
    monthUpdated: updated.m,
    dayUpdated: updated.d,
  }
}

const getOmnivoreUrl = (item: Item) => {
  return `https://omnivore.app/me/${item.slug}`
}

export const renderFilename = (
  item: Item,
  filename: string,
  dateFormat: string,
) => {
  const renderedFilename = render(item, filename, dateFormat)

  // truncate the filename to 100 characters
  return truncateWithOmission(renderedFilename, 100)
}

export const renderLabels = (labels?: LabelView[]) => {
  return labels?.map((l) => ({
    // replace spaces with underscores because Obsidian doesn't allow spaces in tags
    name: l.name.replaceAll(' ', '_'),
  }))
}

export const renderItemContent = (
  item: Item,
  template: string,
  highlightOrder: string,
  highlightManagerId: HighlightManagerId | undefined,
  dateHighlightedFormat: string,
  dateSavedFormat: string,
  shouldMergeIntoSingleFile: boolean,
  frontMatterVariables: string[],
  frontMatterTemplate: string,
  sectionSeparator: string,
  sectionSeparatorEnd: string,
  fileAttachment?: string,
  wechatMessageTemplate?: string,
  // 「笔记属性不含 id」模式：frontmatter 不写强制 id、合并模式也不写 syncedIds，
  // 去重完全交给最新同步游标（见 sync/cursorDedupe.ts）
  omitFrontmatterId = false,
): string => {
  // 🆕 企微消息特殊处理：直接使用简洁模板，不添加分隔符
  if (shouldMergeIntoSingleFile && isWeChatMessage(item)) {
    const dateSaved = formatDate(item.savedAt, dateSavedFormat)
    const simpleContent = wechatMessageTemplate
      ? renderWeChatMessageSimple(item, dateSavedFormat, wechatMessageTemplate)
      : `📅 ${dateSaved}\n\n${item.content || ''}`

    // 创建简单的Front Matter
    const frontMatter: { [id: string]: unknown } = {
      id: item.id,
    }

    const frontMatterYaml = stringifyYaml({
      syncedIds: bloomFromIds([frontMatter.id as string])
    })
    const frontMatterStr = `---\n${frontMatterYaml}---`

    return `${frontMatterStr}\n\n${simpleContent}`
  }

  // Templater 掩码：模板里未被接力渲染的 <% ... %> 标签（未装 Templater /
  // 接力失败 / <%* 执行块）必须原样落盘，但 Mustache 会吃掉表达式里的 {{...}}。
  // 先把标签换成惰性占位符，Mustache 渲染完在最终返回值上还原。
  const templateMask = maskTemplaterTags(template)
  const safeTemplate = templateMask.text

  // filter out notes and redactions
  const itemHighlights =
    item.highlights?.filter((h) => h.type === 'HIGHLIGHT') || []
  // sort highlights by location if selected in options
  if (highlightOrder === 'LOCATION') {
    itemHighlights.sort((a, b) => {
      try {
        if (item.pageType === 'FILE') {
          // sort by location in file
          return compareHighlightsInFile(a, b)
        }
        // for web page, sort by location in the page
        return getHighlightLocation(a.patch) - getHighlightLocation(b.patch)
      } catch (e) {
        logError(e)
        return compareHighlightsInFile(a, b)
      }
    })
  }
  const highlights: HighlightView[] = itemHighlights.map((highlight) => {
    const highlightColor = highlight.color ?? 'yellow'
    const highlightRenderOption = highlightManagerId
      ? {
          highlightColor: highlightColor,
          highlightManagerId: highlightManagerId,
        }
      : null
    return {
      text: formatHighlightQuote(
        highlight.quote,
        safeTemplate,
        highlightRenderOption,
      ),
      highlightUrl: `https://omnivore.app/me/${item.slug}#${highlight.id}`,
      highlightID: highlight.id.slice(0, 8),
      dateHighlighted: highlight.updatedAt
        ? formatDate(highlight.updatedAt, dateHighlightedFormat)
        : undefined,
      note: highlight.annotation ?? undefined,
      labels: renderLabels(highlight.labels || undefined),
      color: highlightColor,
      positionPercent: highlight.highlightPositionPercent || 0,
      positionAnchorIndex: highlight.highlightPositionAnchorIndex
        ? highlight.highlightPositionAnchorIndex + 1
        : 0, // PDF page numbers start at 1
    }
  })
  // 日期字段统一走共享 helper（render() 也用同一个，保证两条渲染路径的日期变量
  // 集合一致；历史上这里和 render() 各自手写 getXxx() 且 View 漏字段，导致
  // folder 模板里的 {{{yearSaved}}} 族变量全部渲染为空串）
  const dateView = buildDateView(item, dateSavedFormat)
  const siteName =
    item.siteName || siteNameFromUrl(item.originalArticleUrl || item.url)
  const articleNote = item.highlights?.find((h) => h.type === 'NOTE')
  const wordsCount = item.wordsCount
  const readLength = wordsCount
    ? Math.round(Math.max(1, wordsCount / 235))
    : undefined
  const articleView: ArticleView = {
    id: item.id,
    title: item.title,
    omnivoreUrl: `https://omnivore.app/me/${item.slug}`,
    siteName,
    originalUrl: item.originalArticleUrl || item.url,
    author: item.author || 'unknown',
    labels: renderLabels(item.labels || undefined),
    highlights,
    content: item.content || undefined,
    fileAttachment,
    description: item.description || undefined,
    note: articleNote?.annotation ?? undefined,
    type: item.pageType,
    isMessage: isWeChatMessage(item),
    wordsCount: item.wordsCount || undefined,
    readLength,
    state: getItemState(item),
    image: item.image || undefined,
    // dateSaved / datePublished / dateRead + 全系列 year/month/day 拆解
    ...dateView,
    // 下面两个字段故意保持原始 ISO（而非 dateView 的格式化版）：
    // 前置元数据常被下游工具按 ISO 解析，格式化会破坏机器可读性
    dateArchived: item.archivedAt || undefined,
    updatedAt: item.updatedAt || undefined,
    ...functionMap,
  }

  let frontMatter: { [id: string]: unknown } = omitFrontmatterId
    ? {} // 无 id 模式：去重靠最新同步游标，不再强制写 id
    : {
        id: item.id, // id is required for deduplication
      }

  // if the front matter template is set, use it
  if (frontMatterTemplate && frontMatterTemplate.trim()) {
    // Front matter 是 YAML 格式，字符串值中的换行会破坏 key: value 结构
    // 在 Mustache 渲染前将字符串值中的换行替换为空格
    const frontMatterArticleView: Record<string, unknown> = {}
    for (const key of Object.keys(articleView)) {
      const value = (articleView as Record<string, unknown>)[key]
      frontMatterArticleView[key] =
        typeof value === 'string'
          ? value.replace(/[\n\r]+/g, ' ').trim()
          : value
    }
    let frontMatterTemplateRendered: string
    try {
      frontMatterTemplateRendered = Mustache.render(
        frontMatterTemplate,
        frontMatterArticleView,
      )
    } catch (renderError) {
      const errorMsg = renderError instanceof Error ? renderError.message : String(renderError)
      logError('Error rendering front matter template', renderError)
      new Notice(`前置模板渲染失败: ${errorMsg}`, 8000)
      frontMatter = {
        ...frontMatter,
        omnivore_error:
          `Front matter template render error: ${errorMsg}`,
      }
      frontMatterTemplateRendered = ''
    }
    let frontMatterParsed: Record<string, unknown> | null = null
    if (frontMatterTemplateRendered) {
      try {
        // parse the front matter template as yaml
        frontMatterParsed = parseYaml(frontMatterTemplateRendered) as Record<string, unknown> | null
      } catch {
        // YAML 解析失败时，尝试对值自动加引号后重新解析
        try {
          const sanitized = sanitizeRenderedYaml(frontMatterTemplateRendered)
          frontMatterParsed = parseYaml(sanitized) as Record<string, unknown> | null
        } catch (error) {
          logError('Error parsing front matter template', error)
          frontMatter = {
            ...frontMatter,
            omnivore_error:
              'There was an error parsing the front matter template. See console for details.',
          }
        }
      }
    }
    if (frontMatterParsed) {
      frontMatter = {
        ...frontMatterParsed,
        ...frontMatter,
      }
    }
  } else {
    // otherwise, use the front matter variables
    for (const item of frontMatterVariables) {
      // split the item into variable and alias
      const aliasedVariables = item.split('::')
      const variable = aliasedVariables[0]
      // we use snake case for variables in the front matter
      const articleVariable = snakeToCamelCase(variable)
      // use alias if available, otherwise use variable
      const key = aliasedVariables[1] || variable
      if (
        variable === 'tags' &&
        articleView.labels &&
        articleView.labels.length > 0
      ) {
        // tags are handled separately
        // use label names as tags
        frontMatter[key] = articleView.labels.map((l) => l.name)
        continue
      }

      const value = (articleView as Record<string, unknown>)[articleVariable]
      if (value) {
        // if variable is in article, use it
        frontMatter[key] = value
      }
    }
  }

  // Build content string based on template
  const content = Mustache.render(safeTemplate, articleView)
  let contentWithoutFrontMatter = removeFrontMatterFromContent(content)
  let frontMatterYaml = stringifyYaml(frontMatter)
  if (shouldMergeIntoSingleFile) {
    // 如果用户配置了分隔符,则使用分隔符包裹内容
    if (sectionSeparator && sectionSeparatorEnd) {
      // 使用Mustache渲染分隔符模板,支持变量(如{{{dateSaved}}})
      const renderedStart = Mustache.render(sectionSeparator, articleView)
      const renderedEnd = Mustache.render(sectionSeparatorEnd, articleView)
      contentWithoutFrontMatter = `${renderedStart}\n${contentWithoutFrontMatter}\n${renderedEnd}`
    }

    // 合并模式：保留完整文章元数据 + 追加 syncedIds（去重用）。
    // 历史上这里直接丢弃 frontMatter、只写 { syncedIds }，导致 ALL 合并模式下
    // 每篇文章（即使各自独占一个文件）的属性都被收成一行 base64，title/author/
    // source/url 全没（用户工单 o56E764NDxeqPyRDgjUpVFUzqgjA）。
    // 现在改为「不丢元数据」：把完整 frontMatter 一起带给 MergeProcessor，由它决定
    // 单篇文件保留到文件级 frontmatter、多篇文件下沉到各 section（见 MergeProcessor.ts）。
    // 无 id 模式：syncedIds 也不写（去重靠游标），Bloom 一律用 item.id 而非
    // frontMatter.id（后者在无 id 模式下不存在）。
    frontMatterYaml = stringifyYaml(
      omitFrontmatterId
        ? { ...frontMatter }
        : {
            ...frontMatter,
            syncedIds: bloomFromIds([item.id]),
          },
    )
  }

  // 无 id 模式 + 用户清空了前置模板/变量 → frontMatter 可能为空对象，
  // stringifyYaml({}) 会输出字面量 "{}"，落盘成 `---\n{}\n---` 噪音；归一成空 frontmatter。
  if (frontMatterYaml.trim() === '{}') {
    frontMatterYaml = ''
  }
  const frontMatterStr = `---\n${frontMatterYaml}---`

  // Templater 占位符还原（见函数开头 templateMask 注释）
  return templateMask.restore(`${frontMatterStr}\n\n${contentWithoutFrontMatter}`)
}

// 渲染「路径」（文件夹）时需要把这些自由文本变量值里的 `/` `\` 折成 `-`，避免
// 单个变量（典型：title=URL、或标题本来就含 `/`）被 Obsidian 当成目录分隔符炸成
// 多级文件夹。日期变量【不在此列】——folderDateFormat 用 `yyyy/MM/dd` 时的 `/`
// 是用户有意的目录层级，必须保留。
const PATH_FREE_TEXT_FIELDS = [
  'title',
  'author',
  'siteName',
  'description',
  'originalUrl',
  'omnivoreUrl',
] as const

const collapsePathSeparators = (v: unknown): unknown =>
  typeof v === 'string' ? v.replace(/[/\\]+/g, '-') : v

export const render = (
  item: Item,
  template: string,
  dateFormat: string,
  opts: { pathSafe?: boolean; isMessage?: boolean } = {},
) => {
  // dateArchived 在文件夹/文件名模板里应当是格式化后的字符串（方便做目录段）；
  // renderItemContent 里则保持原始 ISO（dateView 不覆盖 item.archivedAt）。
  const dateArchived = item.archivedAt
    ? formatDate(item.archivedAt, dateFormat).trim()
    : undefined
  const view: View = {
    ...item,
    siteName:
      item.siteName || siteNameFromUrl(item.originalArticleUrl || item.url),
    author: item.author || 'unknown',
    omnivoreUrl: getOmnivoreUrl(item),
    originalUrl: item.originalArticleUrl || item.url,
    type: item.pageType,
    state: getItemState(item),
    // 企微消息标记：让路径/文件名模板能按 {{#isMessage}}/{{^isMessage}} 分流。
    // 优先用调用方（localizer）按真实标题算好的 opts.isMessage；缺省才从当前
    // item.title 反推（item.title 在 localizer 路径下是 file.basename，可能被
    // 自定义文件名模板带偏，故 sync 管线显式传 opts.isMessage 兜准）。
    isMessage: opts.isMessage ?? isWeChatMessage(item),
    // date / dateSaved / datePublished / dateRead + 全系列 year/month/day 拆解
    ...buildDateView(item, dateFormat),
    dateArchived,
    ...functionMap,
  }
  if (opts.pathSafe) {
    // 只动「值」不动模板：模板里作者手写的字面 `/` 仍生成目录层级。
    const v = view as unknown as Record<string, unknown>
    for (const k of PATH_FREE_TEXT_FIELDS) {
      if (typeof v[k] === 'string') v[k] = collapsePathSeparators(v[k])
    }
    if (Array.isArray(v.labels)) {
      v.labels = (v.labels as Array<{ name?: unknown }>).map((l) =>
        l && typeof l.name === 'string'
          ? { ...l, name: collapsePathSeparators(l.name) }
          : l,
      )
    }
  }
  return Mustache.render(template, view)
}

export const preParseTemplate = (template: string) => {
  return Mustache.parse(template)
}

/**
 * 检测是否为企微消息
 * 标题格式: 同步助手_yyyyMMdd_xxx_类型
 */
export const isWeChatMessage = (item: Item): boolean => {
  // 防御：render() 现在（注入 isMessage 后）会对路径/文件名模板的 stub item 调用本函数，
  // 这类 item 的 title 可能缺失/非字符串，不能直接 .startsWith 否则 render 整体抛错。
  return typeof item.title === 'string' && item.title.startsWith('同步助手_')
}

/**
 * 清洗企微消息正文，得到去掉 HTML / wikilink / markdown 链接的纯文本。
 * 不做任何长度截断 —— 调用方自行决定是否截断。
 */
export const extractMessagePlainText = (item: Item): string => {
  const content = item.content || ''
  return content
    .replace(/<[^>]*>/g, '')                                    // 移除 HTML 标签
    .replace(/!\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_m: string, p: string, a: string) => a || p || '')  // ![[path|alt]] → alt or path
    .replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_m: string, p: string, a: string) => a || p || '')   // [[path|alt]] → alt or path
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                  // ![alt](url) → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                   // [text](url) → text
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 生成消息摘要标题（取内容前10个字）
 * 用于日记链接的锚点 —— 锚点需要稳定，必须保持 10 字上限
 */
export const generateMessageHeading = (item: Item): string => {
  const summary = extractMessagePlainText(item).slice(0, 10)
  return summary || '消息'
}

/**
 * 处理聊天记录内容中的时间戳，将其转换为弱化样式，并精简换行
 */
const processContentTimestamps = (content: string): string => {
  // 1. 匹配聊天记录中的时间戳格式: **yyyy/MM/dd HH:mm:ss**
  // 将其转换为弱化样式: <small style="color: #999;">yyyy/MM/dd HH:mm:ss</small>
  let processed = content.replace(
    /\*\*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\*\*/g,
    '<small style="color: #999;">$1</small>'
  )

  // 2. 精简多余换行：将连续3个及以上换行替换为2个换行
  processed = processed.replace(/\n{3,}/g, '\n\n')

  // 3. 移除时间戳后的多余空行（时间戳+换行+换行 -> 时间戳+换行）
  processed = processed.replace(/(<small style="color: #999;">.*?<\/small>)\n\n/g, '$1\n')

  return processed
}

/**
 * 为企微消息渲染简洁内容（使用用户自定义模板）
 * 可用变量: {{{dateSaved}}}, {{{content}}}, {{{title}}}, {{{id}}}, {{{heading}}} 等
 */
export const renderWeChatMessageSimple = (
  item: Item,
  dateSavedFormat: string,
  wechatMessageTemplate: string,
): string => {
  const dateSaved = formatDate(item.savedAt, dateSavedFormat)
  // 处理content中的时间戳，将其弱化显示
  const processedContent = item.content ? processContentTimestamps(item.content) : ''
  // 生成消息摘要标题（用于日记链接锚点）
  const heading = generateMessageHeading(item)

  const articleView = {
    id: item.id,
    title: item.title,
    content: processedContent,
    dateSaved,
    savedAt: item.savedAt,
    heading,  // 消息摘要标题
  }
  // Templater 掩码：未接力的 <% %> 标签原样保留，防 Mustache 吃掉表达式里的 {{...}}
  const templateMask = maskTemplaterTags(wechatMessageTemplate)
  return templateMask.restore(Mustache.render(templateMask.text, articleView))
}

/**
 * 从模板中提取第一个标题模式（任意层级 #、##、### 等）
 * @param template 模板字符串
 * @returns 标题模式（不含 # 前缀）或 null
 */
export const extractHeadingPatternFromTemplate = (template: string): string | null => {
  const lines = template.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // 匹配以 # 开头的行（标题）
    const match = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      return match[2].trim()
    }
  }
  return null
}

/**
 * 将标题文本转换为 Obsidian 锚点格式
 * Obsidian 锚点规则：冒号替换为空格
 */
export const convertToObsidianAnchor = (heading: string): string => {
  return heading
    .replace(/:/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 为企微消息生成正确的 Obsidian 锚点
 * 从模板中提取标题模式，渲染后转换为锚点格式
 */
export const generateMessageAnchor = (
  item: Item,
  dateSavedFormat: string,
  wechatMessageTemplate: string
): string => {
  const headingPattern = extractHeadingPatternFromTemplate(wechatMessageTemplate)

  if (!headingPattern) {
    return generateMessageHeading(item)
  }

  const dateSaved = formatDate(item.savedAt, dateSavedFormat)
  const heading = generateMessageHeading(item)

  const articleView = {
    id: item.id,
    title: item.title,
    content: item.content || '',
    dateSaved,
    savedAt: item.savedAt,
    heading,
  }

  // Templater 掩码：标题行里未接力的 <% %> 标签原样保留（与正文渲染同一规则，
  // 锚点才能和文件里的实际标题一致）
  const headingMask = maskTemplaterTags(headingPattern)
  const renderedHeading = headingMask.restore(
    Mustache.render(headingMask.text, articleView),
  )
  return convertToObsidianAnchor(renderedHeading)
}
