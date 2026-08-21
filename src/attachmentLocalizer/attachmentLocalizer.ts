/**
 * 附件本地化核心类
 * 负责协调附件检测、下载和链接替换
 *
 * 附件格式示例：
 * 📎 [这是一个PPT.ppt](http://www.bijitongbu.site:8091/wecom4/2025/12/xxx) (0.24MB)
 */

import { App, TFile, Vault, normalizePath } from 'obsidian'
import { log, logError } from '../logger'
import {
  AttachmentEnqueueResult,
  AttachmentInfo,
  AttachmentLocalizeTask,
  AttachmentProcessOptions,
  RemoteAttachmentDetectionResult,
} from './types'
import { downloadAttachment, isRemoteAttachment } from './attachmentDownloader'
import { ensureFolderExists } from '../imageLocalizer/imageProcessor'
import { AttachmentLocalizationQueue } from './attachmentQueue'
import { render } from '../settings/template'
import { DateTime } from 'luxon'
import { Item } from '@omnivore-app/api'
import { LocalizerItemMeta } from '../common/localizerItemMeta'
import {
  emptyLocalizationResult,
  LocalizationResult,
} from '../common/localizationResult'
import { unhideNameSegment, unhideVaultPath } from '../util'

/**
 * 附件链接匹配正则表达式
 * 匹配格式：📎 [文件名.ext](URL) (大小)
 * 或者不带表情符号的格式：[文件名.ext](URL) (大小MB/KB)
 *
 * 捕获组：
 * 1. 文件名（如：这是一个PPT.ppt）
 * 2. URL
 * 3. 文件大小（可选，如：0.24MB）
 */
const ATTACHMENT_PATTERN = /📎\s*\[([^\]]+)\]\(([^)]+)\)(?:\s*\(([^)]+)\))?/g

/**
 * 判断 item 是否为企微文件消息（基于 description 元数据）
 * 双保险的第一层: 在同步阶段通过元数据提前识别文件类型
 */
export function isWeComFileMessage(item: { description?: string | null }): boolean {
  if (!item.description) return false
  return item.description.includes('来自企微的file消息')
}

/**
 * 从企微文件消息的 content 中提取附件信息
 * content 格式: 📎 [文件名.ext](url) (大小)\n\n
 * @returns 附件信息，未找到返回 null
 */
export function extractFileAttachmentFromContent(
  content: string | null,
): { fileName: string; url: string; fileSize?: string } | null {
  if (!content) return null
  ATTACHMENT_PATTERN.lastIndex = 0
  const match = ATTACHMENT_PATTERN.exec(content)
  if (!match) return null
  return {
    fileName: match[1],
    url: match[2],
    fileSize: match[3],
  }
}

export class AttachmentLocalizer {
  private app: App
  private vault: Vault
  private queue: AttachmentLocalizationQueue
  private options: AttachmentProcessOptions

  constructor(app: App, options: AttachmentProcessOptions) {
    this.app = app
    this.vault = app.vault
    this.queue = new AttachmentLocalizationQueue()
    this.options = options
  }

  /**
   * 更新处理选项
   */
  updateOptions(options: AttachmentProcessOptions): void {
    this.options = options
  }

  /**
   * 检测笔记中的远程附件
   * @param file 笔记文件
   * @returns 远程附件列表
   */
  async detectRemoteAttachments(file: TFile): Promise<RemoteAttachmentDetectionResult> {
    try {
      const content = await this.vault.read(file)
      const attachments: AttachmentInfo[] = []

      let match: RegExpExecArray | null

      // 重置正则表达式的 lastIndex
      ATTACHMENT_PATTERN.lastIndex = 0

      while ((match = ATTACHMENT_PATTERN.exec(content)) !== null) {
        const [fullMatch, fileName, url, fileSize] = match

        // 检查是否为远程附件
        if (!isRemoteAttachment(url)) {
          continue
        }

        attachments.push({
          originalUrl: url,
          originalText: fullMatch,
          fileName: fileName,
          fileSize: fileSize,
          startIndex: match.index,
          endIndex: match.index + fullMatch.length,
        })
      }

      if (attachments.length > 0) {
        log(`检测到 ${attachments.length} 个远程附件: ${file.path}`)
      }
      return { status: 'ok', attachments }
    } catch (error) {
      logError(`检测附件失败: ${file.path}`, error)
      return { status: 'read-failed', attachments: [] }
    }
  }

