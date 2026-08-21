/**
 * 附件本地化模块
 * 导出所有公共接口
 */

export { AttachmentLocalizer, isWeComFileMessage, extractFileAttachmentFromContent } from './attachmentLocalizer'
export { downloadAttachment, isRemoteAttachment } from './attachmentDownloader'
export { AttachmentLocalizationQueue } from './attachmentQueue'
export type {
  AttachmentInfo,
  AttachmentLocalizeTask,
  AttachmentDownloadResult,
  AttachmentProcessOptions,
} from './types'
