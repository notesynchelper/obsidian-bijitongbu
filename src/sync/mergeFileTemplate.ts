/**
 * 「合并文件模板」—— 用户自定义合并消息文件的样式（文件头）。
 *
 * 背景：合并模式（消息合并 / 双写 / 全部合并）下，插件按天新建一个合并文件，
 * 历史上它是**空文件**（`vault.create(path, '')`），样式完全由消息模板决定，
 * 用户没法给这个文件本身加笔记属性 / 标题 / 说明。
 *
 * 语义（刻意做得极简）：
 *  - 模板 = **文件头**，只在**新建**该合并文件时写一次；
 *  - 消息永远接在文件头**下面**（按时间降序时新消息紧跟文件头，升序时在文件末尾）；
 *  - 模板为空 = 历史行为（空文件），存量文件不受影响。
 *
 * 🔴 **绝不往用户文件里写任何锚点 / 隐藏注释**。文件头的位置靠「用模板反推出的
 * 正则」在正文开头匹配出来（模板里的 `{{{date}}}` 之类变量位置用通配符，所以日期
 * 变了、文件名变了都还认得）。匹配不上（用户改过文件头）就退回历史插入行为 ——
 * 顶多是消息落在文件头上方，绝不改动/删除用户已有的任何字节。
 */

import Mustache from 'mustache'
import { parseYaml } from 'obsidian'
import { MessageSortOrder } from '../settings'
import { sanitizeRenderedYaml } from '../settings/template'
import { logError } from '../logger'

/** 合并文件模板可用变量。 */
export interface MergeFileTemplateView {
  /** 该合并文件的日期（已按「消息文件日期格式」格式化，与文件名里的 {{{date}}} 同值）。 */
  date: string
  /** 该合并文件的文件名（不含 .md）。 */
  title: string
}

/**
 * 渲染「合并文件模板」，得到新建合并文件的初始内容（文件头）。
 *
 * - 模板为空/全空白 → 返回 `''`（历史行为：创建空文件，零回归）。
 * - 模板语法错误 → 抛出（调用方兜底；设置页保存前已用 validateTemplate 拦过一道）。
 */
export function renderMergeFileTemplate(
  template: string,
  view: MergeFileTemplateView,
): string {
  const raw = renderMergeFileTemplateRaw(template, view)
  if (!raw) return ''
  return `${normalizeLeadingFrontMatter(raw).replace(/\s+$/, '')}\n`
}

/**
 * 渲染，但**不做** frontmatter 的 YAML 兜底修复。
 * 设置页校验要看「用户模板原样落盘会怎样」，走这一版；真正落盘走上面那个。
 */
function renderMergeFileTemplateRaw(
  template: string,
  view: MergeFileTemplateView,
): string {
  const tpl = stripLegacyMessagesPlaceholder(template)
  if (!tpl || !tpl.trim()) return ''
  const rendered = Mustache.render(tpl, { date: view.date, title: view.title })
  return `${rendered.replace(/\s+$/, '')}\n`
}

/** 旧写法里的 `{{{messages}}}` 占位符（3.1.22 短暂存在过，未发布给用户）。 */
export const LEGACY_MESSAGES_PLACEHOLDER = /\{\{\{?\s*messages\s*\}?\}\}/

/**
 * 兼容：模板里若还写着 `{{{messages}}}`，只取它**之前**的部分当文件头，其后的内容
 * （旧设计里的页脚）忽略掉。
 *
 * 为什么不是原样渲染成空串：那会让页脚粘进文件头，于是「文件头」把页脚也算进去，
 * 新消息被插到页脚之下 —— 比直接忽略更糟。设置页会就此给出提示。
 */
export function stripLegacyMessagesPlaceholder(template: string): string {
  if (!template) return template
  const m = template.match(LEGACY_MESSAGES_PLACEHOLDER)
  return m ? template.slice(0, m.index) : template
}

// ---------------------------------------------------------------------------
// 文件头定位：用模板反推正则，不往文件里写任何标记
// ---------------------------------------------------------------------------

/** mustache 标签（`{{x}}` / `{{{x}}}` / `{{#x}}` / `{{/x}}`）。 */
const MUSTACHE_TAG_RE = /\{\{\{?[^{}]*\}?\}\}/g

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 去掉模板开头的属性块——它落在文件的 frontmatter 里，不在 body 里。 */
function stripLeadingFrontMatterTemplate(template: string): string {
  if (!template.startsWith('---')) return template
  const empty = template.match(/^---\r?\n---(\r?\n)?/)
  if (empty) return template.slice(empty[0].length)
  const m = template.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n)?/)
  return m ? template.slice(m[0].length) : template
}

