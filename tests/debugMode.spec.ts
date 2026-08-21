import {
  DEBUG_OVERRIDE_KEYS,
  DEBUG_WINDOW_MS,
  resolveDebugSyncAt,
  resolveEffectiveSyncSettings,
} from '../src/sync/DebugMode'
import { DEFAULT_SETTINGS, OmnivoreSettings } from '../src/settings'

// 一个「用户自定义了位置 + 开了阅后即焚」的设置，用来验证调试模式的覆盖边界。
function customUserSettings(): OmnivoreSettings {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: 'k',
    folder: 'ZZCustom/{{{title}}}',
    folderDateFormat: 'yyyy_MM',
    messageFolder: 'ZZMsg/custom',
    filename: 'ZZ-{{{title}}}',
    filenameDateFormat: 'yyyy_MM_dd',
    singleFileName: 'ZZ单文件_{{{date}}}',
    singleFileDateFormat: 'yyyy_MM',
    sectionSeparator: '%%ZZ_start%%',
    sectionSeparatorEnd: '%%ZZ_end%%',
    burnAfterReading: true,
    // 非「位置」字段：调试模式不应覆盖它们
    mergeMode: DEFAULT_SETTINGS.mergeMode,
    customQuery: 'my-filter',
    template: 'MY-TEMPLATE',
    imageAttachmentFolder: 'ZZImg',
  }
}

describe('DEBUG_OVERRIDE_KEYS', () => {
  it('只覆盖位置/文件名/分节字段，且都存在于 DEFAULT_SETTINGS', () => {
    for (const k of DEBUG_OVERRIDE_KEYS) {
      expect(k in DEFAULT_SETTINGS).toBe(true)
    }
    // 不应把内容/筛选字段纳入覆盖集
    expect((DEBUG_OVERRIDE_KEYS as readonly string[])).not.toContain('mergeMode')
    expect((DEBUG_OVERRIDE_KEYS as readonly string[])).not.toContain('customQuery')
    expect((DEBUG_OVERRIDE_KEYS as readonly string[])).not.toContain('template')
    expect((DEBUG_OVERRIDE_KEYS as readonly string[])).not.toContain('imageAttachmentFolder')
  })
})

describe('resolveEffectiveSyncSettings', () => {
  it('debugActive=false 时原样返回同一引用（非调试路径零改动）', () => {
    const s = customUserSettings()
    expect(resolveEffectiveSyncSettings(s, false)).toBe(s)
  })

  it('debugActive=true 时把位置字段替换为默认值', () => {
    const s = customUserSettings()
    const eff = resolveEffectiveSyncSettings(s, true)
    expect(eff).not.toBe(s)
    for (const k of DEBUG_OVERRIDE_KEYS) {
      expect((eff as any)[k]).toBe((DEFAULT_SETTINGS as any)[k])
    }
    expect(eff.folder).toBe('笔记同步助手/{{{date}}}')
    expect(eff.filename).toBe('{{{title}}}')
    expect(eff.messageFolder).toBe('')
    expect(eff.singleFileName).toBe('同步助手_{{{date}}}')
  })

  it('debugActive=true 时强制关闭阅后即焚', () => {
    const s = customUserSettings()
    expect(s.burnAfterReading).toBe(true)
    const eff = resolveEffectiveSyncSettings(s, true)
    expect(eff.burnAfterReading).toBe(false)
  })

  it('不覆盖非位置字段（mergeMode / customQuery / template / 图片文件夹）', () => {
    const s = customUserSettings()
    const eff = resolveEffectiveSyncSettings(s, true)
    expect(eff.mergeMode).toBe(s.mergeMode)
    expect(eff.customQuery).toBe('my-filter')
    expect(eff.template).toBe('MY-TEMPLATE')
    expect(eff.imageAttachmentFolder).toBe('ZZImg')
  })

  it('绝不改动传入的原 settings（不落盘覆盖用户配置）', () => {
    const s = customUserSettings()
    resolveEffectiveSyncSettings(s, true)
    expect(s.folder).toBe('ZZCustom/{{{title}}}')
    expect(s.filename).toBe('ZZ-{{{title}}}')
    expect(s.burnAfterReading).toBe(true)
  })
})

describe('resolveDebugSyncAt', () => {
  const now = Date.parse('2026-07-03T12:00:00.000Z')

  it('默认窗口为近 24h', () => {
    expect(DEBUG_WINDOW_MS).toBe(24 * 60 * 60 * 1000)
    const iso = resolveDebugSyncAt(now)
    expect(Date.parse(iso)).toBe(now - DEBUG_WINDOW_MS)
  })

  it('接受有限正数覆盖（测试加速用）', () => {
    const iso = resolveDebugSyncAt(now, 60_000)
    expect(Date.parse(iso)).toBe(now - 60_000)
  })

  it.each([0, -1, NaN, Infinity, undefined])('非法覆盖 %p 回退默认 24h', (bad) => {
    const iso = resolveDebugSyncAt(now, bad as number | undefined)
    expect(Date.parse(iso)).toBe(now - DEBUG_WINDOW_MS)
  })
})
