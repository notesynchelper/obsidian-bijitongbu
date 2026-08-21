/**
 * DailyNoteResolver 测试
 * 测试日记文件定位逻辑（配置优先级）
 */

// Must define MockTFile BEFORE jest.mock so the mock factory can reference it
class MockTFile {
  path: string
  name: string
  constructor(path: string) {
    this.path = path
    this.name = path.split('/').pop() || ''
  }
}

jest.mock('obsidian', () => ({
  App: jest.fn(),
  TFile: MockTFile,
  normalizePath: (path: string) => path,
  Notice: jest.fn(),
}))

jest.mock('obsidian-daily-notes-interface', () => ({
  getDailyNoteSettings: jest.fn(),
  createDailyNote: jest.fn(),
  appHasDailyNotesPluginLoaded: jest.fn(),
}))

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
}))

jest.mock('../src/util', () => ({
  formatDate: jest.fn((dateISO: string, _format: string) => {
    return dateISO.slice(0, 10)
  }),
}))

import { getDailyNoteSettings, appHasDailyNotesPluginLoaded } from 'obsidian-daily-notes-interface'
import { DEFAULT_SETTINGS } from '../src/settings/index'

const mockMomentFormat = jest.fn().mockReturnValue('2024-01-15')
const mockMoment = jest.fn().mockReturnValue({ format: mockMomentFormat })
;(globalThis as any).window = { moment: mockMoment }

import { DailyNoteResolver } from '../src/sync/DailyNoteResolver'

const mockGetDailyNoteSettings = getDailyNoteSettings as jest.MockedFunction<typeof getDailyNoteSettings>
const mockAppHasPlugin = appHasDailyNotesPluginLoaded as jest.MockedFunction<typeof appHasDailyNotesPluginLoaded>

function createMockApp(existingFiles: string[] = []): any {
  return {
    vault: {
      getAbstractFileByPath: jest.fn((path: string) => {
        if (existingFiles.includes(path)) {
          return new MockTFile(path)
        }
        return null
      }),
      read: jest.fn().mockResolvedValue(''),
      modify: jest.fn().mockResolvedValue(undefined),
    },
  }
}

describe('DailyNoteResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAppHasPlugin.mockReturnValue(false)
    mockGetDailyNoteSettings.mockReturnValue({
      folder: 'Daily Notes',
      format: 'YYYY-MM-DD',
      template: '',
    } as any)
  })

  describe('getEffectiveDiaryConfig', () => {
    it('autoCreateDiaryNote=true → 始终使用 DN/PN 配置，忽略手动设置', () => {
      mockAppHasPlugin.mockReturnValue(true)
      mockGetDailyNoteSettings.mockReturnValue({
        folder: 'DN-Folder', format: 'YYYY-MM-DD', template: '',
      } as any)

      const resolver = new DailyNoteResolver(createMockApp(), {
        ...DEFAULT_SETTINGS,
        autoCreateDiaryNote: true,
        diaryFolder: 'Manual-Folder',
        diaryDateFormat: 'yyyy/MM/dd',
      })

      const config = resolver.getEffectiveDiaryConfig()
      expect(config.folder).toBe('DN-Folder')
      expect(config.dateFormat).toBe('YYYY-MM-DD')
      expect(config.formatSource).toBe('plugin')
    })

    it('autoCreateDiaryNote=false + 手动设置非空 → 用手动设置', () => {
      const resolver = new DailyNoteResolver(createMockApp(), {
        ...DEFAULT_SETTINGS,
        autoCreateDiaryNote: false,
        diaryFolder: 'My-Diary',
        diaryDateFormat: 'yyyy-MM-dd',
      })

      const config = resolver.getEffectiveDiaryConfig()
      expect(config.folder).toBe('My-Diary')
      expect(config.dateFormat).toBe('yyyy-MM-dd')
      expect(config.formatSource).toBe('manual')
    })

    it('autoCreateDiaryNote=false + 手动设置留空 → 读取 DN/PN 配置', () => {
      mockAppHasPlugin.mockReturnValue(true)
      mockGetDailyNoteSettings.mockReturnValue({
        folder: 'Plugin-Folder', format: 'YYYY/MM/DD', template: '',
      } as any)

      const resolver = new DailyNoteResolver(createMockApp(), {
        ...DEFAULT_SETTINGS,
        autoCreateDiaryNote: false,
        diaryFolder: '',
        diaryDateFormat: '',
      })

      const config = resolver.getEffectiveDiaryConfig()
      expect(config.folder).toBe('Plugin-Folder')
      expect(config.dateFormat).toBe('YYYY/MM/DD')
      expect(config.formatSource).toBe('plugin')
    })

    it('DN/PN 未启用 → 回退到默认设置', () => {
      mockAppHasPlugin.mockReturnValue(false)

      const resolver = new DailyNoteResolver(createMockApp(), {
        ...DEFAULT_SETTINGS,
        autoCreateDiaryNote: false,
        diaryFolder: '',
        diaryDateFormat: '',
      })

      const config = resolver.getEffectiveDiaryConfig()
      expect(config.folder).toBe(DEFAULT_SETTINGS.diaryFolder)
      expect(config.dateFormat).toBe(DEFAULT_SETTINGS.diaryDateFormat)
      expect(config.formatSource).toBe('default')
    })

    it('diaryFolder 非空但 diaryDateFormat 留空 → 独立回退', () => {
      mockAppHasPlugin.mockReturnValue(true)
      mockGetDailyNoteSettings.mockReturnValue({
        folder: 'DN-Folder', format: 'YYYY-MM-DD', template: '',
      } as any)

      const resolver = new DailyNoteResolver(createMockApp(), {
        ...DEFAULT_SETTINGS,
        autoCreateDiaryNote: false,
        diaryFolder: 'Custom-Folder',
        diaryDateFormat: '',
      })

      const config = resolver.getEffectiveDiaryConfig()
      expect(config.folder).toBe('Custom-Folder')
      // dateFormat 为空时从 plugin 回退
      expect(config.dateFormat).toBe('YYYY-MM-DD')
      expect(config.formatSource).toBe('manual')
    })
  })

  describe('resolve', () => {
    it('文件存在 → 返回 TFile', async () => {
      const app = createMockApp(['Daily Notes/2024-01-15.md'])

      const resolver = new DailyNoteResolver(app, {
        ...DEFAULT_SETTINGS,
        autoCreateDiaryNote: false,
        diaryFolder: 'Daily Notes',
        diaryDateFormat: 'yyyy-MM-dd',
      })

      const result = await resolver.resolve('2024-01-15T10:30:00.000Z')
      expect(result.file).not.toBeNull()
    })

    it('文件不存在 + autoCreate=false → fileNotFound', async () => {
      const app = createMockApp([])

      const resolver = new DailyNoteResolver(app, {
        ...DEFAULT_SETTINGS,
        autoCreateDiaryNote: false,
        diaryFolder: 'Daily Notes',
        diaryDateFormat: 'yyyy-MM-dd',
      })

      const result = await resolver.resolve('2024-01-15T10:30:00.000Z')
      expect(result.file).toBeNull()
      expect(result.reason).toBe('fileNotFound')
    })
  })
})
