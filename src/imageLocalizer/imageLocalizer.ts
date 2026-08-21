/**
 * 图片本地化核心类
 * 负责协调图片检测、下载、处理和链接替换
 */

import { App, TFile, Vault, normalizePath } from 'obsidian'
import { log, logError } from '../logger'
import {
  ImageEnqueueResult,
  ImageInfo,
  ImageProcessOptions,
  LocalizeTask,
  RemoteImageDetectionResult,
} from './types'
import { downloadImage, isRemoteImage } from './imageDownloader'
import {
  calculateMD5,
  detectImageFormat,
  convertPngToJpeg,
  saveImageToVault,
} from './imageProcessor'
import { ImageLocalizationQueue } from './imageQueue'
import { UrlLocalMap } from './urlLocalMap'
import { PendingLocalizeStore } from './pendingQueueStore'
import { render } from '../settings/template'
import { DateTime } from 'luxon'
import { Item } from '@omnivore-app/api'
import { isAlwaysLocalizeDomain, isNeverLocalizeUrl } from '../common/imageRelay'
import { LocalizerItemMeta } from '../common/localizerItemMeta'
import {
  emptyLocalizationResult,
  LocalizationResult,
} from '../common/localizationResult'
import { scanImageSyntax } from './imageSyntax'
import { unhideVaultPath } from '../util'

/**
 * 普通 Markdown 链接匹配正则（排除图片链接）
 * 匹配 [text](url) 但不匹配 ![text](url)
 * 用于检测强制本地化域名的资源
 */
const LINK_PATTERN = /(?<!!)\[([^\]]*)\]\(([^)\n]+)\)/g
/** 同篇图片有界并发；足以避免单张黑洞阻断同篇健康图片，又不压垮移动端。 */
const IMAGE_LOCALIZE_CONCURRENCY = 3

interface SessionImageEntry {
  folderPath: string
  localPath: string
}

export class ImageLocalizer {
  private app: App
  private vault: Vault
  private queue: ImageLocalizationQueue
  private options: ImageProcessOptions
  private urlLocalMap: UrlLocalMap
  // 待办任务持久化存储（重启续传用）；缺省时所有钩子是 no-op
  private pendingStore?: PendingLocalizeStore
  // 当前 drain 的共享 Promise。并发 processQueue 调用必须等待同一轮真实结果，
  // 不能在 queue.isProcessing() 时提前 resolve 并让 UI 误报成功。
  private drainPromise: Promise<LocalizationResult> | null = null
  // 会话级安全复用：相同 URL 只有在本篇算出的附件目录也相同、且目标文件仍存在时
  // 才能跳过网络。不能直接跨笔记复用 urlLocalMap，因为目录模板可能依赖 title 等。
  private sessionImageCache = new Map<string, SessionImageEntry>()
  // 网络仍保持 3 路并发；只把会占用 WebView 主线程和大块像素内存的 Canvas 转换
  // 串行化，避免三张 PNG 同时 decode/draw/toBlob。
  private pngConversionTail: Promise<void> = Promise.resolve()

  constructor(
    app: App,
    options: ImageProcessOptions,
    urlLocalMap?: UrlLocalMap,
    pendingStore?: PendingLocalizeStore,
  ) {
    this.app = app
    this.vault = app.vault
    this.queue = new ImageLocalizationQueue()
    this.options = options
    this.urlLocalMap = urlLocalMap ?? new UrlLocalMap()
    this.pendingStore = pendingStore
  }

  /**
   * 暴露 url→localPath 映射（主程序用于持久化初始化后注入）
   */
  getUrlLocalMap(): UrlLocalMap {
    return this.urlLocalMap
  }

  /**
   * 暴露待办任务持久化存储（主程序 onunload flush 用）
   */
  getPendingStore(): PendingLocalizeStore | undefined {
    return this.pendingStore
  }

  /**
   * 处理本地附件改名/移动事件（由主程序订阅 `vault.on('rename')` 转发）。
   *
   * 图床接力的「改名接力」（Paste image rename）会把已本地化的图片从 md5 路径挪走；
   * 若不同步更新 urlLocalMap，下次同步 replayLocalizedUrls 会因旧路径找不到而丢弃映射、
   * 重新下载 → 重复 / 孤儿附件。这里把映射里指向旧路径的记录改指到新路径，保持有效。
   * 对非附件（普通笔记）的 rename 是无害空操作（映射里不会有它作为 localPath）。
   */
  handleAttachmentRename(oldPath: string, newPath: string): void {
    const changed = this.urlLocalMap.renameLocalPath(oldPath, newPath)
    for (const [url, cached] of this.sessionImageCache) {
      if (cached.localPath === oldPath) this.sessionImageCache.delete(url)
    }
    if (changed > 0) {
      log(`🔁 附件改名，同步更新本地化映射: ${oldPath} → ${newPath}（${changed} 条）`)
    }
  }

