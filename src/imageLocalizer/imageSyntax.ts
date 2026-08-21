/**
 * Obsidian 可渲染图片语法的小型扫描器。
 *
 * 这里刻意不用一条大正则：Markdown 的嵌套中括号/成对圆括号，以及 HTML
 * 属性值里的 `>` 都需要按状态扫描。imageLocalizer 与 burnResidual 共用本文件，
 * 保证“应该本地化什么”和“阅后即焚前检查什么”永远是同一套判定。
 */

export type ImageSyntaxKind = 'markdown' | 'wiki' | 'html'

export interface ImageSyntaxMatch {
  kind: ImageSyntaxKind
  fullText: string
  url: string
  alt?: string
  startIndex: number
  endIndex: number
}

/** 扫描正文中所有 Markdown / Wiki / HTML 图片，保留原文位置。 */
export function scanImageSyntax(content: string): ImageSyntaxMatch[] {
  const matches: ImageSyntaxMatch[] = []
  let cursor = 0

  while (cursor < content.length) {
    let match: ImageSyntaxMatch | null = null

    if (content[cursor] === '!' && content[cursor + 1] === '[') {
      match = content[cursor + 2] === '['
        ? scanWikiImageAt(content, cursor)
        : scanMarkdownImageAt(content, cursor)
    } else if (content[cursor] === '<' && isImgTagStart(content, cursor)) {
      match = scanHtmlImageAt(content, cursor)
    }

    if (match) {
      matches.push(match)
      cursor = match.endIndex
    } else {
      cursor++
    }
  }

  return matches
}

function scanWikiImageAt(content: string, start: number): ImageSyntaxMatch | null {
  const bodyStart = start + 3
  const end = content.indexOf(']]', bodyStart)
  if (end < 0 || content.slice(bodyStart, end).includes('\n')) return null

  const url = content.slice(bodyStart, end)
  const endIndex = end + 2
  return {
    kind: 'wiki',
    fullText: content.slice(start, endIndex),
    url,
    startIndex: start,
    endIndex,
  }
}

function scanMarkdownImageAt(content: string, start: number): ImageSyntaxMatch | null {
  const altStart = start + 2
  let bracketDepth = 1
  let cursor = altStart

  // Obsidian/CommonMark 接受 alt 中的嵌套 []；反斜杠转义的 \] 不闭合 alt。
  while (cursor < content.length && bracketDepth > 0) {
    const ch = content[cursor]
    if (ch === '\n') return null
    if (ch === '\\') {
      cursor += 2
      continue
    }
    if (ch === '[') bracketDepth++
    if (ch === ']') bracketDepth--
    cursor++
  }
  if (bracketDepth !== 0 || content[cursor] !== '(') return null

  const altEnd = cursor - 1
  const destinationStart = cursor + 1
  let url: string
  let endIndex: number

  // 尖括号 destination：去掉仅用于 Markdown 定界的 <>，下载真实 URL。
  if (content[destinationStart] === '<') {
    const closeAngle = findUnescaped(content, '>', destinationStart + 1)
    if (closeAngle < 0) return null
    let closeParen = closeAngle + 1
    while (closeParen < content.length && /[ \t]/.test(content[closeParen])) {
      closeParen++
    }
    if (content[closeParen] !== ')') return null
    url = content.slice(destinationStart + 1, closeAngle)
    endIndex = closeParen + 1
  } else {
    // 普通 destination：圆括号按层级配对，故 a(1).png 不会在第一个 `)` 截断。
    let parenDepth = 1
    cursor = destinationStart
    while (cursor < content.length && parenDepth > 0) {
      const ch = content[cursor]
      if (ch === '\n') return null
      if (ch === '\\') {
        cursor += 2
        continue
      }
      if (ch === '(') parenDepth++
      if (ch === ')') parenDepth--
      cursor++
    }
    if (parenDepth !== 0) return null
    url = content.slice(destinationStart, cursor - 1)
    endIndex = cursor
  }

  return {
    kind: 'markdown',
    fullText: content.slice(start, endIndex),
    url,
    alt: content.slice(altStart, altEnd) || undefined,
    startIndex: start,
    endIndex,
  }
}

function isImgTagStart(content: string, start: number): boolean {
  if (content.slice(start, start + 4).toLowerCase() !== '<img') return false
  const next = content[start + 4]
  return next === undefined || /[\s/>]/.test(next)
}

function scanHtmlImageAt(content: string, start: number): ImageSyntaxMatch | null {
  const tagEnd = findHtmlTagEnd(content, start + 4)
  if (tagEnd < 0) return null

  let cursor = start + 4
  let src: string | undefined
  let alt: string | undefined

  while (cursor < tagEnd) {
    while (cursor < tagEnd && /[\s/]/.test(content[cursor])) cursor++
    if (cursor >= tagEnd) break

    const nameStart = cursor
    while (cursor < tagEnd && !/[\s=/>]/.test(content[cursor])) cursor++
    if (cursor === nameStart) {
      cursor++
      continue
    }
    const name = content.slice(nameStart, cursor).toLowerCase()
    while (cursor < tagEnd && /\s/.test(content[cursor])) cursor++

    let value: string | undefined
    if (content[cursor] === '=') {
      cursor++
      while (cursor < tagEnd && /\s/.test(content[cursor])) cursor++
      const quote = content[cursor]
      if (quote === '"' || quote === "'") {
        const valueStart = ++cursor
        while (cursor < tagEnd && content[cursor] !== quote) cursor++
        value = content.slice(valueStart, cursor)
        if (content[cursor] === quote) cursor++
      } else {
        const valueStart = cursor
        while (cursor < tagEnd && !/[\s>]/.test(content[cursor])) cursor++
        value = content.slice(valueStart, cursor)
      }
    }

    if (name === 'src' && value !== undefined && src === undefined) src = value
    if (name === 'alt' && value !== undefined && alt === undefined) alt = value
  }

  if (!src) return null
  const endIndex = tagEnd + 1
  return {
    kind: 'html',
    fullText: content.slice(start, endIndex),
    url: src,
    alt: alt || undefined,
    startIndex: start,
    endIndex,
  }
}

/** 找到 HTML 标签真正的 `>`；引号属性值里的 `>` 不结束标签。 */
function findHtmlTagEnd(content: string, start: number): number {
  let quote: '"' | "'" | null = null
  for (let cursor = start; cursor < content.length; cursor++) {
    const ch = content[cursor]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return cursor
    }
  }
  return -1
}

function findUnescaped(content: string, needle: string, start: number): number {
  for (let cursor = start; cursor < content.length; cursor++) {
    if (content[cursor] === '\n') return -1
    if (content[cursor] === '\\') {
      cursor++
      continue
    }
    if (content[cursor] === needle) return cursor
  }
  return -1
}
