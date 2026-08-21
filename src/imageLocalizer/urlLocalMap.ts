/**
 * UrlLocalMap - 每个笔记维度的 url→localPath 持久化映射
 *
 * 作用：
 * - 针对每个文件单独记录它曾经本地化过的远程 URL 对应的本地附件路径。
 * - 供 sync 写入前的 replayLocalizedUrls 查询，避免本地化结果被二次同步覆盖。
 * - 通过可选 persister 在 Obsidian 插件目录下以 JSON 侧边文件持久化。
 *
 * 注：必须按「文件路径」作为一级 key，因为附件存储路径通常依赖文件名 / savedAt 等
 * 模板字段，多个不同笔记即便引用同一远程 URL，也会各自有不同的本地路径；
 * 若用全局 url→localPath 单层字典，后写的记录会覆盖先写的，replay 时会把
 * 某个笔记的链接错误指向另一个笔记的附件目录。
 */

import { log, logError } from '../logger'

export interface UrlLocalMapPersister {
  load(): Promise<unknown>
  save(map: unknown): Promise<void>
}

const SAVE_DEBOUNCE_MS = 500

export class UrlLocalMap {
  // filePath → (url → localPath)
  private entries: Map<string, Map<string, string>> = new Map()
  private persister?: UrlLocalMapPersister
  private dirty = false
  private saveTimer: number | null = null

  constructor(persister?: UrlLocalMapPersister) {
    this.persister = persister
  }

  /**
   * 从持久化存储加载映射。在本地化器开始使用前调用一次即可。
   */
  async load(): Promise<void> {
    if (!this.persister) return
    try {
      const loaded = await this.persister.load()
      this.entries.clear()
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
        for (const [filePath, urlMap] of Object.entries(loaded as Record<string, unknown>)) {
          if (typeof filePath !== 'string' || !filePath) continue
          if (!urlMap || typeof urlMap !== 'object' || Array.isArray(urlMap)) continue
          const inner = new Map<string, string>()
          for (const [url, localPath] of Object.entries(urlMap as Record<string, unknown>)) {
            if (typeof url === 'string' && url && typeof localPath === 'string' && localPath) {
              inner.set(url, localPath)
            }
          }
          if (inner.size > 0) this.entries.set(filePath, inner)
        }
      }
      log(`📂 已加载 url→localPath 映射: ${this.entries.size} 个文件`)
    } catch (err) {
      logError('加载 urlLocalMap 失败', err)
    }
  }

  get(filePath: string, url: string): string | undefined {
    return this.entries.get(filePath)?.get(url)
  }

  hasFile(filePath: string): boolean {
    const inner = this.entries.get(filePath)
    return !!inner && inner.size > 0
  }

  getFile(filePath: string): ReadonlyMap<string, string> | undefined {
    return this.entries.get(filePath)
  }

  /**
   * 写入一条 (filePath, url) → localPath 记录。重复相同记录不会触发保存。
   */
  set(filePath: string, url: string, localPath: string): void {
    if (!filePath || !url || !localPath) return
    let inner = this.entries.get(filePath)
    if (!inner) {
      inner = new Map()
      this.entries.set(filePath, inner)
    }
    if (inner.get(url) === localPath) return
    inner.set(url, localPath)
    this.scheduleSave()
  }

  /**
   * 本地附件被改名 / 移动时，把所有指向 oldPath 的 localPath 更新到 newPath。
   *
   * 背景：图床接力的「改名接力」（Paste image rename）或用户手动改名会把已本地化的
   * 图片文件从 md5 路径挪走，但本映射里存的仍是旧路径。若不同步更新，下次
   * replayLocalizedUrls 会因 `getAbstractFileByPath(oldPath)` 找不到文件而**丢弃映射**，
   * 进而把远程链接重新下载一遍 → 产生重复 / 孤儿附件。此方法保持映射有效。
   *
   * @returns 被更新的条目数
   */
  renameLocalPath(oldPath: string, newPath: string): number {
    if (!oldPath || !newPath || oldPath === newPath) return 0
    let changed = 0
    for (const inner of this.entries.values()) {
      for (const [url, localPath] of inner) {
        // 更新已存在的 key（value 改指向 newPath）——Map 迭代中改已存在键是安全的
        if (localPath === oldPath) {
          inner.set(url, newPath)
          changed += 1
        }
      }
    }
    if (changed > 0) this.scheduleSave()
    return changed
  }

  /**
   * 笔记改名/移动时迁移 per-file 映射桶；目标桶已存在时合并，旧笔记的映射优先。
   */
  renameFileKey(oldPath: string, newPath: string): boolean {
    if (!oldPath || !newPath || oldPath === newPath) return false
    const oldEntries = this.entries.get(oldPath)
    if (!oldEntries) return false
    const merged = new Map(this.entries.get(newPath) ?? [])
    for (const [url, localPath] of oldEntries) merged.set(url, localPath)
    this.entries.delete(oldPath)
    this.entries.set(newPath, merged)
    this.scheduleSave()
    return true
  }

  /**
   * 删除一条记录，例如本地文件被发现已丢失时。
   */
  delete(filePath: string, url: string): boolean {
    const inner = this.entries.get(filePath)
    if (!inner) return false
    const existed = inner.delete(url)
    if (inner.size === 0) this.entries.delete(filePath)
    if (existed) this.scheduleSave()
    return existed
  }

  get fileCount(): number {
    return this.entries.size
  }

  /**
   * 测试/调试辅助：返回只读快照。
   */
  snapshot(): Record<string, Record<string, string>> {
    const obj: Record<string, Record<string, string>> = {}
    for (const [filePath, inner] of this.entries) {
      const innerObj: Record<string, string> = {}
      for (const [url, path] of inner) innerObj[url] = path
      obj[filePath] = innerObj
    }
    return obj
  }

  /**
   * 强制立即落盘（例如插件卸载前）。
   * 这是 fire-and-forget 安全的：调用方若不 await 也能保证写入被触发。
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty || !this.persister) return
    this.dirty = false
    try {
      await this.persister.save(this.snapshot())
    } catch (err) {
      this.dirty = true
      logError('保存 urlLocalMap 失败（flush）', err)
    }
  }

  private scheduleSave(): void {
    if (!this.persister) return
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      if (!this.dirty) return
      this.dirty = false
      const persister = this.persister
      if (!persister) return
      const snap = this.snapshot()
      void persister.save(snap).catch((err) => {
        this.dirty = true
        logError('保存 urlLocalMap 失败', err)
      })
    }, SAVE_DEBOUNCE_MS)
  }
}