/**
 * 由模板构造「文件头」匹配正则（锚定正文开头）。
 *
 * 字面量部分原样匹配、变量位置用通配符 —— 于是 `# 📮 {{{date}}} 的消息` 这种头
 * 在任何一天的文件里都认得出来，**不需要**知道当初渲染用的是哪个日期。
 *
 * 返回 null 表示「没有文件头可认」（模板为空、或整段模板就是 frontmatter）。
 */
export function buildMergeHeaderMatcher(template: string): RegExp | null {
  const stripped = stripLegacyMessagesPlaceholder(template)
  if (!stripped || !stripped.trim()) return null
  const tpl = stripLeadingFrontMatterTemplate(stripped)
    .replace(/^\s+/, '')
    .replace(/\s+$/, '')
  if (!tpl) return null

  const literals = tpl.split(MUSTACHE_TAG_RE)
  // 全是变量、没有任何字面量 → 没有可靠的锚，别猜。
  if (!literals.some((p) => p.trim().length > 0)) return null

  // 允许正文开头有空白（模板首行留空、frontmatter 之后的空行等）
  let source = '^\\s*'
  literals.forEach((lit, i) => {
    // 变量位置用**不跨行**的通配符：{{{date}}} / {{{title}}} 渲染出来一定是单行值。
    // 若用 [\s\S]*?，用户删掉变量后面那段字面量时，正则会一路搜到某条老消息里去，
    // 把中间所有消息都算成「文件头」—— 新消息于是插到它们下面。宁可匹配不上退回
    // 历史行为，也不能把消息吞进文件头（codex P2）。
    if (i > 0) source += '[^\\n]*?'
    source += escapeRegex(lit)
  })
  // 模板以变量结尾时，最后一段字面量是空的 —— 补一个「吃到行尾」，
  // 否则文件头会在变量渲染值之前就被截断，消息插到半行中间。
  if (literals.length > 1 && literals[literals.length - 1] === '')
    source += '[^\\n]*'

  try {
    return new RegExp(source)
  } catch {
    return null
  }
}

/**
 * 把正文切成「文件头 / 其余」。匹配不上（无模板、用户改过头部）时头为空串。
 */
export function splitMergeHeader(
  body: string,
  headerRe: RegExp | null,
): { header: string; rest: string } {
  // 兼容：3.1.22（未发布给用户，但 git 上存在过）写下的锚点文件 —— 起始锚点就是
  // 文件头的边界。只读不写：新文件永远不会再出现这个标记。
  const legacy = body.indexOf(LEGACY_ANCHOR_START)
  if (legacy >= 0) {
    const end = legacy + LEGACY_ANCHOR_START.length
    return {
      header: body.slice(0, end),
      rest: body.slice(end).replace(/^\s+/, ''),
    }
  }

  if (!headerRe) return { header: '', rest: body }
  const m = headerRe.exec(body)
  if (!m || m.index !== 0 || m[0].length === 0)
    return { header: '', rest: body }
  // 补齐到行尾：变量值里恰好含有它后面那段字面量时（如 title=「周报 消息」配模板
  // `# {{{title}}} 消息`），惰性通配会在行中间收尾，插消息就会把标题行劈开。
  let end = m[0].length
  if (end < body.length && body[end] !== '\n' && body[end] !== '\r') {
    const nl = body.indexOf('\n', end)
    end = nl < 0 ? body.length : nl
  }
  return {
    header: body.slice(0, end),
    rest: body.slice(end).replace(/^\s+/, ''),
  }
}

/** 3.1.22 短暂用过的消息区起始锚点。只用于识别老文件，**绝不再写入**。 */
const LEGACY_ANCHOR_START = '<!--nh-msgs-->'

/**
 * 正文里「文件头之外是否已有内容」。
 *
 * 替代裸 `body.trim().length > 0`：启用模板后新建的文件天生带文件头，裸判空会把它
 * 误当成「已有内容的 digest」，让 ALL 模式下的单篇文章元数据被下沉进 callout。
 */
export function mergeBodyHasContent(
  body: string,
  headerRe: RegExp | null = null,
): boolean {
  return splitMergeHeader(body, headerRe).rest.trim().length > 0
}

/**
 * 「刚按模板新建、文件头之下还空着」的合并文件。
 *
 * `templateActive` 为 false（用户没配模板）时恒 false —— 所有历史判定路径逐字不变。
 * 注意不能只看 headerRe：模板可以**只有属性块**（`---\nid: x\n---`），此时正文里
 * 没有可匹配的文件头，但它同样是一个全新的空文件。
 */
