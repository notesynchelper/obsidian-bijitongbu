/**
 * 一次本地化队列 drain 的文件级结果。
 *
 * total / succeeded / failed 均按“笔记文件任务”计数；failedFiles 保留 vault
 * 相对路径，供右键入口只判断用户当前点击的文件，不再根据日志猜测成功与否。
 */
export interface LocalizationResult {
  total: number
  succeeded: number
  failed: number
  failedFiles: string[]
}

export function emptyLocalizationResult(): LocalizationResult {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    failedFiles: [],
  }
}
