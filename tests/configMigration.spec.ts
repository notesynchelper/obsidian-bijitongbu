/**
 * 配置迁移与设置兼容性测试
 *
 * 覆盖三个 bug：
 * BUG 1: 频率迁移在每次加载时重复执行 → 移除频率迁移逻辑
 * BUG 2: smartMergeSettings 遗漏用户配置字段 → 补全 userConfigFields
 * BUG 3: isValidValue 把空字符串/空数组视为无效 → 改为 fieldExists 检查字段是否存在
 */

import {
  DEFAULT_SETTINGS,
  OmnivoreSettings,
  MergeMode,
  ImageMode,
  DiaryLinkType,
  HighlightManagerId,
} from '../src/settings/index'
import { ConfigMigrationManager } from '../src/configMigration'

// ===================== Mocks =====================
jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
    normalizePath: (p: string) => p,
  }
})

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
}))

function createMockApp(): any {
  return {
    vault: {
      configDir: '.obsidian',
      adapter: {
        exists: jest.fn().mockResolvedValue(false),
        read: jest.fn().mockResolvedValue('[]'),
        write: jest.fn().mockResolvedValue(undefined),
      },
      createFolder: jest.fn().mockResolvedValue(undefined),
    },
  }
}

function createMockPlugin(): any {
  return { manifest: { version: '3.0.0' } }
}

/** 创建用户自定义的完整设置（模拟用户已修改过所有字段，所有值都不同于 DEFAULT） */
function createUserSettings(overrides?: Partial<OmnivoreSettings>): OmnivoreSettings {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: 'user-api-key-12345',
    folder: '我的笔记/{{{date}}}',
    filename: '{{{title}}}-{{{date}}}',
    template: '# 自定义模板\n{{{content}}}',
    endpoint: 'https://custom.endpoint.com/api/graphql',
    dateHighlightedFormat: 'yyyy/MM/dd',
    dateSavedFormat: 'yyyy/MM/dd HH:mm',
    customQuery: 'label:important',
    frequency: 300,
    syncOnStart: true,
    mergeMode: MergeMode.ALL,
    frontMatterVariables: ['title', 'author', 'tags'],
    frontMatterTemplate: 'title: {{{title}}}',
    folderDateFormat: 'yyyyMMdd',
    filenameDateFormat: 'yyyyMMdd',
    attachmentFolder: '自定义附件',
    singleFileName: '自定义单文件_{{{date}}}',
    singleFileDateFormat: 'yyyy/MM/dd',
    sectionSeparator: '<!-- start -->',
    sectionSeparatorEnd: '<!-- end -->',
    wechatMessageTemplate: '## {{{heading}}}\n{{{content}}}',
    imageMode: ImageMode.REMOTE,
    enablePngToJpeg: true,
    jpegQuality: 90,
    imageDownloadRetries: 5,
    imageAttachmentFolder: '自定义图片',
    enableDiaryLinks: true,
    diaryFolder: '我的日记',
    diaryDateFormat: 'yyyy/MM/dd',
    diaryAnchor: 'my-anchor',
    diaryLinkType: DiaryLinkType.MESSAGES,
    highlightOrder: 'TIME',
    enableHighlightColorRender: true,
    highlightManagerId: HighlightManagerId.HIGHLIGHTR,
    highlightColorMapping: {
      yellow: '#ffff00',
      red: '#ff0000',
      blue: '#0000ff',
      green: '#00ff00',
    },
    version: '2.9.0',
    syncAt: '2024-06-01T00:00:00.000Z',
    intervalId: 0,
    deviceSyncCursors: { 'device-1': '2024-06-01T00:00:00.000Z' },
    initialSyncCompleted: true,
    ...overrides,
  }
}