export function isHeaderOnlyBody(
  body: string,
  headerRe: RegExp | null,
  templateActive: boolean,
): boolean {
  if (!templateActive) return false
  return !mergeBodyHasContent(body, headerRe)
}

/**
 * `正文末行\n---` 会被 CommonMark 解析为 setext H2，而 `正文末行\n- - -`
 * 仍是 thematic break。只改消息边界右侧的分隔线写法，不动模板本身。
 */
export function makeLeadingThematicBreakSetextSafe(block: string): string {
  return block.replace(/^( {0,3})-{3,}([ \t]*)(?=\r?\n|$)/, '$1- - -$2')
}

const COMMONMARK_TYPE_6_HTML_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'

const COMMONMARK_TYPE_6_HTML_OPENER = new RegExp(
  `^ {0,3}<\\/?(?:${COMMONMARK_TYPE_6_HTML_TAGS})(?:[ \\t]+|\\/?>|$)`,
  'i',
)

// type-7 必须是完整的单个 open/close tag，且 tag 后到行尾只能有空白。
const COMMONMARK_TYPE_7_HTML_OPENER =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ "'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/

type HtmlLiteralEnd =
  | '-->'
  | '?>'
  | '>'
  | ']]>'
  | 'script'
  | 'pre'
  | 'style'
  | 'textarea'

function htmlLiteralEnd(firstLine: string): HtmlLiteralEnd | null {
  const opener = firstLine.match(
    /^ {0,3}<(?:script|pre|style|textarea)(?:[ \t]|>|$)/i,
  )
  if (opener)
    return opener[0]
      .match(/script|pre|style|textarea/i)?.[0]
      .toLowerCase() as HtmlLiteralEnd
  if (/^ {0,3}<!--/.test(firstLine)) return '-->'
  if (/^ {0,3}<\?/.test(firstLine)) return '?>'
  if (/^ {0,3}<![A-Z]/.test(firstLine)) return '>'
  if (/^ {0,3}<!\[CDATA\[/.test(firstLine)) return ']]>'
  return null
}

function closesHtmlLiteral(line: string, end: HtmlLiteralEnd): boolean {
  if (
    end === 'script' ||
    end === 'pre' ||
    end === 'style' ||
    end === 'textarea'
  ) {
    return new RegExp(`<\\/${end}>`, 'i').test(line)
  }
  return line.includes(end)
}

/**
 * 左侧块末尾若仍处于只能由空行终止的 type-6/type-7 HTML block，单换行会把右侧吞进 raw HTML。
 * 同行已闭合的 type-1~5（尤其默认 `<!--nh:id-->`）会先退出各自状态，不触发此守卫。
 */
function hasOpenBlankLineTerminatedHtmlBlock(block: string): boolean {
  let htmlLiteral: HtmlLiteralEnd | null = null
  let blankLineTerminatedHtml = false
  let fence: { marker: '`' | '~'; length: number } | null = null
  let paragraphOpen = false

  for (const line of block.split(/\r?\n/)) {
    if (htmlLiteral) {
      if (closesHtmlLiteral(line, htmlLiteral)) htmlLiteral = null
      paragraphOpen = false
      continue
    }

    if (blankLineTerminatedHtml) {
      if (/^[ \t]*$/.test(line)) blankLineTerminatedHtml = false
      paragraphOpen = false
      continue
    }

    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (
        close &&
        close[1][0] === fence.marker &&
        close[1].length >= fence.length
      ) {
        fence = null
      }
      paragraphOpen = false
      continue
    }

    if (/^[ \t]*$/.test(line)) {
      paragraphOpen = false
      continue
    }

    const literalEnd = htmlLiteralEnd(line)
    if (literalEnd) {
      if (!closesHtmlLiteral(line.slice(line.indexOf('<') + 1), literalEnd))
        htmlLiteral = literalEnd
      paragraphOpen = false
      continue
    }

    if (COMMONMARK_TYPE_6_HTML_OPENER.test(line)) {
      blankLineTerminatedHtml = true
      paragraphOpen = false
      continue
    }

    const fenceOpen = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fenceOpen && (fenceOpen[1][0] === '~' || !fenceOpen[2].includes('`'))) {
      fence = {
        marker: fenceOpen[1][0] as '`' | '~',
        length: fenceOpen[1].length,
      }
      paragraphOpen = false
      continue
    }

    if (!paragraphOpen && COMMONMARK_TYPE_7_HTML_OPENER.test(line)) {
      blankLineTerminatedHtml = true
      continue
    }

    // 这些单行块结束后，下一行仍处于 block 起点；其余内容按 paragraph 保守处理。
    if (
      /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line) ||
      /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(
        line,
      ) ||
      (paragraphOpen && /^ {0,3}(?:=+[ \t]*|-+[ \t]*)$/.test(line))
    ) {
      paragraphOpen = false
    } else {
      paragraphOpen = true
    }
  }

  return blankLineTerminatedHtml
}

