/**
 * 市场版弱升级提醒（Update reminder — marketplace build）
 *
 * 与主线私有渠道的自动更新器不同，本模块【只做一件事】：向版本号端点查询
 * 市场渠道的最新版本号，比当前版本新时返回提醒信息。
 *
 *  - 绝不下载任何文件、绝不写入/替换插件自身文件（main.js / manifest.json / styles.css）。
 *    实际升级完全交给 Obsidian 官方的第三方插件（Community plugins）更新机制。
 *  - 失败静默：网络不可达 / 返回异常时不打扰用户，仅记 debug 日志。
 *  - 去抖：每个会话至多每 6 小时真正发起一次请求。
 */

import { requestUrl } from 'obsidian'
import { log } from './logger'

/** 市场渠道版本号端点（只返回 {"version": "x.y.z"}，不含任何下载地址） */
export const MARKET_VERSION_CHECK_URL =
  'https://obsidian.notebooksyncer.com/plugversion-market'

/** 版本检查去抖窗口：至多每 6 小时查一次 */
export const REMINDER_CHECK_DEBOUNCE_MS = 6 * 60 * 60 * 1000

export interface UpdateReminderInfo {
  latestVersion: string
}

/** 语义化版本比较：latest 比 current 新时返回 true */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0)
  const l = parse(latest)
  const c = parse(current)
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const a = l[i] || 0
    const b = c[i] || 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

export class UpdateReminder {
  private currentVersion: string
  private lastCheckAt = 0
  private known: UpdateReminderInfo | null = null
  private inflight: Promise<UpdateReminderInfo | null> | null = null

  constructor(currentVersion: string) {
    this.currentVersion = currentVersion
  }

  /**
   * 查询是否有新版本。去抖窗口内直接返回缓存结论；任何失败都静默返回 null
   * （或上一次已知的结论）。
   */
  async check(): Promise<UpdateReminderInfo | null> {
    const now = Date.now()
    if (this.known) return this.known
    if (now - this.lastCheckAt < REMINDER_CHECK_DEBOUNCE_MS) return this.known
    if (this.inflight) return this.inflight

    this.inflight = (async (): Promise<UpdateReminderInfo | null> => {
      try {
        const response = await requestUrl({
          url: MARKET_VERSION_CHECK_URL,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        })
        this.lastCheckAt = Date.now()
        if (response.status !== 200) return null
        const data = response.json as { version?: unknown }
        const latest = typeof data?.version === 'string' ? data.version : ''
        if (latest && isNewerVersion(latest, this.currentVersion)) {
          this.known = { latestVersion: latest }
          log(`🔔 [UpdateReminder] 发现市场新版本: ${latest}（当前 ${this.currentVersion}）`)
        }
        return this.known
      } catch (e) {
        // 弱提醒：失败静默，不打扰用户
        this.lastCheckAt = Date.now()
        log('🔔 [UpdateReminder] 版本检查失败（忽略）:', e)
        return this.known
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }

  /** 已知的新版本信息（不发请求） */
  getKnown(): UpdateReminderInfo | null {
    return this.known
  }
}