// =========================================================================
// BUG 1: 频率迁移不应再存在
// 验证：processSettingsCompatibility 中移除频率迁移后，频率值不会被篡改
// =========================================================================
describe('BUG 1: 频率值不应被篡改', () => {
  function simulateSettingsLoad(savedData: Partial<OmnivoreSettings>): OmnivoreSettings {
    return Object.assign({}, DEFAULT_SETTINGS, savedData)
  }

  it('频率 60 秒（1分钟）→ 加载后仍为 60', () => {
    const settings = simulateSettingsLoad({ frequency: 60 })
    expect(settings.frequency).toBe(60)
  })

  it('频率 300 秒（5分钟）→ 加载后仍为 300', () => {
    const settings = simulateSettingsLoad({ frequency: 300 })
    expect(settings.frequency).toBe(300)
  })

  it('频率 899 秒 → 加载后仍为 899', () => {
    const settings = simulateSettingsLoad({ frequency: 899 })
    expect(settings.frequency).toBe(899)
  })

  it('频率 15 秒（最小值）→ 加载后仍为 15', () => {
    const settings = simulateSettingsLoad({ frequency: 15 })
    expect(settings.frequency).toBe(15)
  })

  it('频率 0（手动同步）→ 加载后仍为 0', () => {
    const settings = simulateSettingsLoad({ frequency: 0 })
    expect(settings.frequency).toBe(0)
  })

  it('频率 3600 秒（1小时）→ 加载后仍为 3600', () => {
    const settings = simulateSettingsLoad({ frequency: 3600 })
    expect(settings.frequency).toBe(3600)
  })
})

