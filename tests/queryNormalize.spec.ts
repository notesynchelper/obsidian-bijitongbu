/**
 * 「筛选器/自定义查询」下线后的一次性归一化（settings/queryNormalize.ts）
 *
 * Phase 2 IA（2026-08）把这两个设置从设置页移除、同步范围恒为默认 in:all。
 * 归一化必须：
 *  - 只跑一次（customQueryNormalized 标记）
 *  - 存量非默认查询 → 重置查询 + 按旧设置页语义重置同步游标（否则拓宽范围后
 *    老游标会跳过此前被查询排除的内容）
 *  - 默认/空查询 → 只回填默认值，不动游标
 *  - E2E harness 预置 customQueryNormalized: true 的隔离查询 → 完全不动
 */
import { normalizeRetiredQuerySettings } from '../src/settings/queryNormalize'
import { DEFAULT_SETTINGS, OmnivoreSettings } from '../src/settings'

function makeSettings(over: Partial<OmnivoreSettings> = {}): OmnivoreSettings {
  return {
    ...DEFAULT_SETTINGS,
    syncAt: '2026-08-01T00:00:00.000Z',
    initialSyncCompleted: true,
    deviceSyncCursors: { 'desktop-A': '2026-08-01T00:00:00.000Z' },
    ...over,
  }
}

describe('normalizeRetiredQuerySettings', () => {
  it('已归一化（标记为 true）→ 完全不动，返回 false', () => {
    const s = makeSettings({
      customQuery: 'qa-isolation-token', // E2E 隔离查询场景
      customQueryNormalized: true,
    })
    expect(normalizeRetiredQuerySettings(s)).toBe(false)
    expect(s.customQuery).toBe('qa-isolation-token')
    expect(s.syncAt).toBe('2026-08-01T00:00:00.000Z')
    expect(s.initialSyncCompleted).toBe(true)
    expect(s.deviceSyncCursors['desktop-A']).toBe('2026-08-01T00:00:00.000Z')
  })

  it('存量非默认查询 → 重置为 in:all 并重置游标（syncAt/initialSyncCompleted/deviceSyncCursors）', () => {
    const s = makeSettings({ customQuery: 'label:important' })
    expect(normalizeRetiredQuerySettings(s)).toBe(true)
    expect(s.customQuery).toBe('in:all')
    expect(s.filter).toBe('ALL')
    expect(s.syncAt).toBe('')
    expect(s.initialSyncCompleted).toBe(false)
    expect(s.deviceSyncCursors).toEqual({})
    expect(s.customQueryNormalized).toBe(true)
  })

  it('存量为默认 in:all → 只打标记，不重置游标', () => {
    const s = makeSettings({ customQuery: 'in:all' })
    expect(normalizeRetiredQuerySettings(s)).toBe(true)
    expect(s.customQuery).toBe('in:all')
    expect(s.syncAt).toBe('2026-08-01T00:00:00.000Z')
    expect(s.initialSyncCompleted).toBe(true)
    expect(s.deviceSyncCursors['desktop-A']).toBe('2026-08-01T00:00:00.000Z')
  })

  it('存量为空（老默认值）→ 回填 in:all，不重置游标', () => {
    const s = makeSettings({ customQuery: '' })
    expect(normalizeRetiredQuerySettings(s)).toBe(true)
    expect(s.customQuery).toBe('in:all')
    expect(s.syncAt).toBe('2026-08-01T00:00:00.000Z')
    expect(s.deviceSyncCursors['desktop-A']).toBe('2026-08-01T00:00:00.000Z')
  })

  it('legacy filter 值（如 ADVANCED / 枚举中文串）一并归一到 ALL', () => {
    const s = makeSettings({ filter: 'ADVANCED', customQuery: 'in:all (label:x)' })
    normalizeRetiredQuerySettings(s)
    expect(s.filter).toBe('ALL')
    expect(s.customQuery).toBe('in:all')
    expect(s.syncAt).toBe('') // 非默认查询 → 游标重置
  })

  it('非默认查询 + 阅后即焚开启 → 归一化时强制关闭阅后即焚（防全量补拉触发云端全删）', () => {
    const s = makeSettings({ customQuery: 'label:important', burnAfterReading: true })
    normalizeRetiredQuerySettings(s)
    expect(s.burnAfterReading).toBe(false)
    expect(s.syncAt).toBe('')
  })

  it('默认查询 + 阅后即焚开启 → 不触发游标重置，也不动阅后即焚', () => {
    const s = makeSettings({ customQuery: 'in:all', burnAfterReading: true })
    normalizeRetiredQuerySettings(s)
    expect(s.burnAfterReading).toBe(true)
    expect(s.syncAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('幂等：第二次调用返回 false 且不再改动', () => {
    const s = makeSettings({ customQuery: 'label:x' })
    normalizeRetiredQuerySettings(s)
    const snapshot = JSON.stringify(s)
    expect(normalizeRetiredQuerySettings(s)).toBe(false)
    expect(JSON.stringify(s)).toBe(snapshot)
  })
})
