/**
 * 设备级自动同步 - 迁移 & 多设备隔离测试
 *
 * 覆盖场景：
 * 1. 老用户首次升级：顶层 frequency/syncOnStart 迁移到当前 deviceId
 * 2. 已迁移幂等：再次加载不覆盖已有条目
 * 3. 新设备首次打开：用默认 {0, false}，不继承其他设备
 * 4. 多设备互相隔离：一台改不影响另一台
 * 5. getEffectiveAutoSync 的回退链：deviceAutoSync > legacy > 默认
 * 6. setEffectiveAutoSync 部分更新语义（只改一个字段时另一字段保持）
 * 7. 新安装用户：legacy 都是默认值，迁移后 device 条目也是默认值
 * 8. 从未同步过的老用户顶层字段为 undefined（非常老的配置）时不崩溃
 */

import { DEFAULT_SETTINGS, OmnivoreSettings } from '../src/settings/index'
import {
  getDeviceAutoSync,
  setDeviceAutoSync,
  migrateDeviceAutoSync,
} from '../src/settings/deviceAutoSync'

function makeSettings(overrides: Partial<OmnivoreSettings> = {}): OmnivoreSettings {
  return {
    ...DEFAULT_SETTINGS,
    // 确保每个测试用例拿到独立对象，避免相互污染
    deviceAutoSync: {},
    deviceSyncCursors: {},
    ...overrides,
  }
}

// =============================================================================
// 场景 1: 老用户首次升级迁移
// =============================================================================
describe('老用户首次升级迁移', () => {
  it('顶层 frequency=60 / syncOnStart=true → 迁移到当前设备条目', () => {
    const settings = makeSettings({
      frequency: 60,
      syncOnStart: true,
      deviceAutoSync: {},
      deviceAutoSyncMigrated: false,
    })
    const result = migrateDeviceAutoSync(settings, 'desktop-A')
    expect(result.changed).toBe(true)
    expect(result.action).toBe('migrated-legacy-to-device')
    expect(settings.deviceAutoSync['desktop-A']).toEqual({
      frequency: 60,
      syncOnStart: true,
    })
    expect(settings.deviceAutoSyncMigrated).toBe(true)
  })

  it('迁移后顶层 legacy 字段保留（回滚兜底）', () => {
    const settings = makeSettings({
      frequency: 300,
      syncOnStart: true,
      deviceAutoSyncMigrated: false,
    })
    migrateDeviceAutoSync(settings, 'desktop-A')
    // legacy 不清空
    expect(settings.frequency).toBe(300)
    expect(settings.syncOnStart).toBe(true)
  })

  it('新安装用户（legacy 都是默认 0/false）也会走一次迁移，写入默认设备条目', () => {
    const settings = makeSettings({
      frequency: 0,
      syncOnStart: false,
      deviceAutoSyncMigrated: false,
    })
    const result = migrateDeviceAutoSync(settings, 'fresh-install-device')
    expect(result.changed).toBe(true)
    expect(result.action).toBe('migrated-legacy-to-device')
    expect(settings.deviceAutoSync['fresh-install-device']).toEqual({
      frequency: 0,
      syncOnStart: false,
    })
    expect(settings.deviceAutoSyncMigrated).toBe(true)
  })

  it('非常老的配置顶层字段缺失（undefined） → 迁移时兜底为 0/false，不崩溃', () => {
    const settings = makeSettings({
      deviceAutoSyncMigrated: false,
    })
    // 模拟非常老的 data.json 里没有 frequency/syncOnStart 字段
    delete (settings as Partial<OmnivoreSettings>).frequency
    delete (settings as Partial<OmnivoreSettings>).syncOnStart
    expect(() => migrateDeviceAutoSync(settings, 'legacy-device')).not.toThrow()
    expect(settings.deviceAutoSync['legacy-device']).toEqual({
      frequency: 0,
      syncOnStart: false,
    })
  })
})