  /** 用户改名/移动 Markdown 笔记时，迁移所有以笔记路径为 key 的续传状态。 */
  handleNoteRename(oldPath: string, newPath: string): void {
    const mapChanged = this.urlLocalMap.renameFileKey(oldPath, newPath)
    const pendingChanged = this.pendingStore?.renameFilePath(oldPath, newPath) ?? false
    this.queue.renameFilePath(oldPath, newPath)
    if (mapChanged || pendingChanged) {
      log(`🔁 笔记改名，迁移图片本地化状态: ${oldPath} → ${newPath}`)
    }
  }

  /**
   * 在写入前重放已知的 url→localPath 映射，避免本地化结果被同步覆盖。
   *
   * 对传入的原始 content 执行一次纯函数式替换：凡命中（filePath, url）映射的远程 URL，
   * 都被预先替换为对应的本地 wiki 链接，再交给 sync 写入 vault。
   *
   * 映射按文件路径分桶：不同笔记即便含有同一远程 URL，也能各自映射到各自的本地路径，
   * 避免一个笔记的 replay 指向另一个笔记的附件目录。
   *
   * 若目标本地文件已被用户删除，则清理该条映射并保留原远程链接，
   * 让后续 localizer 走正常下载流程重新恢复本地化结果。
   */
  replayLocalizedUrls(content: string, filePath: string): string {
    if (!content || !filePath || !this.urlLocalMap.hasFile(filePath)) return content

    const staleUrls: string[] = []
    const edits = this.collectLocalizationEdits(content, (url) => {
      const localPath = this.urlLocalMap.get(filePath, url)
      if (!localPath) return undefined
      if (!this.vault.getAbstractFileByPath(localPath)) {
        staleUrls.push(url)
        return undefined
      }
      return localPath
    })

    for (const url of staleUrls) {
      this.urlLocalMap.delete(filePath, url)
    }

    return this.applyLocalizationEdits(content, edits)
  }

  /**
   * 扫描 content 中所有应被本地化的图片/强制域名链接，返回一组位置编辑。
   *
   * resolve 回调接收远程 URL，返回可用的本地路径则纳入替换，返回 undefined 则跳过。
   * 位置索引保留匹配原文的起止，供 applyLocalizationEdits 按位置拼接使用。
   */
  private collectLocalizationEdits(
    content: string,
    resolve: (url: string) => string | undefined,
  ): { start: number; end: number; replacement: string }[] {
    const edits: { start: number; end: number; replacement: string }[] = []

    // Pass 1: 标准图片语法。共享扫描器支持嵌套括号/中括号与完整 HTML 属性语法。
    let match: RegExpExecArray | null
    for (const imageMatch of scanImageSyntax(content)) {
      const {
        fullText,
        url,
        alt: parsedAlt,
        startIndex,
        endIndex,
        kind,
      } = imageMatch
      if (isNeverLocalizeUrl(url)) continue
      const localPath = resolve(url)
      if (!localPath) continue

      let start = startIndex
      let end = endIndex
      const alt = parsedAlt
      const isHtml = kind === 'html'

      // 可点击图片（image 紧贴包在外层 markdown 链接里）：
      //   `[![alt](img)](outer)` / `[<img src="img">](outer)`
      // 文章 HTML `<a href><img></a>` 经 HTML→Markdown 就是这个形态。
      // 若只把内层图片换成 wiki 嵌入，会得到 `[![[local|alt]]](outer)` ——
      // Obsidian 不渲染「套在链接里的 ![[]] 嵌入」，阅读视图只剩外链箭头图标，
      // 图片不显示，且外层远程 URL 也没被本地化。
      // 解决：把外层 `[ ... ]( outer )` wrapper 一并吞掉，替换成独立嵌入。
      let liftOut = false
      if (content[start - 1] === '[') {
        const wrap = /^\s*\/?>?\s*\]\(([^)\n]+)\)/.exec(content.slice(end))
        if (wrap) {
          start -= 1
          end += wrap[0].length
        }
      } else if (isHtml) {
        // 独子 <p> 包装：`<p …><img …></p>` 整体吞掉，避免留下空 <p></p>。
        const before = /<p\b[^>]*>\s*$/.exec(
          content.slice(Math.max(0, start - 400), start),
        )
        const after = /^\s*<\/p>/.exec(content.slice(end))
        if (before && after) {
          start -= before[0].length
          end += after[0].length
        }
        // HTML 块上下文判定：所在行以 `<` 开头时（CommonMark HTML block），
        // Obsidian 不解析块内的 ![[…]] —— 必须用空行把嵌入提为独立 markdown
        // 块（空行终结 HTML block，嵌入恢复渲染）。行内 HTML（行首是普通
        // 文字 / 引用符）保持内联替换。
        const lineStart = content.lastIndexOf('\n', start - 1) + 1
        liftOut = /^\s{0,3}</.test(content.slice(lineStart, start + 1))
      }