  /**
   * 本地化单个文件中的所有附件
   * @param fileOrTask 笔记文件 或 完整任务（含 meta）。直接传 TFile 等价于
   *   不附带 meta（generateFolderPath 会回退到 null/empty Item）。
   */
  async localizeFile(
    fileOrTask: TFile | AttachmentLocalizeTask,
  ): Promise<boolean> {
    const task: { file: TFile; meta?: LocalizerItemMeta } =
      fileOrTask instanceof TFile ? { file: fileOrTask } : fileOrTask
    const { file, meta } = task
    try {
      log(`开始本地化附件: ${file.path}`)

      // 检测远程附件
      const detected = await this.detectRemoteAttachments(file)
      if (detected.status === 'read-failed') {
        logError(`读取笔记失败，附件保留待重试: ${file.path}`)
        return false
      }
      const { attachments } = detected
      if (attachments.length === 0) {
        log(`没有需要本地化的附件: ${file.path}`)
        return true
      }

      const replacements: { original: string; local: string }[] = []
      let allLocalized = true

      // 先下载所有附件（耗时操作）
      for (const attachment of attachments) {
        try {
          const result = await this.processAttachment(attachment, file, meta)
          if (result) {
            replacements.push({
              original: attachment.originalText,
              local: result.replacement,
            })
            // terminal（源站 NoSuchKey 真过期）是【永久】失败：再同步多少次也回不来。
            // 它已经在正文里留下 ⚠️已过期 标记，算"能做的都做完了"，绝不能计入
            // 可重试失败 —— 否则任务永远排回队列，每次同步重下一次、再追加一个标记。
            if (!result.localized && !result.terminal) allLocalized = false
          } else {
            allLocalized = false
          }
        } catch (error) {
          allLocalized = false
          logError(`处理附件失败: ${attachment.originalUrl}`, error)
        }
      }

      // 使用 vault.process 原子地读取-替换-写入，避免覆盖用户的编辑器修改
      if (replacements.length > 0) {
        await this.vault.process(file, (content) => {
          for (const { original, local } of replacements) {
            // 幂等护栏：目标文本已在正文里就跳过。同文件里"过期附件 + 瞬态失败附件"
            // 并存时整篇会重排重试，若不判重，过期那条的 ⚠️已过期 会每轮再追加一个。
            if (content.includes(local)) continue
            content = content.split(original).join(local)
          }
          return content
        })
        log(`附件本地化完成: ${file.path} (${replacements.length}/${attachments.length})`)
      }
      return allLocalized
    } catch (error) {
      logError(`本地化文件失败: ${file.path}`, error)
      return false
    }
  }

  /**
   * 处理单个附件（下载、保存）
   * @param attachment 附件信息
   * @param file 所属文件
   * @returns 替换后的markdown文本，失败返回 null
   */
  private async processAttachment(
    attachment: AttachmentInfo,
    file: TFile,
    meta?: LocalizerItemMeta,
  ): Promise<{ replacement: string; localized: boolean; terminal?: boolean } | null> {
    try {
      const url = attachment.originalUrl

      // 下载附件
      const downloadResult = await downloadAttachment(
        url,
        this.options.maxRetries,
        this.options.retryDelay
      )

      // 文件已过期
      if (downloadResult.expired) {
        log(`附件已过期，保留原链接并添加标记: ${attachment.fileName}`)
        // 返回带过期标记的文本
        return {
          replacement: `📎 [${attachment.fileName}](${url}) ⚠️已过期`,
          localized: false,
          // 源站 NoSuchKey = 永久失败，标记完即终态，不进重试队列
          terminal: true,
        }
      }

      if (!downloadResult.success || !downloadResult.data) {
        logError(`下载失败: ${url}`)
        return null
      }

      // 生成存储路径
      const folderPath = this.generateFolderPath(file, meta)

      // 保存附件
      const localPath = await this.saveAttachmentToVault(
        folderPath,
        attachment.fileName,
        downloadResult.data
      )

      // 生成替换后的markdown链接
      return {
        replacement: this.generateMarkdownLink(attachment, localPath),
        localized: true,
      }
    } catch (error) {
      logError(`处理附件失败: ${attachment.originalUrl}`, error)
      return null
    }
  }

  /**
   * 保存附件到 Vault
   */
  private async saveAttachmentToVault(
    folderPath: string,
    fileName: string,
    data: ArrayBuffer
  ): Promise<string> {
    // 确保文件夹存在（并发安全：见 imageProcessor.ensureFolderExists 的说明，
    // 「先查后建」之间可能被另一路抢先建好，抛 already exists 不该让附件失败）
    const normalizedFolder = normalizePath(folderPath)
    await ensureFolderExists(this.vault, normalizedFolder)

    // 处理文件名（去除非法字符）
    const safeFileName = this.sanitizeFileName(fileName)
    const filePath = normalizePath(`${folderPath}/${safeFileName}`)

    // 检查文件是否已存在
    const existingFile = this.vault.getAbstractFileByPath(filePath)
    if (existingFile instanceof TFile) {
      log(`附件已存在，跳过下载: ${filePath}`)
      return filePath
    }

    // 保存文件
    await this.vault.createBinary(filePath, data)
    log(`附件保存成功: ${filePath}`)

    return filePath
  }

