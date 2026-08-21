import { App } from 'obsidian'

/**
 * Templater 接力（文章模板 / 消息模板 → Templater `<% %>` 插值）
 *
 * 方向（2026-08-07 真机实验后定稿，见 docs/templater-compat-design.md）：
 * - 只支持 `<% %>` 插值；`<%*` 执行块 mask 掉不送 Templater、原样落盘
 *   （防呆：从网上抄来的日记模板带 tp.file.rename 之类副作用会毁合并文件路由）。
 * - 只走 `parse_template()`（内存渲染、不碰文件）；**绝不**用
 *   `overwrite_file_commands()` —— 它是 read-once→render→整份覆盖，渲染期间
 *   插入的消息会被旧快照静默吞掉，且超时护栏在它身上有害（真机实测）。
 * - 未装/未启用 Templater、接力失败、超时 → 一律原文返回（非破坏降级），
 *   标签原样落盘，用户在文件里看得见没生效的源码，与设置页警告呼应。
 *
 * 为什么 tp.file.* / tp.frontmatter.* 不支持：
 * `parse_template()` 在 generate_object 阶段会**急切**执行
 * `vault.read(target_file)` 与 `target_file.basename`（2.20.6 源码实证），
 * target_file 必须是真实存在的 TFile。而文章/消息模板渲染时目标文件往往
 * 尚未创建（编号冲突文件更是渲染后才定路径），拿不到正确上下文——静默给出
 * 错误值比不支持更糟，所以整个命名空间 mask 掉原样保留。
 */

export const TEMPLATER_PLUGIN_ID = 'templater-obsidian'

/** Templater RunMode.DynamicProcessor —— 真机实验 P8 验证过的 parse_template 模式 */

/** 单次 parse_template 超时（tp.web.* 网络请求可能悬挂；内存渲染超时无副作用） */

/**
 * 触发抑制的保留时长：Templater trigger_on_file_creation 在 create 事件后
 * sleep 300ms 才检查 files_with_pending_templates，900ms 覆盖 300ms 窗口 + 余量
 * （QuickAdd 用 350ms buffer 防的是同一件事）。
 */
const TRIGGER_SUPPRESS_HOLD_MS = 900

/** 匹配一个完整的 Templater 标签（含 <%* / <%+ / 空白控制变体） */
const TEMPLATER_TAG_RE = /<%[\s\S]*?%>/g

/**
 * 不支持接力的调用（出现在插值标签内则整个标签 mask 原样保留）：
 * - tp.file.* / tp.frontmatter.* ：依赖 target_file 上下文，渲染时目标文件
 *   可能尚不存在，给错上下文=静默错误值（见文件头注释）
 * - tp.config.* / tp.hooks.* ：暴露运行配置 / 挂文件事件钩子，语义不成立
 * - tp.system.* 只放行 clipboard（白名单）：prompt / suggester /
 *   multi_suggester 等弹窗类 API 在后台渲染永久挂起（真机实测），且 Templater
 *   将来再加弹窗 API 也不能漏（codex P2）
 * - `tp?.` / `tp[` 等非点号访问：deny-regex 认不出访问的是哪个模块，一律不接力
 *   （codex P1：`tp?.file.rename` / `tp["file"].title` 绕过点号规则会真执行）。
 *   本检测是防呆不是防恶意——插值是任意 JS 表达式，语法上总能构造绕过（如
 *   `[tp][0].file`），但模板是用户自己写的，挡住常见写法即达目的。
 */
const UNSUPPORTED_CALL_PATTERNS: Array<{
  re: RegExp
  label: (m: RegExpExecArray) => string
}> = [
  {
    re: /\btp\s*(\?\.|\[)/g,
    label: () => 'tp[...] / tp?.（仅支持 tp.xxx 点号访问）',
  },
  {
    re: /\btp\s*\.\s*(file|frontmatter|config|hooks)\b/g,
    label: (m) => `tp.${m[1]}.*`,
  },
  {
    re: /\btp\s*\.\s*system\s*[?.[]+\s*['"]?(?!clipboard\b)(\w+)/g,
    label: (m) => `tp.system.${m[1]}`,
  },
]

const hasUnsupportedCall = (inner: string): boolean =>
  UNSUPPORTED_CALL_PATTERNS.some((p) => {
    p.re.lastIndex = 0
    return p.re.test(inner)
  })

/** 提取命中的不支持调用名（给设置页提示用，如 "tp.file.*"） */
const collectUnsupportedCalls = (inner: string, into: Set<string>): void => {
  for (const p of UNSUPPORTED_CALL_PATTERNS) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(inner)) !== null) {
      into.add(p.label(m))
    }
  }
}

