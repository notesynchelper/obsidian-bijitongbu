/**
 * 附件本地化相关的类型定义
 */

import { TFile } from 'obsidian'
import { LocalizerItemMeta } from '../common/localizerItemMeta'

/**
 * 附件信息
 * 格式: 📎 [文件名.ext](URL) (大小)
 */
export interface AttachmentInfo {
  /** 原始URL */
  originalUrl: string
  /** 附件在笔记中的原始文本（包含markdown语法和表情符号） */
  originalText: string
  /** 文件名（从链接文本提取，如：这是一个PPT.ppt） */
  fileName: string
  /** 文件大小描述（如：0.24MB） */
  fileSize?: string
  /** 匹配的起始位置 */
  startIndex: number
  /** 匹配的结束位置 */
  endIndex: number
}

/**
 * 附件本地化任务
 */
export interface AttachmentLocalizeTask {
  /** 笔记文件 */
  file: TFile
  /** 需要处理的附件列表 */
  attachments: AttachmentInfo[]
  /** 任务创建时间 */
  createdAt: number
  /** 重试次数 */
  retryCount: number
  /**
   * 笔记的 Item 上下文 snapshot；generateFolderPath 用它给 render() 喂真实
   * siteName/author/originalUrl/publishedAt 等模板变量。
   */
  meta?: LocalizerItemMeta
}

/**
 * 附件下载结果
 */
export interface AttachmentDownloadResult {
  /** 是否成功 */
  success: boolean
  /** 本地文件路径 */
  localPath?: string
  /** 错误信息 */
  error?: string
  /** 文件内容（ArrayBuffer） */
  data?: ArrayBuffer
  /** 是否文件已过期（NoSuchKey错误） */
  expired?: boolean
}

/**
 * 附件处理选项
 */
export interface AttachmentProcessOptions {
  /** 附件存储文件夹模板 */
  attachmentFolder: string
  /** 文件夹日期格式 */
  folderDateFormat: string
  /** 下载重试次数 */
  maxRetries: number
  /** 重试延迟（毫秒） */
  retryDelay: number
}

/** detectRemoteAttachments 的可判别结果。 */
export type RemoteAttachmentDetectionResult =
  | { status: 'ok'; attachments: AttachmentInfo[] }
  | { status: 'read-failed'; attachments: [] }

/** 附件入队结果，供右键入口把读取失败计入可见结果。 */
export type AttachmentEnqueueResult =
  | 'enqueued'
  | 'already-queued'
  | 'already-processed'
  | 'no-remote-attachments'
  | 'read-failed'