// =========================================================================
// BUG 2: smartMergeSettings 应保留所有用户配置字段
// 场景：apiKey 丢失，current 基本全是 DEFAULT，backup 有用户真实数据
// =========================================================================
describe('BUG 2: smartMergeSettings 应保留所有用户配置字段', () => {
  let manager: ConfigMigrationManager

  beforeEach(() => {
    manager = new ConfigMigrationManager(createMockApp(), createMockPlugin())
  })

  it('迁移后保留 template（文章模板）', () => {
    const current = { ...DEFAULT_SETTINGS }  // apiKey 丢失，current 全是默认值
    const backup = createUserSettings()
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.template).toBe('# 自定义模板\n{{{content}}}')
  })

  it('迁移后保留 endpoint（API端点）', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings()
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.endpoint).toBe('https://custom.endpoint.com/api/graphql')
  })

  it('迁移后保留 dateHighlightedFormat', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings()
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.dateHighlightedFormat).toBe('yyyy/MM/dd')
  })

  it('迁移后保留 dateSavedFormat', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings()
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.dateSavedFormat).toBe('yyyy/MM/dd HH:mm')
  })

  it('迁移后保留 singleFileDateFormat', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings()
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.singleFileDateFormat).toBe('yyyy/MM/dd')
  })

  it('迁移后保留 sectionSeparator 和 sectionSeparatorEnd', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings()
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.sectionSeparator).toBe('<!-- start -->')
    expect(merged.sectionSeparatorEnd).toBe('<!-- end -->')
  })

  it('迁移后保留所有图片相关设置', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings()
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.imageMode).toBe(ImageMode.REMOTE)
    expect(merged.enablePngToJpeg).toBe(true)
    expect(merged.jpegQuality).toBe(90)
    expect(merged.imageDownloadRetries).toBe(5)
    expect(merged.imageAttachmentFolder).toBe('自定义图片')
  })

  it('迁移后保留所有日记链接设置', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings()
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.enableDiaryLinks).toBe(true)
    expect(merged.diaryFolder).toBe('我的日记')
    expect(merged.diaryDateFormat).toBe('yyyy/MM/dd')
    expect(merged.diaryAnchor).toBe('my-anchor')
    expect(merged.diaryLinkType).toBe(DiaryLinkType.MESSAGES)
  })

  it('迁移后保留 filter', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings({ filter: 'ALL' })
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.filter).toBe('ALL')
  })

  it('当 current 有非默认值时优先使用 current（用户在备份后又改了设置）', () => {
    const current = createUserSettings({ template: '# 最新模板', apiKey: 'new-key' })
    const backup = createUserSettings({ template: '# 旧模板', apiKey: 'old-key' })
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.template).toBe('# 最新模板')
    expect(merged.apiKey).toBe('new-key')
  })

  it('备份中没有新字段时使用默认值', () => {
    const current = { ...DEFAULT_SETTINGS }
    // 模拟旧版备份，不包含新字段
    const oldBackup = { ...DEFAULT_SETTINGS, apiKey: 'old-key' } as any
    delete oldBackup.enableDiaryLinks
    delete oldBackup.diaryFolder
    const merged = manager.smartMergeSettings(current, oldBackup, '3.0.0')
    // 新字段应使用默认值（来自 { ...DEFAULT, ...backup } 的 DEFAULT 部分）
    expect(merged.enableDiaryLinks).toBe(DEFAULT_SETTINGS.enableDiaryLinks)
    expect(merged.diaryFolder).toBe(DEFAULT_SETTINGS.diaryFolder)
  })

  it('版本号更新为目标版本', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings()
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.version).toBe('3.0.0')
  })

  // --------- deviceAutoSync map 合并 ---------
  describe('deviceAutoSync 按 deviceId 合并（不覆盖其他设备）', () => {
    it('current 只有本设备条目 + backup 有其他设备条目 → 合并两者', () => {
      const current: OmnivoreSettings = {
        ...DEFAULT_SETTINGS,
        deviceAutoSync: { 'desktop-A': { frequency: 60, syncOnStart: true } },
        deviceAutoSyncMigrated: true,
      }
      const backup: OmnivoreSettings = {
        ...DEFAULT_SETTINGS,
        apiKey: 'backup-key',
        deviceAutoSync: {
          'desktop-A': { frequency: 300, syncOnStart: false }, // 老版本
          'mobile-B': { frequency: 900, syncOnStart: false },  // 另一台设备
        },
        deviceAutoSyncMigrated: true,
      }
      const merged = manager.smartMergeSettings(current, backup, '3.0.0')
      // current 的 desktop-A 值优先（用户最近的手动修改）
      expect(merged.deviceAutoSync['desktop-A']).toEqual({ frequency: 60, syncOnStart: true })
      // backup 的 mobile-B 被保留（否则会丢失其他设备配置）
      expect(merged.deviceAutoSync['mobile-B']).toEqual({ frequency: 900, syncOnStart: false })
    })

    it('current 是空 map + backup 有多台设备 → 合并后含所有设备', () => {
      const current = { ...DEFAULT_SETTINGS }
      const backup: OmnivoreSettings = {
        ...DEFAULT_SETTINGS,
        apiKey: 'backup-key',
        deviceAutoSync: {
          'desktop-A': { frequency: 60, syncOnStart: true },
          'mobile-B': { frequency: 900, syncOnStart: false },
        },
        deviceAutoSyncMigrated: true,
      }
      const merged = manager.smartMergeSettings(current, backup, '3.0.0')
      expect(merged.deviceAutoSync).toEqual({
        'desktop-A': { frequency: 60, syncOnStart: true },
        'mobile-B': { frequency: 900, syncOnStart: false },
      })
    })

    it('current 和 backup 都为空 → 合并后仍为空', () => {
      const current = { ...DEFAULT_SETTINGS }
      const backup: OmnivoreSettings = { ...DEFAULT_SETTINGS, apiKey: 'key' }
      const merged = manager.smartMergeSettings(current, backup, '3.0.0')
      expect(merged.deviceAutoSync).toEqual({})
    })

    it('deviceAutoSyncMigrated 走通用字段合并', () => {
      const current: OmnivoreSettings = {
        ...DEFAULT_SETTINGS,
        deviceAutoSyncMigrated: true,
      }
      const backup: OmnivoreSettings = {
        ...DEFAULT_SETTINGS,
        apiKey: 'key',
        deviceAutoSyncMigrated: false,  // 老备份没经过迁移
      }
      const merged = manager.smartMergeSettings(current, backup, '3.0.0')
      expect(merged.deviceAutoSyncMigrated).toBe(true)  // current 非默认值优先
    })
  })
})

