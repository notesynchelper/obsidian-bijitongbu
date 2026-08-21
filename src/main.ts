import { Item } from '@omnivore-app/api'
import { DateTime } from 'luxon'
import {
  addIcon,
  normalizePath,
  Notice,
  Platform,
  Plugin,
  requestUrl,
  TFile,
  TFolder,
} from 'obsidian'
import { getItems, deleteArticleById } from './api'
import { log, logError, Logger } from './logger'
import { DEFAULT_SETTINGS, DeviceAutoSyncConfig, ImageMode, MIN_AUTO_SYNC_FREQUENCY, MergeMode, OLD_DEFAULT_FRONT_MATTER_TEMPLATE, PREV_DEFAULT_FRONT_MATTER_TEMPLATE, OmnivoreSettings, PendingBurnDelete, PluginLanguage } from './settings'
import { normalizeRetiredQuerySettings } from './settings/queryNormalize'
import { setForcedLang, t } from './i18n'
import {
  getDeviceAutoSync,
  setDeviceAutoSync,
  migrateDeviceAutoSync as migrateDeviceAutoSyncPure,
} from './settings/deviceAutoSync'
import {
  preParseTemplate,
  render,
  renderFilename,
  renderItemContent,
  isWeChatMessage,
  OLD_DEFAULT_TEMPLATE,
} from './settings/template'
import { OmnivoreSettingTab } from './settingsTab'
import { stripPromoQrImages } from './common/imageRelay'
import {
  escapeContentHashtags,
  formatDate,
  getQueryFromFilter,
  parseDateTime,
  replaceIllegalCharsFile,
  replaceIllegalCharsFolder,
  setOrUpdateHighlightColors,
  unhideNameSegment,
  unhideVaultPath,
} from './util'
import { ConfigMigrationManager } from './configMigration'
import { ImageLocalizer } from './imageLocalizer/imageLocalizer'
import { clampImageDownloadRetries } from './imageLocalizer/imageDownloader'
import { ImageProcessOptions } from './imageLocalizer/types'
import { UrlLocalMap, UrlLocalMapPersister } from './imageLocalizer/urlLocalMap'
import { PendingLocalizeStore } from './imageLocalizer/pendingQueueStore'
import { AttachmentLocalizer, AttachmentProcessOptions, isWeComFileMessage, extractFileAttachmentFromContent } from './attachmentLocalizer'
import { metaFromFrontmatter } from './common/localizerItemMeta'
import { adjustSyncCursor, advanceSyncCursor, shouldMarkInitialSyncCompleted } from './syncCursorAdjust'
import { SyncContext } from './sync/SyncContext'
import { latestSyncCursor, isCursorCovered } from './sync/cursorDedupe'
import { SyncNoticeManager } from './sync/SyncNoticeManager'
import { MergeProcessor, MergeGroup, flushMergeGroups } from './sync/MergeProcessor'
import { renderMergeFileTemplate } from './sync/mergeFileTemplate'
import {
  suppressTemplaterTriggerOnCreate,
  maskTemplaterTags,
} from './sync/templaterRelay'
import { FileProcessor } from './sync/FileProcessor'
import { BurnDeleteRecord } from './sync/BurnDeleteTracker'
import { hasLocalizationResidual } from './sync/burnResidual'
import { DiaryLinkResult } from './sync/DiaryLinkProcessor'
import {
  FirstSyncNoticeModal,
  resolveFirstSyncNoticeDelay,
  selectNotesToOpen,
  shouldAutoOpenOnFirstSync,
  shouldSuppressFirstSyncOnLoad,
} from './sync/FirstSyncOpener'
import { resolveEffectiveSyncSettings, resolveDebugSyncAt } from './sync/DebugMode'
import { UpdateReminder } from './updateReminder'
import {
  formatFolderRelocalizeNotice,
  formatRelocalizeNotice,
  getFolderRelocalizeMenuTitle,
  getRelocalizeMenuTitle,
} from './common/relocalizeNotice'
import { collectMarkdownFiles } from './common/relocalizeFolder'

/**
 * 图片本地化续传的延迟启动时间。叠加 initializeNonCriticalFeatures 自身的
 * onLayoutReady + 3s，实际在启动后约 13s+ 才开始续传，绝不阻塞启动主路径。
 */
const IMAGE_RESUME_DELAY_MS = 10_000

/**
 * 「后续同步重试」的冷却窗口（轻量去抖）：同一条续传失败任务距上次失败尝试不足
 * 此时长时，本次同步不重挂——只挡住密集手动连点同步反复 hammer 未就绪 / 永久失败
 * 的图床；正常同步间隔（分钟级）与重启（走 resumePending，cooldown=0，不受此限制）
 * 都能照常重试，符合「后续再同步时再尝试」的诉求。
 */
const PENDING_RETRY_COOLDOWN_MS = 60 * 1000

export default class OmnivorePlugin extends Plugin {
  settings: OmnivoreSettings
  private refreshTimeout: number | null = null
  private imageResumeTimeout: number | null = null
  private firstSyncNoticeTimeout: number | null = null
  private syncing: boolean = false
  private debouncedSaveSettings: () => void
  configMigrationManager: ConfigMigrationManager
  imageLocalizer: ImageLocalizer | null = null
  private imageLocalizerInitPromise: Promise<void> | null = null
  attachmentLocalizer: AttachmentLocalizer | null = null
  // 市场版弱升级提醒：只查版本号，绝不下载/替换插件自身文件。
  // 实际升级由用户在 Obsidian 设置 → 第三方插件（Community plugins）页完成。
  updateReminder: UpdateReminder | null = null

  constructor(...args: ConstructorParameters<typeof Plugin>) {
    super(...args)
    this.debouncedSaveSettings = this.createDebouncedSave()
  }

  private createDebouncedSave(): () => void {
    let timeout: number | null = null
    return () => {
      if (timeout) {
        window.clearTimeout(timeout)
      }
      timeout = window.setTimeout(() => {
        log('💾 [防抖保存] 开始执行磁盘 I/O 操作...')
        const startTime = Date.now()
        const settingsToSave = { ...this.settings }
        delete (settingsToSave as Record<string, unknown>)['config-backup']
        void this.saveData(settingsToSave).then(() => {
          const duration = Date.now() - startTime
          log(`💾 [防抖保存] saveData 完成，耗时: ${duration}ms`)
          if (this.configMigrationManager) {
            void this.configMigrationManager.backupSettings(settingsToSave)
              .then(() => log('💾 [防抖保存] 外部备份完成'))
              .catch((error: unknown) => log('外部备份时遇到问题，但设置已正常保存', error))
          }
        })
      }, 60000) // 60秒（优化启动性能，减少磁盘I/O频率）
    }
  }

  /**
   * 获取当前设备的唯一标识
   * 使用 localStorage 持久化（不跨设备同步，每台设备独有）
   */
  public getDeviceId(): string {
    const STORAGE_KEY = 'notehelper-device-id'
    try {
      let id = window.localStorage.getItem(STORAGE_KEY)
      if (!id) {
        const platform = Platform.isMobile ? 'mobile' : 'desktop'
        id = `${platform}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`
        window.localStorage.setItem(STORAGE_KEY, id)
        log(`🆔 生成新设备ID: ${id}`)
      }
      return id
    } catch {
      // localStorage 不可用时生成临时 ID
      return `tmp-${Math.random().toString(36).substring(2, 8)}`
    }
  }

  /**
   * 清理超过 30 天未更新的设备游标
   */
  private cleanStaleDeviceCursors(): void {
    const cursors = this.settings.deviceSyncCursors
    if (!cursors) return
    const thirtyDaysAgo = DateTime.local().minus({ days: 30 })
    for (const [deviceId, cursor] of Object.entries(cursors)) {
      const cursorTime = parseDateTime(cursor)
      if (cursorTime.isValid && cursorTime < thirtyDaysAgo) {
        delete cursors[deviceId]
        log(`🧹 清理过期设备游标: ${deviceId}`)
      }
    }
  }

  /**
   * 读取当前设备生效的自动同步配置
   * 委托给 settings/deviceAutoSync.ts 中的纯函数，便于单测。
   *
   * 生效值钳位：自动同步最低 MIN_AUTO_SYNC_FREQUENCY 秒（存量 1~59 的旧配置
   * 不改写存储、只在生效时按下限处理；0 = 仅手动同步不受限）。
   */
  public getEffectiveAutoSync(): DeviceAutoSyncConfig {
    const raw = getDeviceAutoSync(this.settings, this.getDeviceId())
    if (raw.frequency > 0 && raw.frequency < MIN_AUTO_SYNC_FREQUENCY) {
      return { ...raw, frequency: MIN_AUTO_SYNC_FREQUENCY }
    }
    return raw
  }

  /**
   * 为当前设备写入（部分）自动同步配置
   *
   * 同时把当前设备的最新值同步到顶层 legacy frequency/syncOnStart，
   * 以便用户回滚到老版本插件时仍能读到 *这台设备* 最近一次设置的值。
   * （老版本只认识单一全局字段；多设备语义无法兼容，只能退化为"最后写入的设备"）
   */
  public setEffectiveAutoSync(next: Partial<DeviceAutoSyncConfig>): void {
    const deviceId = this.getDeviceId()
    setDeviceAutoSync(this.settings, deviceId, next)
    const updated = this.settings.deviceAutoSync[deviceId]
    this.settings.frequency = updated.frequency
    this.settings.syncOnStart = updated.syncOnStart
  }

  /**
   * 首次加载时把老版本的顶层 frequency/syncOnStart 迁移到当前设备条目
   * @returns 是否发生了写操作（调用方据此决定是否持久化）
   */
  public migrateDeviceAutoSync(): boolean {
    const result = migrateDeviceAutoSyncPure(this.settings, this.getDeviceId())
    if (result.changed) {
      log(`🔄 自动同步设备级迁移: ${result.action}`, {
        deviceId: this.getDeviceId(),
        entry: this.settings.deviceAutoSync[this.getDeviceId()],
      })
    }
    return result.changed
  }

  async onload() {
    // 🚀 优化启动速度：延迟非关键操作
    log('🚀 笔记同步助手启动中...')

    // 关键操作：立即加载基本设置
    await this.loadEssentialSettings()

    // 根据用户设置初始化日志模式
    Logger.setDevMode(this.settings.enableDebugLog)

    // 注册核心组件
    this.registerCoreComponents()

    // 🚀 延迟非关键操作到启动完成后再执行
    this.app.workspace.onLayoutReady(() => {
      // 延迟3秒后执行非关键初始化（优化启动速度）
      window.setTimeout(() => {
        void this.initializeNonCriticalFeatures()
      }, 3000)
    })
  }

