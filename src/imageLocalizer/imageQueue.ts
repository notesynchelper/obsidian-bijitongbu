/**
 * 异步任务队列
 * 用于管理图片本地化任务，避免重复处理
 */

import { LocalizeTask } from './types'
import { log } from '../logger'

/**
 * 图片本地化任务队列
 */
export class ImageLocalizationQueue {
  private queue: LocalizeTask[] = []
  private processing: boolean = false
  private processedFiles: Set<string> = new Set()
  // 正在处理中的任务路径（已被 dequeue 移出 queue[]，但尚未完成）。
  // enqueue 去重必须把它算进去，否则 resume/sync 在处理窗口内重复入队
  // 同一文件会造成顺序重复本地化。
  private activePath: string | null = null

  /**
   * 添加任务到队列
   * @param task 本地化任务
   */
  enqueue(task: LocalizeTask): void {
    const filePath = task.file.path

    // 仅做"同一任务正在队列中"的去重。不再因为 processedFiles 标记拒绝入队，
    // 以便同步在覆盖文件后本地化器可以自愈重跑。
    if (this.isInQueue(filePath)) {
      return
    }

    this.queue.push(task)
    log(`任务入队: ${filePath} (队列长度: ${this.queue.length})`)
  }

  /**
   * 从队列取出任务
   * @returns 本地化任务，如果队列为空则返回 undefined
   */
  dequeue(): LocalizeTask | undefined {
    return this.queue.shift()
  }

  /**
   * 查看队列头部任务（不移除）
   * @returns 本地化任务，如果队列为空则返回 undefined
   */
  peek(): LocalizeTask | undefined {
    return this.queue[0]
  }

  /**
   * 检查队列是否为空
   */
  isEmpty(): boolean {
    return this.queue.length === 0
  }

  /**
   * 获取队列长度
   */
  size(): number {
    return this.queue.length
  }

  /**
   * 检查文件是否在队列中
   * @param filePath 文件路径
   */
  isInQueue(filePath: string): boolean {
    return this.queue.some((task) => task.file.path === filePath)
  }

  /**
   * 拿到队列里指定路径对应的任务（用于二次 enqueue 时刷新 meta）。
   * 找不到返回 undefined。
   */
  findTaskByPath(filePath: string): LocalizeTask | undefined {
    return this.queue.find((task) => task.file.path === filePath)
  }

  /**
   * 返回当前排队任务的浅拷贝（不含已 dequeue、正在处理中的 activePath 任务）。
   * 供进度统计预扫描使用：在 processQueue 开始前数出待下载图片总数，
   * 让右上角进度条以「图片」为分母而非「文件」。
   */
  getTasks(): LocalizeTask[] {
    return this.queue.slice()
  }

  /**
   * 检查文件是否已处理
   * @param filePath 文件路径
   */
  isProcessed(filePath: string): boolean {
    return this.processedFiles.has(filePath)
  }

  /**
   * 标记文件已处理
   * @param filePath 文件路径
   */
  markAsProcessed(filePath: string): void {
    this.processedFiles.add(filePath)
    log(`标记为已处理: ${filePath}`)
  }

  /**
   * 取消标记文件已处理（用于重试）
   * @param filePath 文件路径
   */
  unmarkAsProcessed(filePath: string): void {
    this.processedFiles.delete(filePath)
    log(`取消已处理标记: ${filePath}`)
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = []
    log('队列已清空')
  }

  /**
   * 清空已处理记录
   */
  clearProcessed(): void {
    this.processedFiles.clear()
    log('已处理记录已清空')
  }

  /**
   * 标记/清除当前正在处理中的任务路径（processQueue 取出任务时置位，
   * 任务结束——无论成功失败——后清除）
   */
  setActivePath(filePath: string | null): void {
    this.activePath = filePath
  }

  /**
   * 当前正在处理中的任务路径；空闲时为 null
   */
  getActivePath(): string | null {
    return this.activePath
  }

  /** 笔记改名时同步队列内部按路径保存的状态；task.file.path 由 Obsidian 自身更新。 */
  renameFilePath(oldPath: string, newPath: string): void {
    if (!oldPath || !newPath || oldPath === newPath) return
    if (this.activePath === oldPath) this.activePath = newPath
    if (this.processedFiles.delete(oldPath)) this.processedFiles.add(newPath)
  }

  /**
   * 设置处理状态
   * @param processing 是否正在处理
   */
  setProcessing(processing: boolean): void {
    this.processing = processing
  }

  /**
   * 获取处理状态
   */
  isProcessing(): boolean {
    return this.processing
  }

  /**
   * 获取队列统计信息
   */
  getStats(): {
    queueSize: number
    processedCount: number
    isProcessing: boolean
  } {
    return {
      queueSize: this.queue.length,
      processedCount: this.processedFiles.size,
      isProcessing: this.processing,
    }
  }
}
