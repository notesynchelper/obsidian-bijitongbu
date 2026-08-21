import { App, TFile, moment, normalizePath } from 'obsidian'
import type { Moment } from 'moment'

// obsidian 的 `moment` 导出在 esModuleInterop 下被推断成不可调用的命名空间
// 类型（typeof import('moment')），运行时它就是 moment 函数本体；这里标回
// 可调用签名（本插件只用到 ISO 字符串入参）。
const momentFn = moment as unknown as (input: string) => Moment
import { OmnivoreSettings } from '../settings'
import { formatDate } from '../util'
import { log, logError } from '../logger'
import {
  getDailyNoteSettings,
  createDailyNote,
  appHasDailyNotesPluginLoaded,
} from 'obsidian-daily-notes-interface'

export interface ResolveResult {
  file: TFile | null
  reason?: 'fileNotFound' | 'createFailed'
  errorMsg?: string
}

interface DiaryConfig {
  folder: string
  dateFormat: string
  formatSource: 'manual' | 'plugin' | 'default'
}

export class DailyNoteResolver {
  constructor(
    private app: App,
    private settings: OmnivoreSettings,
  ) {}

  getEffectiveDiaryConfig(): DiaryConfig {
    const { autoCreateDiaryNote, diaryFolder, diaryDateFormat } = this.settings

    if (autoCreateDiaryNote) {
      return this.getPluginConfig()
    }

    if (diaryFolder) {
      if (diaryDateFormat) {
        return {
          folder: diaryFolder,
          dateFormat: diaryDateFormat,
          formatSource: 'manual',
        }
      }
      // folder manual but dateFormat empty → get dateFormat from plugin/default
      const pluginConfig = this.getPluginConfig()
      return {
        folder: diaryFolder,
        dateFormat: pluginConfig.dateFormat,
        formatSource: 'manual',
      }
    }

    return this.getPluginConfig()
  }

  private getPluginConfig(): DiaryConfig {
    if (appHasDailyNotesPluginLoaded()) {
      const { folder, format } = getDailyNoteSettings()
      return {
        folder: folder || 'Daily Notes',
        dateFormat: format || 'YYYY-MM-DD',
        formatSource: 'plugin',
      }
    }

    log('Daily Notes / Periodic Notes 插件未启用，使用默认配置')
    return {
      folder: 'Daily Notes',
      dateFormat: 'yyyy-MM-dd',
      formatSource: 'default',
    }
  }

  private formatDiaryDate(dateISO: string, config: DiaryConfig): string {
    if (config.formatSource === 'plugin') {
      return momentFn(dateISO).format(config.dateFormat)
    }
    return formatDate(dateISO, config.dateFormat)
  }

  async resolve(dateISO: string): Promise<ResolveResult> {
    const config = this.getEffectiveDiaryConfig()
    const dateStr = this.formatDiaryDate(dateISO, config)
    const diaryPath = normalizePath(`${config.folder}/${dateStr}.md`)

    const existingFile = this.app.vault.getAbstractFileByPath(diaryPath)
    if (existingFile instanceof TFile) {
      return { file: existingFile }
    }

    if (this.settings.autoCreateDiaryNote) {
      return this.tryCreateDailyNote(dateISO, diaryPath)
    }

    log(`日记文件不存在，跳过: ${diaryPath}`)
    return { file: null, reason: 'fileNotFound' }
  }

  private async tryCreateDailyNote(
    dateISO: string,
    expectedPath: string,
  ): Promise<ResolveResult> {
    try {
      if (!appHasDailyNotesPluginLoaded()) {
        const msg = '自动创建日记需要启用 Daily Notes 或 Periodic Notes 插件'
        log(msg)
        return { file: null, reason: 'createFailed', errorMsg: msg }
      }

      const momentDate = momentFn(dateISO)
      const newFile = await createDailyNote(momentDate)

      if (newFile instanceof TFile) {
        log(`自动创建日记文件: ${newFile.path}`)
        return { file: newFile }
      }

      return {
        file: null,
        reason: 'createFailed',
        errorMsg: `创建日记文件失败: ${expectedPath}`,
      }
    } catch (error) {
      const errorMsg = `创建日记文件失败: ${error instanceof Error ? error.message : String(error)}`
      logError(errorMsg, error)
      return { file: null, reason: 'createFailed', errorMsg }
    }
  }
}