  /**
   * 清理文件名中的非法字符
   */
  private sanitizeFileName(fileName: string): string {
    // Windows 不允许的字符: \ / : * ? " < > |
    // 同时去除前后空格和点号（Windows 文件名不能以点号结尾）
    const sanitized = fileName
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim()
      .replace(/\.+$/, '')

    // Obsidian 会隐藏 dot-file；附件被藏起来后，正文 wikilink 点开是空的。
    return unhideNameSegment(sanitized)
  }

  /**
   * 生成附件存储文件夹路径
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
   * 生成 Markdown 附件链接
   * @param attachment 附件信息
   * @param localPath 本地路径
   */
  private generateMarkdownLink(attachment: AttachmentInfo, localPath: string): string {
    // 使用 Wiki 链接格式，保留文件名作为显示文本
    // 格式：📎 [[本地路径|文件名]]
    const sizeInfo = attachment.fileSize ? ` (${attachment.fileSize})` : ''
    return `📎 [[${localPath}|${attachment.fileName}]]${sizeInfo}`
  }

  /**
   * 添加文件到本地化队列
   *
   * @param file 笔记文件
   * @param metaOrSavedAt 笔记的 Item 上下文（推荐），或仅 savedAt 字符串
   *   （历史兼容 overload）。
   *
   * 同一文件多次 enqueue：已在队列中时，用最新 meta 覆盖已排队任务的 meta
   * （last-write-wins）；已 processed 时直接早退（自愈逻辑由调用方通过
   * clearProcessedMark 控制）。
   */
  async enqueueFile(
    file: TFile,
    metaOrSavedAt?: LocalizerItemMeta | string,
  ): Promise<AttachmentEnqueueResult> {
    const meta = normalizeMetaArg(metaOrSavedAt)
    const filePath = file.path

    // 已 processed 早退（保持现有自愈策略：调用方 clearProcessedMark 后才会重新入队）
    if (this.queue.isProcessed(filePath)) {
      return 'already-processed'
    }

    const existing = this.queue.findTaskByPath(filePath)
    if (existing) {
      if (meta) existing.meta = meta
      return 'already-queued'
    }

    const detected = await this.detectRemoteAttachments(file)
    if (detected.status === 'read-failed') return 'read-failed'
    const { attachments } = detected
    if (attachments.length === 0) {
      return 'no-remote-attachments'
    }

    this.queue.enqueue({
      file,
      attachments,
      createdAt: Date.now(),
      retryCount: 0,
      meta,
    })
    return 'enqueued'
  }

  /**
   * 处理队列中的任务
   */
  async processQueue(
    onProgress?: (processed: number, total: number) => void,
  ): Promise<LocalizationResult> {
    if (this.queue.isProcessing() || this.queue.isEmpty()) {
      return emptyLocalizationResult()
    }

    this.queue.setProcessing(true)
    log('开始处理附件本地化队列...')

    const total = this.queue.getStats().pending
    let processed = 0
    const result = emptyLocalizationResult()
    // 失败任务本轮 drain 结束后放回队列，留给“下一次同步”重试；不能在 while
    // 内立刻 enqueue，否则同一轮会反复消费直到死循环/狂刷服务器。
    const retryTasks: AttachmentLocalizeTask[] = []

    try {
      while (!this.queue.isEmpty()) {
        const task = this.queue.dequeue()
        if (!task) break
        result.total++

        try {
          const ok = await this.localizeFile(task)
          if (ok) {
            this.queue.markAsProcessed(task.file.path)
            result.succeeded++
          } else {
            result.failed++
            result.failedFiles.push(task.file.path)
            task.retryCount++
            retryTasks.push(task)
            log(`附件任务未完成，保留可重试状态: ${task.file.path}`)
          }
        } catch (error) {
          logError(`处理任务失败: ${task.file.path}`, error)
          result.failed++
          result.failedFiles.push(task.file.path)
          task.retryCount++
          retryTasks.push(task)
        }

        processed++
        onProgress?.(processed, total)
      }
    } finally {
      for (const task of retryTasks) this.queue.enqueue(task)
      this.queue.setProcessing(false)
      log('附件本地化队列处理完成')
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
   * 清空队列
   */
  clearQueue(): void {
    this.queue.clear()
  }
}

/**
 * 把 enqueueFile 的 overload 第二参（meta 对象 / savedAt 字符串 / undefined）
 * 归一化成 LocalizerItemMeta | undefined。
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