export interface TemplaterTagAnalysis {
  /** 文本里存在任何 <% ... %> 标签 */
  hasTags: boolean
  /** 可接力的插值标签数（<% expr %>，且不含不支持的调用） */
  relayableCount: number
  /** <%* 执行块数（不支持，mask 原样保留） */
  execCount: number
  /** <%+ 动态命令数（有意保留原文——它本来就该留在文件里由预览动态渲染） */
  dynamicCount: number
  /** 命中的不支持调用（去重），如 ["tp.file.title"] */
  unsupportedCalls: string[]
  /**
   * 疑似毒化：未闭合的 `<%` 或 `<%%`。Templater 遇到会**静默放弃整个文件**
   * 的解析（真机 C2/C3），此时不接力，全部原样保留。
   */
  poisoned: boolean
}

interface ParsedTag {
  /** 标签原文（含 <% %>） */
  raw: string
  /** 在原文中的起始偏移 */
  index: number
  kind: 'interpolation' | 'exec' | 'dynamic' | 'unsupported' | 'poison'
}

/** 去掉开头 <% 与空白控制符后取首个语义字符，判定标签类型 */
const classifyTag = (raw: string): ParsedTag['kind'] => {
  // <%% 会毒化整个文件的解析（真机 C2）
  if (raw.startsWith('<%%')) return 'poison'
  const inner = raw.slice(2, -2)
  const head = inner.replace(/^[-_]/, '')
  if (head.startsWith('*')) return 'exec'
  if (head.startsWith('+')) return 'dynamic'
  if (hasUnsupportedCall(inner)) return 'unsupported'
  return 'interpolation'
}

const parseTags = (text: string): { tags: ParsedTag[]; unclosed: boolean } => {
  const tags: ParsedTag[] = []
  let m: RegExpExecArray | null
  TEMPLATER_TAG_RE.lastIndex = 0
  while ((m = TEMPLATER_TAG_RE.exec(text)) !== null) {
    tags.push({ raw: m[0], index: m.index, kind: classifyTag(m[0]) })
  }
  // 把所有完整标签抠掉后残留的 `<%` = 未闭合标签（真机 C3：毒化整文件）
  const residual = text.replace(TEMPLATER_TAG_RE, '')
  return { tags, unclosed: residual.includes('<%') }
}

/** 分析模板文本里的 Templater 标签构成（设置页提示 + 接力前置判定共用） */
export const analyzeTemplaterTags = (text: string): TemplaterTagAnalysis => {
  const empty: TemplaterTagAnalysis = {
    hasTags: false,
    relayableCount: 0,
    execCount: 0,
    dynamicCount: 0,
    unsupportedCalls: [],
    poisoned: false,
  }
  if (!text || !text.includes('<%')) return empty
  const { tags, unclosed } = parseTags(text)
  const unsupported = new Set<string>()
  let relayable = 0
  let exec = 0
  let dynamic = 0
  let poison = false
  for (const tag of tags) {
    switch (tag.kind) {
      case 'interpolation':
        relayable++
        break
      case 'exec':
        exec++
        break
      case 'dynamic':
        dynamic++
        break
      case 'poison':
        poison = true
        break
      case 'unsupported':
        collectUnsupportedCalls(tag.raw.slice(2, -2), unsupported)
        break
    }
  }
  return {
    hasTags: true,
    relayableCount: relayable,
    execCount: exec,
    dynamicCount: dynamic,
    unsupportedCalls: [...unsupported],
    poisoned: poison || unclosed,
  }
}

// ---------------------------------------------------------------------------
// 掩码：把 <% %> 段落换成惰性占位符，防两件事——
// 1) Mustache 吃掉 Templater 表达式里的 {{...}}（未接力/接力失败时标签仍在文本里）
// 2) 接力时把 <%* 执行块 / 不支持的调用送进 Templater
// 占位符对同一段文本是**确定性**的（同模板 → 同占位符），Mustache 的内部模板
// 缓存不会因每次渲染的随机串而无限增长；nonce 随插件加载随机一次，正文不可能撞上。
// ---------------------------------------------------------------------------

const MASK_NONCE = Math.random().toString(36).slice(2, 10)