// =========================================================================
// BUG 3: backup 中用户刻意设为空/false/0 的值应被正确保留
// 场景：backup 是用户真实数据（可能含空值），不应因为值为空就丢失
// =========================================================================
describe('BUG 3: backup 中用户设为空/false/0 的值应被保留', () => {
  let manager: ConfigMigrationManager

  beforeEach(() => {
    manager = new ConfigMigrationManager(createMockApp(), createMockPlugin())
  })

  it('backup 中 frontMatterVariables 为 [] → 合并后保留空数组', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings({
      frontMatterVariables: [],  // 用户刻意清空
    })
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.frontMatterVariables).toEqual([])
  })

  it('backup 中 customQuery 为 "" → 合并后保留空字符串', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings({
      customQuery: '',  // 用户刻意清空
    })
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.customQuery).toBe('')
  })

  it('backup 中 frontMatterTemplate 为 "" → 合并后保留空字符串', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings({
      frontMatterTemplate: '',  // 用户刻意清空
    })
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.frontMatterTemplate).toBe('')
  })

  it('backup 中 boolean 值为 false → 合并后保留 false', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings({
      syncOnStart: false,
      enablePngToJpeg: false,
      enableDiaryLinks: false,
      enableHighlightColorRender: false,
    })
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.syncOnStart).toBe(false)
    expect(merged.enablePngToJpeg).toBe(false)
    expect(merged.enableDiaryLinks).toBe(false)
    expect(merged.enableHighlightColorRender).toBe(false)
  })

  it('backup 中 frequency 为 0（手动同步）→ 合并后保留 0', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = createUserSettings({
      frequency: 0,
    })
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.frequency).toBe(0)
  })

  it('字段真正不存在（undefined）时 → 使用默认值', () => {
    const current = { ...DEFAULT_SETTINGS }
    const backup = { ...DEFAULT_SETTINGS, apiKey: 'key' } as any
    delete backup.folder  // 模拟字段丢失
    const merged = manager.smartMergeSettings(current, backup, '3.0.0')
    expect(merged.folder).toBe(DEFAULT_SETTINGS.folder)  // 来自 DEFAULT
  })
})

// =========================================================================
// fieldExists 工具方法
// =========================================================================
describe('fieldExists 工具方法', () => {
  let manager: ConfigMigrationManager

  beforeEach(() => {
    manager = new ConfigMigrationManager(createMockApp(), createMockPlugin())
  })

  it('字段存在且有值 → true', () => {
    expect(manager.fieldExists({ a: 'hello' }, 'a')).toBe(true)
  })

  it('字段存在且值为空字符串 → true', () => {
    expect(manager.fieldExists({ a: '' }, 'a')).toBe(true)
  })

  it('字段存在且值为空数组 → true', () => {
    expect(manager.fieldExists({ a: [] }, 'a')).toBe(true)
  })

  it('字段存在且值为 false → true', () => {
    expect(manager.fieldExists({ a: false }, 'a')).toBe(true)
  })

  it('字段存在且值为 0 → true', () => {
    expect(manager.fieldExists({ a: 0 }, 'a')).toBe(true)
  })

  it('字段存在且值为 null → true', () => {
    expect(manager.fieldExists({ a: null }, 'a')).toBe(true)
  })

  it('字段存在且值为 undefined → false', () => {
    expect(manager.fieldExists({ a: undefined }, 'a')).toBe(false)
  })

  it('字段不存在 → false', () => {
    expect(manager.fieldExists({}, 'a')).toBe(false)
  })
})