  /**
   * 🚀 快速加载基本设置（不执行配置迁移，避免阻塞启动）
   */
  private async loadEssentialSettings(): Promise<void> {
    try {
      // 1. 加载主配置
      const loadedData = await this.loadData() as Partial<OmnivoreSettings> | null

      // 🆕 检测数据是否损坏（文件过大超过 100KB）
      const dataSize = loadedData ? JSON.stringify(loadedData).length : 0
      const MAX_ALLOWED_SIZE = 100 * 1024  // 100KB
      const isCorrupted = dataSize > MAX_ALLOWED_SIZE

      if (isCorrupted) {
        log(`⚠️ 检测到损坏的配置文件 (${(dataSize / 1024 / 1024).toFixed(2)} MB > 100KB)，尝试从外部备份恢复...`)

        // 🔧 改进：先尝试从外部备份恢复关键配置，而不是直接清空
        try {
          // 从损坏的数据中提取核心配置（不包括备份字段）
          const coreSettings: Partial<OmnivoreSettings> = {}
          const keysToPreserve = ['apiKey', 'syncAt', 'folder', 'filename', 'customQuery', 'endpoint']
          for (const key of keysToPreserve) {
            if (loadedData && key in loadedData) {
              (coreSettings as Record<string, unknown>)[key] = (loadedData as Record<string, unknown>)[key]
            }
          }

          // 合并默认配置和提取的核心配置
          this.settings = { ...DEFAULT_SETTINGS, ...coreSettings }
          // 删除可能残留的备份字段
          delete (this.settings as unknown as Record<string, unknown>)['config-backup']

          // 保存清理后的配置（不包含备份，备份会在后续由 configMigrationManager 重新生成）
          const cleanSettings = { ...this.settings }
          delete (cleanSettings as unknown as Record<string, unknown>)['config-backup']
          await this.saveData(cleanSettings)

          new Notice(
            `检测到配置文件异常，已自动修复。您的核心配置已保留。`,
            8000
          )
          log('✅ 配置文件修复完成，核心配置已保留')
        } catch (error) {
          logError('修复损坏的配置文件失败，使用默认配置:', error)
          this.settings = { ...DEFAULT_SETTINGS }
          await this.saveData({})
          new Notice(
            `配置文件修复失败，已使用默认配置。请重新配置 API key。`,
            10000
          )
        }
      } else {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData ?? {})
        // 🔧 关键修复：确保 this.settings 不包含 config-backup，防止递归嵌套导致文件膨胀
        delete (this.settings as unknown as Record<string, unknown>)['config-backup']
      }
      // 老用户 data.json 可能保存了 100；必须在任何本地化器读取前收敛到运行时硬上限。
      this.settings.imageDownloadRetries = clampImageDownloadRetries(
        this.settings.imageDownloadRetries,
      )

      log('📖 加载主配置完成', {
        hasData: !!loadedData,
        dataSize: `${(dataSize / 1024).toFixed(2)} KB`,
        isCorrupted: isCorrupted,
        apiKey: this.settings.apiKey ? '***' : '(空)',
        version: this.settings.version,
        syncAt: this.settings.syncAt || '(空)'
      })

      // 2. 仅在配置完全丢失时执行紧急恢复
      const hasApiKey = this.settings.apiKey && this.settings.apiKey !== DEFAULT_SETTINGS.apiKey

      if (!hasApiKey) {
        log('⚠️ 检测到API Key丢失，执行紧急恢复...')
        const tempMigrationManager = new ConfigMigrationManager(this.app, this)
        const restoredSettings = await tempMigrationManager.performMigration(
          this.settings,
          this.manifest.version
        )
        this.settings = restoredSettings
        await this.saveData(this.settings)
        log('✅ 紧急恢复完成')
      } else {
        // ✅ 配置正常，只更新版本号（不触发完整迁移）
        if (this.settings.version !== this.manifest.version) {
          this.settings.version = this.manifest.version
          // 延迟保存，不阻塞启动
          window.setTimeout(() => { void this.saveSettings() }, 3000)
        }
      }

      // 3. 重置同步状态（轻量级操作）
      this.settings.intervalId = 0

      // 3.1 老用户升级兼容：之前同步过的用户不应在升级后被当成「首次同步」而突然
      // 自动打开笔记 + 弹窗。这里在加载阶段（早于任何 syncOnStart）就把 firstSyncAutoOpened
      // 标记为 true 抑制掉。判定同步历史走两路：initialSyncCompleted，或 syncAt / 任一
      // 设备游标非空（覆盖 initialSyncCompleted 字段出现之前就同步过的更老用户）。
      // 真正的新用户三者皆空，不会进这里，首轮同步正常触发。
      const deviceCursors = this.settings.deviceSyncCursors
      const hasSyncHistory =
        !!this.settings.syncAt ||
        (!!deviceCursors && Object.values(deviceCursors).some((c) => !!c))
      if (shouldSuppressFirstSyncOnLoad({
        firstSyncAutoOpened: this.settings.firstSyncAutoOpened,
        initialSyncCompleted: this.settings.initialSyncCompleted,
        hasSyncHistory,
      })) {
        this.settings.firstSyncAutoOpened = true
      }

      // 3.2 一次性归一化已下线的「筛选器/自定义查询」（必须在 3.1 之后：先按真实
      // 同步历史抑制 auto-open，再重置游标做全量补拉）；也必须在 registerCoreComponents
      // 之前，保证 syncOnStart 的首轮同步就用归一化后的范围与游标。
      if (normalizeRetiredQuerySettings(this.settings)) {
        // 落盘失败必须本地兜住：抛到外层 catch 会用 DEFAULT_SETTINGS 覆盖
        // 已加载配置（配置丢失路径）。内存里保留归一化结果即可，标记未落盘
        // 则下次启动幂等重跑。
        try {
          await this.saveData(this.settings)
          log('🔧 已归一化下线的自定义查询设置（范围恢复默认，游标已重置）')
        } catch (e) {
          logError('归一化设置落盘失败（内存已生效，下次启动重试）:', e)
        }
      }

      // 4. 应用界面语言偏好（强制中文/英文/跟随系统）
      this.applyLanguagePreference()
    } catch (error) {
      logError('❌ 加载基本设置失败:', error)
      this.settings = { ...DEFAULT_SETTINGS }
    }
  }

  /**
   * 把用户在「高级设置 → 界面语言」里选的语言同步给 i18n 模块。
   * AUTO → 清空强制语言（回到自动探测）；ZH/EN → 强制对应语言。
   * 在 loadEssentialSettings 末尾、以及每次 saveSettings 时调用，保证任何改写
   * settings.language 的路径（设置面板下拉、E2E setSetting 桥）都即时生效。
   */
  applyLanguagePreference(): void {
    const lang = this.settings.language
    setForcedLang(lang === PluginLanguage.ZH || lang === PluginLanguage.EN ? lang : null)
  }

  /**
   * 🚀 注册核心组件（快速操作）
   */
  private registerCoreComponents(): void {
    // 注册命令和UI组件
    this.registerCommands()
    this.registerRibbonIcon()
    this.registerFileMenu()
    // ✅ 设置页面Tab延迟创建，移到initializeNonCriticalFeatures()

    // 启动时同步检查（按设备生效）
    if (this.getEffectiveAutoSync().syncOnStart) {
      this.app.workspace.onLayoutReady(() => {
        // 延迟2秒执行同步，确保启动完成
        window.setTimeout(() => {
          if (this.settings.apiKey) {
            void this.fetchOmnivore(false).then(() => {
              this.refreshFileExplorer()
            })
          }
        }, 2000)
      })
    }
  }

  /**
   * 🚀 延迟初始化非关键功能
   */
  private async initializeNonCriticalFeatures(): Promise<void> {
    // 定时同步优先启动，独立于其他初始化（只依赖当前设备的 deviceAutoSync 配置，无其他依赖）
    try {
      this.scheduleSync()
    } catch (error) {
      logError('定时同步启动失败:', error)
    }

    try {
      log('🚀 初始化非关键功能...')

      // 0. 延迟创建设置页面Tab（避免阻塞启动）
      this.addSettingTab(new OmnivoreSettingTab(this.app, this))

      // 1. 延迟创建配置迁移管理器
      this.configMigrationManager = new ConfigMigrationManager(this.app, this)

      // 2. 延迟执行设置兼容性处理
      await this.processSettingsCompatibility()

      // 3. 延迟初始化高亮颜色
      setOrUpdateHighlightColors(this.settings.highlightColorMapping)

      // 5. 初始化图片本地化器（仅在本地模式下）
      if (this.settings.imageMode === ImageMode.LOCAL) {
        await this.initializeImageLocalizer()
        // 5.1 调度重启续传：上个会话下载中断的图片本地化任务延迟恢复
        if (this.imageLocalizer) {
          this.scheduleImageLocalizationResume()
        }
      }

      // 6. 初始化附件本地化器
      this.initializeAttachmentLocalizer()

      // 7. 延迟刷新文件浏览器
      this.refreshFileExplorer()

      // 7. 市场版弱升级提醒：只查版本号（升级由用户在第三方插件页自行完成）
      this.updateReminder = new UpdateReminder(this.manifest.version)

      log('🚀 非关键功能初始化完成')
    } catch (error) {
      logError('非关键功能初始化失败:', error)
      // 非关键功能失败不应该影响插件正常使用
    }
  }

  /**
   * 初始化图片本地化器（并发安全：同时调用只会构造一次）
   */
  private async initializeImageLocalizer(): Promise<void> {
    if (this.imageLocalizer) return
    if (this.imageLocalizerInitPromise) return this.imageLocalizerInitPromise

    const doInit = async (): Promise<void> => {
      try {
        const options: ImageProcessOptions = {
          enablePngToJpeg: this.settings.enablePngToJpeg,
          jpegQuality: this.settings.jpegQuality,
          attachmentFolder: this.settings.imageAttachmentFolder,
          folderDateFormat: this.settings.folderDateFormat,
          maxRetries: this.settings.imageDownloadRetries,
          retryDelay: 1000, // 1秒重试延迟
        }

        // 构造 url→localPath 持久化存储（存放在插件目录的侧边 JSON 文件里）
        const urlLocalMap = new UrlLocalMap(this.createSidecarJsonPersister('url-local-map.json'))
        await urlLocalMap.load()

        // 待办任务持久化存储（重启续传用，同款侧边 JSON）
        const pendingStore = new PendingLocalizeStore(
          this.createSidecarJsonPersister('pending-localize-queue.json'),
        )
        await pendingStore.load()

        // 双重检查：load 期间其它 caller 已经完成初始化时直接复用
        if (this.imageLocalizer) return
        this.imageLocalizer = new ImageLocalizer(this.app, options, urlLocalMap, pendingStore)

        // 订阅附件改名事件：改名接力（Paste image rename）或用户手动改名把已本地化图片
        // 从 md5 路径挪走后，同步更新 urlLocalMap，避免下次同步误判「映射失效」重复下载。
        // 注册一次即可（initializeImageLocalizer 有 this.imageLocalizer 守卫，只跑一次）。
        this.registerEvent(
          this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile) {
              if (file.extension === 'md') {
                this.imageLocalizer?.handleNoteRename(oldPath, file.path)
              } else {
                this.imageLocalizer?.handleAttachmentRename(oldPath, file.path)
              }
            }
          }),
        )
        log('✅ 图片本地化器初始化完成')
      } catch (error) {
        logError('图片本地化器初始化失败:', error)
      }
    }

    this.imageLocalizerInitPromise = doInit().finally(() => {
      this.imageLocalizerInitPromise = null
    })
    return this.imageLocalizerInitPromise
  }

  /**
   * 构造插件目录下侧边 JSON 文件的读写器（url-local-map.json /
   * pending-localize-queue.json 共用）。损坏/读失败一律降级为 {}，不抛。
   */
  private createSidecarJsonPersister(fileName: string): UrlLocalMapPersister | undefined {
    const pluginDir = this.manifest.dir
    if (!pluginDir) return undefined
    const filePath = `${pluginDir}/${fileName}`
    const adapter = this.app.vault.adapter
    return {
      load: async () => {
        try {
          if (await adapter.exists(filePath)) {
            const text = await adapter.read(filePath)
            const parsed: unknown = JSON.parse(text)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return parsed
            }
          }
        } catch (err) {
          logError(`读取 ${fileName} 失败`, err)
        }
        return {}
      },
      save: async (snapshot: unknown) => {
        try {
          await adapter.write(filePath, JSON.stringify(snapshot))
        } catch (err) {
          logError(`写入 ${fileName} 失败`, err)
          // 上层 store 需要看到 reject 才能恢复 dirty，并在 flush 时补写。
          throw err
        }
      },
    }
  }

  /**
   * 调度图片本地化续传：延迟 IMAGE_RESUME_DELAY_MS 后 fire-and-forget 执行。
   * 调用处已在 onLayoutReady + 3s 的非关键初始化里，叠加后 ≈ 启动 13s+。
   */
  private scheduleImageLocalizationResume(): void {
    if (this.imageResumeTimeout) return
    this.imageResumeTimeout = window.setTimeout(() => {
      this.imageResumeTimeout = null
      void this.resumePendingImageLocalization()
    }, IMAGE_RESUME_DELAY_MS)
  }

  /**
   * 重启续传：把上个会话未完成的图片本地化任务重新入队处理。
   * 全程 catch，任何异常只 log，不影响插件其余功能。
   */
  private async resumePendingImageLocalization(): Promise<void> {
    try {
      if (this.settings.imageMode !== ImageMode.LOCAL) return
      const localizer = this.imageLocalizer
      if (!localizer) return
      const resumed = await localizer.resumePending((filePath) => {
        const af = this.app.vault.getAbstractFileByPath(filePath)
        return af instanceof TFile ? af : null
      })
      if (resumed > 0) {
        log(`🔁 图片本地化续传完成：恢复处理 ${resumed} 个文件`)
        this.refreshFileExplorer()
      }
    } catch (error) {
      logError('图片本地化续传失败:', error)
    }
  }

  /**
   * 初始化附件本地化器
   */
  private initializeAttachmentLocalizer(): void {
    // syncOnStart（约 2s）可能早于非关键初始化（约 3s）创建实例。后者绝不能
    // 用一个新空队列覆盖已经注入 SyncContext、正在收任务的旧实例。
    if (this.attachmentLocalizer) return
    try {
      const options: AttachmentProcessOptions = {
        attachmentFolder: this.settings.attachmentFolder,
        folderDateFormat: this.settings.folderDateFormat,
        maxRetries: this.settings.imageDownloadRetries, // 复用图片下载重试次数设置
        retryDelay: 1000, // 1秒重试延迟
      }

      this.attachmentLocalizer = new AttachmentLocalizer(this.app, options)
      log('✅ 附件本地化器初始化完成')
    } catch (error) {
      logError('附件本地化器初始化失败:', error)
    }
  }

  /**
   * 注释掉文件中的图片语法（不加载图片模式）
   */
  private async commentOutImages(files: TFile[]): Promise<void> {
    log(`开始注释 ${files.length} 个文件中的图片...`)

    for (const file of files) {
      try {
        await this.app.vault.process(file, (content) => {
          // 匹配并注释 ![alt](url) 格式
          content = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<!-- ![$1]($2) -->')
          // 匹配并注释 ![[image]] 格式
          content = content.replace(/!\[\[([^\]]+)\]\]/g, '<!-- ![[$1]] -->')
          // 匹配并注释 <img> 标签
          content = content.replace(/<img([^>]+)>/g, '<!-- <img$1> -->')
          return content
        })
        log(`已注释图片: ${file.path}`)
      } catch (error) {
        logError(`注释图片失败: ${file.path}`, error)
      }
    }
  }

  /**
   * 🚀 处理设置兼容性（从loadSettings中提取）
   */
  private async processSettingsCompatibility(): Promise<void> {
    try {
      let needsSave = false

      // 自定义查询兜底：空值回填默认。正常路径 normalizeRetiredQuerySettings
      // 已在加载阶段保证非空；E2E harness 预置 customQueryNormalized 的隔离查询
      // 是非空值，不会被这里覆盖。
      if (!this.settings.customQuery) {
        this.settings.customQuery = getQueryFromFilter(this.settings.filter)
        needsSave = true
      }

      // 迁移空的前置元数据模板到新默认值
      // 仅当用户从未自定义过模板和变量时才迁移
      if (
        this.settings.frontMatterTemplate === '' &&
        this.settings.frontMatterVariables.length === 0
      ) {
        this.settings.frontMatterTemplate = DEFAULT_SETTINGS.frontMatterTemplate
        needsSave = true
        log('前置元数据模板已迁移到新默认值')
      }

      // 迁移旧的默认内容模板到新默认值
      // 旧模板中 title/originalUrl 与 frontMatterTemplate 重复，简化为仅保留正文
      if (this.settings.template === OLD_DEFAULT_TEMPLATE) {
        this.settings.template = DEFAULT_SETTINGS.template
        needsSave = true
        log('内容模板已从旧默认值迁移到新默认值')
      }

      // 迁移旧的默认前置元数据模板到新默认值（添加 [笔记同步助手] 标签）
      if (this.settings.frontMatterTemplate === OLD_DEFAULT_FRONT_MATTER_TEMPLATE) {
        this.settings.frontMatterTemplate = DEFAULT_SETTINGS.frontMatterTemplate
        needsSave = true
        log('前置元数据模板已从旧默认值迁移到新默认值（添加笔记同步助手标签）')
      }

      // 迁移上一版默认前置元数据模板到新默认值
      // 上一版用 `tags: [笔记同步助手]{{#labels}}[{{{name}}}]{{/labels}}`，
      // 多 label 时渲染出非法 YAML，会被 sanitize 兜底成单字符串，导致 tags 被挤成一坨
      if (this.settings.frontMatterTemplate === PREV_DEFAULT_FRONT_MATTER_TEMPLATE) {
        this.settings.frontMatterTemplate = DEFAULT_SETTINGS.frontMatterTemplate
        needsSave = true
        log('前置元数据模板已从上一版默认值迁移到新默认值（修复多 label 拼接问题）')
      }

      // 迁移老版本的顶层 frequency/syncOnStart 到 deviceAutoSync[currentDevice]
      // 老用户升级后首次启动：把全局值搬到当前设备；其他设备后续启动时会各自创建默认条目
      if (this.migrateDeviceAutoSync()) {
        needsSave = true
      }

      // 迁移旧的图片本地化布尔值设置到新的枚举模式
      // 旧版配置可能包含 enableImageLocalization 布尔字段，需要迁移到新的 imageMode 枚举
      const settingsWithLegacy = this.settings as OmnivoreSettings & { enableImageLocalization?: boolean }
      if (typeof settingsWithLegacy.enableImageLocalization === 'boolean') {
        log('检测到旧版图片设置，开始迁移...')
        const oldValue = settingsWithLegacy.enableImageLocalization
        this.settings.imageMode = oldValue ? ImageMode.LOCAL : ImageMode.REMOTE
        delete settingsWithLegacy.enableImageLocalization
        needsSave = true
        log(`图片设置已迁移: ${oldValue} -> ${this.settings.imageMode}`)
      }


      if (needsSave) {
        // 兼容性迁移只在升级首次触发，立即落盘避免 60s 防抖窗口内用户关闭 Obsidian 导致迁移丢失
        await this.saveSettings(true)
      }
    } catch (error) {
      logError('处理设置兼容性失败:', error)
    }
  }

  /**
   * 🚀 注册命令（快速操作）
   */
  private registerCommands(): void {
    this.addCommand({
      id: 'sync',
      name: 'Sync new changes',
      callback: async () => {
        await this.fetchOmnivore()
      },
    })

    // this.addCommand({
    //   id: 'resync',
    //   name: 'Resync all articles',
    //   callback: async () => {
    //     this.settings.syncAt = ''
    //     this.settings.initialSyncCompleted = false
    //     // 同时重置当前设备的游标
    //     const deviceId = this.getDeviceId()
    //     if (this.settings.deviceSyncCursors) {
    //       this.settings.deviceSyncCursors[deviceId] = ''
    //     }
    //     await this.saveSettings()
    //     new Notice('笔记同步助手最后同步时间已重置')
    //     await this.fetchOmnivore()
    //   },
    // })
  }

  /**
   * 🚀 注册图标（快速操作）
   */
  private registerRibbonIcon(): void {
    const iconId = 'tongbuzhushou'
    addIcon(
      iconId,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
      <text x="2" y="13" font-size="12" font-family="Noto Sans SC, sans-serif" font-weight="bold" fill="currentColor">同</text></svg>`
    )

    this.addRibbonIcon(iconId, iconId, async (evt: MouseEvent) => {
      await this.fetchOmnivore()
    })
  }

  /**
   * 注册文件右键菜单
   */
  private registerFileMenu(): void {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        const imageModeEnabled = this.settings.imageMode === ImageMode.LOCAL
        // 菜单项常驻，不再以「localizer 实例已存在」为显示条件：两个 localizer
        // 都是延迟初始化（附件 ~3s），旧条件会让启动头几秒右键看不到入口，
        // onClick 里的懒初始化兜底也就永远触达不了（codex 交叉验证发现）。
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle(getFolderRelocalizeMenuTitle(imageModeEnabled))
              .setIcon('folder-down')
              .onClick(() => this.relocalizeFolder(file))
          })
          return
        }
        if (!(file instanceof TFile)) return
        if (file.extension !== 'md') return
        menu.addItem((item) => {
          item
            .setTitle(getRelocalizeMenuTitle(imageModeEnabled))
            .setIcon('download')
            .onClick(() => this.relocalizeFile(file))
        })
        const parent = file.parent
        if (parent) {
          menu.addItem((item) => {
            item
              .setTitle(getFolderRelocalizeMenuTitle(imageModeEnabled))
              .setIcon('folder-down')
              .onClick(() => this.relocalizeFolder(parent))
          })
        }
      })
    )
  }

  /**
   * 重新本地化指定文件的图片和附件
   */
  private async relocalizeFile(file: TFile): Promise<void> {
    const imageModeEnabled = this.settings.imageMode === ImageMode.LOCAL
    // 与同步入口相同的懒初始化补偿：启动竞态或 REMOTE→LOCAL 运行时切换后，
    // 用户第一次右键就应真正创建并使用图片本地化器。
    if (imageModeEnabled && !this.imageLocalizer) {
      await this.initializeImageLocalizer()
    }
    if (!this.attachmentLocalizer) {
      this.initializeAttachmentLocalizer()
    }

    const noticeManager = new SyncNoticeManager()
    let totalPhases = 0
    if (imageModeEnabled && this.imageLocalizer) totalPhases++
    if (this.attachmentLocalizer) totalPhases++

    noticeManager.startPhaseProgress('本地化', totalPhases)

    // 从 frontmatter 按 alias 表回填 Item 上下文，保持文件夹路径与原始同步一致。
    // 默认前置元数据模板 (settings/index.ts:122) 的 key 是 author/source/url/saved，
    // 不是 author/siteName/originalUrl/dateSaved —— metaFromFrontmatter 会两种命名都吃。
    const cache = this.app.metadataCache.getFileCache(file)
    const meta = metaFromFrontmatter(
      cache?.frontmatter,
    )

    try {
      let failed = 0

      if (imageModeEnabled && this.imageLocalizer) {
        this.imageLocalizer.clearProcessedMark(file.path)
        const enqueueResult = await this.imageLocalizer.enqueueFile(file, meta)
        const result = await this.imageLocalizer.processQueue()
        if (
          enqueueResult === 'read-failed' ||
          result.failedFiles.includes(file.path)
        ) {
          failed++
        }
        noticeManager.onPhaseItemProcessed()
      } else if (imageModeEnabled) {
        // 初始化失败也必须显式反馈，不能降级成成功。
        failed++
      }

      if (this.attachmentLocalizer) {
        this.attachmentLocalizer.clearProcessedMark(file.path)
        const enqueueResult = await this.attachmentLocalizer.enqueueFile(file, meta)
        const result = await this.attachmentLocalizer.processQueue()
        if (
          enqueueResult === 'read-failed' ||
          result.failedFiles.includes(file.path)
        ) {
          failed++
        }
        noticeManager.onPhaseItemProcessed()
      } else {
        failed++
      }

      const message = formatRelocalizeNotice({
        basename: file.basename,
        imageModeEnabled,
        failed,
      })
      if (failed > 0) {
        logError(message)
        noticeManager.failPhase(message)
      } else {
        noticeManager.completePhase()
        new Notice(message, 3000)
      }
    } catch (error) {
      logError('重新本地化失败:', error)
      noticeManager.failPhase('本地化失败，请重试')
    }
  }

  /**
   * 递归重新本地化指定文件夹内所有笔记的图片和附件。
   *
   * 每个 localizer 都先完成整批入队，再统一 drain 一次，避免逐文件 drain
   * 破坏共享队列的交接语义。
   */
  private async relocalizeFolder(folder: TFolder): Promise<void> {
    const imageModeEnabled = this.settings.imageMode === ImageMode.LOCAL
    // 与同步入口、单文件重新本地化相同的懒初始化补偿。
    if (imageModeEnabled && !this.imageLocalizer) {
      await this.initializeImageLocalizer()
    }
    if (!this.attachmentLocalizer) {
      this.initializeAttachmentLocalizer()
    }

    const files = collectMarkdownFiles(folder)
    if (files.length === 0) {
      new Notice('该文件夹没有可处理的笔记')
      return
    }

    const noticeManager = new SyncNoticeManager()
    let totalPhases = 0
    if (imageModeEnabled && this.imageLocalizer) totalPhases++
    if (this.attachmentLocalizer) totalPhases++
    noticeManager.startPhaseProgress('本地化', totalPhases)

    const entries = files.map((file) => {
      const cache = this.app.metadataCache.getFileCache(file)
      return {
        file,
        meta: metaFromFrontmatter(
          cache?.frontmatter,
        ),
      }
    })

    try {
      const failedPaths = new Set<string>()
      const targetPaths = new Set(files.map((file) => file.path))

      if (imageModeEnabled && this.imageLocalizer) {
        for (const { file, meta } of entries) {
          this.imageLocalizer.clearProcessedMark(file.path)
          const enqueueResult = await this.imageLocalizer.enqueueFile(file, meta)
          if (enqueueResult === 'read-failed') failedPaths.add(file.path)
        }
        const result = await this.imageLocalizer.processQueue()
        for (const path of result.failedFiles) {
          if (targetPaths.has(path)) failedPaths.add(path)
        }
        noticeManager.onPhaseItemProcessed()
      } else if (imageModeEnabled) {
        // 图片模式开启但初始化失败：该批笔记都不能降级成成功。
        for (const file of files) failedPaths.add(file.path)
      }

      if (this.attachmentLocalizer) {
        for (const { file, meta } of entries) {
          this.attachmentLocalizer.clearProcessedMark(file.path)
          const enqueueResult = await this.attachmentLocalizer.enqueueFile(file, meta)
          if (enqueueResult === 'read-failed') failedPaths.add(file.path)
        }
        const result = await this.attachmentLocalizer.processQueue()
        for (const path of result.failedFiles) {
          if (targetPaths.has(path)) failedPaths.add(path)
        }
        noticeManager.onPhaseItemProcessed()
      } else {
        for (const file of files) failedPaths.add(file.path)
      }

      const failed = failedPaths.size
      const message = formatFolderRelocalizeNotice({
        folderName: folder.isRoot() ? '/' : folder.name,
        noteCount: files.length,
        imageModeEnabled,
        failed,
      })
      if (failed > 0) {
        logError(message)
        noticeManager.failPhase(message)
      } else {
        noticeManager.completePhase()
        new Notice(message, 3000)
      }
    } catch (error) {
      logError('文件夹重新本地化失败:', error)
      noticeManager.failPhase('本地化失败，请重试')
    }
  }

  /**
   * 打开 Obsidian 设置的「第三方插件」页（Community plugins），便于用户完成升级。
   * 优先走设置面板 API；异常时回退到 obsidian:// 协议打开本插件的市场详情页。
   */
  openCommunityPluginsPage(): void {
    try {
      const setting = (
        this.app as unknown as {
          setting?: { open: () => void; openTabById: (id: string) => void }
        }
      ).setting
      if (setting) {
        setting.open()
        setting.openTabById('community-plugins')
        return
      }
    } catch (e) {
      log('打开第三方插件页失败，回退协议跳转', e)
    }
    window.open(`obsidian://show-plugin?id=${this.manifest.id}`)
  }

  onunload() {
    // 清理防抖timeout
    if (this.refreshTimeout) {
      window.clearTimeout(this.refreshTimeout)
      this.refreshTimeout = null
    }
    // 清理续传延迟启动定时器
    if (this.imageResumeTimeout) {
      window.clearTimeout(this.imageResumeTimeout)
      this.imageResumeTimeout = null
    }
    // 清理首次同步说明弹窗的延迟定时器
    if (this.firstSyncNoticeTimeout) {
      window.clearTimeout(this.firstSyncNoticeTimeout)
      this.firstSyncNoticeTimeout = null
    }
    // 强制落盘 urlLocalMap + 续传队列，避免卸载/重启丢失最近的本地化状态
    if (this.imageLocalizer) {
      void this.imageLocalizer.getUrlLocalMap().flush()
      void this.imageLocalizer.getPendingStore()?.flush()
    }
    // registerInterval 会自动清理定时器，无需手动处理
  }

  
  async saveSettings(immediate = false) {
    // 保存即生效：任何改写 settings.language 的路径（设置面板下拉、E2E setSetting 桥）
    // 走完这里后 i18n 立刻读到新语言，再 display() 重渲染就是目标语言。
    this.applyLanguagePreference()

    const settingsToSave = { ...this.settings }
    delete (settingsToSave as Record<string, unknown>)['config-backup']

    if (immediate) {
      log('💾 [立即保存] 开始执行磁盘 I/O 操作...')
      const startTime = Date.now()
      await this.saveData(settingsToSave)
      const duration = Date.now() - startTime
      log(`💾 [立即保存] saveData 完成，耗时: ${duration}ms`)
      // 同时备份配置到外部目录，防止插件升级时丢失
      if (this.configMigrationManager) {
        try {
          await this.configMigrationManager.backupSettings(settingsToSave)
          log('💾 [立即保存] 外部备份完成')
        } catch (error) {
          log('外部备份时遇到问题，但设置已正常保存', error)
        }
      }
    } else {
      log('💾 [防抖保存] 调用防抖保存，将在30秒后执行...')
      this.debouncedSaveSettings()
    }
  }

  scheduleSync(): void {
    // clear previous interval
    if (this.settings.intervalId > 0) {
      window.clearInterval(this.settings.intervalId)
      this.settings.intervalId = 0
    }

    const frequency = this.getEffectiveAutoSync().frequency
    if (frequency > 0) {
      // schedule new interval
      const intervalId = window.setInterval(
        () => {
          void this.fetchOmnivore(false)
        },
        frequency * 1000,
      )

      // save new interval id (no need to persist to disk, just keep in memory)
      this.settings.intervalId = intervalId

      // register interval for proper cleanup on plugin unload
      this.registerInterval(intervalId)
    }
  }

  async downloadFileAsAttachment(item: Item): Promise<string> {
    // download pdf from the URL to the attachment folder
    const url = item.url
    const response = await requestUrl({
      url,
      contentType: 'application/pdf',
    })
    const folderName = unhideVaultPath(
      normalizePath(
        render(
          item,
          this.settings.attachmentFolder,
          this.settings.folderDateFormat,
          { pathSafe: true },
        ),
      ),
    )
    const folder = this.app.vault.getAbstractFileByPath(folderName)
    if (!(folder instanceof TFolder)) {
      await this.app.vault.createFolder(folderName)
    }
    const fileName = normalizePath(`${folderName}/${item.id}.pdf`)
    const file = this.app.vault.getAbstractFileByPath(fileName)
    if (!(file instanceof TFile)) {
      const newFile = await this.app.vault.createBinary(
        fileName,
        response.arrayBuffer,
      )
      return newFile.path
    }
    return file.path
  }

  /**
   * 双保险-元数据层：通过 description 识别企微文件消息，提前下载附件并替换 content 中的远程链接
   * 在同步阶段（写入笔记前）执行，确保写入 vault 的内容已包含本地路径
   * 即使此层失败，内容层（AttachmentLocalizer 的 📎 正则）仍会在笔记写入后兜底处理
   */
  async preDownloadWeComFileAttachment(item: Item): Promise<void> {
    try {
      const attachmentInfo = extractFileAttachmentFromContent(item.content)
      if (!attachmentInfo) {
        log(`📎 企微文件消息但未找到附件链接: ${item.title}`)
        return
      }

      const { fileName, url, fileSize } = attachmentInfo
      log(`📎 元数据层检测到企微文件附件: ${fileName} (${fileSize || '未知大小'})`)

      // 生成附件存储文件夹路径
      const folderPath = unhideVaultPath(
        normalizePath(
          render(item, this.settings.attachmentFolder, this.settings.folderDateFormat, { pathSafe: true }),
        ),
      )

      // 确保文件夹存在
      const folder = this.app.vault.getAbstractFileByPath(folderPath)
      if (!(folder instanceof TFolder)) {
        try {
          await this.app.vault.createFolder(folderPath)
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          if (!msg.includes('already exists')) throw error
        }
      }

      // 清理文件名中的非法字符
      // Obsidian 会隐藏 dot-file；附件被藏起来后，正文 wikilink 点开是空的。
      const safeFileName = unhideNameSegment(
        fileName
          .replace(/[\\/:*?"<>|]/g, '_')
          .trim()
          .replace(/\.+$/, ''),
      )
      const filePath = normalizePath(`${folderPath}/${safeFileName}`)

      // 检查文件是否已存在（跳过重复下载）
      const existingFile = this.app.vault.getAbstractFileByPath(filePath)
      if (existingFile instanceof TFile) {
        log(`📎 附件已存在，跳过下载: ${filePath}`)
      } else {
        // 下载附件
        const response = await requestUrl({
          url,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        })

        if (response.status !== 200) {
          logError(`📎 下载附件失败 HTTP ${response.status}: ${url}`)
          return
        }

        await this.app.vault.createBinary(filePath, response.arrayBuffer)
        log(`📎 附件下载成功: ${filePath}`)
      }

      // 替换 content 中的远程链接为本地链接
      const originalText = `📎 [${fileName}](${url})`
      const sizeInfo = fileSize ? ` (${fileSize})` : ''
      // 构造两种可能的原始文本格式（带大小和不带大小）
      const originalTextWithSize = `${originalText}${sizeInfo ? ` (${fileSize})` : ''}`
      const localText = `📎 [[${filePath}|${fileName}]]${sizeInfo}`

      if (item.content) {
        // 优先替换带大小的完整格式，再替换不带大小的格式
        if (item.content.includes(originalTextWithSize)) {
          item.content = item.content.split(originalTextWithSize).join(localText)
        } else if (item.content.includes(originalText)) {
          item.content = item.content.split(originalText).join(localText)
        }
        log(`📎 已替换远程链接为本地路径: ${filePath}`)
      }
    } catch (error) {
      // 元数据层失败不影响同步，内容层（AttachmentLocalizer）会兜底
      logError(`📎 元数据层预下载附件失败（内容层将兜底）: ${item.title}`, error)
    }
  }

  /**
   * 确保文件夹存在（不存在则创建；已存在 / 并发创建都视为成功）。
   */
  private async ensureFolderExists(folderName: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(folderName)
    if (existing instanceof TFolder) return
    try {
      await this.app.vault.createFolder(folderName)
    } catch (error: unknown) {
      // 处理文件夹已存在的情况（并发创建竞态）：视为成功即可，
      // Vault API 会自行派发事件，无需（也不应）手动 trigger 内部事件。
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorMessage.includes('Folder already exists') ||
          errorMessage.includes('already exists')) {
        // no-op
      } else {
        logError(`🔧 文件夹创建失败: ${folderName}`, error)
        throw error
      }
    }
  }

  /**
   * 双写模式（MergeMode.DUAL）：把一条已进合并文件的消息，再按「文章」的文件夹 /
   * 文件名模板单独落一份笔记。
   *
   * 与合并副本的关系：合并副本是主真相（成功计数、游标、阅后即焚删除候选、日记双链
   * 都由 MergeProcessor 负责），本副本只是额外的一份正文，所以：
   *  - 路由只认「独立笔记」索引（见 FileProcessor 的 dualStandaloneCopy）；
   *  - 与合并文件同路径时直接放弃（否则单篇正文会覆写整个合并文件）。
   */
  private async writeDualStandaloneCopy(params: {
    item: Item
    content: string
    folderTemplate: string
    folderDateFormat: string
    filenameTemplate: string
    filenameDateFormat: string
    mergeTargetPath: string
    fileProcessor: FileProcessor
    skipByCursor: boolean
  }): Promise<void> {
    const { item, content, mergeTargetPath, fileProcessor } = params
    // 「无 id」模式：item 已被最新设备游标覆盖 → 其它设备已同步过，文件会随库同步到达，
    // 跳过写盘防重复（与非合并路径同一条规则）。
    if (params.skipByCursor) return

    const folderName = replaceIllegalCharsFolder(
      normalizePath(render(item, params.folderTemplate, params.folderDateFormat, { pathSafe: true })),
    )
    const customFilename = replaceIllegalCharsFile(
      renderFilename(item, params.filenameTemplate, params.filenameDateFormat),
    )
    const normalizedPath = normalizePath(`${folderName}/${customFilename}.md`)
    if (normalizedPath === mergeTargetPath) {
      // 用户把文章模板配成了和消息合并文件同名 —— 写下去等于用单篇正文覆盖整份合并文件。
      // 数据安全优先：放弃独立副本，合并副本照常。
      logError(`⚠️ 双写跳过：独立副本与合并文件同路径 ${normalizedPath}（请调整文章文件名模板）`)
      return
    }
    await this.ensureFolderExists(folderName)
    await fileProcessor.process(item, normalizedPath, content, folderName, customFilename, {
      dualStandaloneCopy: true,
    })
  }

  /**
   * 查找或创建合并目标文件，用于 processBatch 批量写入
   */
  private async resolveOrCreateMergeTarget(
    omnivoreFile: ReturnType<typeof this.app.vault.getAbstractFileByPath>,
    normalizedPath: string,
    syncContext: SyncContext,
    item: Item,
    dualWrite = false,
    initialContent = '',
  ): Promise<TFile | null> {
    // 按路径查找
    if (omnivoreFile instanceof TFile) {
      // 本轮的合并目标登记进 SyncContext：新建的按天文件不在启动索引里，
      // 不登记的话同轮的单篇写入会把它当普通文件整份覆写。
      syncContext.markMergeFile(omnivoreFile)
      return omnivoreFile
    }
    // 按 ID 索引查找（阅后即焚用 exact-only，避免 Bloom 假阳性把新 item 误路由到错误文件）
    // 双写模式用 merge-only：同一条消息的 id 也挂在它的独立笔记上，通用查找可能返回那篇
    // 独立文章 → 合并内容被追加进单篇笔记（不可逆的内容搅混）。burn 下同样只认精确记录。
    const burn = this.settings.burnAfterReading === true
    const indexed = dualWrite
      ? syncContext.findMergeFileById(item.id, burn)
      : burn
        ? syncContext.findFileByExactId(item.id)
        : syncContext.findFileById(item.id)
    if (indexed) {
      syncContext.markMergeFile(indexed)
      return indexed
    }
    // 文件不存在：按「合并文件模板」落初始内容（未配置模板时 initialContent=''，
    // 等于历史的空文件），再让 processBatch 统一排序写入。
    // P0 加固：预挂 Templater trigger_on_file_creation 抑制条目，防它按全文
    // 执行本插件落盘内容里的 <% %> 命令（同步内容=不可信输入，真机 B2 实锤）
    const releaseSuppress = suppressTemplaterTriggerOnCreate(this.app, normalizedPath)
    try {
      await this.app.vault.create(normalizedPath, initialContent)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('already exists')) throw e
    } finally {
      releaseSuppress()
    }
    const created = this.app.vault.getAbstractFileByPath(normalizedPath)
    if (created instanceof TFile) {
      syncContext.markMergeFile(created)
      return created
    }
    return null
  }

  async fetchOmnivore(manualSync = true) {
    // 调试模式：仅手动同步生效（后台 syncOnStart/定时同步照常按用户配置 + 真实游标跑）。
    // 生效时用 syncSettings（用户设置浅拷贝，位置字段替换为默认值 + 强制关闭阅后即焚）跑本轮，
    // 持久化的 this.settings 原封不动 —— 关掉调试即彻底复原（见 DebugMode / 设计 §1）。
    const debugActive = !!this.settings.debugMode && manualSync
    const syncSettings = resolveEffectiveSyncSettings(this.settings, debugActive)
    if (debugActive) log('🐞 调试模式已激活：默认位置 + 近 24h + 自动打开，不改同步状态/不删数据')

    const {
      apiKey,
      customQuery,
      highlightOrder,
      template,
      folder,
      messageFolder,
      filename,
      mergeMode,
      frontMatterVariables,
      frontMatterTemplate,
      singleFileName,
      // 合并文件模板：新建合并文件时的初始内容（内容模板，调试模式不覆盖）
      mergeFileTemplate,
      // 位置/文件名日期格式：本轮全部走 syncSettings，调试模式才能真正落到默认位置（codex #4）
      folderDateFormat,
      filenameDateFormat,
      singleFileDateFormat,
    } = syncSettings
    const effectiveMessageFolder = messageFolder || folder
    // 阅后即焚是否本轮生效：调试模式 syncSettings.burnAfterReading 恒为 false（诊断不删数据）。
    const burnActive = syncSettings.burnAfterReading === true

    // 获取同步起点（优先用自己的设备游标）
    const deviceId = this.getDeviceId()
    let syncAt = this.settings.deviceSyncCursors?.[deviceId]
      || this.settings.syncAt
      || ''

    if (debugActive) {
      // 调试模式：固定拉近 24h（无视存量游标），且不做首次同步回退调整。
      syncAt = resolveDebugSyncAt(Date.now(), this.settings.debugWindowMs)
      log(`🐞 调试模式同步窗口起点: ${syncAt}`)
    } else {
      // 同步游标调整：初次同步未完成回退1天
      const adjustedSyncAt = adjustSyncCursor(
        syncAt,
        folder,
        this.settings.initialSyncCompleted,
      )
      if (adjustedSyncAt !== syncAt) {
        log(`📅 同步时间已调整: ${syncAt} -> ${adjustedSyncAt}`)
        syncAt = adjustedSyncAt
      }
    }

    // 根据合并模式确定是否启用单文件模式（用于兼容现有逻辑）
    const isSingleFile = mergeMode !== MergeMode.NONE
    // 双写模式：消息进合并文件的同时，再按「文章」的文件夹/文件名模板单独落一份笔记。
    // 合并副本是主真相（游标 / 阅后即焚 / 日记双链都走它），独立副本是额外的一份。
    const dualWrite = mergeMode === MergeMode.DUAL

    if (this.syncing) {
      if (manualSync) {
        new Notice('🐢 正在同步中...')
      }
      return
    }

    if (!apiKey) {
      new Notice('API 密钥未填写，请前往「笔记同步助手」公众号获取', 10000)
      return
    }

    const noticeManager = new SyncNoticeManager()
    if (manualSync) {
      noticeManager.startSync()
    }

    // 市场版弱升级提醒：异步查版本号（不阻塞同步、失败静默）。发现新版本时，
    // 在同步状态 Notice 下方附一行提示，点击跳转 Obsidian 第三方插件页升级。
    // 绝不下载/替换任何插件文件——实际升级完全交给官方插件市场机制。
    if (manualSync && this.updateReminder) {
      void this.updateReminder
        .check()
        .then((info) => {
          if (!info) return
          noticeManager.setUpdateReminder({
            text: t('versionCheck.reminderLine').replace(
              '{version}',
              info.latestVersion,
            ),
            onClick: () => this.openCommunityPluginsPage(),
          })
        })
        .catch(() => {
          // 弱提醒：任何失败都静默
        })
    }

    this.syncing = true

    // 看门狗：防止网络挂起导致 syncing 永远为 true，阻断所有后续同步
    const SYNC_TIMEOUT_MS = 5 * 60 * 1000
    const syncWatchdog = window.setTimeout(() => {
      if (this.syncing) {
        logError('⚠️ 同步超时（5分钟），强制重置同步状态')
        this.syncing = false
        if (manualSync) {
          new Notice('同步超时，已自动重置。请检查网络后重试。', 5000)
        }
      }
    }, SYNC_TIMEOUT_MS)

    // 阅后即焚：本轮删除候选，留到 finally 之后（移出 watchdog）再执行
    let burnRecordsToDelete: BurnDeleteRecord[] = []

    try {
      log(`笔记同步助手开始同步，自: '${syncAt}'`)

      // 市场版：不做 Templater 插值接力（该能力依赖 Templater 未公开的内部 API）。
      // 模板里的 <% %> 标签仍会被掩码保护（防 Mustache 解析炸裂），并原样保留在输出中。
      const effectiveTemplate = template
      const effectiveWechatMessageTemplate = this.settings.wechatMessageTemplate

      // pre-parse template
      log('🔧 开始解析前端模板')
      if (frontMatterTemplate) {
        preParseTemplate(frontMatterTemplate)
      }
      log('🔧 开始解析主模板')
      // 未接力成功的 <% %> 标签仍在文本里，Mustache.parse 会被表达式里的 {{ 弄炸
      // → 掩码后再 parse（renderItemContent 渲染时同样掩码，两边一致）
      const templateSpans = preParseTemplate(maskTemplaterTags(effectiveTemplate).text)
      log('🔧 模板解析完成，templateSpans:', templateSpans)
      // check if we need to include content or file attachment
      const includeContent = templateSpans.some(
        (templateSpan) => templateSpan[1] === 'content',
      )
      log('🔧 includeContent:', includeContent)
      const includeFileAttachment = templateSpans.some(
        (templateSpan) => templateSpan[1] === 'fileAttachment',
      )
      log('🔧 includeFileAttachment:', includeFileAttachment)

      const size = 15

      // 确保图片/附件本地化器已初始化（防止 syncOnStart 时序竞态：sync 2s 启动，初始化 3s 才执行）
      if (this.settings.imageMode === ImageMode.LOCAL && !this.imageLocalizer) {
        await this.initializeImageLocalizer()
      }
      if (!this.attachmentLocalizer) {
        this.initializeAttachmentLocalizer()
      }

      // 🆕 创建同步上下文（集中管理状态，自动去重）
      // 传 syncSettings（调试模式下为默认位置副本）让 MergeProcessor 等读到覆盖后的位置/分节字段；
      // debugActive 时禁用跨库 ID 路由，保证 item 落到默认路径而非命中旧位置文件原地更新（codex #1）。
      const syncContext = new SyncContext(this.app, syncSettings, this.imageLocalizer, this.attachmentLocalizer, debugActive)
      // 本轮生效的消息模板（Templater 接力后）：MergeProcessor 的消息渲染与
      // 日记双链锚点都读它，与 renderFor 用的同一份，保证锚点与标题一致
      syncContext.effectiveWechatMessageTemplate = effectiveWechatMessageTemplate
      // 内联标记合并文件的正文 id 补进 exact 索引（frontmatter 已无 syncedIds），
      // 保证改名 / 模板变更后仍能按 id 路由回旧文件，不重复建文件。
      await syncContext.buildMarkerIndex()
      const mergeProcessor = new MergeProcessor(syncContext)
      const fileProcessor = new FileProcessor(syncContext)

      // 「无 id」模式本轮是否生效：burn 优先——阅后即焚必须保留 frontmatter id 的精确
      // 识别，否则同名文章会先覆盖再删云端、永久丢数据（codex P1）；调试模式旁路——
      // 重拉的近 24h item 全落在游标之前，不旁路一条都写不出来。
      const omitIdActive =
        this.settings.omitFrontmatterId === true && !burnActive && !debugActive
      // 游标快照取在本轮推进之前：所有设备游标 + 全局 syncAt 的最新值（见 cursorDedupe.ts）
      const noIdLatestCursor = omitIdActive ? latestSyncCursor(this.settings) : ''

      let maxUpdatedAt = ''
      // 合并分组跨所有 fetch 分页累积，循环结束后用 flushMergeGroups 一次性落盘。
      // 绝不能每分页各调一次 processBatch —— 服务器 newest-first 分页 + 每批整块
      // prepend 会把老页堆到文件顶部（顶部变最老而非最新），还会让后页 item 撞
      // 前页累积 filter 的 Bloom 假阳性被静默丢。详见 flushMergeGroups 注释。
      const mergeGroups = new Map<string, MergeGroup>()
      log('🔧 准备开始循环获取数据')
      for (let after = 0; ; after += size) {
        log(`🔧 开始获取第 ${after/size + 1} 批数据`)
        const [items, hasNextPage] = await getItems(
          this.settings.endpoint,
          apiKey,
          after,
          size,
          parseDateTime(syncAt).toISO() || undefined,
          customQuery,
          includeContent,
          'highlightedMarkdown',
        )

        log(`🔧 成功获取数据，items数量: ${items.length}，hasNextPage: ${hasNextPage}`)

        let processedCount = 0
        for (const item of items) {
          // 每处理50篇文章输出一次进度
          processedCount++
          if (processedCount % 50 === 0) {
            log(`🔧 已处理 ${processedCount}/${items.length} 篇文章`)
          }

          // 🆕 容错处理：单篇文章失败不中断整体同步
          try {
            // 对于企微消息,从标题提取日期用于文件夹路径
            let folderName: string
            if (isSingleFile && item.title.startsWith('同步助手_')) {
              const titleParts = item.title.split('_')
              if (titleParts.length >= 2 && titleParts[1].length === 8) {
              // 从标题提取日期: yyyyMMdd -> ISO格式，让 formatDate 根据 folderDateFormat 设置格式化
              const dateStr = titleParts[1]
              const year = dateStr.substring(0, 4)
              const month = dateStr.substring(4, 6)
              const day = dateStr.substring(6, 8)
              // 构造 ISO 日期字符串，而不是硬编码格式
              const isoDate = `${year}-${month}-${day}T00:00:00.000Z`

              // 创建临时item对象,使用提取的日期
              const tempItem = {
                ...item,
                savedAt: isoDate, // 传递 ISO 格式，让 render 函数根据 folderDateFormat 格式化
              }
              folderName = replaceIllegalCharsFolder(
                normalizePath(render(tempItem, effectiveMessageFolder, folderDateFormat, { pathSafe: true })),
              )
            } else {
              folderName = replaceIllegalCharsFolder(
                normalizePath(render(item, effectiveMessageFolder, folderDateFormat, { pathSafe: true })),
              )
            }
          } else {
            folderName = replaceIllegalCharsFolder(
              normalizePath(render(item, folder, folderDateFormat, { pathSafe: true })),
            )
          }
          // log(`🔧 文件夹名称: ${folderName}`)
          await this.ensureFolderExists(folderName)
          // 双保险-元数据层：通过 description 识别企微文件消息，提前下载附件
          if (isWeComFileMessage(item)) {
            await this.preDownloadWeComFileAttachment(item)
          }

          // log(`🔧 开始处理文件附件`)
          const fileAttachment =
            item.pageType === 'FILE' && includeFileAttachment
              ? await this.downloadFileAsAttachment(item)
              : undefined
          // log(`🔧 文件附件处理完成`)
          // log(`🔧 开始渲染内容`)

          // 判断是否需要合并到单文件：
          // - MergeMode.MESSAGES: 只合并企微消息
          // - MergeMode.DUAL: 同 MESSAGES（合并副本），另外再写一份独立笔记
          // - MergeMode.ALL: 合并所有文章
          const shouldMergeIntoSingleFile =
            ((mergeMode === MergeMode.MESSAGES || dualWrite) && isWeChatMessage(item)) ||
            mergeMode === MergeMode.ALL

          // 市场版合规：先剥离正文里的「积分充值二维码」推广图（插件界面外不得
          // 出现推广，会员入口统一在设置页）；再按需做标签转义。都用浅拷贝。
          let contentForRender = item.content
          if (contentForRender) {
            contentForRender = stripPromoQrImages(contentForRender)
            if (this.settings.escapeHashtags) {
              contentForRender = escapeContentHashtags(contentForRender)
            }
          }
          const itemForRender = contentForRender === item.content
            ? item
            : { ...item, content: contentForRender }

          // 同一条 item 在双写模式下要渲染两次（合并副本 merged=true / 独立副本 merged=false），
          // 抽成局部闭包避免两处 14 个位置参数漂移。
          const renderFor = (merged: boolean): string => renderItemContent(
            itemForRender,
            effectiveTemplate,
            highlightOrder,
            this.settings.enableHighlightColorRender
              ? this.settings.highlightManagerId
              : undefined,
            this.settings.dateHighlightedFormat,
            this.settings.dateSavedFormat,
            merged,
            frontMatterVariables,
            frontMatterTemplate,
            syncSettings.sectionSeparator,
            syncSettings.sectionSeparatorEnd,
            fileAttachment,
            effectiveWechatMessageTemplate,
            omitIdActive,
          )
          const content = renderFor(shouldMergeIntoSingleFile)
          // log(`🔧 内容渲染完成`)
          // use the custom filename
          let customFilename = replaceIllegalCharsFile(
            renderFilename(item, filename, filenameDateFormat),
          )

          // 合并文件模板的 {{{date}}}：默认取 item.savedAt，企微消息标题里带
          // yyyyMMdd 时（下方分支）改用那个日期 —— 与合并文件名里的日期同源。
          let mergeFileDateIso = item.savedAt

          // 检测是否为企微消息（标题格式：同步助手_yyyyMMdd_xxx_类型）
          if (isSingleFile && item.title.startsWith('同步助手_')) {
            // 提取日期部分（格式：yyyyMMdd）
            const titleParts = item.title.split('_')
            if (titleParts.length >= 2) {
              const dateStr = titleParts[1] // yyyyMMdd
              // 将 yyyyMMdd 转换为 ISO 日期格式，让 formatDate 根据 filenameDateFormat 设置格式化
              if (dateStr.length === 8) {
                const year = dateStr.substring(0, 4)
                const month = dateStr.substring(4, 6)
                const day = dateStr.substring(6, 8)
                // 构造 ISO 日期字符串，而不是硬编码格式
                const isoDate = `${year}-${month}-${day}T00:00:00.000Z`
                mergeFileDateIso = isoDate

                // 使用 singleFileName 模板
                const singleFileTemplate = singleFileName || '同步助手_{{{date}}}'
                // 创建临时item对象用于渲染文件名
                const tempItem = {
                  ...item,
                  savedAt: isoDate, // 传递 ISO 格式，让 render 函数根据 singleFileDateFormat 格式化
                }
                customFilename = replaceIllegalCharsFile(
                  renderFilename(tempItem, singleFileTemplate, singleFileDateFormat),
                )
                // log(`🔧 企微消息使用单文件模板: ${customFilename}`)
              }
            }
          }

          const pageName = `${folderName}/${customFilename}.md`
          const normalizedPath = normalizePath(pageName)
          // log(`🔧 准备创建/更新文件: ${normalizedPath}`)
          const omnivoreFile =
            this.app.vault.getAbstractFileByPath(normalizedPath)

          // 判断是否需要合并
          const shouldMerge =
            ((mergeMode === MergeMode.MESSAGES || dualWrite) && isWeChatMessage(item)) ||
            mergeMode === MergeMode.ALL

          if (!shouldMerge) {
            if (omitIdActive && isCursorCovered(item.updatedAt || item.savedAt, noIdLatestCursor)) {
              // 无 id 模式（非合并路径）：item 已被最新设备游标覆盖 = 其它设备已同步过、
              // 文件会随库同步到达 → 跳过写盘防重复/防覆写（codex P1：游标去重不能只在
              // MergeProcessor）。仍记 success 让游标正常前推。
              syncContext.successTracker.recordSuccess(item.id)
            } else {
              await fileProcessor.process(item, normalizedPath, content, folderName, customFilename)
            }
          } else {
            // 合并模式：收集到 mergeGroups，Phase 2 统一批量处理。
            // 新建合并文件时按「合并文件模板」落初始内容（页眉/属性/页脚 + 消息区锚点）；
            // 模板为空 → '' → 与历史一致创建空文件。模板炸了只降级成空文件，绝不拖垮同步。
            let mergeFileInitial = ''
            if (mergeFileTemplate && mergeFileTemplate.trim()) {
              try {
                mergeFileInitial = renderMergeFileTemplate(mergeFileTemplate, {
                  date: formatDate(mergeFileDateIso, singleFileDateFormat),
                  title: customFilename,
                })
              } catch (error) {
                logError(`⚠️ 合并文件模板渲染失败，本次按空文件创建: ${normalizedPath}`, error)
              }
            }
            const mergeTarget = await this.resolveOrCreateMergeTarget(
              omnivoreFile, normalizedPath, syncContext, item, dualWrite, mergeFileInitial
            )
            if (mergeTarget) {
              const group = mergeGroups.get(mergeTarget.path)
                ?? mergeGroups.set(mergeTarget.path, { file: mergeTarget, items: [] }).get(mergeTarget.path)!
              group.items.push({ item, content })

              // 双写模式：合并副本已收进 group，这里再按「文章」模板落一份独立笔记。
              // 独立副本失败绝不能连累合并副本（它才是主真相），所以单独 try/catch。
              if (dualWrite) {
                try {
                  await this.writeDualStandaloneCopy({
                    item,
                    content: renderFor(false),
                    folderTemplate: folder,
                    folderDateFormat,
                    filenameTemplate: filename,
                    filenameDateFormat,
                    mergeTargetPath: mergeTarget.path,
                    fileProcessor,
                    skipByCursor:
                      omitIdActive && isCursorCovered(item.updatedAt || item.savedAt, noIdLatestCursor),
                  })
                } catch (error) {
                  logError(`❌ 双写独立副本失败（合并副本已保留）: ${item.title}`, error)
                }
              }
            }
          }
          // 仅对未抛异常的 item 追踪 updatedAt，避免失败 item 推进游标
          if (item.updatedAt) {
            const t = DateTime.fromISO(item.updatedAt)
            const cur = maxUpdatedAt ? DateTime.fromISO(maxUpdatedAt) : DateTime.fromMillis(0)
            if (t.isValid && t > cur) {
              maxUpdatedAt = item.updatedAt
            }
          }
          } catch (error) {
            logError(`❌ 处理文章失败，跳过: ${item.title}`, error)
            // 不中断循环，继续处理下一篇
          }
        }

        log(`🔧 批次获取完成，本页 ${items.length} 篇文章`)
        if (manualSync) {
          noticeManager.onBatchProcessed(items.length, hasNextPage)
        }

        if (!hasNextPage) {
          break
        }
      }

      // Phase 2: 所有分页拉取完毕后，对累积的合并分组一次性落盘。
      // 每个文件只调一次 processBatch → 全 item 一起全局排序、对同一份起始
      // filter 判重，避免跨页 prepend 的排序错乱与同轮 Bloom 假阳性丢消息。
      await flushMergeGroups(
        mergeProcessor,
        mergeGroups.values(),
        (path, err) => logError(`Batch merge failed for ${path}, fell back to one-by-one`, err),
      )

      // 🆕 所有批次处理完成后，根据成功数量决定是否更新同步时间
      const successCount = syncContext.successTracker.getCount()
      // 阅后即焚：游标由 burnTracker 的「本地已落地」真相计算（不含失败/未落盘 item），
      // 修掉「失败 item 仍推进游标」既有 bug；burn=off 保持原 maxUpdatedAt 行为不变。
      const cursorBasis = burnActive
        ? syncContext.burnTracker.maxCursorUpdatedAt()
        : maxUpdatedAt
      // 调试模式：本轮不推进游标、不改 initialSyncCompleted —— 纯诊断，用完关掉即彻底复原（设计 §2.5）。
      // 直接跳过游标计算（advanceSyncCursor 本就是纯函数，这里只是让意图更清晰、零副作用）。
      const cursorValue = (successCount > 0 && !debugActive) ? advanceSyncCursor(cursorBasis) : null
      if (cursorValue) {
        this.settings.syncAt = cursorValue  // 全局游标（兼容性）
        if (!this.settings.deviceSyncCursors) {
          this.settings.deviceSyncCursors = {}
        }
        this.settings.deviceSyncCursors[deviceId] = cursorValue  // 设备游标
        if (shouldMarkInitialSyncCompleted(successCount, this.settings.initialSyncCompleted)) {
          this.settings.initialSyncCompleted = true
        }
        this.cleanStaleDeviceCursors()  // 清理过期游标
        await this.saveSettings(true)

        log(`✅ 同步完成！成功处理 ${successCount} 篇文章，syncAt: ${cursorValue} (maxUpdatedAt=${maxUpdatedAt}+1s), deviceId: ${deviceId}`)
        if (manualSync) {
          noticeManager.completeSync(successCount)
        }
      } else if (debugActive && successCount > 0) {
        log(`🐞 调试模式：成功处理 ${successCount} 篇，本轮不推进游标/不改同步状态`)
        if (manualSync) {
          noticeManager.completeSync(successCount)
        }
      } else {
        log('⚠️ 没有成功处理任何文章，不更新同步时间')
        if (manualSync) {
          noticeManager.completeSync(0)
        }
      }

      // 刷新文件浏览器以显示新创建的文件和文件夹
      this.refreshFileExplorer()

      // 图片处理（await 以便跟踪进度）
      if (this.settings.imageMode === ImageMode.LOCAL && this.imageLocalizer) {
        log('🖼️ 开始处理图片本地化...')
        // 后续同步重试：把上次同步 / 上次会话遗留的续传任务（图床源站当时未就绪、
        // 下载失败等）重新挂回队列，与本次新同步的笔记一起处理，直到源站就绪能下到
        // 真图并改写链接（见 tests/relayImageNotReady.repro.spec.ts 的 Defect B）。
        try {
          await this.imageLocalizer.enqueuePendingRecords((filePath) => {
            const af = this.app.vault.getAbstractFileByPath(filePath)
            return af instanceof TFile ? af : null
          }, PENDING_RETRY_COOLDOWN_MS)
        } catch (error) {
          logError('重挂图片续传任务失败:', error)
        }
        // 进度分母按「待下载图片总数」（而非文件数）统计：弱网下单篇多图笔记的
        // 进度条才会随每张图落盘平滑推进，而不是卡 0/1 直到整篇下完才跳满
        // （见 tests/real-obsidian/cases/weaknet-image-progress.case.js）。
        const imageTotal = manualSync
          ? await this.imageLocalizer.countQueuedRemoteImages()
          : 0
        if (manualSync && imageTotal > 0) {
          noticeManager.startPhaseProgress('处理图片', imageTotal)
        }
        try {
          await this.imageLocalizer.processQueue(
            manualSync && imageTotal > 0
              ? () => noticeManager.onPhaseItemProcessed()
              : undefined
          )
          log('🖼️ 图片本地化队列处理完成')
          if (manualSync) noticeManager.completePhase()
        } catch (error: unknown) {
          logError('图片本地化处理失败:', error)
          if (manualSync) noticeManager.failPhase('图片处理失败，文章内容不受影响')
        }
      } else if (this.settings.imageMode === ImageMode.DISABLED) {
        log('🖼️ 开始注释图片...')
        const processedFilesArray = syncContext.getProcessedFilesArray()
        if (manualSync) noticeManager.showPhaseNotice('处理图片中...')
        try {
          await this.commentOutImages(processedFilesArray)
          log('🖼️ 图片注释处理完成')
          if (manualSync) noticeManager.completePhase()
        } catch (error: unknown) {
          logError('图片注释处理失败:', error)
          if (manualSync) noticeManager.failPhase('图片处理失败，文章内容不受影响')
        }
      }

      // 附件处理（await 以便跟踪进度）
      if (this.attachmentLocalizer) {
        log('📎 开始处理附件本地化...')
        const attachQueueSize = this.attachmentLocalizer.getQueueStats().pending
        if (manualSync && attachQueueSize > 0) {
          noticeManager.startPhaseProgress('处理附件', attachQueueSize)
        }
        try {
          await this.attachmentLocalizer.processQueue(
            manualSync ? () => noticeManager.onPhaseItemProcessed() : undefined
          )
          log('📎 附件本地化队列处理完成')
          if (manualSync) noticeManager.completePhase()
        } catch (error: unknown) {
          logError('附件本地化处理失败:', error)
          if (manualSync) noticeManager.failPhase('附件处理失败，文章内容不受影响')
        }
      }

      // 市场版：图床上传接力 / 图片改名接力（调用其它插件命令的跨插件特性）
      // 已整体移除 —— 该能力依赖未公开的 app.plugins / app.commands API。

      // 处理日记链接（同步完成后）
      if (this.settings.enableDiaryLinks && syncContext.diaryLinkProcessor.linkCount > 0) {
        log('📔 开始处理日记链接...')
        try {
          const diaryResult = await syncContext.diaryLinkProcessor.processAll()
          if (diaryResult.success > 0) {
            log(`📔 日记链接处理完成：成功 ${diaryResult.success}，跳过 ${diaryResult.skipped}`)
          }
          if (diaryResult.errors.length > 0) {
            logError('📔 部分日记处理失败:', diaryResult.errors)
          }
          // 显示用户友好的处理结果通知
          this.showDiaryLinkNotice(diaryResult)
        } catch (error) {
          logError('📔 日记链接处理失败:', error)
          new Notice('📔 日记链接处理出错，请查看控制台日志')
        }
      }

      // 首次同步：本轮是第一次成功同步 → 在所有本地化阶段（图片/附件/图床）跑完之后，
      // 自动打开最新的几篇笔记（桌面≤3 / 手机≤1）并延迟弹窗说明。整个生命周期只触发一次，
      // 触发后即置 firstSyncAutoOpened 并落盘，后续任何同步都不会再打开/弹窗。
      // 全程 best-effort：失败只 log，不影响同步本身。
      // 调试模式跳过本块：由下面的调试块接管打开，避免重复开标签 + 误把 onboarding 一次性标志烧掉（codex #2）。
      if (!debugActive && shouldAutoOpenOnFirstSync({
        alreadyOpened: this.settings.firstSyncAutoOpened,
        successCount,
        fileCount: syncContext.processedFiles.size,
      })) {
        try {
          await this.openFirstSyncNotes(syncContext.getProcessedFilesArray())
          this.settings.firstSyncAutoOpened = true
          await this.saveSettings(true)
          this.scheduleFirstSyncNotice()
          log('📖 首次同步：已自动打开最新笔记，安排说明弹窗')
        } catch (error) {
          logError('首次同步自动打开流程失败（不影响同步）:', error)
        }
      }

      // 调试模式：每次手动调试同步，都自动打开本轮拉到的最新笔记（桌面≤3 / 手机≤1），
      // 让用户当场看到「同步是通的，笔记就在默认位置」。不置 firstSyncAutoOpened、不弹首次同步
      // 延迟说明弹窗（说明弹窗在开关点击时已弹）。best-effort：失败只 log。
      if (debugActive && successCount > 0 && syncContext.processedFiles.size > 0) {
        try {
          await this.openDebugNotes(syncContext.getProcessedFilesArray())
        } catch (error) {
          logError('调试模式自动打开失败（不影响同步）:', error)
        }
      }

      // 阅后即焚：图片/附件/图床本地化都跑完后，捕获本轮删除候选（留到 finally 之后执行）。
      // 调试模式 burnActive 恒 false → 不收集，诊断绝不删数据。
      if (burnActive) {
        burnRecordsToDelete = syncContext.burnTracker.getDeleteRecords()
      }
    } catch (e) {
      if (manualSync) {
        noticeManager.showError(e)
      }
      logError(e)
    } finally {
      window.clearTimeout(syncWatchdog)
      this.syncing = false

      // 确保在任何情况下都刷新文件浏览器
      try {
        this.refreshFileExplorer()
      } catch (refreshError) {
        log('文件浏览器刷新遇到问题，但不影响正常使用', refreshError)
      }
    }

    // 阅后即焚删除阶段：在 finally 之后跑（watchdog 已清、syncing 已 false），
    // 避免大量删除耗时触发「同步超时」误报。处理本轮候选 + 历史 pending，全程 best-effort。
    // 调试模式 burnActive 恒 false → 不进删除阶段，诊断绝不删云端数据（codex #3）。
    if (burnActive) {
      await this.runBurnDeletePhase(burnRecordsToDelete)
    }
  }

  /**
   * 阅后即焚删除阶段（best-effort，绝不抛、绝不影响同步显示）。
   * 合并「本轮新候选 + 历史 pending」，逐条：
   *  1) 文件不存在/读失败 → 不删，留 pending（保守，数据安全优先）。
   *  2) 本地化仍有原始 URL 残留 → 不删，留 pending（下轮重试）。
   *  3) 通过门槛 → deleteArticleById（幂等）；失败留 pending。
   * 最后把更新后的 pending 落盘。
   */
  private async runBurnDeletePhase(newRecords: BurnDeleteRecord[]): Promise<void> {
    try {
      if (!this.settings.burnAfterReading) return
      const nowIso = new Date().toISOString()
      // 合并历史 pending + 本轮候选（同 id 以本轮为准）
      const byId = new Map<string, PendingBurnDelete>()
      for (const p of this.settings.pendingBurnDeletes ?? []) byId.set(p.id, p)
      for (const r of newRecords) {
        byId.set(r.id, {
          id: r.id,
          updatedAt: r.updatedAt,
          filePath: r.filePath,
          originalImageUrls: r.originalImageUrls,
          originalAttachmentUrls: r.originalAttachmentUrls,
          reason: 'pending',
          lastTriedAt: nowIso,
        })
      }
      if (byId.size === 0) return

      const apiKey = this.settings.apiKey
      const endpoint = this.settings.endpoint
      const imageMode = this.settings.imageMode
      const stillPending: PendingBurnDelete[] = []
      let deleted = 0
      let failed = 0

      for (const rec of byId.values()) {
        // 1) 文件存在性（不在了 → 保守不删，留 pending）
        const file = this.app.vault.getAbstractFileByPath(rec.filePath)
        if (!(file instanceof TFile)) {
          stillPending.push({ ...rec, reason: 'file-missing', lastTriedAt: nowIso })
          continue
        }
        // 2) 本地化无残留复查（仍有原始 URL → 留 pending 下轮重试）
        let fileContent: string
        try {
          fileContent = await this.app.vault.read(file)
        } catch {
          stillPending.push({ ...rec, reason: 'read-failed', lastTriedAt: nowIso })
          continue
        }
        if (hasLocalizationResidual(fileContent, rec, imageMode)) {
          stillPending.push({ ...rec, reason: 'localization-pending', lastTriedAt: nowIso })
          continue
        }
        // 3) 删云端（幂等，best-effort）
        const ok = apiKey ? await deleteArticleById(endpoint, apiKey, rec.id) : false
        if (ok) {
          deleted++
        } else {
          failed++
          stillPending.push({ ...rec, reason: 'delete-failed', lastTriedAt: nowIso })
        }
      }

      this.settings.pendingBurnDeletes = stillPending
      await this.saveSettings(true)
      log(`🔥 阅后即焚：已删云端 ${deleted} 篇，待重试 ${stillPending.length}（删除失败 ${failed}）`)
    } catch (e) {
      logError('🔥 阅后即焚删除阶段异常（不影响同步）:', e)
    }
  }



  /**
   * 文件浏览器刷新（市场版：no-op）。
   *
   * 历史实现手动 trigger `vault.trigger('changed')` / `workspace.trigger('layout-change')`
   * 内部事件强刷 explorer —— 属未公开 API 且早已多余：本插件全部落盘都走
   * Vault API（create/modify/process），Obsidian 会自行派发事件并刷新文件浏览器。
   * 保留方法与调用点以最小化与主项目的 diff。
   */
  private refreshFileExplorer() {
    // 依赖 Vault API 的原生事件派发，无需手动刷新
  }

  /**
   * 首次同步：自动打开最新的几篇笔记。
   * 桌面端最多 3 篇、手机端最多 1 篇（见 selectNotesToOpen）。第一篇复用当前叶子，
   * 其余在新标签打开。单篇打开失败只 log，不中断其它篇。
   */
  private async openFirstSyncNotes(files: TFile[]): Promise<void> {
    const isMobile = Platform.isMobile
    const toOpen = selectNotesToOpen(files, isMobile)
    for (let i = 0; i < toOpen.length; i++) {
      try {
        // 第一篇复用当前活动叶子（新装 vault 通常是个空白页），其余各开新标签
        const leaf = this.app.workspace.getLeaf(i === 0 ? false : 'tab')
        await leaf.openFile(toOpen[i], { active: i === 0 })
      } catch (error) {
        logError(`首次同步打开笔记失败: ${toOpen[i]?.path}`, error)
      }
    }
    log(`📖 首次同步：已自动打开 ${toOpen.length} 篇笔记（mobile=${isMobile}）`)
  }

  /**
   * 调试模式：自动打开本轮拉到的最新笔记（桌面≤3 / 手机≤1）。
   * 与首次同步不同：可重复触发（每次手动调试同步都开），因此先剔除**已经在打开中**的笔记，
   * 避免反复调试把同一批旧标签重复打开（codex #8）。剔除后取前 N 篇打开；若全都已打开则不动。
   */
  private async openDebugNotes(files: TFile[]): Promise<void> {
    const isMobile = Platform.isMobile
    // 收集已打开的 markdown 文件路径（best-effort：任何异常都退化为空集 → 顶多重复打开，绝不崩）。
    let openPaths = new Set<string>()
    try {
      openPaths = new Set(
        this.app.workspace.getLeavesOfType('markdown')
          .map((leaf) => {
            const view = leaf?.view as unknown as { file?: { path?: string } } | undefined
            return view?.file?.path
          })
          .filter((p): p is string => !!p),
      )
    } catch (error) {
      logError('调试模式：读取已打开笔记失败（忽略去重）', error)
    }
    const fresh = files.filter((f) => !openPaths.has(f.path))
    const toOpen = selectNotesToOpen(fresh, isMobile)
    for (let i = 0; i < toOpen.length; i++) {
      try {
        // 一律开新标签，绝不复用当前活动叶子（避免替换掉用户正在看的笔记，也巩固「剔除已打开」的意图）。
        // 第一篇设为 active，让用户视线聚焦到刚拉下来的笔记上。
        const leaf = this.app.workspace.getLeaf('tab')
        await leaf.openFile(toOpen[i], { active: i === 0 })
      } catch (error) {
        logError(`调试模式打开笔记失败: ${toOpen[i]?.path}`, error)
      }
    }
    log(`🐞 调试模式：已自动打开 ${toOpen.length} 篇笔记（mobile=${isMobile}，跳过已打开 ${files.length - fresh.length} 篇）`)
  }

  /**
   * 首次同步：延迟弹出说明弹窗。延迟时间默认 15s（FIRST_SYNC_NOTICE_DELAY_MS），
   * E2E 可通过 settings.firstSyncNoticeDelayMs 覆盖以加速测试。timeout 存字段，onunload 清理。
   */
  private scheduleFirstSyncNotice(): void {
    if (this.firstSyncNoticeTimeout) return
    const delay = resolveFirstSyncNoticeDelay(this.settings.firstSyncNoticeDelayMs)
    this.firstSyncNoticeTimeout = window.setTimeout(() => {
      this.firstSyncNoticeTimeout = null
      try {
        new FirstSyncNoticeModal(this.app).open()
      } catch (error) {
        logError('首次同步说明弹窗打开失败:', error)
      }
    }, delay)
  }

  /**
   * 显示日记链接处理结果通知
   * 提供用户友好的反馈和错误修复指引
   */
  private showDiaryLinkNotice(result: DiaryLinkResult): void {
    const { success, skipped, errors, skipReasons } = result

    // 全部成功
    if (success > 0 && errors.length === 0 && skipped === 0) {
      new Notice(`📔 日记链接：成功写入 ${success} 个链接`)
      return
    }

    // 部分成功
    if (success > 0 && skipped > 0) {
      new Notice(`📔 日记链接：写入 ${success} 个，跳过 ${skipped} 个`, 5000)
    }

    // 全部跳过 - 提供详细修复指引
    if (skipped > 0 && success === 0) {
      let message = '📔 日记链接未写入\n\n'

      if (skipReasons.fileNotFound.length > 0) {
        message += `日记不存在：${skipReasons.fileNotFound.join(', ')}\n`
        message += '→ 请先创建对应日期的日记文件\n\n'
      }

      if (skipReasons.anchorMissing.length > 0) {
        message += `缺少锚点：${skipReasons.anchorMissing.join(', ')}\n`
        message += `→ 请在日记模板中添加：<!-- ${this.settings.diaryAnchor} -->\n\n`
      }

      if (skipReasons.createFailed.length > 0) {
        message += `自动创建失败：${skipReasons.createFailed.join(', ')}\n`
        message += '→ 请确认已启用 Daily Notes 或 Periodic Notes 插件\n\n'
      }

      new Notice(message, 10000)
    }

    // 有错误
    if (errors.length > 0) {
      new Notice(
        `📔 日记链接处理失败 ${errors.length} 个\n请检查日记文件是否可写入`,
        8000
      )
    }
  }
}
