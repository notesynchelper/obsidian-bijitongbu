import { TFile, TFolder } from 'obsidian'

/**
 * 递归收集文件夹中的 Markdown 笔记。
 *
 * 只依赖 TFolder.children，因而根目录与任意层级子文件夹使用同一套逻辑。
 */
export function collectMarkdownFiles(folder: TFolder): TFile[] {
  const files: TFile[] = []

  for (const child of folder.children) {
    if (child instanceof TFile) {
      if (child.extension === 'md') files.push(child)
    } else if (child instanceof TFolder) {
      files.push(...collectMarkdownFiles(child))
    }
  }

  return files
}
