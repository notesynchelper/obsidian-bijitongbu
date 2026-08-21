export interface RelocalizeNoticeInput {
  basename: string
  imageModeEnabled: boolean
  failed: number
}

export interface FolderRelocalizeNoticeInput {
  folderName: string
  noteCount: number
  imageModeEnabled: boolean
  failed: number
}

export function getRelocalizeMenuTitle(imageModeEnabled: boolean): string {
  return imageModeEnabled
    ? '将本笔记图片重新本地化'
    : '将本笔记附件重新本地化'
}

export function getFolderRelocalizeMenuTitle(
  imageModeEnabled: boolean,
): string {
  return imageModeEnabled
    ? '将本文件夹图片重新本地化'
    : '将本文件夹附件重新本地化'
}

/**
 * 右键本地化的最终文案只由真实结果生成。
 *
 * 失败文案故意不含“完成”二字，方便用户和真机断言都不会把失败提示误读为成功。
 */
export function formatRelocalizeNotice(input: RelocalizeNoticeInput): string {
  const { basename, imageModeEnabled, failed } = input
  if (failed > 0) {
    const modePrefix = imageModeEnabled ? '' : '图片模式未开启；'
    return `${modePrefix}本地化未成功：${failed} 项仍是远程链接，稍后会自动重试`
  }
  if (!imageModeEnabled) {
    return `图片模式未开启，仅处理了附件: ${basename}`
  }
  return `本地化完成: ${basename}`
}

/**
 * 文件夹批量本地化的最终文案按失败笔记数生成。
 *
 * 和单文件文案一样，失败文案故意不含“完成”二字。
 */
export function formatFolderRelocalizeNotice(
  input: FolderRelocalizeNoticeInput,
): string {
  const { folderName, noteCount, imageModeEnabled, failed } = input
  if (failed > 0) {
    const modePrefix = imageModeEnabled ? '' : '图片模式未开启；'
    return `${modePrefix}本地化未成功：${failed} 个笔记仍有远程链接，稍后会自动重试`
  }
  if (!imageModeEnabled) {
    return `图片模式未开启，仅处理了附件: ${folderName}（${noteCount} 个笔记）`
  }
  return `本地化完成: ${folderName}（${noteCount} 个笔记）`
}
