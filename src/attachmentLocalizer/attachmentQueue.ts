/**
 * 附件本地化队列管理器
 * 参考 imageQueue.ts 实现
 */

import { AttachmentLocalizeTask } from './types'

export class AttachmentLocalizationQueue {
  private queue: AttachmentLocalizeTask[] = []
  private processedPaths: Set<string> = new Set()
  private isProcessingFlag = false

  /**
   * 添加任务到队列
   */
  enqueue(task: AttachmentLocalizeTask): void {
    // 避免重复添加
    if (!this.isInQueue(task.file.path) && !this.isProcessed(task.file.path)) {
      this.queue.push(task)
    }
  }

  /**
   * 从队列取出任务
   */
  dequeue(): AttachmentLocalizeTask | undefined {
    return this.queue.shift()
  }

  /**
   * 检查路径是否在队列中
   */
  isInQueue(filePath: string): boolean {
    return this.queue.some((task) => task.file.path === filePath)
  }

  /**
   * 拿到队列里指定路径对应的任务（用于二次 enqueue 时刷新 meta）。
   */
  findTaskByPath(filePath: string): AttachmentLocalizeTask | undefined {
    return this.queue.find((task) => task.file.path === filePath)
  }

  /**
   * 检查路径是否已处理
   */
  isProcessed(filePath: string): boolean {
    return this.processedPaths.has(filePath)
  }

  /**
   * 标记为已处理
   */
  markAsProcessed(filePath: string): void {
    this.processedPaths.add(filePath)
  }

  /**
   * 取消标记文件已处理（用于重新本地化）
   */
  unmarkAsProcessed(filePath: string): void {
    this.processedPaths.delete(filePath)
  }

  /**
   * 队列是否为空
   */
  isEmpty(): boolean {
    return this.queue.length === 0
  }

  /**
   * 是否正在处理
   */
  isProcessing(): boolean {
    return this.isProcessingFlag
  }

  /**
   * 设置处理状态
   */
  setProcessing(value: boolean): void {
    this.isProcessingFlag = value
  }

  /**
   * 获取队列统计信息
   */
  getStats(): { pending: number; processed: number } {
    return {
      pending: this.queue.length,
      processed: this.processedPaths.size,
    }
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = []
    this.processedPaths.clear()
    this.isProcessingFlag = false
  }
}
