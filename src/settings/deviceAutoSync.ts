/**
 * 设备级自动同步配置的纯逻辑实现
 *
 * 把「读、写、迁移」抽成无副作用的纯函数，便于单测覆盖多设备 / 升级 / 回滚等场景。
 * 调用方（main.ts）负责注入 deviceId 和 settings。
 */
import { DeviceAutoSyncConfig, OmnivoreSettings } from './index'

/**
 * 读取给定设备生效的自动同步配置
 *
 * 三个分支：
 * 1. deviceAutoSync[deviceId] 有值 → 用设备条目
 * 2. 当前设备没条目 + deviceAutoSyncMigrated=true → 视为「新设备」，返回 {0,false}
 *    关键：首次在这台设备上启动时，initializeNonCriticalFeatures 的 scheduleSync /
 *    registerCoreComponents 的 syncOnStart 检查会在延迟 3s 的迁移之前运行。
 *    如果这里回退到顶层 legacy（那是另一台已迁移设备当初用的值），新设备就会
 *    错误地按其他设备的频率自动同步。必须在这里直接返回默认值。
 * 3. 未迁移（deviceAutoSyncMigrated=false）→ 回退到顶层 legacy 字段（升级路径）
 */
export function getDeviceAutoSync(
  settings: Pick<OmnivoreSettings, 'deviceAutoSync' | 'frequency' | 'syncOnStart' | 'deviceAutoSyncMigrated'>,
  deviceId: string,
): DeviceAutoSyncConfig {
  const entry = settings.deviceAutoSync?.[deviceId]
  if (entry) {
    return { frequency: entry.frequency, syncOnStart: entry.syncOnStart }
  }
  if (settings.deviceAutoSyncMigrated) {
    // 已迁移但当前设备没条目 = 新设备，显式关闭自动同步，避免误继承其他设备
    return { frequency: 0, syncOnStart: false }
  }
  return {
    frequency: settings.frequency ?? 0,
    syncOnStart: settings.syncOnStart ?? false,
  }
}

/**
 * 为指定设备写入（部分）自动同步配置
 *
 * - 若该设备已有条目：merge 覆盖指定字段，未指定字段保持不变
 * - 若该设备无条目：用当前 effective 值作为基线再 merge
 */
export function setDeviceAutoSync(
  settings: Pick<OmnivoreSettings, 'deviceAutoSync' | 'frequency' | 'syncOnStart' | 'deviceAutoSyncMigrated'>,
  deviceId: string,
  next: Partial<DeviceAutoSyncConfig>,
): void {
  // 克隆 map：避免在 loadEssentialSettings 里 Object.assign 导致的
  // reference 共享（savedData 缺字段时 deviceAutoSync 指向 DEFAULT_SETTINGS.deviceAutoSync，
  // 直接 mutate 会污染 DEFAULT_SETTINGS 这个单例）
  settings.deviceAutoSync = { ...(settings.deviceAutoSync ?? {}) }
  const current = settings.deviceAutoSync[deviceId] ?? getDeviceAutoSync(settings, deviceId)
  settings.deviceAutoSync[deviceId] = {
    frequency: next.frequency ?? current.frequency,
    syncOnStart: next.syncOnStart ?? current.syncOnStart,
  }
}

/**
 * 迁移结果
 */
export interface MigrateDeviceAutoSyncResult {
  /** 是否改动了 settings，调用方据此决定是否持久化 */
  changed: boolean
  /** 具体发生了哪种迁移（用于日志/统计） */
  action: 'already-migrated-noop' | 'migrated-legacy-to-device' | 'new-device-default'
}

/**
 * 首次把老版本顶层 frequency/syncOnStart 搬到当前 deviceId 条目；幂等
 *
 * 分支：
 * 1) deviceAutoSyncMigrated === true 且当前设备已有条目 → noop
 * 2) deviceAutoSyncMigrated === true 且当前设备无条目 → 新设备，写默认值 {0, false}
 *    （不继承其他设备的配置，用户需显式开启）
 * 3) deviceAutoSyncMigrated === false
 *    - 当前设备无条目：用顶层 legacy 值创建条目
 *    - 当前设备已有条目（异常数据）：保留条目原值
 *    最后都会把 deviceAutoSyncMigrated 置 true
 *
 * 顶层 legacy frequency/syncOnStart 字段**不会被清空**，作为老版本回滚兜底。
 */
export function migrateDeviceAutoSync(
  settings: OmnivoreSettings,
  deviceId: string,
): MigrateDeviceAutoSyncResult {
  // 克隆 map 避免污染 DEFAULT_SETTINGS（见 setDeviceAutoSync 注释）
  settings.deviceAutoSync = { ...(settings.deviceAutoSync ?? {}) }

  if (settings.deviceAutoSyncMigrated) {
    if (!settings.deviceAutoSync[deviceId]) {
      settings.deviceAutoSync[deviceId] = { frequency: 0, syncOnStart: false }
      return { changed: true, action: 'new-device-default' }
    }
    return { changed: false, action: 'already-migrated-noop' }
  }

  // 首次迁移
  if (!settings.deviceAutoSync[deviceId]) {
    settings.deviceAutoSync[deviceId] = {
      frequency: settings.frequency ?? 0,
      syncOnStart: settings.syncOnStart ?? false,
    }
  }
  settings.deviceAutoSyncMigrated = true
  return { changed: true, action: 'migrated-legacy-to-device' }
}