      const embed = this.generateMarkdownLink(
        {
          originalUrl: url,
          originalText: fullText,
          alt,
          startIndex: 0,
          endIndex: 0,
        },
        localPath,
      )
      edits.push({
        start,
        end,
        replacement: liftOut ? `\n\n${embed}\n\n` : embed,
      })
    }

    // Pass 2: 强制本地化域名的普通链接（需按位置判断 📎 前缀，逐条跳过）
    LINK_PATTERN.lastIndex = 0
    while ((match = LINK_PATTERN.exec(content)) !== null) {
      const [fullMatch, linkText, url] = match
      if (!url) continue
      if (!isAlwaysLocalizeDomain(url)) continue
      const prefixStart = Math.max(0, match.index - 10)
      const prefix = content.substring(prefixStart, match.index)
      if (prefix.includes('📎')) continue
      const localPath = resolve(url)
      if (!localPath) continue
      edits.push({
        start: match.index,
        end: match.index + fullMatch.length,
        replacement: this.generateMarkdownLink(
          {
            originalUrl: url,
            originalText: fullMatch,
            alt: linkText || undefined,
            startIndex: 0,
            endIndex: 0,
          },
          localPath,
        ),
      })
    }

    return edits
  }

  /**
   * 按位置应用编辑（非 split/join），避免误改写其它位置上形状相同的片段。
   */
  private applyLocalizationEdits(
    content: string,
    edits: { start: number; end: number; replacement: string }[],
  ): string {
    if (edits.length === 0) return content
    edits.sort((a, b) => a.start - b.start)
    const parts: string[] = []
    let cursor = 0
    for (const edit of edits) {
      if (edit.start < cursor) continue // 防御性重叠保护
      parts.push(content.slice(cursor, edit.start))
      parts.push(edit.replacement)
      cursor = edit.end
    }
    parts.push(content.slice(cursor))
    return parts.join('')
  }

  /**
   * 更新处理选项
   */
  updateOptions(options: ImageProcessOptions): void {
    this.options = options
  }

  /**
   * 检测笔记中的网络图片（读文件 + 扫描）。
   *
   * 读失败返回独立的 read-failed 状态，绝不再伪装成 []。否则 enqueue 会把
   * “读不到”误判成“确实没有远程图”，进而删除续传记录并向 UI 报成功。
   */
  async detectRemoteImages(file: TFile): Promise<RemoteImageDetectionResult> {
    try {
      const content = await this.vault.read(file)
      return { status: 'ok', images: this.scanRemoteImages(content, file.path) }
    } catch (error) {
      logError(`检测图片失败: ${file.path}`, error)
      return { status: 'read-failed', images: [] }
    }
  }

  /**
   * 纯扫描：从已读到的 content 里提取需本地化的网络图片（无 IO、无副作用）。
   * 与 detectRemoteImages 内联版本行为一致，抽出来让 localizeFile 能用「自管 read
   * + 扫描」，从而把读文件失败如实上报为整文件级失败（codex 应修#6）。
   */
  private scanRemoteImages(content: string, filePath: string): ImageInfo[] {
    const images: ImageInfo[] = []

    let match: RegExpExecArray | null

      // 第一遍：匹配标准图片语法（![](url), ![[url]], <img src="url">）
      for (const imageMatch of scanImageSyntax(content)) {
        const { fullText, url, alt, startIndex, endIndex } = imageMatch

        // 检查是否为网络图片
        if (!isRemoteImage(url)) {
          log(`跳过非网络图片: ${url}`)
          continue
        }
        // 绝不本地化的 UI 元素（如积分充值二维码），保持远程 HTML 原样渲染
        if (isNeverLocalizeUrl(url)) {
          log(`跳过绝不本地化域名: ${url}`)
          continue
        }
        log(`检测到网络图片: ${url}`)

        images.push({
          originalUrl: url,
          originalText: fullText,
          alt,
          startIndex,
          endIndex,
        })
      }

      // 第二遍：匹配强制本地化域名在普通链接中的资源（[text](url)，非图片语法）
      LINK_PATTERN.lastIndex = 0
      while ((match = LINK_PATTERN.exec(content)) !== null) {
        const [fullMatch, linkText, url] = match
        if (!url) continue
        if (!isRemoteImage(url)) continue
        if (!isAlwaysLocalizeDomain(url)) continue

        // 跳过 📎 前缀的附件链接，由附件本地化器（AttachmentLocalizer）处理
        // 📎 在 JS 中占 2 个字符，加上可能的空格，往前看 10 个字符
        const prefixStart = Math.max(0, match.index - 10)
        const prefix = content.substring(prefixStart, match.index)
        if (prefix.includes('📎')) continue

        images.push({
          originalUrl: url,
          originalText: fullMatch,
          alt: linkText || undefined,
          startIndex: match.index,
          endIndex: match.index + fullMatch.length,
        })
      }

    log(`检测到 ${images.length} 张网络图片: ${filePath}`)
    return images
  }

  /**
   * 本地化单个文件中的所有图片
   * @param fileOrTask 笔记文件 或 完整任务（含 meta）。直接传 TFile 等价于
   *   不附带 meta（generateFolderPath 会回退到 null/empty Item，模板里的
   *   {{{siteName}}} 等字段会渲染为空）。sync / processQueue 通常传完整 task。
   * @returns 是否「已把该文件的所有远程图片都本地化」。
   *   - true：本文件没有远程图 / 全部图片成功落盘并改写。
   *   - false：至少有一张远程图未能本地化（下载失败 / 图床源站未就绪 / 保存失败），
   *     或整文件级错误。成功的那部分图片仍会被替换；未成功的保留原始远程链接。
   *   processQueue 据此决定：全部完成 → 清除续传记录；否则 → 【保留】续传记录，
   *   交给后续同步 / 重启重试（图床未就绪属瞬态，绝不能丢任务）。
   *
   *   历史语义变更（2026-07）：旧实现「单张图下载失败不影响结果、恒返回 true」会
   *   把「图床未就绪导致下载失败」误判为成功 → 清除续传记录 → 永不重试，且配合
   *   下载层缺校验时还会把占位/错误页当图片存下并替换链接。现改为如实反映
   *   「是否全部本地化」。见 tests/relayImageNotReady.repro.spec.ts。
   */
  async localizeFile(
    fileOrTask: TFile | LocalizeTask,
    onImageDone?: () => void,
  ): Promise<boolean> {
    const task: LocalizeTask | { file: TFile; meta?: LocalizerItemMeta } =
      fileOrTask instanceof TFile ? { file: fileOrTask } : fileOrTask
    const { file, meta } = task
    try {
      log(`开始本地化图片: ${file.path}`)

      // 自管 read + 扫描：读文件失败要如实上报为「未完成」（return false → 保留续传），
      // 不能像 detectRemoteImages 那样把读失败吞成 [] 后误当「无图完成」清掉续传记录
      // （codex 应修#6）。
      let content: string
      try {
        content = await this.vault.read(file)
      } catch (error) {
        logError(`读取笔记失败，保留续传记录待重试: ${file.path}`, error)
        return false
      }
      const images = this.scanRemoteImages(content, file.path)
      if (images.length === 0) {
        log(`没有需要本地化的图片: ${file.path}`)
        return true
      }

      const urlToLocal = new Map<string, string>()
      // 是否本文件的每一张远程图都成功本地化。任一张失败（下载失败 / 图床源站
      // 未就绪 / 保存抛错）都会置 false，最终作为返回值让 processQueue 保留续传记录。
      let allResolved = true

      // 不同 URL 最多 3 路并发，避免黑洞/弱网图片阻断同篇健康图。同 URL 用 promise
      // 链串行，避免两个 worker 同时 createBinary 同一路径；真实 vault 中后一个会命中
      // 刚落盘的缓存，且每个语法命中仍各推进一次进度。
      const work = images
      let nextIndex = 0
      const urlChains = new Map<string, Promise<void>>()
      const worker = async (): Promise<void> => {
        while (nextIndex < work.length) {
          const image = work[nextIndex++]
          const previous = urlChains.get(image.originalUrl) ?? Promise.resolve()
          const current = previous.then(async () => {
            try {
              const localPath = await this.processImage(image, file, meta)
              if (localPath) {
                this.urlLocalMap.set(file.path, image.originalUrl, localPath)
                urlToLocal.set(image.originalUrl, localPath)
              } else {
                allResolved = false
              }
            } catch (error) {
              allResolved = false
              logError(`处理图片失败: ${image.originalUrl}`, error)
            } finally {
              onImageDone?.()
            }
          })
          urlChains.set(image.originalUrl, current)
          await current
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(IMAGE_LOCALIZE_CONCURRENCY, work.length) },
          () => worker(),
        ),
      )

      // 使用 vault.process 原子地读取-替换-写入，避免覆盖用户的编辑器修改。
      // 注：在 process 回调里对 content 重新跑一次检测正则，按命中位置替换，
      // 避免 split/join 把其它位置上形状相同但不应处理的片段（如 📎 前缀附件）一并改写。
      if (urlToLocal.size > 0) {
        let replaceCount = 0
        const result = await this.vault.process(file, (content) => {
          const edits = this.collectLocalizationEdits(content, (url) => urlToLocal.get(url))
          if (edits.length === 0) return content
          replaceCount = edits.length
          return this.applyLocalizationEdits(content, edits)
        })
        log(`图片本地化完成: ${file.path} (${replaceCount}/${images.length})`)

        // 验证：process 返回写入后的内容，直接验证「本应被替换的（成功下载的）」
        // 链接是否都已改写。未成功下载的图（allResolved=false）保留远程链接是
        // 预期行为，不算写入验证失败。
        const unreplaced = [...urlToLocal.keys()].filter((url) => result.includes(url))
        if (unreplaced.length > 0) {
          // 已成功下载却没改写进正文（位置匹配异常等）→ 本文件未完成，保留续传记录
          // 待重试，绝不能算成功后清掉记录（codex 应修#5）。
          allResolved = false
          log(`⚠️ 写入验证失败! 已下载但未改写的链接残留: ${file.path}`)
          for (const url of unreplaced) log(`  未替换: ${url}`)
        } else {
          log(`✅ 写入验证通过: 已下载的远程图片链接均已替换: ${file.path}`)
        }
      }
      return allResolved
    } catch (error) {
      logError(`本地化文件失败: ${file.path}`, error)
      return false
    }
  }

  /**
   * 处理单张图片（下载、转换、保存）
   * @param image 图片信息
   * @param file 所属文件
   * @returns 本地文件路径，失败返回 null
   */
  private async processImage(
    image: ImageInfo,
    file: TFile,
    meta?: LocalizerItemMeta,
  ): Promise<string | null> {
    try {
      const url = image.originalUrl

      // 单图断点续传：上个会话已下载并记录映射的图片直接复用。
      // urlLocalMap 每张图成功即记录且持久化，重启后据此跳过重复下载。
      // 命中条件收紧为 instanceof TFile，避免同名文件夹等异常路径把
      // markdown 改写到不可用的 embed。
      const mapped = this.urlLocalMap.get(file.path, url)
      if (mapped && this.vault.getAbstractFileByPath(mapped) instanceof TFile) {
        log(`使用已记录的本地图片（断点续传）: ${url} -> ${mapped}`)
        return mapped
      }

      // 目录必须用当前笔记的完整模板上下文计算；仅当缓存记录来自相同目录，
      // 且附件仍是实际文件时，才可安全跨笔记复用，避免重复下载/读盘/逐字节比较。
      const folderPath = this.generateFolderPath(file, meta)
      const sessionEntry = this.sessionImageCache.get(url)
      if (sessionEntry?.folderPath === folderPath) {
        if (
          this.vault.getAbstractFileByPath(sessionEntry.localPath) instanceof TFile
        ) {
          log(`复用会话内已下载图片: ${url} -> ${sessionEntry.localPath}`)
          return sessionEntry.localPath
        }
        this.sessionImageCache.delete(url)
      }

      // 下载图片
      const downloadResult = await downloadImage(
        url,
        this.options.maxRetries,
        this.options.retryDelay
      )

      if (!downloadResult.success || !downloadResult.data) {
        logError(`下载失败: ${url}`)
        return null
      }

      let imageData = downloadResult.data

      // 检测图片格式
      const format = detectImageFormat(imageData)
      log(`图片格式: ${format} - ${url}`)

      // PNG 转 JPEG（如果启用）
      let finalFormat = format
      if (
        this.options.enablePngToJpeg &&
        format === 'png'
      ) {
        try {
          log(`转换 PNG → JPEG: ${url}`)
          imageData = await this.convertPngToJpegSerially(
            imageData,
            this.options.jpegQuality / 100
          )
          finalFormat = 'jpg'
          log(`转换成功: ${url}`)
        } catch (error) {
          logError(`PNG转JPEG失败，使用原格式: ${url}`, error)
        }
      }

      // 计算 MD5
      const md5 = calculateMD5(imageData)

      // 生成文件名
      const extension = finalFormat === 'unknown' ? 'png' : finalFormat
      const fileName = `${md5}.${extension}`

      // 保存图片
      const localPath = await saveImageToVault(
        this.vault,
        folderPath,
        fileName,
        imageData
      )

      // 只有保存成功后才写缓存；失败路径不会留下指向半成品/不存在文件的记录。
      this.sessionImageCache.set(url, { folderPath, localPath })
      return localPath
    } catch (error) {
      logError(`处理图片失败: ${image.originalUrl}`, error)
      return null
    }
  }

  private async convertPngToJpegSerially(
    data: ArrayBuffer,
    quality: number,
  ): Promise<ArrayBuffer> {
    const conversion = this.pngConversionTail.then(() =>
      convertPngToJpeg(data, quality),
    )
    // 无论本次转换成功还是失败都释放队列，不能让一次坏 PNG 永久毒死后续转换。
    this.pngConversionTail = conversion.then(
      () => undefined,
      () => undefined,
    )
    return conversion
  }

  /**
   * 生成图片存储文件夹路径
   * @param file 笔记文件
   * @param meta sync/relocalize 喂进来的笔记 Item 上下文；缺失时回退到 null/empty
   *             Item（此时模板里的 {{{siteName}}} / {{{author}}} / {{{originalUrl}}}
   *             / publishedAt|readAt|archivedAt|updatedAt 系列拆解会渲染为空串）。
   */
  private generateFolderPath(file: TFile, meta?: LocalizerItemMeta): string {
    const savedAt =
      meta?.savedAt ?? DateTime.now().toISO() ?? new Date().toISOString()
    const tempItem: Item = {
      id: meta?.id ?? '',
      title: file.basename,
      siteName: meta?.siteName ?? null,
      originalArticleUrl: meta?.originalArticleUrl ?? null,
      author: meta?.author ?? null,
      description: meta?.description ?? null,
      slug: meta?.slug ?? '',
      labels: null,
      highlights: null,
      updatedAt: meta?.updatedAt ?? null,
      savedAt,
      pageType: meta?.pageType ?? 'ARTICLE',
      content: null,
      publishedAt: meta?.publishedAt ?? null,
      // url 兜底给 originalUrl 渲染路径：FILE 类型可能 originalArticleUrl=null 但 url 有值
      url: meta?.url ?? meta?.originalArticleUrl ?? '',
      image: meta?.image ?? null,
      readAt: meta?.readAt ?? null,
      wordsCount: meta?.wordsCount ?? null,
      readingProgressPercent: meta?.readingProgressPercent ?? 0,
      isArchived: meta?.isArchived ?? false,
      archivedAt: meta?.archivedAt ?? null,
      contentReader: null,
    }

    const folderPath = render(
      tempItem,
      this.options.attachmentFolder,
      this.options.folderDateFormat,
      // isMessage 用 sync 管线按真实标题算好的值，不从 file.basename 反推
      // （自定义 singleFileName 去掉「同步助手_」前缀时反推会误判）
      { pathSafe: true, isMessage: meta?.isMessage },
    )

    return unhideVaultPath(normalizePath(folderPath))
  }

  /**
   * 生成 Markdown 图片链接
   * @param image 图片信息
   * @param localPath 本地路径
   */
  private generateMarkdownLink(image: ImageInfo, localPath: string): string {
    // 优先使用 Wiki 链接格式（Obsidian 推荐）
    if (image.alt) {
      return `![[${localPath}|${image.alt}]]`
    }

    return `![[${localPath}]]`
  }

  /**
   * 添加文件到本地化队列
   *
   * @param file 笔记文件
   * @param metaOrSavedAt 笔记的 Item 上下文（推荐），或仅 savedAt 字符串
   *   （历史兼容 overload —— 旧调用方传字符串 savedAt 仍工作，等价于
   *   { savedAt: <string> }，其他 Item 字段全空）。
   *
   * 同一文件多次 enqueue：队列里已有任务时不重复入队，但会用最新的 meta
   * 覆盖已排队任务的 meta（last-write-wins）。这与历史 fileSavedAtMap 的
   * "二次 set 覆盖 savedAt" 行为一致；如果第二次 enqueue 没带 meta，则
   * 保留旧 meta 不动。
   */
  async enqueueFile(
    file: TFile,
    metaOrSavedAt?: LocalizerItemMeta | string,
  ): Promise<ImageEnqueueResult> {
    return this.enqueueFileInternal(file, normalizeMetaArg(metaOrSavedAt), 0)
  }

  /**
   * enqueueFile 主体 + 续传专用的 initialRetryCount 参数（resumePending 用，
   * 跨重启保留重试预算，避免永久失败的图无限重启重试）。
   *
   * pendingStore 写路径与内存队列对称（见设计文档 §3.3）：
   * - 成功入队 / 重复入队刷新 meta → upsert
   * - 检出 0 张远程图 → remove（自愈清理上个会话的 stale 记录）
   * - in-flight 命中（文件正被处理）→ 不入队，仅刷新已有记录的 meta
   *
   * @returns 明确的入队结果。读失败与确实没有远程图严格分开，且重复排队 /
   *   正在处理也分别上报，供右键入口判断自己点击的文件处于哪种状态。
   */
  private async enqueueFileInternal(
    file: TFile,
    meta: LocalizerItemMeta | undefined,
    initialRetryCount: number,
  ): Promise<ImageEnqueueResult> {
    const filePath = file.path

    // 🆕 优先检查：避免队列内重复任务
    // 注：不再基于 processedFiles 早退。只要检测到文件中仍存在远程图片就允许重入队，
    // 让本地化器在同步覆盖后可以自愈。processedCount 仍会统计，供调用方参考。
    const existing = this.queue.findTaskByPath(filePath)
    if (existing) {
      if (meta) existing.meta = meta
      // 内存任务刷新了 meta，store 必须同步，否则崩溃恢复后会用旧 meta
      // 生成错误的附件目录
      this.pendingStore?.upsert({
        filePath,
        meta: existing.meta,
        retryCount: existing.retryCount,
        createdAt: existing.createdAt,
      })
      log(`文件已在队列中，跳过（已刷新 meta=${meta ? 'yes' : 'no'}）: ${filePath}`)
      return 'already-queued'
    }

    // in-flight 去重：文件正在被 processQueue 处理（已 dequeue、不在 queue[]），
    // 此窗口内重复入队会造成顺序重复本地化。只刷新 store meta，不入队。
    if (this.queue.getActivePath() === filePath) {
      const rec = this.pendingStore?.get(filePath)
      if (rec && meta) {
        this.pendingStore?.upsert({ ...rec, meta })
      }
      log(`文件正在处理中，跳过入队: ${filePath}`)
      return 'processing'
    }

    const detected = await this.detectRemoteImages(file)
    if (detected.status === 'read-failed') {
      // 读取失败时保留已有续传记录；不能 remove，更不能向上伪装成“没有图片”。
      log(`读取笔记失败，保留续传记录且不上报成功: ${file.path}`)
      return 'read-failed'
    }
    const { images } = detected
    if (images.length === 0) {
      log(`没有网络图片，跳过入队: ${file.path}`)
      // 自愈：上个会话的续传记录指向的文件已无远程图（被编辑/已手动本地化）
      this.pendingStore?.remove(filePath)
      return 'no-remote-images'
    }

    const createdAt = Date.now()
    this.queue.enqueue({
      file,
      images,
      createdAt,
      retryCount: initialRetryCount,
      meta,
    })
    this.pendingStore?.upsert({
      filePath,
      meta,
      retryCount: initialRetryCount,
      createdAt,
    })
    return 'enqueued'
  }

  /**
   * 重启续传入口：把持久化的待办任务重新入队并处理。
   *
   * @param resolveFile 把存储的 filePath 解析回 TFile；返回 null 表示文件
   *   已不存在（记录会被清除）。由调用方注入以便单测。
   * @returns 实际重新入队处理的文件数
   *
   * 调用方（main.ts）保证：延迟启动（onLayoutReady + 双重 setTimeout）、
   * fire-and-forget、imageMode === LOCAL 才触发。
   */
  async resumePending(resolveFile: (filePath: string) => TFile | null): Promise<number> {
    // 重启是很强的重试信号：不设冷却，续传队列全部立即重挂重试。
    const resumed = await this.enqueuePendingRecords(resolveFile, 0)
    if (resumed > 0) {
      log(`🔁 发现 ${resumed} 个未完成的图片本地化任务，开始续传`)
    }
    await this.processQueue()
    return resumed
  }

  /**
   * 把持久化的续传记录重新挂回内存队列（只入队，不处理）。
   *
   * 供两条路径复用：
   *   - resumePending（重启后）：入队 + processQueue，cooldownMs=0（重启即重试）。
   *   - 每次同步的图片阶段（main.ts）：把上次遗留的续传任务（图床当时未就绪等）
   *     与本次新同步的笔记一起入队处理，实现「后续再同步时再尝试下载及替换」；
   *     传一个较大的 cooldownMs，避免同一条永久失败任务在密集同步里被反复 hammer
   *     （codex 应修#7）。
   *
   * @param resolveFile 把存储的 filePath 解析回 TFile；返回 null 表示文件已不存在
   *   （记录会被清除）。
   * @param cooldownMs 冷却窗口：距上次失败尝试不足此毫秒数的记录本轮跳过（不重挂）。
   *   0 表示不冷却（全部重挂）。
   * @returns 实际【新入队】的记录数（跳过 / 去重命中的不计）。
   */
  async enqueuePendingRecords(
    resolveFile: (filePath: string) => TFile | null,
    cooldownMs = 0,
  ): Promise<number> {
    const store = this.pendingStore
    if (!store) return 0
    const records = store.list()
    if (records.length === 0) return 0

    const now = Date.now()
    let resumed = 0
    for (const record of records) {
      // 冷却：距上次失败尝试太近的任务本轮跳过，等冷却过后的同步 / 重启再试。
      if (
        cooldownMs > 0 &&
        typeof record.lastAttemptAt === 'number' &&
        now - record.lastAttemptAt < cooldownMs
      ) {
        continue
      }
      const file = resolveFile(record.filePath)
      if (!file) {
        // 笔记已被删除，放弃该任务
        store.remove(record.filePath)
        continue
      }
      if (
        (await this.enqueueFileInternal(file, record.meta, record.retryCount)) ===
        'enqueued'
      ) {
        resumed++
      }
    }
    return resumed
  }

  /**
   * 预扫描当前队列里所有待处理任务，数出需要本地化的远程图片总数。
   *
   * detectRemoteImages 是纯函数（读文件 + 正则，无网络、无副作用），所以这里
   * 的预扫描成本极低，且和 localizeFile 内部跑的是同一套检测逻辑 —— 二者数到
   * 的图片集合一致，故进度条分母（本方法）与每图 onImageDone 自增（localizeFile）
   * 天然对齐：同步链路里两次检测之间文件内容不变，processed 最终恰好等于 total。
   *
   * 给右上角进度条提供「图片级」分母用（取代旧的「文件级」size()）。
   */
  async countQueuedRemoteImages(): Promise<number> {
    let total = 0
    for (const task of this.queue.getTasks()) {
      const detected = await this.detectRemoteImages(task.file)
      if (detected.status === 'ok') total += detected.images.length
    }
    return total
  }

  /**
   * 处理队列中的任务
   *
   * @param onImageProgress 每下载完一张图片回调一次（成功/失败/命中缓存都算）。
   *   配合 countQueuedRemoteImages() 数出的总数，让进度条按真实图片数推进，
   *   而非按文件数 —— 弱网下单篇多图笔记不再卡在 0/1 直到整篇下完才跳满。
   */
  async processQueue(onImageProgress?: () => void): Promise<LocalizationResult> {
    // 同步/续传已经在 drain 时，右键调用必须等待它，而不是提前 resolve。
    const shared = this.drainPromise
    if (shared) {
      const sharedResult = await shared
      // 那一轮 drain 可能【已经越过】我们刚入队的任务就退出了循环（它的 while
      // 只在每次迭代前查 isEmpty）。此时若直接返回它的结果，右键会拿着一份
      // 不包含自己文件的结果报「完成」—— 正是本次要根除的"提示说谎"。
      // 属主仍持有引用 = 确实还在同一轮里跑，交给它；否则队列还有活就自己再 drain 一轮。
      if (this.drainPromise === shared || this.queue.isEmpty()) return sharedResult
      const ownResult = await this.processQueue(onImageProgress)
      return {
        total: sharedResult.total + ownResult.total,
        succeeded: sharedResult.succeeded + ownResult.succeeded,
        failed: sharedResult.failed + ownResult.failed,
        failedFiles: [...sharedResult.failedFiles, ...ownResult.failedFiles],
      }
    }
    if (this.queue.isEmpty()) return emptyLocalizationResult()

    const drain = this.drainQueue(onImageProgress)
    this.drainPromise = drain
    try {
      return await drain
    } finally {
      if (this.drainPromise === drain) this.drainPromise = null
    }
  }

  private async drainQueue(
    onImageProgress?: () => void,
  ): Promise<LocalizationResult> {
    this.queue.setProcessing(true)
    log('开始处理图片本地化队列...')
    const result = emptyLocalizationResult()

    try {
      while (!this.queue.isEmpty()) {
        const task = this.queue.dequeue()
        if (!task) break
        result.total++

        // in-flight 标记：task 已不在 queue[]，去重需要靠 activePath 兜住
        this.queue.setActivePath(task.file.path)
        let ok = false
        try {
          // 把整个 task 传下去 —— task.meta 决定 generateFolderPath 的模板变量上下文
          ok = await this.localizeFile(task, onImageProgress)
        } catch (error) {
          // localizeFile 内部已 catch 所有异常并返回 false；这里只是双保险
          logError(`处理任务失败: ${task.file.path}`, error)
        } finally {
          this.queue.setActivePath(null)
        }

        if (ok) {
          // 本文件所有远程图都本地化成功 → 标记完成并清除续传记录
          this.queue.markAsProcessed(task.file.path)
          this.pendingStore?.remove(task.file.path)
          result.succeeded++
        } else {
          result.failed++
          result.failedFiles.push(task.file.path)
          // 本轮未能全部本地化（图床源站未就绪 / 下载失败 / 保存失败）。
          // 会话内已由下载层做过指数退避重试（imageDownloadRetries 次）；这里
          // 【不再】立即重排在会话内狂刷（避免弱网下 hammer 图床），而是【保留】
          // 续传记录，交给后续同步（enqueuePendingRecords）或下次重启
          // （resumePending）再试，直到源站就绪能下到真图。
          //
          // ⚠️ 绝不再「重试预算耗尽即 remove 丢弃」——图床未就绪是【瞬态】失败，
          // 丢任务会导致原始远程链接永远不被本地化（钉红：Defect B）。retryCount
          // 仅作跨会话诊断累加，不再充当丢弃闸门。stale / 已无远程图 / 笔记被删
          // 等的自愈清理仍由 enqueueFileInternal / resumePending 负责。
          task.retryCount++
          this.pendingStore?.upsert({
            filePath: task.file.path,
            meta: task.meta,
            retryCount: task.retryCount,
            createdAt: task.createdAt,
            // 记录本次尝试时间：后续同步重挂时据此做冷却，避免密集同步 hammer 图床。
            lastAttemptAt: Date.now(),
          })
          log(`任务未完成，保留续传记录（累计第 ${task.retryCount} 次未果）: ${task.file.path}`)
        }
      }
    } finally {
      // finally 保证异常路径也能复位 processing flag，否则队列会永久卡 processing
      this.queue.setProcessing(false)
      log('图片本地化队列处理完成')
    }
    return result
  }

  /**
   * 获取队列统计信息
   */
  getQueueStats() {
    return this.queue.getStats()
  }

  /**
   * 清除指定文件的已处理标记（用于右键重新本地化）
   */
  clearProcessedMark(filePath: string): void {
    this.queue.unmarkAsProcessed(filePath)
  }

  /**
   * 清空队列（连同持久化的续传记录）
   */
  clearQueue(): void {
    this.queue.clear()
    this.pendingStore?.clear()
  }

  /** 清除仅用于减少本会话重复网络请求的缓存；持久化 urlLocalMap 不受影响。 */
  clearCache(): void {
    this.sessionImageCache.clear()
  }
}

/**
 * 把 enqueueFile 的 overload 第二参（meta 对象 / savedAt 字符串 / undefined）
 * 归一化成 LocalizerItemMeta | undefined。
 *   - 非空字符串 → { savedAt: <string> }
 *   - 普通对象 → 直接透传
 *   - null / 空字符串 / 非 object → undefined（视为没传 meta）
 */
function normalizeMetaArg(
  arg: LocalizerItemMeta | string | undefined,
): LocalizerItemMeta | undefined {
  if (arg === undefined || arg === null) return undefined
  if (typeof arg === 'string') {
    const trimmed = arg.trim()
    return trimmed ? { savedAt: trimmed } : undefined
  }
  if (typeof arg === 'object') return arg
  return undefined
}