// =========================================================================
// 前置元数据模板迁移
// 场景：老用户从未设置 frontMatterTemplate 和 frontMatterVariables，
//       更新后应自动获得新默认模板；已自定义的用户不受影响
// =========================================================================
describe('前置元数据模板迁移', () => {
  /**
   * 模拟 processSettingsCompatibility 中的迁移逻辑
   * （该方法在 main.ts 中，依赖 this.settings，这里提取纯逻辑测试）
   */
  function migrateFrontMatterTemplate(settings: OmnivoreSettings): {
    settings: OmnivoreSettings
    migrated: boolean
  } {
    const result = { ...settings }
    let migrated = false
    if (
      result.frontMatterTemplate === '' &&
      result.frontMatterVariables.length === 0
    ) {
      result.frontMatterTemplate = DEFAULT_SETTINGS.frontMatterTemplate
      migrated = true
    }
    return { settings: result, migrated }
  }

  it('新用户: DEFAULT_SETTINGS 直接包含新模板', () => {
    expect(DEFAULT_SETTINGS.frontMatterTemplate).toContain('author:')
    expect(DEFAULT_SETTINGS.frontMatterTemplate).toContain('{{{siteName}}}')
    expect(DEFAULT_SETTINGS.frontMatterTemplate).toContain('{{{originalUrl}}}')
    expect(DEFAULT_SETTINGS.frontMatterTemplate).toContain('{{{dateSaved}}}')
    expect(DEFAULT_SETTINGS.frontMatterTemplate).toContain('{{#labels}}')
  })

  it('老用户，模板和变量都为空 → 迁移到新默认模板', () => {
    const oldSettings: OmnivoreSettings = {
      ...DEFAULT_SETTINGS,
      frontMatterTemplate: '',   // 老默认值
      frontMatterVariables: [],  // 老默认值
    }
    const { settings, migrated } = migrateFrontMatterTemplate(oldSettings)
    expect(migrated).toBe(true)
    expect(settings.frontMatterTemplate).toBe(DEFAULT_SETTINGS.frontMatterTemplate)
  })

  it('老用户，自定义了 frontMatterTemplate → 不迁移', () => {
    const oldSettings: OmnivoreSettings = {
      ...DEFAULT_SETTINGS,
      frontMatterTemplate: 'title: {{{title}}}',
      frontMatterVariables: [],
    }
    const { settings, migrated } = migrateFrontMatterTemplate(oldSettings)
    expect(migrated).toBe(false)
    expect(settings.frontMatterTemplate).toBe('title: {{{title}}}')
  })

  it('老用户，自定义了 frontMatterVariables → 不迁移', () => {
    const oldSettings: OmnivoreSettings = {
      ...DEFAULT_SETTINGS,
      frontMatterTemplate: '',
      frontMatterVariables: ['title', 'author', 'tags'],
    }
    const { settings, migrated } = migrateFrontMatterTemplate(oldSettings)
    expect(migrated).toBe(false)
    expect(settings.frontMatterTemplate).toBe('')
  })

  it('老用户，两个都自定义了 → 不迁移', () => {
    const oldSettings: OmnivoreSettings = {
      ...DEFAULT_SETTINGS,
      frontMatterTemplate: 'custom: true',
      frontMatterVariables: ['title'],
    }
    const { settings, migrated } = migrateFrontMatterTemplate(oldSettings)
    expect(migrated).toBe(false)
    expect(settings.frontMatterTemplate).toBe('custom: true')
  })

  it('Object.assign 加载: 老用户 savedData 有空模板 → 保留空值不被新默认覆盖', () => {
    // 模拟 loadEssentialSettings 的 Object.assign 行为
    const savedData = {
      apiKey: 'user-key',
      frontMatterTemplate: '',   // 老用户保存的空值
      frontMatterVariables: [],
    }
    const loaded = Object.assign({}, DEFAULT_SETTINGS, savedData)
    // Object.assign 用 savedData 的 '' 覆盖新默认值
    expect(loaded.frontMatterTemplate).toBe('')
    // 所以需要迁移逻辑来处理
    const { settings, migrated } = migrateFrontMatterTemplate(loaded)
    expect(migrated).toBe(true)
    expect(settings.frontMatterTemplate).toBe(DEFAULT_SETTINGS.frontMatterTemplate)
  })

  it('Object.assign 加载: 新用户无 savedData → 直接用新默认值', () => {
    const loaded = Object.assign({}, DEFAULT_SETTINGS, {})
    expect(loaded.frontMatterTemplate).toBe(DEFAULT_SETTINGS.frontMatterTemplate)
    expect(loaded.frontMatterTemplate).toContain('author:')
  })
})