// =============================================================================
// 场景 2: 幂等（多次加载/升级都不会覆盖）
// =============================================================================
describe('迁移幂等性', () => {
  it('已迁移 + 当前设备已有条目 → 不改动（noop）', () => {
    const settings = makeSettings({
      frequency: 60,  // 老值还在
      syncOnStart: true,
      deviceAutoSync: { 'desktop-A': { frequency: 900, syncOnStart: false } },  // 用户改过
      deviceAutoSyncMigrated: true,
    })
    const result = migrateDeviceAutoSync(settings, 'desktop-A')
    expect(result.changed).toBe(false)
    expect(result.action).toBe('already-migrated-noop')
    // 用户自己改的值要保留
    expect(settings.deviceAutoSync['desktop-A']).toEqual({
      frequency: 900,
      syncOnStart: false,
    })
  })

  it('顶层 legacy 值后来被用户误改 → 不再影响已迁移的设备条目', () => {
    // 用户场景：第一次升级后，又手工编辑 data.json 把 frequency 改了，但不应影响设备条目
    const settings = makeSettings({
      frequency: 9999,
      syncOnStart: false,
      deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    migrateDeviceAutoSync(settings, 'desktop-A')
    expect(settings.deviceAutoSync['desktop-A'].frequency).toBe(60)
  })
})

// =============================================================================
// 场景 3: 新设备首次打开
// =============================================================================
describe('新设备首次打开', () => {
  it('已迁移但当前设备无条目 → 写入默认 {0, false}，不继承其他设备', () => {
    const settings = makeSettings({
      frequency: 300,  // 这是 desktop-A 当初迁移到 device 条目里的那个值
      syncOnStart: true,
      deviceAutoSync: { 'desktop-A': { frequency: 300, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    const result = migrateDeviceAutoSync(settings, 'mobile-B')
    expect(result.changed).toBe(true)
    expect(result.action).toBe('new-device-default')
    expect(settings.deviceAutoSync['mobile-B']).toEqual({
      frequency: 0,
      syncOnStart: false,
    })
    // desktop-A 不被影响
    expect(settings.deviceAutoSync['desktop-A']).toEqual({
      frequency: 300,
      syncOnStart: true,
    })
  })

  it('新设备首启后再次启动 → noop（幂等）', () => {
    const settings = makeSettings({
      deviceAutoSync: { 'mobile-B': { frequency: 0, syncOnStart: false } },
      deviceAutoSyncMigrated: true,
    })
    const first = migrateDeviceAutoSync(settings, 'mobile-B')
    const second = migrateDeviceAutoSync(settings, 'mobile-B')
    expect(first.changed).toBe(false)
    expect(second.changed).toBe(false)
  })
})

// =============================================================================
// 场景 4: 多设备互相隔离
// =============================================================================
describe('多设备互相隔离', () => {
  it('setDeviceAutoSync 只改指定设备', () => {
    const settings = makeSettings({
      deviceAutoSync: {
        'desktop-A': { frequency: 60, syncOnStart: true },
        'mobile-B': { frequency: 300, syncOnStart: false },
      },
      deviceAutoSyncMigrated: true,
    })
    setDeviceAutoSync(settings, 'mobile-B', { frequency: 1800 })
    expect(settings.deviceAutoSync['desktop-A']).toEqual({ frequency: 60, syncOnStart: true })
    expect(settings.deviceAutoSync['mobile-B']).toEqual({ frequency: 1800, syncOnStart: false })
  })

  it('一台设备关闭自动同步（frequency=0）不影响另一台', () => {
    const settings = makeSettings({
      deviceAutoSync: {
        'desktop-A': { frequency: 60, syncOnStart: true },
        'mobile-B': { frequency: 900, syncOnStart: false },
      },
      deviceAutoSyncMigrated: true,
    })
    setDeviceAutoSync(settings, 'mobile-B', { frequency: 0, syncOnStart: false })
    expect(settings.deviceAutoSync['desktop-A'].frequency).toBe(60)
    expect(settings.deviceAutoSync['mobile-B'].frequency).toBe(0)
  })

  it('getDeviceAutoSync 针对不同 deviceId 返回不同的 config', () => {
    const settings = makeSettings({
      deviceAutoSync: {
        'desktop-A': { frequency: 60, syncOnStart: true },
        'mobile-B': { frequency: 900, syncOnStart: false },
      },
      deviceAutoSyncMigrated: true,
    })
    expect(getDeviceAutoSync(settings, 'desktop-A')).toEqual({ frequency: 60, syncOnStart: true })
    expect(getDeviceAutoSync(settings, 'mobile-B')).toEqual({ frequency: 900, syncOnStart: false })
  })
})

// =============================================================================
// 场景 5: getEffectiveAutoSync 的回退链
// =============================================================================
describe('getDeviceAutoSync 回退链', () => {
  it('deviceAutoSync[id] 有值 → 用设备条目', () => {
    const settings = makeSettings({
      frequency: 9999,   // legacy 不该被用
      syncOnStart: false,
      deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    expect(getDeviceAutoSync(settings, 'desktop-A')).toEqual({ frequency: 60, syncOnStart: true })
  })

  it('deviceAutoSync[id] 缺失 + 未迁移 → 回退到顶层 legacy（升级路径）', () => {
    const settings = makeSettings({
      frequency: 120,
      syncOnStart: true,
      deviceAutoSync: {},
      deviceAutoSyncMigrated: false,
    })
    expect(getDeviceAutoSync(settings, 'desktop-A')).toEqual({ frequency: 120, syncOnStart: true })
  })

  it('deviceAutoSync[id] 缺失 + 已迁移 → 视为新设备，返回 {0,false}', () => {
    // 关键回归：如果这里回退到 legacy，第二台设备首次启动会按其他设备的 frequency
    // 自动同步，造成 registerCoreComponents 的 syncOnStart / scheduleSync 误触发
    const settings = makeSettings({
      frequency: 9999,
      syncOnStart: true,
      deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    expect(getDeviceAutoSync(settings, 'mobile-B')).toEqual({ frequency: 0, syncOnStart: false })
  })

  it('deviceAutoSync 对象本身缺失（极端回滚数据） + 未迁移 → 回退到 legacy，不崩溃', () => {
    const settings = makeSettings({
      frequency: 45,
      syncOnStart: true,
      deviceAutoSyncMigrated: false,
    })
    delete (settings as Partial<OmnivoreSettings>).deviceAutoSync
    expect(getDeviceAutoSync(settings, 'desktop-A')).toEqual({ frequency: 45, syncOnStart: true })
  })

  it('deviceAutoSync 和 legacy 都缺失 + 未迁移 → 回退到 0/false', () => {
    const settings = makeSettings({ deviceAutoSyncMigrated: false })
    delete (settings as Partial<OmnivoreSettings>).deviceAutoSync
    delete (settings as Partial<OmnivoreSettings>).frequency
    delete (settings as Partial<OmnivoreSettings>).syncOnStart
    expect(getDeviceAutoSync(settings, 'desktop-A')).toEqual({ frequency: 0, syncOnStart: false })
  })
})

// =============================================================================
// 场景 6: setDeviceAutoSync 部分更新语义
// =============================================================================
describe('setDeviceAutoSync 部分更新', () => {
  it('只传 frequency → syncOnStart 保持原值', () => {
    const settings = makeSettings({
      deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    setDeviceAutoSync(settings, 'desktop-A', { frequency: 300 })
    expect(settings.deviceAutoSync['desktop-A']).toEqual({ frequency: 300, syncOnStart: true })
  })

  it('只传 syncOnStart → frequency 保持原值', () => {
    const settings = makeSettings({
      deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    setDeviceAutoSync(settings, 'desktop-A', { syncOnStart: false })
    expect(settings.deviceAutoSync['desktop-A']).toEqual({ frequency: 60, syncOnStart: false })
  })

  it('设备条目不存在时 → 用 effective 值（可能来自 legacy）作为基线', () => {
    // 未迁移状态下给一个没条目的设备写 frequency，应用 legacy syncOnStart 作为基线
    const settings = makeSettings({
      frequency: 999,
      syncOnStart: true,
      deviceAutoSync: {},
      deviceAutoSyncMigrated: false,
    })
    setDeviceAutoSync(settings, 'desktop-A', { frequency: 60 })
    expect(settings.deviceAutoSync['desktop-A']).toEqual({ frequency: 60, syncOnStart: true })
  })

  it('可把 frequency 设为 0（禁用自动同步）', () => {
    const settings = makeSettings({
      deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    setDeviceAutoSync(settings, 'desktop-A', { frequency: 0 })
    expect(settings.deviceAutoSync['desktop-A'].frequency).toBe(0)
  })

  it('可把 syncOnStart 设为 false', () => {
    const settings = makeSettings({
      deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    setDeviceAutoSync(settings, 'desktop-A', { syncOnStart: false })
    expect(settings.deviceAutoSync['desktop-A'].syncOnStart).toBe(false)
  })
})

// =============================================================================
// 场景 7: 端到端——模拟加载→迁移→读→写→读 的完整链路
// =============================================================================
describe('端到端：加载→迁移→读写 流程', () => {
  it('老用户两台设备分别升级：各自得到自己的条目', () => {
    // 第一台设备 desktop-A：老用户，frequency=60, syncOnStart=true
    const settings: OmnivoreSettings = makeSettings({
      frequency: 60,
      syncOnStart: true,
      deviceAutoSync: {},
      deviceAutoSyncMigrated: false,
    })
    migrateDeviceAutoSync(settings, 'desktop-A')
    expect(getDeviceAutoSync(settings, 'desktop-A')).toEqual({ frequency: 60, syncOnStart: true })

    // 同一份 settings 同步到第二台设备 mobile-B（模拟云同步场景）
    // mobile-B 启动时发现自己没条目，应该得到默认 {0,false}
    migrateDeviceAutoSync(settings, 'mobile-B')
    expect(getDeviceAutoSync(settings, 'mobile-B')).toEqual({ frequency: 0, syncOnStart: false })

    // desktop-A 不受影响
    expect(getDeviceAutoSync(settings, 'desktop-A')).toEqual({ frequency: 60, syncOnStart: true })

    // 在 mobile-B 上用户单独设置 frequency=1800
    setDeviceAutoSync(settings, 'mobile-B', { frequency: 1800 })
    expect(getDeviceAutoSync(settings, 'mobile-B')).toEqual({ frequency: 1800, syncOnStart: false })

    // desktop-A 依旧不受影响
    expect(getDeviceAutoSync(settings, 'desktop-A')).toEqual({ frequency: 60, syncOnStart: true })
  })

  it('同一设备重启多次：migrate 幂等，effective 一致', () => {
    const settings = makeSettings({
      frequency: 60,
      syncOnStart: true,
      deviceAutoSyncMigrated: false,
    })
    for (let i = 0; i < 3; i++) {
      migrateDeviceAutoSync(settings, 'desktop-A')
    }
    expect(settings.deviceAutoSync['desktop-A']).toEqual({ frequency: 60, syncOnStart: true })
    expect(Object.keys(settings.deviceAutoSync)).toEqual(['desktop-A'])
  })

  it('老用户迁移后修改频率：顶层 legacy 不再被修改', () => {
    const settings = makeSettings({
      frequency: 60,
      syncOnStart: true,
      deviceAutoSyncMigrated: false,
    })
    migrateDeviceAutoSync(settings, 'desktop-A')
    setDeviceAutoSync(settings, 'desktop-A', { frequency: 300 })
    expect(settings.frequency).toBe(60)  // legacy 保留
    expect(settings.deviceAutoSync['desktop-A'].frequency).toBe(300)  // 设备条目已更新
  })

  /**
   * 模拟 main.ts 中 `OmnivorePlugin.setEffectiveAutoSync` 的完整行为：
   * 既写入 deviceAutoSync[currentDevice]，也把顶层 legacy frequency/syncOnStart
   * 同步为当前设备的值，保证用户回滚到老版本时 legacy 字段仍是「本设备最近设置值」
   */
  function simulateSetEffectiveAutoSync(
    settings: OmnivoreSettings,
    currentDeviceId: string,
    next: Parameters<typeof setDeviceAutoSync>[2],
  ): void {
    setDeviceAutoSync(settings, currentDeviceId, next)
    const entry = settings.deviceAutoSync[currentDeviceId]
    settings.frequency = entry.frequency
    settings.syncOnStart = entry.syncOnStart
  }

  it('回滚兼容: setEffectiveAutoSync 把当前设备值同步写入顶层 legacy 字段', () => {
    const settings = makeSettings({
      frequency: 60,
      syncOnStart: true,
      deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    simulateSetEffectiveAutoSync(settings, 'desktop-A', { frequency: 900 })
    expect(settings.deviceAutoSync['desktop-A']).toEqual({ frequency: 900, syncOnStart: true })
    expect(settings.frequency).toBe(900)
    expect(settings.syncOnStart).toBe(true)
  })

  it('回滚兼容: 关闭 syncOnStart → 顶层 legacy 也被更新', () => {
    const settings = makeSettings({
      frequency: 60,
      syncOnStart: true,
      deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    simulateSetEffectiveAutoSync(settings, 'desktop-A', { syncOnStart: false })
    expect(settings.syncOnStart).toBe(false)
    expect(settings.frequency).toBe(60)
  })

  it('多设备时顶层 legacy = 最近一次被写入的设备值（老版本退化语义）', () => {
    // 老版本不认识 deviceAutoSync，只能读 legacy。多设备下 legacy 无法精确表示，
    // 采用「last-write-wins」语义：顶层 legacy 反映最后一次被修改的设备
    const settings = makeSettings({
      deviceAutoSync: {},
      deviceAutoSyncMigrated: true,
    })
    simulateSetEffectiveAutoSync(settings, 'desktop-A', { frequency: 60, syncOnStart: true })
    expect(settings.frequency).toBe(60)
    expect(settings.syncOnStart).toBe(true)

    simulateSetEffectiveAutoSync(settings, 'mobile-B', { frequency: 900, syncOnStart: false })
    // mobile-B 后写，顶层 legacy 反映 mobile-B
    expect(settings.frequency).toBe(900)
    expect(settings.syncOnStart).toBe(false)
    // desktop-A 的条目不受影响
    expect(settings.deviceAutoSync['desktop-A']).toEqual({ frequency: 60, syncOnStart: true })
  })

  it('回归: 第二台设备首次打开时的启动窗口期（migration 延迟执行）', () => {
    // 场景：desktop-A 已升级，deviceAutoSync[A]={300,true}，deviceAutoSyncMigrated=true
    // 用户在同一个 vault 打开 mobile-B。mobile-B 加载 settings 后：
    //   t+0ms:   registerCoreComponents 检查 effective.syncOnStart
    //   t+0ms:   initializeNonCriticalFeatures 调用 scheduleSync → 读 effective.frequency
    //   t+3s:    processSettingsCompatibility 才跑到 migrateDeviceAutoSync 给 mobile-B 建条目
    // 必须保证前两个时间点读到 {0, false}，否则 mobile-B 会按 desktop-A 的设置自动同步
    const settings = makeSettings({
      frequency: 300,
      syncOnStart: true,
      deviceAutoSync: { 'desktop-A': { frequency: 300, syncOnStart: true } },
      deviceAutoSyncMigrated: true,
    })
    // 迁移还没跑的时间窗口
    const effectiveBeforeMigration = getDeviceAutoSync(settings, 'mobile-B')
    expect(effectiveBeforeMigration).toEqual({ frequency: 0, syncOnStart: false })

    // 3 秒后迁移跑完
    migrateDeviceAutoSync(settings, 'mobile-B')
    // 迁移后读取也应保持 {0, false}
    expect(getDeviceAutoSync(settings, 'mobile-B')).toEqual({ frequency: 0, syncOnStart: false })
    // desktop-A 条目不受影响
    expect(getDeviceAutoSync(settings, 'desktop-A')).toEqual({ frequency: 300, syncOnStart: true })
  })
})

// =============================================================================
// 场景 8: Object.assign 加载行为兼容（模拟 loadEssentialSettings 流程）
// =============================================================================
describe('Object.assign 加载后兼容', () => {
  it('老用户 data.json 无 deviceAutoSync 字段 → 加载后为空对象，legacy 字段仍可用', () => {
    const savedData = {
      apiKey: 'old-key',
      frequency: 300,
      syncOnStart: true,
      // 无 deviceAutoSync / deviceAutoSyncMigrated
    }
    const loaded = Object.assign({}, DEFAULT_SETTINGS, savedData) as OmnivoreSettings
    expect(loaded.deviceAutoSync).toEqual({})
    expect(loaded.deviceAutoSyncMigrated).toBe(false)
    expect(loaded.frequency).toBe(300)

    // 接下来迁移应该能正确工作
    migrateDeviceAutoSync(loaded, 'desktop-A')
    expect(loaded.deviceAutoSync['desktop-A']).toEqual({ frequency: 300, syncOnStart: true })
    expect(loaded.deviceAutoSyncMigrated).toBe(true)
  })

  it('已升级后的 data.json 再次加载 → deviceAutoSync 被保留（非空映射覆盖空默认）', () => {
    const savedData = {
      apiKey: 'key',
      frequency: 60,  // legacy 残留
      syncOnStart: true,
      deviceAutoSync: {
        'desktop-A': { frequency: 300, syncOnStart: false },
      },
      deviceAutoSyncMigrated: true,
    }
    const loaded = Object.assign({}, DEFAULT_SETTINGS, savedData) as OmnivoreSettings
    expect(loaded.deviceAutoSync).toEqual({
      'desktop-A': { frequency: 300, syncOnStart: false },
    })
    expect(loaded.deviceAutoSyncMigrated).toBe(true)

    // 再迁移是 noop
    const result = migrateDeviceAutoSync(loaded, 'desktop-A')
    expect(result.changed).toBe(false)
    expect(loaded.deviceAutoSync['desktop-A']).toEqual({ frequency: 300, syncOnStart: false })
  })
})

// =============================================================================
// 场景 9: 默认设置完整性
// =============================================================================
describe('DEFAULT_SETTINGS 包含设备级自动同步字段', () => {
  it('deviceAutoSync 默认是空对象', () => {
    expect(DEFAULT_SETTINGS.deviceAutoSync).toEqual({})
  })

  it('deviceAutoSyncMigrated 默认是 false', () => {
    expect(DEFAULT_SETTINGS.deviceAutoSyncMigrated).toBe(false)
  })

  it('顶层 frequency 默认值仍为 0（向后兼容）', () => {
    expect(DEFAULT_SETTINGS.frequency).toBe(0)
  })

  it('顶层 syncOnStart 默认值仍为 false（向后兼容）', () => {
    expect(DEFAULT_SETTINGS.syncOnStart).toBe(false)
  })
})