/** CommonMark/GFM 中能可靠打断左侧 paragraph 的块级首行。拿不准时宁可返回 false。 */
function hasParagraphBreakingFirstLine(block: string): boolean {
  const firstLine = block.match(/^[^\r\n]*/)?.[0] ?? ''

  // thematic break（`---` 已在调用前改成幂等的 `- - -`）；`===` 刻意不在其中。
  if (
    /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(
      firstLine,
    )
  )
    return true
  if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(firstLine)) return true
  if (/^ {0,3}(?:`{3,}[^`]*|~{3,}.*)$/.test(firstLine)) return true
  if (/^ {0,3}>/.test(firstLine)) return true
  // 有序列表只有起始编号 1 能打断 paragraph；2. 等写法在此边界必须退回双换行。
  // 空列表项（裸 `-` / `-   ` 等）不能打断 paragraph，且 `-` 会成为 setext 下划线。
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]+\S/.test(firstLine)) return true

  // CommonMark HTML block 的保守子集：特殊 opener，以及规范列出的 block tag。
  return /^ {0,3}(?:<!--|<\?|<![A-Z]|<!\[CDATA\[|<\/?(?:script|pre|style|textarea)(?:[ \t>/]|$)|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t>/]|$))/i.test(
    firstLine,
  )
}

/**
 * 连接两个消息块：左侧没有仍打开的 HTML block、且右侧明确以块级构造开头时才压成单换行，
 * 否则保留历史双换行。
 * setext 防护在所有消息模式下一视同仁，包括带隐形 marker 的默认路径。
 * ALL 模式下 message ↔ article 边界同样走此压缩策略，这是有意保留的已知边界。
 */
export function joinWechatMessageBlocks(left: string, right: string): string {
  const safeRight = makeLeadingThematicBreakSetextSafe(right)
  const separator =
    !hasOpenBlankLineTerminatedHtmlBlock(left) &&
    hasParagraphBreakingFirstLine(safeRight)
      ? '\n'
      : '\n\n'
  return `${left}${separator}${safeRight}`
}

/** 插入内容之间的连接策略；默认值保持文章等既有调用的双换行行为。 */
export interface MergeBodyInsertOptions {
  /** 消息块边界启用“安全时单换行，否则双换行”；文章等调用不传，保持历史行为。 */
  compactWechatMessageSpacing?: boolean
}

/**
 * 把一块渲染好的内容（一批消息 / 一批文章 section）插进合并文件正文。
 *
 * - 降序（默认）：插在**文件头之下**、其余内容之上；认不出文件头就退回历史的整体
 *   prepend。
 * - 升序：追加到文件末尾 —— 与历史行为逐字一致（文件头本就在最上，无需特殊处理）。
 */
export function insertIntoMergeBody(
  body: string,
  block: string,
  sortOrder: MessageSortOrder,
  headerRe: RegExp | null = null,
  options: MergeBodyInsertOptions = {},
): string {
  const joinContent = (left: string, right: string): string => {
    return options.compactWechatMessageSpacing
      ? joinWechatMessageBlocks(left, right)
      : `${left}\n\n${right}`
  }

  if (sortOrder === MessageSortOrder.ASC) {
    // 文件头与首条内容不是「消息 ↔ 消息」边界，保持原来的双换行字节。
    const { header, rest } = splitMergeHeader(body, headerRe)
    if (header && !rest.trim()) return `${header}\n\n${block}`
    return body.trim() ? joinContent(body, block) : block
  }
  const { header, rest } = splitMergeHeader(body, headerRe)
  if (!header) return rest.trim() ? joinContent(block, rest) : block
  return rest.trim()
    ? `${header}\n\n${joinContent(block, rest)}`
    : `${header}\n\n${block}`
}

// ---------------------------------------------------------------------------
// 落盘前的 frontmatter 兜底 + 设置页校验
// ---------------------------------------------------------------------------

/** 开头是否为「空属性块」（`---\n---`）—— 合法且 MergeProcessor 认得。 */
const EMPTY_FM_RE = /^---\r?\n---(\r?\n|$)/
/** 开头闭合的属性块（捕获里面的 YAML）。 */
const LEADING_FM_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---)((?:\r?\n)|$)/