/** djb2 —— 占位符里带上标签内容哈希，两个占位符相等 ⟹ 原标签相同，还原绝不串包 */
const tagHash = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

export interface MaskedTemplate {
  /** 掩码后的文本（可安全交给 Mustache / Templater） */
  text: string
  /** 把输出里的占位符还原回原始标签（作用于任何包含这些占位符的字符串） */
  restore: (rendered: string) => string
  /** 被掩码的标签数 */
  maskedCount: number
}

/**
 * 掩码文本中命中 filter 的 Templater 标签。
 * @param filter 缺省 = 掩码所有 <% %> 标签（Mustache 安全场景）；
 *               接力场景传「非插值才掩码」。
 */
export const maskTemplaterTags = (
  text: string,
  filter: (tag: ParsedTag) => boolean = () => true,
): MaskedTemplate => {
  if (!text || !text.includes('<%')) {
    return { text, restore: (s) => s, maskedCount: 0 }
  }
  const replacements = new Map<string, string>()
  let seq = 0
  const masked = text.replace(TEMPLATER_TAG_RE, (raw, offset: number) => {
    const tag: ParsedTag = { raw, index: offset, kind: classifyTag(raw) }
    if (!filter(tag)) return raw
    const placeholder = `TPMASK${MASK_NONCE}x${seq++}x${tagHash(raw)}Z`
    replacements.set(placeholder, raw)
    return placeholder
  })
  const restore = (rendered: string): string => {
    let out = rendered
    for (const [placeholder, raw] of replacements) {
      out = out.split(placeholder).join(raw)
    }
    return out
  }
  return { text: masked, restore, maskedCount: replacements.size }
}

// ---------------------------------------------------------------------------
// Templater feature-detect（未公开 API，多年稳定 + QuickAdd 同款用法；
// 全程防御式访问，任何一步不满足 → 当作没装）
// ---------------------------------------------------------------------------

interface TemplaterLike {
  files_with_pending_templates?: Set<string>
}

const getTemplater = (app: App): TemplaterLike | null => {
  try {
    const anyApp = app as unknown as {
      plugins?: { plugins?: Record<string, { templater?: TemplaterLike } | undefined> }
    }
    return anyApp.plugins?.plugins?.[TEMPLATER_PLUGIN_ID]?.templater ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// P0 加固：trigger_on_file_creation 的存量注入面
// ---------------------------------------------------------------------------

/**
 * 在本插件 `vault.create` 一个 md 文件**之前**调用：预挂
 * `files_with_pending_templates` 抑制条目；返回的 release 在 create
 * **完成后**（try/finally）调用，从那一刻起计时 900ms 再删条目。
 *
 * 计时必须从 create 完成后开始：Templater 的 trigger 在 create 事件后
 * sleep 300ms 才检查条目，若从 create **之前**就开始计时，慢设备上 create
 * 本身耗时 >600ms 时检查点会落在删除之后，抑制静默失效。
 *
 * 背景（真机 B2/B4/B3/B6 实锤）：用户开了 Templater 全局开关
 * trigger_on_file_creation 时，任何插件创建的 md 文件在 300ms 后会被 Templater
 * 按**当时的全文**执行命令 —— 本插件落盘的是全网网页正文，正文里恰好出现的
 * `<%* ... %>` 就是任意代码执行。预挂抑制条目可让 Templater 放弃处理该文件；
 * 我们只用 parse_template（不会像 overwrite_file_commands 那样顺手删掉条目），
 * 所以挂一次 + 延迟删除即可。
 *
 * 代价：这类用户的「folder template 自动应用到新建合并空文件」组合行为失效
 * —— 可接受，合并文件模板特性正是它的替代品。
 *
 * @returns release：create 结束后调用（成功失败都要调，放 finally），开始延迟删除计时
 */
export const suppressTemplaterTriggerOnCreate = (app: App, path: string): (() => void) => {
  const noop = () => { /* Templater 未装/结构缺失 */ }
  try {
    const set = getTemplater(app)?.files_with_pending_templates
    if (!set || typeof set.add !== 'function' || typeof set.delete !== 'function') {
      return noop
    }
    set.add(path)
    let released = false
    return () => {
      if (released) return
      released = true
      window.setTimeout(() => {
        try {
          set.delete(path)
        } catch {
          // 第三方内部结构变化不许影响同步
        }
      }, TRIGGER_SUPPRESS_HOLD_MS)
    }
  } catch {
    // 防御：任何异常都不能阻断创建文件
    return noop
  }
}
