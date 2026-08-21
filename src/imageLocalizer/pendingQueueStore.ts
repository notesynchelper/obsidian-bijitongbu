/**
 * PendingLocalizeStore - 图片本地化待办任务的持久化存储（重启续传用）
 *
 * 设计文档：docs/image-localization-resume-design.md
 *
 * 作用：
 * - 把内存队列（ImageLocalizationQueue）中尚未完成的任务镜像到插件目录的
 *   pending-localize-queue.json，下载过程中关闭 Obsidian 后重启可继续。
 * - 只存可序列化的最小信息（filePath / meta / retryCount / createdAt），
 *   不存 images 数组 —— 恢复时对落盘内容重新 detectRemoteImages，内容是
 *   ground truth，停机期间文件被编辑/删除都能自愈。
 *
 * 落盘策略与 UrlLocalMap 一致：500ms 防抖合并写 + onunload flush。
 * 进程被强杀最多丢 500ms 内的变更：丢「新增」则该文件不续传（与无此功能持平）；
 * 丢「移除」则重启后多跑一遍已完成文件，重扫发现 0 张远程图后自然清除，幂等无害。
 */

import { log, logError } from '../logger'
import { LocalizerItemMeta } from '../common/localizerItemMeta'

export interface PendingTaskRecord {
  /** 笔记文件路径（vault 相对路径），一级 key，唯一 */
  filePath: string
  /** 笔记的 Item 上下文，决定附件目录模板变量；可缺省 */
  meta?: LocalizerItemMeta
  /** 跨重启保留的重试次数累加（诊断用，不再作丢弃闸门） */
  retryCount: number
  /** 任务首次创建时间（毫秒时间戳） */
  createdAt: number
  /**
   * 上次真正尝试本地化失败的时间（毫秒时间戳）；用于「后续同步重试」的冷却，
   * 避免同一条永久失败任务在密集同步里被每次重挂重跑而 hammer 图床。缺省表示
   * 尚未尝试过（不受冷却限制）。
   */
  lastAttemptAt?: number
}

export interface PendingStorePersister {
  load(): Promise<unknown>
  save(data: unknown): Promise<void>
}

const SAVE_DEBOUNCE_MS = 500
const STORE_VERSION = 1

/** 容量上限：超出时按插入顺序淘汰最旧记录，防止状态文件无界膨胀 */
export const MAX_PENDING_TASKS = 500

export class PendingLocalizeStore {
  // filePath → record；Map 保持插入顺序，FIFO 淘汰直接取首个 key
  private records: Map<string, PendingTaskRecord> = new Map()
  private persister?: PendingStorePersister
  private dirty = false
  private saveTimer: number | null = null

  constructor(persister?: PendingStorePersister) {
    this.persister = persister
  }

  /**
   * 从持久化存储加载。任何解析失败都降级为空表 + log，绝不抛出。
   */
  async load(): Promise<void> {
    if (!this.persister) return
    try {
      const loaded = await this.persister.load()
      this.records.clear()
      const tasks =
        loaded && typeof loaded === 'object' && !Array.isArray(loaded)
          ? (loaded as Record<string, unknown>)['tasks']
          : null
      if (Array.isArray(tasks)) {
        for (const item of tasks) {
          const rec = sanitizeRecord(item)
          if (rec) this.records.set(rec.filePath, rec)
        }
      }
      if (this.records.size > 0) {
        log(`📂 已加载图片本地化续传队列: ${this.records.size} 个待办任务`)
      }
    } catch (err) {
      logError('加载 pending-localize-queue 失败', err)
      this.records.clear()
    }
  }

  get(filePath: string): PendingTaskRecord | undefined {
    return this.records.get(filePath)
  }

  /** 恢复用快照（浅拷贝，调用方不应改写返回的 record） */
  list(): PendingTaskRecord[] {
    return Array.from(this.records.values())
  }

  get size(): number {
    return this.records.size
  }

  /**
   * 新增/覆盖一条记录。新增超出上限时淘汰最旧的（FIFO）。
   */
  upsert(record: PendingTaskRecord): void {
    if (!record.filePath) return
    if (!this.records.has(record.filePath) && this.records.size >= MAX_PENDING_TASKS) {
      const first = this.records.keys().next()
      if (!first.done) {
        const oldest = first.value
        this.records.delete(oldest)
        log(`⚠️ 图片本地化续传队列已达上限 ${MAX_PENDING_TASKS}，淘汰最旧任务: ${oldest}`)
      }
    }
    this.records.set(record.filePath, record)
    this.scheduleSave()
  }

  remove(filePath: string): boolean {
    const existed = this.records.delete(filePath)
    if (existed) this.scheduleSave()
    return existed
  }

  /**
   * 笔记改名/移动时迁移以旧笔记路径为 key 的续传记录。
   * 与删除严格分开：rename 事件会调用这里；真正删除仍由 resume 时 resolveFile=null 清理。
   */
  renameFilePath(oldPath: string, newPath: string): boolean {
    if (!oldPath || !newPath || oldPath === newPath) return false
    const record = this.records.get(oldPath)
    if (!record) return false
    const target = this.records.get(newPath)
    this.records.delete(oldPath)
    this.records.set(newPath, {
      ...target,
      ...record,
      filePath: newPath,
      retryCount: Math.max(target?.retryCount ?? 0, record.retryCount),
      createdAt: Math.min(target?.createdAt ?? record.createdAt, record.createdAt),
      lastAttemptAt: Math.max(target?.lastAttemptAt ?? 0, record.lastAttemptAt ?? 0) || undefined,
    })
    this.scheduleSave()
    return true
  }

  clear(): void {
    if (this.records.size === 0) return
    this.records.clear()
    this.scheduleSave()
  }

  /**
   * 强制立即落盘（插件卸载前调用）。fire-and-forget 安全。
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
      // 写盘失败是瞬态：恢复 dirty，让下次 flush/变更有机会补写。
      this.dirty = true
      logError('保存 pending-localize-queue 失败（flush）', err)
    }
  }

  snapshot(): { version: number; tasks: PendingTaskRecord[] } {
    return { version: STORE_VERSION, tasks: this.list() }
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
        // 不能在 save 前永久清掉 dirty；失败后必须让 onunload flush 能补写。
        this.dirty = true
        logError('保存 pending-localize-queue 失败', err)
      })
    }, SAVE_DEBOUNCE_MS)
  }
}

/**
 * 单条记录的防御性解析：filePath 必须是非空字符串；retryCount/createdAt
 * 非法时回退默认值；meta 非对象时丢弃。
 */
function sanitizeRecord(item: unknown): PendingTaskRecord | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const obj = item as Record<string, unknown>
  if (typeof obj.filePath !== 'string' || !obj.filePath) return null
  const retryCount =
    typeof obj.retryCount === 'number' && Number.isFinite(obj.retryCount) && obj.retryCount >= 0
      ? Math.floor(obj.retryCount)
      : 0
  const createdAt =
    typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt)
      ? obj.createdAt
      : Date.now()
  const lastAttemptAt =
    typeof obj.lastAttemptAt === 'number' && Number.isFinite(obj.lastAttemptAt)
      ? obj.lastAttemptAt
      : undefined
  const meta =
    obj.meta && typeof obj.meta === 'object' && !Array.isArray(obj.meta)
      ? (obj.meta as LocalizerItemMeta)
      : undefined
  return { filePath: obj.filePath, meta, retryCount, createdAt, lastAttemptAt }
}