/**
 * 🔴 落盘前兜底：保证新建的合并文件开头那段属性块**一定能被 YAML 解析**。
 *
 * 设置页的校验只用样例值试渲染，挡不住「模板里插了变量、而真实值是 YAML 保留字符」
 * 的情况 —— 典型：模板写 `title: {{{title}}}`，某天的合并文件恰好叫 `@daily`，
 * 渲染出 `title: @daily`（`@` 是 YAML 保留指示符）→ 文件落盘后 MergeProcessor 每次
 * 解析都抛 YAMLException → 那份文件**永远写不进消息**（而文件已存在，下一轮还是同一份）。
 *
 * 兜底顺序：原样能解析 → 用 sanitizeRenderedYaml 补引号后能解析 → 都不行就整块丢掉
 * （保留用户可见的文件头，宁可少一段属性，也不能让整个文件同步不进内容）。
 */
function normalizeLeadingFrontMatter(content: string): string {
  if (!content.startsWith('---') || EMPTY_FM_RE.test(content)) return content
  const m = content.match(LEADING_FM_RE)
  // 开头的 `---` 没有闭合 → 不构成属性块（Obsidian/MergeProcessor 都当正文），不动。
  if (!m) return content

  const [matched, open, yaml, close, trailing] = m
  if (isMappingYaml(yaml)) return content

  const rest = content.slice(matched.length)
  const sanitized = sanitizeRenderedYaml(yaml)
  if (isMappingYaml(sanitized)) {
    logError('⚠️ 合并文件模板的属性块 YAML 需要补引号，已自动 sanitize 后落盘')
    return `${open}${sanitized}${close}${trailing}${rest}`
  }
  logError(
    '⚠️ 合并文件模板的属性块不是合法的键值对 YAML，已丢弃该属性块（正文保留）',
  )
  return rest.replace(/^[\r\n]+/, '')
}

/**
 * YAML 能解析 **且**根是键值对（或空）。
 *
 * 只判「能不能解析」不够：根是标量 / 数组时 MergeProcessor 会把它 spread 成数字下标、
 * 或当成 legacy `messages` 字段 delete 掉 —— 第一次同步就把用户模板的属性块改坏/抹掉。
 */
function isMappingYaml(yaml: string): boolean {
  try {
    const parsed = parseYaml(yaml) as unknown
    if (parsed === null || parsed === undefined) return true
    return typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/** 合并文件模板的开头 YAML 校验结果（设置页实时提示用）。 */
export interface MergeFileTemplateValidation {
  valid: boolean
  /** 不合法时的原因（中文，直接展示给用户）。 */
  error: string | null
}

/**
 * 校验模板开头的 `---`：Obsidian 把文件开头的 `---` 当**属性块起始**，
 * 所以模板要么根本不以 `---` 开头，要么开头就是一段闭合且能解析的 YAML。
 *
 * 不合法的典型写法是把 `---` 当水平分割线放在第一行 —— 落盘后 Obsidian 会把
 * 后面一大段正文吞进属性区。这里在设置页就提示出来（**不阻断保存**）。
 */
export function validateMergeFileTemplate(
  template: string,
): MergeFileTemplateValidation {
  if (!template || !template.trim()) return { valid: true, error: null }

  let rendered: string
  try {
    // 用 raw 版：要提示的正是「原样落盘会被误读」，走修复版就永远看不到问题了。
    rendered = renderMergeFileTemplateRaw(template, {
      date: '2026-01-23',
      title: '同步助手_2026-01-23',
    })
  } catch (e) {
    return {
      valid: false,
      error: `模板渲染失败: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (!rendered.startsWith('---')) return { valid: true, error: null }
  // 空属性块（`---\n---`）是合法写法，通用正则匹配不到（它要求闭合前还有一个换行），
  // 先单独放行，否则设置页会对一个能正常落盘的模板报假警。
  if (EMPTY_FM_RE.test(rendered)) return { valid: true, error: null }

  const fm = rendered.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/)
  if (!fm) {
    return {
      valid: false,
      error:
        '模板第一行的 --- 会被 Obsidian 当作「属性块」起始，但后面没有闭合的 ---。想画分割线请把它挪到第二行之后。',
    }
  }
  try {
    const parsed = parseYaml(fm[1]) as unknown
    if (
      parsed !== null &&
      parsed !== undefined &&
      (typeof parsed !== 'object' || Array.isArray(parsed))
    ) {
      return {
        valid: false,
        error: '开头的属性块解析结果不是键值对，Obsidian 会忽略这些字段。',
      }
    }
    return { valid: true, error: null }
  } catch (e) {
    return {
      valid: false,
      error: `开头的属性块不是合法 YAML: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
