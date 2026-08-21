import { Highlight } from '@omnivore-app/api'
import { diff_match_patch } from 'diff-match-patch'
import { DateTime } from 'luxon'
import escape from 'markdown-escape'
import { parseYaml } from 'obsidian'
import outOfCharacter from 'out-of-character'
import { HighlightColorMapping, HighlightManagerId } from './settings'
import { logError } from './logger'

export const DATE_FORMAT_W_OUT_SECONDS = "yyyy-MM-dd'T'HH:mm"
export const DATE_FORMAT = `${DATE_FORMAT_W_OUT_SECONDS}:ss`
export const REPLACEMENT_CHAR = '-'
export const HIDDEN_PREFIX_GUARD = '_'
export const EMPTY_NAME_FALLBACK = 'untitled'
// On Unix-like systems / is reserved and <>:"/\|?* as well as non-printable characters \u0000-\u001F on Windows
// credit: https://github.com/sindresorhus/filename-reserved-regex
// eslint-disable-next-line no-control-regex -- \u0000-\u001F 控制字符正是要从文件名里过滤的目标，属有意匹配
export const ILLEGAL_CHAR_REGEX_FILE = /[<>:"/\\|?*\u0000-\u001F]/g
// eslint-disable-next-line no-control-regex -- 同上：目录名同样要滤掉 Windows 保留的控制字符
export const ILLEGAL_CHAR_REGEX_FOLDER = /[<>:"\\|?*\u0000-\u001F]/g

export interface HighlightPoint {
  left: number
  top: number
}

export interface HighlightRenderOption {
  highlightManagerId: HighlightManagerId
  highlightColor: string
}

export const getHighlightLocation = (patch: string | null): number => {
  if (!patch) {
    return 0
  }
  const dmp = new diff_match_patch()
  const patches = dmp.patch_fromText(patch)
  return patches[0].start1 || 0
}

export const getHighlightPoint = (patch: string | null): HighlightPoint => {
  if (!patch) {
    return { left: 0, top: 0 }
  }
  const { bbox } = JSON.parse(patch) as { bbox: number[] }
  if (!bbox || bbox.length !== 4) {
    return { left: 0, top: 0 }
  }
  return { left: bbox[0], top: bbox[1] }
}

export const compareHighlightsInFile = (a: Highlight, b: Highlight): number => {
  // get the position of the highlight in the file
  const highlightPointA = getHighlightPoint(a.patch)
  const highlightPointB = getHighlightPoint(b.patch)
  if (highlightPointA.top === highlightPointB.top) {
    // if top is same, sort by left
    return highlightPointA.left - highlightPointB.left
  }
  // sort by top
  return highlightPointA.top - highlightPointB.top
}

export const markdownEscape = (text: string): string => {
  try {
    return escape(text)
  } catch (e) {
    logError('markdownEscape error', e)
    return text
  }
}

export const escapeQuotationMarks = (text: string): string => {
  return text.replace(/"/g, '\\"')
}

export const parseDateTime = (str: string): DateTime => {
  // 优先识别 ISO 8601 含毫秒/时区的 cursor（advanceSyncCursor 写出的格式），
  // 回落到旧的秒级 / 分钟级 DATE_FORMAT 以兼容旧数据和 UI 手输入。
  const iso = DateTime.fromISO(str)
  if (iso.isValid) {
    return iso
  }
  const sec = DateTime.fromFormat(str, DATE_FORMAT)
  if (sec.isValid) {
    return sec
  }
  return DateTime.fromFormat(str, DATE_FORMAT_W_OUT_SECONDS)
}

export const wrapAround = (value: number, size: number): number => {
  return ((value % size) + size) % size
}

/**
 * 末尾截断（与 lodash.truncate 的默认语义对齐，市场版去 lodash 依赖后自研）：
 * 结果总长（含省略号）不超过 length；原文不超长时原样返回。
 * 截断点若劈开增补平面字符（emoji 等），回退一位避免留下孤立代理项。
 */
export const truncateWithOmission = (
  str: string,
  length: number,
  omission = '...',
): string => {
  if (str.length <= length) return str
  const end = length - omission.length
  if (end < 1) return omission
  let cut = str.slice(0, end)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut + omission
}

export const unicodeSlug = (str: string, savedAt: string) => {
  return (
    str
      .normalize('NFKD') // using NFKD method returns the Unicode Normalization Form of a given string.
      .replace(/[\u0300-\u036f]/g, '') // remove all previously split accents
      .trim()
      .toLowerCase()
      .replace(
        /[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g,
        '',
      ) // replace all the symbols with -
      .replace(/\s+/g, '-') // collapse whitespace and replace by -
      .replace(/_/g, '-') // replace _ with -
      .replace(/-+/g, '-') // collapse dashes
      // remove trailing -
      .replace(/-$/g, '')
      .substring(0, 64) +
    '-' +
    new Date(savedAt).getTime().toString(16)
  )
}

/**
 * Obsidian 会隐藏以半角点开头的文件和文件夹，因此在这类段落前补一个保护前缀。
 * 只补前缀、不改原文：全文搜索 / 快速切换 / `[[` 补全都是子串匹配，把点换成
 * 别的字符（如全角句点）虽然同样能让文件可见，却会让用户搜 `.NET` 再也搜不到。
 * 只看段首，中间/结尾的点（`v1.2.3 发布说明`、`结束了.`）逐字节不动，
 * 否则既有笔记路径会漂移、老用户凭空多出重复笔记。
 * 天然幂等：补过前缀的名字不再以 `.` 开头，重复清洗不会叠加。
 */
export const unhideNameSegment = (segment: string): string => {
  if (!segment.startsWith('.')) {
    return segment
  }
  // 整段全是点（`.` / `..`）：本来就没有可搜索的原文要保，而补前缀会留下
  // 以点结尾的名字 —— Windows 会吃掉结尾的点，落盘路径和插件算出来的对不上。
  // 这类段整段换成等长的前缀字符，既 Windows 安全、也不再是父目录段。
  if (/^\.+$/.test(segment)) {
    return HIDDEN_PREFIX_GUARD.repeat(segment.length)
  }
  return HIDDEN_PREFIX_GUARD + segment
}

/**
 * 逐段修正 vault 路径，确保任意层级都不会因半角点前缀被 Obsidian 隐藏。
 */
export const unhideVaultPath = (p: string): string => {
  if (p === '') {
    return p
  }
  return p.split('/').map(unhideNameSegment).join('/')
}

export const replaceIllegalCharsFile = (str: string): string => {
  const sanitized = unhideNameSegment(
    removeInvisibleChars(str.replace(ILLEGAL_CHAR_REGEX_FILE, REPLACEMENT_CHAR)),
  )
  return sanitized.trim() === '' ? EMPTY_NAME_FALLBACK : sanitized
}

export const replaceIllegalCharsFolder = (str: string): string => {
  return unhideVaultPath(
    removeInvisibleChars(
      str.replace(ILLEGAL_CHAR_REGEX_FOLDER, REPLACEMENT_CHAR),
    ),
  )
}

export function formatDate(date: string, format: string): string {
  if (isNaN(Date.parse(date))) {
    throw new Error(`Invalid date: ${date}`)
  }
  return DateTime.fromJSDate(new Date(date)).setLocale('zh-CN').toFormat(format)
}

export const getQueryFromFilter = (filter: string): string => {
  switch (filter) {
    case 'ALL':
      return 'in:all'
    case 'HIGHLIGHTS':
      return `in:all has:highlights`
    case 'ARCHIVED':
      return `in:archive`
    case 'LIBRARY':
      return `in:library`
    default:
      return 'in:all'
  }
}

export const siteNameFromUrl = (originalArticleUrl: string): string => {
  try {
    return new URL(originalArticleUrl).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const wrapHighlightMarkup = (
  quote: string,
  highlightRenderOption: HighlightRenderOption,
): string => {
  const { highlightManagerId, highlightColor } = highlightRenderOption

  const markupRender = (content: string) => {
    if (content.trim().length === 0) {
      return ''
    }
    if (highlightManagerId == HighlightManagerId.HIGHLIGHTR) {
      return `<mark class="${highlightManagerId}-${highlightColor}">${content}</mark>`
    } else {
      return `<mark class="${highlightManagerId} ${highlightManagerId}-${highlightColor}">${content}</mark>`
    }
  }

  return quote.replaceAll(/(>)?(.+)$/gm, (_: string, g1: string | undefined, g2: string) => {
    return (g1 ?? '') + markupRender(g2)
  })
}

export const formatHighlightQuote = (
  quote: string | null,
  template: string,
  highlightRenderOption: HighlightRenderOption | null,
): string => {
  if (!quote) {
    return ''
  }
  // if the template has highlights, we need to preserve paragraphs
  const regex = /{{#highlights}}(\n)*>/gm
  if (regex.test(template)) {
    // replace all empty lines with blockquote '>' to preserve paragraphs
    quote = quote.replaceAll('&gt;', '>').replaceAll(/\n/gm, '\n> ')
  }
  if (highlightRenderOption != null) {
    quote = wrapHighlightMarkup(quote, highlightRenderOption)
  }

  return quote
}

export const parseFrontMatterFromContent = (content: string): unknown => {
  // get front matter yaml from content
  // 兼容Windows行尾符 \r\n
  const frontMatter = content.match(/^---\r?\n(.*?)\r?\n---/s)
  if (!frontMatter) {
    return undefined
  }
  // parse yaml —— YAML 顶层可能是映射/数组/标量，调用方自行收窄
  return parseYaml(frontMatter[1]) as unknown
}

export const removeFrontMatterFromContent = (content: string): string => {
  const frontMatterRegex = /^---.*?---\n*/s

  return content.replace(frontMatterRegex, '')
}

export const snakeToCamelCase = (str: string) =>
  str.replace(/(_[a-z])/g, (group) => group.toUpperCase().replace('_', ''))

const removeInvisibleChars = (str: string): string => {
  return outOfCharacter.replace(str)
}

/**
 * 转义内容中的 hashtag，防止 Obsidian 将其识别为标签
 * 跳过：markdown 标题、fenced/indented code blocks、inline code、URL、锚点链接、wikilink
 * 注意：此函数处理的是 item.content（文章正文），不包含 YAML frontmatter
 */
export const escapeContentHashtags = (text: string): string => {
  if (!text) return text
  const lines = text.split('\n')
  let inFencedCode = false
  let inIndentedCode = false
  // 文首视作 "前一行为空"，便于识别开头就出现的缩进代码块
  let prevBlank = true

  return lines.map(line => {
    // 剥离 blockquote 前缀（保留剥离后的前导空白），用于检测缩进代码块/空行
    const bqStripped = line.replace(/^(\s{0,3}>\s?)+/, '')
    const isBlank = bqStripped.trim() === ''
    // strip blockquote 前缀用于检测 fenced code 边界和标题
    const stripped = line.trim().replace(/^>+\s*/, '')
    const isFenceBoundary = /^\s{0,3}(`{3,}|~{3,})/.test(stripped)

    // fenced code 内部：仅检查结束边界，其余保持原样
    if (inFencedCode) {
      if (isFenceBoundary) inFencedCode = false
      prevBlank = isBlank
      return line
    }

    // fenced code 起始
    if (isFenceBoundary) {
      inFencedCode = true
      inIndentedCode = false
      prevBlank = false
      return line
    }

    // CommonMark indented code block：4 空格或 tab 起始，且前一行为空（含文首）
    // 使用 bqStripped 以支持 blockquote 内的缩进代码块
    const isIndentedLine = /^(\t| {4})/.test(bqStripped)
    if (inIndentedCode) {
      if (isBlank) {
        // 空行允许出现在缩进代码块内部，后续若仍为缩进则保持在代码块中
        prevBlank = true
        return line
      }
      if (isIndentedLine) {
        prevBlank = false
        return line
      }
      // 非空、非缩进行 → 退出缩进代码块，按普通行继续处理
      inIndentedCode = false
    } else if (prevBlank && isIndentedLine) {
      inIndentedCode = true
      prevBlank = false
      return line
    }

    if (isBlank) {
      prevBlank = true
      return line
    }
    prevBlank = false

    // 跳过 markdown 标题（包括 blockquote 中的标题）
    if (/^#{1,6}\s/.test(stripped)) return line
    // 转义 hashtags，跳过 inline code、URL、锚点链接 ](#...)、wikilink [[#...]]
    // 注意：不用 lookbehind（iOS <16.4 的 WebView 不支持，正则在解析期就会抛错）。
    // 改为把「行首/空白/左括号」前缀捕获进匹配并原样拼回；前缀被消费不影响相邻
    // hashtag（`#a #b` 中 #b 的前缀空格未被 #a 的匹配占用）。
    return line.replace(
      /(`[^`]+`)|(\bhttps?:\/\/\S+)|(\]\(#)|(\[\[#)|(^|[\s(])#(?=[^\s#])/g,
      (match: string, inlineCode: string, url: string, anchorLink: string, wikilink: string, hashPrefix: string) => {
        if (inlineCode || url || anchorLink || wikilink) return match
        return `${hashPrefix}\\#`
      }
    )
  }).join('\n')
}

export const setOrUpdateHighlightColors = (
  colorSetting: HighlightColorMapping,
) => {
  const root = document.documentElement

  Object.entries(colorSetting).forEach(([k, v]) => {
    root.style.setProperty(`--omni-${k}`, v)
  })
}
