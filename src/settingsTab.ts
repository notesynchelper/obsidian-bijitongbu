import {
  App,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  requestUrl,
} from 'obsidian'

import OmnivorePlugin from './main'
import { FolderSuggest } from './settings/file-suggest'
import {
  DEFAULT_SETTINGS,
  FRONT_MATTER_VARIABLES,
  ImageMode,
  MIN_AUTO_SYNC_FREQUENCY,
  MergeMode,
  MessageSortOrder,
  DiaryLinkType,
  DiaryWritePosition,
  DiaryLinkOrder,
  PluginLanguage,
} from './settings'
import { formatDate } from './util'
import { validateTemplate, validateDateFormat } from './settings/validation'
import { analyzeTemplaterTags } from './sync/templaterRelay'
import { normalizeRetiredQuerySettings } from './settings/queryNormalize'
import { validateFrontMatterTemplate } from './settings/template'
import { validateMergeFileTemplate } from './sync/mergeFileTemplate'
import { getArticleCount, clearAllArticles, fetchVipStatus, fetchVipStatusFresh } from './api'
import { VIP_QR_DATA_URI } from './assets/vipQrImage'
import { log, logError, Logger } from './logger'
import { MARKET_VERSION_CHECK_URL } from './updateReminder'
import { t } from './i18n'
import {
  clampImageDownloadRetries,
  MAX_IMAGE_DOWNLOAD_RETRIES,
} from './imageLocalizer/imageDownloader'

// Obsidian 全局函数声明
declare function createFragment(callback: (fragment: DocumentFragment) => void): DocumentFragment

// 「手机电脑同步」插件官网 —— 二次确认弹窗里的超链接目标
const PHONE_PC_SYNC_URL = 'https://shoujidiannao.bijitongbu.site/'

// Render a t()-loaded multi-line string into a fragment, turning '\n' into <br>.
// Lets us keep multi-paragraph descriptions as single i18n keys instead of a
// dozen tiny fragment-piece keys.
function appendMultiline(fragment: DocumentFragment, text: string): void {
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (i > 0) fragment.append(fragment.createEl('br'))
    if (line) fragment.append(line)
  })
}


interface VersionInfo {
  version: string
}

export class OmnivoreSettingTab extends PluginSettingTab {
  plugin: OmnivorePlugin
  private latestVersionInfo: VersionInfo | null = null
  private versionCheckPromise: Promise<void> | null = null
  private vipStatusContainer: HTMLElement | null = null
  // VIP 状态请求的单调序号：最新发起的请求才有权渲染，丢弃迟到的旧结果。
  // 防「页面加载的 /user-config（慢、被缓存的旧值）迟到后盖掉刚点刷新的实时值」竞态。
  private vipStatusReqSeq = 0

  constructor(app: App, plugin: OmnivorePlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  /**
   * ⚠️ 必须返回空数组（2026-08-13 线上回归教训）：Obsidian 1.13 的
   * renderTab = () => settingItems.length > 0 ? 声明式渲染 : this.display()
   * —— 返回任何非空条目（哪怕只有 name/desc 的“纯索引条目”）都会让 1.13
   * 【彻底跳过 display()】，整页被渲染成纯文字、没有任何输入控件，用户连
   * API key 都填不进去。本插件页面渲染完全依赖 display() 的分区折叠版；
   * 在完成真正的声明式迁移（每条都带 render/control）之前，这里必须保持 []。
   * 守护用例：obsidian-plug 主仓 tests/real-obsidian/
   * run-market-settings-input-pull-screenshot.js（Obsidian 1.13.4 真机）。
   */
  getSettingDefinitions(): [] {
    return []
  }

  // 市场版：二维码不走网络 —— 「购买高级权益」用打包进插件的静态 data URI
  // （见 src/assets/vipQrImage.ts；政策禁止网络动态加载推广内容，静态+披露允许）。
  private loadQrCode(imgElement: HTMLImageElement): void {
    imgElement.src = VIP_QR_DATA_URI
  }

  // 更新VIP状态显示（自动/页面加载/原有「刷新」按钮：走 /user-config，CF 端 15s 缓存）
  private async updateVipStatus(): Promise<void> {
    if (!this.vipStatusContainer) {
      return
    }

    const apiKey = this.plugin.settings.apiKey

    // 如果没有密钥，隐藏状态容器
    if (!apiKey || apiKey.trim() === '') {
      this.vipStatusContainer.addClass('is-hidden')
      return
    }

    // 显示状态容器
    this.vipStatusContainer.removeClass('is-hidden')

    // 查询VIP状态（迟到的旧结果会被更晚的请求作废，避免盖掉手动刷新的实时值）
    const seq = ++this.vipStatusReqSeq
    const vipStatus = await fetchVipStatus(apiKey, this.plugin.settings.vipApiBase)
    if (seq !== this.vipStatusReqSeq) return
    this.renderVipStatus(vipStatus)
  }

  // 手动刷新「高级权益状态」（大按钮：走 /user-config/refresh，不走缓存、直查实时状态，
  // 但有相对宽松的防刷限流）。与 updateVipStatus 共用渲染逻辑。
  private async refreshVipStatusFresh(button: HTMLButtonElement): Promise<void> {
    const apiKey = this.plugin.settings.apiKey
    if (!apiKey || apiKey.trim() === '') {
      new Notice(t('settings.vip.needKey'))
      return
    }

    const originalText = button.textContent || ''
    button.disabled = true
    button.textContent = t('common.refreshing')
    const seq = ++this.vipStatusReqSeq
    try {
      const vipStatus = await fetchVipStatusFresh(apiKey, this.plugin.settings.vipApiBase)

      // 防刷限流：不覆盖当前显示，只提示用户稍后再试
      if (vipStatus.rateLimited) {
        new Notice(t('settings.vip.rateLimited'))
        return
      }

      // 已被更晚发起的状态请求取代 → 丢弃本次结果，避免盖掉更新的状态
      if (seq !== this.vipStatusReqSeq) {
        return
      }

      // 确保状态区可见后渲染最新状态
      if (this.vipStatusContainer) {
        this.vipStatusContainer.removeClass('is-hidden')
      }
      this.renderVipStatus(vipStatus)

      if (vipStatus.networkError) {
        new Notice(t('settings.vip.refreshFailed'))
      } else {
        new Notice(t('settings.vip.refreshed'))
      }
    } finally {
      button.disabled = false
      button.textContent = originalText
    }
  }

  // 把一份 VipStatus 渲染到状态展示区（自动 / 手动刷新共用）
  private renderVipStatus(vipStatus: import('./api').VipStatus): void {
    if (!this.vipStatusContainer) {
      return
    }

    // 更新左侧状态文本
    const statusInfo = this.vipStatusContainer.querySelector(
      '.vip-status-info',
    ) as HTMLElement

    // 更新右侧二维码和引导文字
    const qrImg = this.vipStatusContainer.querySelector(
      '.vip-status-qr img',
    ) as HTMLImageElement
    const qrLabel = this.vipStatusContainer.querySelector(
      '.vip-status-qr-label',
    ) as HTMLElement
    const qrContainer = this.vipStatusContainer.querySelector(
      '.vip-status-qr',
    ) as HTMLElement

    // 网络异常时隐藏二维码，显示服务号查询引导
    if (vipStatus.networkError) {
      if (statusInfo) {
        statusInfo.textContent = '请前往 笔记同步助手 服务号查看'
      }
      if (qrLabel) {
        qrLabel.textContent = '点击下方「会员」菜单查询会员状态及有效期'
      }
      if (qrContainer) {
        qrContainer.addClass('is-hidden')
      }
      return
    }

    // 正常状态：显示二维码
    if (qrContainer) {
      qrContainer.removeClass('is-hidden')
    }

    if (statusInfo) {
      statusInfo.textContent = vipStatus.displayText
    }

    if (qrImg && qrLabel) {
      const isMember =
        vipStatus.isValid &&
        (vipStatus.vipType === 'obvip' || vipStatus.vipType === 'obvvip')

      if (isMember) {
        // 市场版：微信群二维码会过期轮换，既不打包也不联网加载 —— 文字引导替代
        qrImg.addClass('is-hidden')
        qrLabel.textContent = '如需加入用户交流群，请在「笔记同步助手」服务号内联系获取'
      } else {
        // 非会员：展示打包内置的静态「购买高级权益」二维码（零网络请求）
        qrImg.removeClass('is-hidden')
        this.loadQrCode(qrImg)
        qrLabel.textContent = '购买高级权益'
      }
    }
  }


  // —— 设置页分区折叠（Phase 1 IA 重排）——
  // 同一次设置会话内，展开状态跨 display() 重渲染保留（改一个下拉不再把
  // 所有分区弹回默认）；关闭设置页后重置，保证「危险区默认收起」不跨会话失效。
  private static readonly DEFAULT_SECTION_OPEN: Record<string, boolean> = {
    vip: true,
    sync: true,
    path: false,
    image: false,
    diary: false,
    system: false,
    // 二级折叠（VIP中心内）
    'vip-cloud': false,
    'vip-diag': false,
    // 二级折叠（路径设置内）
    'path-article': false,
    'path-message': false,
    'path-template': false,
  }
  private sectionOpen: Record<string, boolean> = {
    ...OmnivoreSettingTab.DEFAULT_SECTION_OPEN,
  }

  hide(): void {
    this.sectionOpen = { ...OmnivoreSettingTab.DEFAULT_SECTION_OPEN }
    super.hide()
  }

  // 创建一个原生 <details> 分区并返回其内容容器。
  // 原生 summary 取代旧 max-height 自制折叠：内容再长也不会被 2000px 截断，
  // 也不再需要 document 级事件绑定。
  private createSection(
    containerEl: HTMLElement,
    key: string,
    title: string,
    subtitle: string,
    opts: { sub?: boolean } = {},
  ): HTMLElement {
    // nh-section-<key> 是 E2E/QA 的稳定定位类，别随意改名。
    // opts.sub = 二级折叠（嵌套在一级分区 body 里，样式更轻、有缩进）。
    const details = containerEl.createEl('details', {
      cls: `nh-section nh-section-${key}` + (opts.sub ? ' nh-subsection' : ''),
    })
    details.toggleAttribute('open', this.sectionOpen[key] === true)
    const summary = details.createEl('summary', { cls: 'nh-section-summary' })
    const titles = summary.createDiv({ cls: 'nh-section-titles' })
    titles.createDiv({ cls: 'nh-section-title', text: title })
    if (subtitle) {
      titles.createDiv({ cls: 'nh-section-sub', text: subtitle })
    }
    details.addEventListener('toggle', () => {
      this.sectionOpen[key] = details.open
    })
    return details.createDiv({ cls: 'nh-section-body' })
  }

  /**
   * 文章模板 / 消息模板里 Templater 用法的实时提示文本（只提示、不阻断保存）。
   * 返回 '' = 没什么可提示。判定与 sync/templaterRelay 的接力规则同源。
   */
  private templaterStatusText(value: string): string {
    const a = analyzeTemplaterTags(value ?? '')
    if (!a.hasTags) return ''
    const msgs: string[] = []
    if (a.poisoned) msgs.push(t('settings.templater.warnUnclosed'))
    // 市场版不做 Templater 插值接力：任何 <% %> 标签都原样保留在笔记里
    msgs.push(t('settings.templater.marketPassthrough'))
    return msgs.join('\n')
  }

  display(): void {
    const { containerEl } = this

    // 重渲染保持滚动位置：display() 会被各下拉/开关反复调用整页重建，
    // 不还原 scrollTop 的话用户每改一项就被甩回页面顶部。
    const scroller =
      (containerEl.closest('.vertical-tab-content')) ??
      containerEl
    const prevScrollTop = scroller.scrollTop

    containerEl.empty()

    // 🚀 延迟执行配置迁移（不阻塞页面显示）
    window.setTimeout(() => {
      void this.checkAndPerformMigration()
    }, 500)

    // —— 顶部固定：密钥（「不配置就无法使用」的第一项，不进任何折叠区）——
    new Setting(containerEl)
      .setName(t('settings.apiKey.name'))
      .setDesc(t('settings.apiKey.desc'))
      .addText((text) =>
        text
          .setPlaceholder(t('settings.apiKey.placeholder'))
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value
            await this.plugin.saveSettings(true)
            // 密钥更新后查询VIP状态
            await this.updateVipStatus()
          }),
      )

    // ============ 1. VIP中心（默认展开） ============
    const vipBody = this.createSection(
      containerEl,
      'vip',
      t('settings.section.vip.name'),
      t('settings.section.vip.sub'),
    )

    new Setting(vipBody)
      .setName(t('settings.vip.heading'))
      .setDesc(t('settings.vip.delayNote'))
      .setHeading()

    // 会员状态展示区域
    this.vipStatusContainer = vipBody.createDiv({
      cls: 'vip-status-container',
    })

    // 左侧：状态信息容器
    const statusContainer = this.vipStatusContainer.createDiv({
      cls: 'vip-status-left',
    })

    // 会员状态信息
    statusContainer.createDiv({
      cls: 'vip-status-info',
      text: t('settings.vip.loading'),
    })

    // 引导文字（放在状态信息下方）
    statusContainer.createDiv({
      cls: 'vip-status-qr-label',
      text: t('settings.vip.loading'),
    })

    // 右侧：二维码容器
    const qrContainer = this.vipStatusContainer.createDiv({
      cls: 'vip-status-qr',
    })

    // 二维码图片
    qrContainer.createEl('img', {
      attr: {
        alt: t('settings.vip.qrAlt'),
      },
    })

    // 大号「刷新高级权益状态」引导按钮：走不缓存的实时接口，解决「会员状态有延迟」。
    const freshRefreshWrap = vipBody.createDiv({
      cls: 'vip-refresh-fresh',
    })
    const freshRefreshBtn = freshRefreshWrap.createEl('button', {
      cls: 'vip-refresh-fresh-btn mod-cta',
      text: t('settings.vip.refreshFresh'),
    })
    freshRefreshWrap.createDiv({
      cls: 'vip-refresh-fresh-hint',
      text: t('settings.vip.refreshFreshHint'),
    })
    freshRefreshBtn.addEventListener('click', () => {
      void this.refreshVipStatusFresh(freshRefreshBtn)
    })

    // 页面加载时查询VIP状态
    void this.updateVipStatus()

    // 帮助与资源：教程 / 模拟器 / 云空间管理入口集中于此。
    new Setting(vipBody)
      .setName(t('settings.help.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(t('settings.help.desc'))
          const linksEl = fragment.createDiv({ cls: 'notehelper-help-links' })
          linksEl.createEl('a', {
            text: t('settings.help.link.tutorial'),
            href: 'https://bijitongbu.feishu.cn/wiki/RE0fw090CihOAykU8iKcqZFEntd',
          })
          linksEl.createEl('a', {
            text: t('settings.help.link.pathSimulator'),
            href: 'https://obsidian.notebooksyncer.com/path-simulator',
          })
          linksEl.createEl('a', {
            text: t('settings.help.link.contentProcessing'),
            href: 'https://obsidian.notebooksyncer.com/settings',
          })
          linksEl.createEl('a', {
            text: t('settings.help.link.openCloudSpace'),
            href: 'https://obsidian.notebooksyncer.com/settings',
          })
        }),
      )


    // ▸ 云空间（二级折叠，默认收起）
    const vipCloudBody = this.createSection(
      vipBody,
      'vip-cloud',
      t('settings.section.vipCloud.name'),
      t('settings.section.vipCloud.sub'),
      { sub: true },
    )

    const renderArticleCountDesc = (countText: string): DocumentFragment =>
      createFragment((fragment) => {
        fragment.append(
          t('settings.article.count.desc'),
          fragment.createEl('br'),
          fragment.createEl('br'),
          fragment.createEl('strong', {
            text: `${t('settings.article.count.currentLabel')}: ${countText}`,
          }),
        )
      })

    // 使用 Setting 组件来保持样式一致
    const articleCountSetting = new Setting(vipCloudBody)
      .setName(t('settings.article.count.name'))
      .setDesc(renderArticleCountDesc(t('settings.article.count.currentLoading')))

    // 添加刷新按钮
    articleCountSetting.addButton((button) => {
      button
        .setButtonText(t('common.refresh'))
        .setCta()
        .onClick(async () => {
          try {
            button.setDisabled(true)
            button.setButtonText(t('settings.article.count.refreshing'))

            const count = await getArticleCount(
              this.plugin.settings.endpoint,
              this.plugin.settings.apiKey
            )

            articleCountSetting.setDesc(renderArticleCountDesc(String(count)))
            new Notice(`${t('settings.article.count.currentLabel')}: ${count}`)
          } catch (error) {
            logError('获取文章数量失败:', error)
            new Notice(t('settings.article.count.noticeFetchFail'))
            articleCountSetting.setDesc(t('settings.article.count.noticeFetchFailShort'))
          } finally {
            button.setDisabled(false)
            button.setButtonText(t('common.refresh'))
          }
        })
    })


    // 阅后即焚：不外显危险标识（普通开关样式），仅保留开启确认弹窗
    new Setting(vipCloudBody)
      .setName(t('settings.burnAfterReading.name'))
      .setDesc(t('settings.burnAfterReading.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.burnAfterReading)
          .onChange(async (value) => {
            if (value === true) {
              // 开启走二次确认 ConfirmModal
              const confirmModal = new ConfirmModal(
                this.app,
                t('settings.burnAfterReading.confirmTitle'),
                t('settings.burnAfterReading.confirmBody'),
                async () => {
                  this.plugin.settings.burnAfterReading = true
                  // 开启确认时刻的 ISO（legacy Bloom 迁移阈值用）
                  this.plugin.settings.burnAfterReadingEnabledAt = new Date().toISOString()
                  await this.plugin.saveSettings(true)
                  // 多设备运行时保护：其它设备近 30 天活跃游标 → 弹警告（仍允许）
                  this.warnIfOtherDevicesActive()
                }
              )
              // ConfirmModal 只有 onConfirm 回调、没有 onCancel。
              // 用关闭事件兜底：若关闭时设置仍未变 true（即用户取消/点叉），回滚 toggle。
              const origOnClose = confirmModal.onClose.bind(confirmModal) as () => void
              confirmModal.onClose = () => {
                origOnClose()
                if (!this.plugin.settings.burnAfterReading) {
                  // 用户取消：toggle 回滚、不改 settings、不保存
                  toggle.setValue(false)
                }
              }
              confirmModal.open()
            } else {
              // 关闭：直接保存
              this.plugin.settings.burnAfterReading = false
              await this.plugin.saveSettings(true)
            }
          }),
      )

    new Setting(vipCloudBody)
      .setName(t('settings.section.clearCloud.name'))
      .setDesc(t('settings.section.clearCloud.desc'))
      .addButton((button) => {
      button
        .setButtonText(t('settings.article.count.clearButton'))
        .setWarning()
        .onClick(async () => {
          // 显示确认对话框
          const confirmModal = new ConfirmModal(
            this.app,
            t('settings.article.count.confirmTitle'),
            t('settings.article.count.confirmBody'),
            async () => {
              try {
                // 立即更新按钮状态和显示通知
                button.setDisabled(true)
                button.setButtonText(t('settings.article.count.clearing'))
                new Notice(t('settings.article.count.noticeClearStart'))

                const result = await clearAllArticles(
                  this.plugin.settings.endpoint,
                  this.plugin.settings.apiKey
                )

                new Notice(`${t('settings.article.count.currentLabel')}: ${result.deletedCount}`)
                articleCountSetting.setDesc(renderArticleCountDesc('0'))

                // 自动刷新以获取最新数量
                window.setTimeout(() => {
                  void (async () => {
                    try {
                      const count = await getArticleCount(
                        this.plugin.settings.endpoint,
                        this.plugin.settings.apiKey
                      )
                      articleCountSetting.setDesc(renderArticleCountDesc(String(count)))
                    } catch (error) {
                      logError('刷新文章数量失败:', error)
                    }
                  })()
                }, 1000)
              } catch (error) {
                logError('清空文章失败:', error)
                new Notice(t('settings.article.count.noticeClearFail'))
              } finally {
                button.setDisabled(false)
                button.setButtonText(t('settings.article.count.clearButton'))
              }
            }
          )
          confirmModal.open()
        })
    })


    // ▸ 问题诊断（二级折叠，默认收起）
    const vipDiagBody = this.createSection(
      vipBody,
      'vip-diag',
      t('settings.section.vipDiag.name'),
      t('settings.section.vipDiag.sub'),
      { sub: true },
    )

    // 调试模式开关（账户、帮助与诊断区）。
    // 说明的第一行是紫色排查提示（引导「收到推送但看不到笔记」的用户打开本开关），第二行是常规描述。
    // 开启走说明弹窗二次确认（取消/保存失败均回滚 toggle），关闭直接保存。
    // settingEl 加类 notehelper-debug-toggle-row 提供稳定选择器（real-obsidian e2e 用它点开关）。
    const debugModeSetting = new Setting(vipDiagBody)
      .setName(t('settings.debugMode.name'))
      .setDesc(
        createFragment((fragment) => {
          // 第一行：紫色排查提示
          fragment.createDiv({
            cls: 'notehelper-debug-hint',
            text: t('settings.debugMode.hint'),
          })
          // 第二行：常规描述
          fragment.append(t('settings.debugMode.desc'))
        }),
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (value) => {
            if (value === true) {
              const confirmModal = new DebugModeConfirmModal(this.app, async () => {
                this.plugin.settings.debugMode = true
                try {
                  await this.plugin.saveSettings(true)
                } catch (e) {
                  // 保存失败：回滚 toggle + 内存状态，提示用户（codex #9）
                  this.plugin.settings.debugMode = false
                  toggle.setValue(false)
                  new Notice(t('settings.debugMode.saveFailed'))
                  logError('保存调试模式失败:', e)
                }
              })
              // ConfirmModal 只有 onConfirm 回调；用关闭事件兜底：关闭时若未确认（仍 false），回滚 toggle。
              const origOnClose = confirmModal.onClose.bind(confirmModal) as () => void
              confirmModal.onClose = () => {
                origOnClose()
                if (!this.plugin.settings.debugMode) {
                  toggle.setValue(false)
                }
              }
              confirmModal.open()
            } else {
              this.plugin.settings.debugMode = false
              await this.plugin.saveSettings(true)
            }
          }),
      )
    debugModeSetting.settingEl.addClass('notehelper-debug-toggle-row')


    new Setting(vipDiagBody)
      .setName(t('settings.advanced.debugLog.name'))
      .setDesc(t('settings.advanced.debugLog.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDebugLog)
          .onChange(async (value) => {
            this.plugin.settings.enableDebugLog = value
            Logger.setDevMode(value)
            await this.plugin.saveSettings(true)
            new Notice(value ? t('settings.advanced.debugLog.noticeOn') : t('settings.advanced.debugLog.noticeOff'))
          }),
      )


    new Setting(vipDiagBody)
      .setName(t('settings.advanced.exportConfig.name'))
      .setDesc(t('settings.advanced.exportConfig.desc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.advanced.exportConfig.button'))
          .onClick(async () => {
            try {
              const configPath = this.plugin.manifest.dir + '/data.json'
              const data = await this.app.vault.adapter.read(configPath)
              const blob = new Blob([data], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = createEl('a')
              a.href = url
              a.download = 'data.json'
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(url)
              new Notice(t('settings.advanced.exportConfig.noticeOk'))
            } catch (e) {
              new Notice(t('settings.advanced.exportConfig.noticeFail') + (e as Error).message)
            }
          }),
      )

    // 版本信息 + 检查更新
    this.displayVersionInfo(vipDiagBody)

    // ============ 2. 同步设置（默认展开） ============
    const syncBody = this.createSection(
      containerEl,
      'sync',
      t('settings.section.sync.name'),
      t('settings.section.sync.sub'),
    )

    // 自动同步设置：按设备独立保存（每台设备可设置不同的 frequency / syncOnStart）
    const currentDeviceId = this.plugin.getDeviceId()
    const currentAutoSync = this.plugin.getEffectiveAutoSync()
    const otherDeviceCount = Object.keys(this.plugin.settings.deviceAutoSync ?? {})
      .filter((id) => id !== currentDeviceId).length

    new Setting(syncBody)
      .setName(t('settings.sync.syncOnStart.name'))
      .setDesc(
        createFragment((fragment) => {
          const deviceLabel = `${t('settings.sync.syncOnStart.deviceIdLabel')}: ${currentDeviceId}${
            otherDeviceCount > 0
              ? ` · ${t('settings.sync.syncOnStart.otherDevicesLabel')}: ${otherDeviceCount}`
              : ''
          }`
          fragment.append(
            t('settings.sync.syncOnStart.desc'),
            fragment.createEl('br'),
            fragment.createEl('small', { text: deviceLabel }),
          )
        })
      )
      .addToggle((toggle) =>
        toggle
          .setValue(currentAutoSync.syncOnStart)
          .onChange(async (value) => {
            this.plugin.setEffectiveAutoSync({ syncOnStart: value })
            await this.plugin.saveSettings(true)
          }),
      )
    new Setting(syncBody)
      .setName(t('settings.sync.frequency.name'))
      .setDesc(
        createFragment((fragment) => {
          appendMultiline(fragment, t('settings.sync.frequency.desc'))
        })
      )
      .addText((text) => {
        text
          .setPlaceholder(t('settings.sync.frequency.placeholder'))
          .setValue(currentAutoSync.frequency.toString())
          .onChange(async (value) => {
            const frequency = parseInt(value)
            // 键入途中/非法输入不保存；失焦时统一校正显示并提示
            if (isNaN(frequency) || frequency < 0) return

            // 0 = 仅手动同步；1–59 静默钳位到最低 60（输入过程不改写输入框）
            const clamped =
              frequency > 0 && frequency < MIN_AUTO_SYNC_FREQUENCY
                ? MIN_AUTO_SYNC_FREQUENCY
                : frequency

            // save frequency（写入当前设备）
            this.plugin.setEffectiveAutoSync({ frequency: clamped })
            await this.plugin.saveSettings(true)

            this.plugin.scheduleSync()
          })
        // 失焦时把输入框校正为实际生效值（钳位/非法输入都在这里一次性提示）
        text.inputEl.addEventListener('blur', () => {
          const effective = this.plugin.getEffectiveAutoSync().frequency
          if (text.getValue() === String(effective)) return
          const typed = parseInt(text.getValue())
          text.setValue(String(effective))
          if (isNaN(typed) || typed < 0) {
            new Notice(t('settings.sync.frequency.noticeMustBePositive'))
          } else {
            new Notice(t('settings.sync.frequency.noticeClamped'))
          }
        })
      })


    new Setting(syncBody)
      .setName(t('settings.sync.lastSync.name'))
      .setDesc(t('settings.sync.lastSync.desc'))
      .addMomentFormat((momentFormat) =>
        momentFormat
          .setPlaceholder(t('settings.sync.lastSync.placeholder'))
          .setValue(this.plugin.settings.syncAt)
          .setDefaultFormat("yyyy-MM-dd'T'HH:mm:ss")
          .onChange(async (value) => {
            this.plugin.settings.syncAt = value
            const deviceId = this.plugin.getDeviceId()
            if (this.plugin.settings.deviceSyncCursors) {
              this.plugin.settings.deviceSyncCursors[deviceId] = value
            }
            await this.plugin.saveSettings(true)
          }),
      )


    // ============ 3. 路径设置 ============
    const pathBody = this.createSection(
      containerEl,
      'path',
      t('settings.section.path.name'),
      t('settings.section.path.sub'),
    )

    // ▸ 文章设置（二级折叠，默认收起）
    const articleBody = this.createSection(
      pathBody,
      'path-article',
      t('settings.section.path.article'),
      '',
      { sub: true },
    )

    new Setting(articleBody)
      .setName(t('settings.sync.articleFolder.name'))
      .setDesc(t('settings.sync.articleFolder.desc'))
      .addText((text) => {
        new FolderSuggest(this.app, text.inputEl)
        text
          .setPlaceholder(t('settings.sync.articleFolder.placeholder'))
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            if (!validateTemplate(value, '文章文件夹')) return
            this.plugin.settings.folder = value
            await this.plugin.saveSettings(true)
          })
      })
    new Setting(articleBody)
      .setName(t('settings.sync.articleFolderDateFormat.name'))
      .setDesc(t('settings.sync.articleFolderDateFormat.desc'))
      .addText((text) =>
        text
           
          .setPlaceholder(t('settings.sync.articleFolderDateFormat.placeholder'))
          .setValue(this.plugin.settings.folderDateFormat)
          .onChange(async (value) => {
            if (!validateDateFormat(value, '文章文件夹日期格式')) return
            this.plugin.settings.folderDateFormat = value
            await this.plugin.saveSettings(true)
          }),
      )

    new Setting(articleBody)
      .setName(t('settings.sync.attachmentFolder.name'))
      .setDesc(t('settings.sync.attachmentFolder.desc'))
      .addText((text) => {
        new FolderSuggest(this.app, text.inputEl)
        text
          .setPlaceholder(t('settings.sync.attachmentFolder.placeholder'))
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange(async (value) => {
            if (!validateTemplate(value, '附件文件夹')) return
            this.plugin.settings.attachmentFolder = value
            await this.plugin.saveSettings(true)

            // Update AttachmentLocalizer with new path
            if (this.plugin.attachmentLocalizer) {
              this.plugin.attachmentLocalizer.updateOptions({
                attachmentFolder: this.plugin.settings.attachmentFolder,
                folderDateFormat: this.plugin.settings.folderDateFormat,
                maxRetries: this.plugin.settings.imageDownloadRetries,
                retryDelay: 1000,
              })
            }
          })
      })

    new Setting(articleBody)
      .setName(t('settings.sync.articleFilename.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            t('settings.sync.articleFilename.desc'),
            fragment.createEl('br'),
            fragment.createEl('a', {
              text: t('settings.sync.articleFilename.debugLink'),
              href: 'https://obsidian.notebooksyncer.com/template-playground',
            }),
          )
        }),
      )
      .addText((text) =>
        text
          .setPlaceholder(t('settings.sync.articleFilename.placeholder'))
          .setValue(this.plugin.settings.filename)
          .onChange(async (value) => {
            if (!validateTemplate(value, '文章文件名')) return
            this.plugin.settings.filename = value
            await this.plugin.saveSettings(true)
          }),
      )

    new Setting(articleBody)
      .setName(t('settings.sync.articleFilenameDateFormat.name'))
      .setDesc(t('settings.sync.articleFilenameDateFormat.desc'))
      .addText((text) =>
        text
           
          .setPlaceholder(t('settings.sync.articleFilenameDateFormat.placeholder'))
          .setValue(this.plugin.settings.filenameDateFormat)
          .onChange(async (value) => {
            if (!validateDateFormat(value, '文章文件名日期格式')) return
            this.plugin.settings.filenameDateFormat = value
            await this.plugin.saveSettings(true)
          }),
      )


    const frontMatterSetting = new Setting(articleBody)
      .setName(t('settings.advanced.frontMatterTemplate.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            t('settings.advanced.frontMatterTemplate.descMain'),
            fragment.createEl('br'),
            fragment.createEl('br'),
            t('settings.advanced.frontMatterTemplate.descOverride'),
            fragment.createEl('br'),
            fragment.createEl('a', {
              text: t('settings.advanced.frontMatterTemplate.debugLink'),
              href: 'https://obsidian.notebooksyncer.com/template-playground',
            }),
          )
        }),
      )

    // 校验提示条：跟随模板输入实时显示 YAML 错误，避免只在同步时才在控制台冒 Notice。
    // 视觉状态全部走 styles.css 的 is-visible / is-error / is-warning 组合类。
    const frontMatterStatusEl = articleBody.createDiv({
      cls: 'omnivore-frontmatter-status',
    })

    const updateFrontMatterStatus = (template: string) => {
      const result = validateFrontMatterTemplate(template)
      if (result.valid && !result.sanitized) {
        frontMatterStatusEl.removeClass('is-visible', 'is-error', 'is-warning')
        frontMatterStatusEl.setText('')
        return
      }
      frontMatterStatusEl.addClass('is-visible')
      if (!result.valid) {
        frontMatterStatusEl.removeClass('is-warning')
        frontMatterStatusEl.addClass('is-error')
        frontMatterStatusEl.setText(
          t('settings.advanced.frontMatterTemplate.invalidWarning') +
          '\n' +
          result.error +
          t('settings.advanced.frontMatterTemplate.invalidHint')
        )
      } else {
        // sanitize 兜底命中：valid=true 但有风险
        frontMatterStatusEl.removeClass('is-error')
        frontMatterStatusEl.addClass('is-warning')
        frontMatterStatusEl.setText(t('settings.advanced.frontMatterTemplate.sanitizeWarning'))
      }
    }

    frontMatterSetting.addTextArea((text) => {
      text
        .setPlaceholder(t('settings.advanced.frontMatterTemplate.placeholder'))
        .setValue(this.plugin.settings.frontMatterTemplate)
        .onChange(async (value) => {
          if (!validateTemplate(value, '前置元数据模板')) return
          this.plugin.settings.frontMatterTemplate = value
          updateFrontMatterStatus(value)
          await this.plugin.saveSettings(true)
        })

      text.inputEl.setAttr('rows', 10)
      text.inputEl.setAttr('cols', 30)
    })
    frontMatterSetting.addExtraButton((button) => {
      button
        .setIcon('reset')
        .setTooltip(t('settings.advanced.frontMatterTemplate.resetTooltip'))
        .onClick(async () => {
          this.plugin.settings.frontMatterTemplate =
            DEFAULT_SETTINGS.frontMatterTemplate
          await this.plugin.saveSettings(true)
          this.display()
          new Notice(t('settings.advanced.frontMatterTemplate.noticeReset'))
        })
    })

    // 首次打开设置面板时也要校验当前保存的模板（用户可能之前就保存了错的模板）
    updateFrontMatterStatus(this.plugin.settings.frontMatterTemplate)

    // 笔记属性不写 id（去重纯靠最新同步游标）。
    // 开启走 ConfirmModal 二次确认（警告按 id 识别失效 + 跨设备不能用网盘方案），取消回滚 toggle。
    const omitIdSetting = new Setting(articleBody)
      .setName(t('settings.advanced.omitFrontmatterId.name'))
      .setDesc(t('settings.advanced.omitFrontmatterId.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.omitFrontmatterId)
          .onChange(async (value) => {
            if (value === true) {
              const confirmModal = new ConfirmModal(
                this.app,
                t('settings.advanced.omitFrontmatterId.confirmTitle'),
                t('settings.advanced.omitFrontmatterId.confirmBody'),
                async () => {
                  this.plugin.settings.omitFrontmatterId = true
                  await this.plugin.saveSettings(true)
                },
                [{ text: t('common.phonePcSyncLink'), url: PHONE_PC_SYNC_URL }]
              )
              // ConfirmModal 只有 onConfirm 回调；用关闭事件兜底：关闭时若未确认（仍 false），回滚 toggle。
              const origOnClose = confirmModal.onClose.bind(confirmModal) as () => void
              confirmModal.onClose = () => {
                origOnClose()
                if (!this.plugin.settings.omitFrontmatterId) {
                  toggle.setValue(false)
                }
              }
              confirmModal.open()
            } else {
              this.plugin.settings.omitFrontmatterId = false
              await this.plugin.saveSettings(true)
            }
          }),
      )
    // 稳定选择器：real-obsidian e2e 用它定位开关行
    omitIdSetting.settingEl.addClass('notehelper-omit-id-toggle-row')


    // Templater 用法实时提示条（与合并文件模板的提示条同款样式）
    const articleTplStatusEl = articleBody.createDiv({
      cls: 'notehelper-merge-template-status',
    })
    const updateArticleTemplaterStatus = (value: string) => {
      const msg = this.templaterStatusText(value)
      if (!msg) {
        articleTplStatusEl.removeClass('is-visible')
        articleTplStatusEl.setText('')
        return
      }
      articleTplStatusEl.addClass('is-visible')
      articleTplStatusEl.setText(msg)
    }

    const articleTemplateSetting = new Setting(articleBody)
      .setName(t('settings.advanced.articleTemplate.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            t('settings.advanced.articleTemplate.descMain'),
            fragment.createEl('br'),
            t('settings.advanced.articleTemplate.descBelow'),
            fragment.createEl('br'),
            fragment.createEl('a', {
              text: t('settings.advanced.articleTemplate.debugLink'),
              href: 'https://obsidian.notebooksyncer.com/template-playground',
            }),
          )
        }),
      )
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.advanced.articleTemplate.placeholder'))
          .setValue(this.plugin.settings.template)
          .onChange(async (value) => {
            if (!validateTemplate(value, '文章模板', { allowTemplaterTags: true })) return
            updateArticleTemplaterStatus(value)
            // if template is empty, use default template
            this.plugin.settings.template = value
              ? value
              : DEFAULT_SETTINGS.template
            await this.plugin.saveSettings(true)
          })
        text.inputEl.setAttr('rows', 4)
        text.inputEl.setAttr('cols', 30)
      })
      .addExtraButton((button) => {
        // add a button to reset template
        button
          .setIcon('reset')
          .setTooltip(t('settings.advanced.articleTemplate.resetTooltip'))
          .onClick(async () => {
            this.plugin.settings.template = DEFAULT_SETTINGS.template
            await this.plugin.saveSettings(true)
            this.display()
            new Notice(t('settings.advanced.articleTemplate.noticeReset'))
          })
      })
    // 提示条要跟在设置行下面，且首次打开就按现值校验一次
    articleTemplateSetting.settingEl.insertAdjacentElement('afterend', articleTplStatusEl)
    updateArticleTemplaterStatus(this.plugin.settings.template ?? '')


    // ▸ 消息处理（二级折叠，默认收起）
    const messageBody = this.createSection(
      pathBody,
      'path-message',
      t('settings.section.path.message'),
      '',
      { sub: true },
    )

    const mergeModeSetting = new Setting(messageBody)
      .setName(t('settings.sync.mergeMode.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            t('settings.sync.mergeMode.descIntro'),
            fragment.createEl('br'),
            fragment.createEl('br'),
            fragment.createEl('strong', { text: t('settings.sync.mergeMode.labelNone') }),
            `: ${t('settings.sync.mergeMode.descNone')}`,
            fragment.createEl('br'),
            fragment.createEl('strong', { text: t('settings.sync.mergeMode.labelMessages') }),
            `: ${t('settings.sync.mergeMode.descMessages')}`,
            fragment.createEl('br'),
            fragment.createEl('strong', { text: t('settings.sync.mergeMode.labelAll') }),
            `: ${t('settings.sync.mergeMode.descAll')}`,
            fragment.createEl('br'),
            fragment.createEl('strong', { text: t('settings.sync.mergeMode.labelDual') }),
            `: ${t('settings.sync.mergeMode.descDual')}`,
          )
        })
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption(MergeMode.NONE, t('settings.sync.mergeMode.optionNone'))
          .addOption(MergeMode.MESSAGES, t('settings.sync.mergeMode.optionMessages'))
          .addOption(MergeMode.DUAL, t('settings.sync.mergeMode.optionDual'))
          .addOption(MergeMode.ALL, t('settings.sync.mergeMode.optionAll'))
          .setValue(this.plugin.settings.mergeMode)
          .onChange(async (value) => {
            this.plugin.settings.mergeMode = value as MergeMode
            await this.plugin.saveSettings(true)
            // 重新显示设置页面以显示/隐藏单文件名称设置
            this.display()
          }),
      )
    // 稳定选择器：real-obsidian e2e 用它定位合并模式这一行
    mergeModeSetting.settingEl.addClass('notehelper-merge-mode-row')

    // 消息排序设置 - 只在合并模式不是 NONE 时显示
    if (this.plugin.settings.mergeMode !== MergeMode.NONE) {
      new Setting(messageBody)
        .setName(t('settings.sync.messageSortOrder.name'))
        .setDesc(
          createFragment((fragment) => {
            fragment.append(
              t('settings.sync.messageSortOrder.descIntro'),
              fragment.createEl('br'),
              fragment.createEl('strong', { text: t('settings.sync.messageSortOrder.labelDesc') }),
              `: ${t('settings.sync.messageSortOrder.descDesc')}`,
              fragment.createEl('br'),
              fragment.createEl('strong', { text: t('settings.sync.messageSortOrder.labelAsc') }),
              `: ${t('settings.sync.messageSortOrder.descAsc')}`,
            )
          })
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption(MessageSortOrder.DESC, t('settings.sync.messageSortOrder.optionDesc'))
            .addOption(MessageSortOrder.ASC, t('settings.sync.messageSortOrder.optionAsc'))
            .setValue(this.plugin.settings.messageSortOrder ?? MessageSortOrder.DESC)
            .onChange(async (value) => {
              this.plugin.settings.messageSortOrder = value as MessageSortOrder
              await this.plugin.saveSettings(true)
            }),
        )
    }

    // 消息不写 id（取消隐藏注释符，去重纯靠最新同步游标）- 只在合并模式不是 NONE 时显示。
    // 开启走 ConfirmModal 二次确认（警告跨设备不能用网盘方案），取消/点叉回滚 toggle；关闭直接保存。
    if (this.plugin.settings.mergeMode !== MergeMode.NONE) {
      const noMarkerSetting = new Setting(messageBody)
        .setName(t('settings.sync.noMessageMarker.name'))
        .setDesc(t('settings.sync.noMessageMarker.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.disableMessageMarkers)
            .onChange(async (value) => {
              if (value === true) {
                const confirmModal = new ConfirmModal(
                  this.app,
                  t('settings.sync.noMessageMarker.confirmTitle'),
                  t('settings.sync.noMessageMarker.confirmBody'),
                  async () => {
                    this.plugin.settings.disableMessageMarkers = true
                    await this.plugin.saveSettings(true)
                  },
                  [{ text: t('common.phonePcSyncLink'), url: PHONE_PC_SYNC_URL }]
                )
                // ConfirmModal 只有 onConfirm 回调；用关闭事件兜底：关闭时若未确认（仍 false），回滚 toggle。
                const origOnClose = confirmModal.onClose.bind(confirmModal) as () => void
                confirmModal.onClose = () => {
                  origOnClose()
                  if (!this.plugin.settings.disableMessageMarkers) {
                    toggle.setValue(false)
                  }
                }
                confirmModal.open()
              } else {
                this.plugin.settings.disableMessageMarkers = false
                await this.plugin.saveSettings(true)
              }
            }),
        )
      // 稳定选择器：real-obsidian e2e 用它定位开关行
      noMarkerSetting.settingEl.addClass('notehelper-no-marker-toggle-row')
    }

    // 消息文件夹设置 - 只在合并模式不是 NONE 时显示
    if (this.plugin.settings.mergeMode !== MergeMode.NONE) {
      new Setting(messageBody)
        .setName(t('settings.sync.messageFolder.name'))
        .setDesc(t('settings.sync.messageFolder.desc'))
        .addText((text) => {
          new FolderSuggest(this.app, text.inputEl)
          text
            .setPlaceholder(this.plugin.settings.folder)
            .setValue(this.plugin.settings.messageFolder)
            .onChange(async (value) => {
              if (value && !validateTemplate(value, '消息文件夹')) return
              this.plugin.settings.messageFolder = value
              await this.plugin.saveSettings(true)
            })
        })
    }

    // 单文件名称设置 - 只在合并模式不是 NONE 时显示
    if (this.plugin.settings.mergeMode !== MergeMode.NONE) {
      new Setting(messageBody)
        .setName(t('settings.sync.messageFileName.name'))
        .setDesc(
          createFragment((fragment) => {
            fragment.append(
              t('settings.sync.messageFileName.descBefore'),
              fragment.createEl('code', { text: '{{{date}}}' }),
              t('settings.sync.messageFileName.descAfter'),
              fragment.createEl('br'),
              fragment.createEl('br'),
              t('settings.sync.messageFileName.examplesIntro'),
              fragment.createEl('br'),
              '• ',
              fragment.createEl('code', { text: '同步助手_{{{date}}}' }),
              fragment.createEl('br'),
              '• ',
              fragment.createEl('code', { text: '企微消息_{{{date}}}' }),
            )
          }),
        )
        .addText((text) =>
          text
            .setPlaceholder(t('settings.sync.messageFileName.placeholder'))
            .setValue(this.plugin.settings.singleFileName)
            .onChange(async (value) => {
              if (!validateTemplate(value, '消息文件名称')) return
              this.plugin.settings.singleFileName = value || '同步助手_{{{date}}}'
              await this.plugin.saveSettings(true)
            }),
        )

      new Setting(messageBody)
        .setName(t('settings.sync.messageFileDateFormat.name'))
        .setDesc(
          createFragment((fragment) => {
            fragment.append(
              t('settings.sync.messageFileDateFormat.desc'),
              fragment.createEl('br'),
              fragment.createEl('br'),
              t('settings.sync.messageFileDateFormat.examplesIntro'),
              fragment.createEl('br'),
            )
            // Format examples — language-neutral codes + samples; only the
            // surrounding "example" word swaps via examplePrefix.
            const examples = [
              { format: 'yyyy-MM-dd', sample: '2025-01-23' },
              { format: 'yyyyMMdd', sample: '20250123' },
              { format: 'yyyy/MM/dd', sample: '2025/01/23' },
              { format: 'yyyy年MM月dd日', sample: '2025年01月23日' },
            ]
            const examplePrefix = t('settings.sync.messageFileDateFormat.examplePrefix')
            examples.forEach((example, index) => {
              if (index > 0) {
                fragment.append(fragment.createEl('br'))
              }
              fragment.append(
                '• ',
                fragment.createEl('code', { text: example.format }),
                ` (${examplePrefix}: ${example.sample})`,
              )
            })
          }),
        )
        .addText((text) =>
          text
             
            .setPlaceholder(t('settings.sync.messageFileDateFormat.placeholder'))
            .setValue(this.plugin.settings.singleFileDateFormat)
            .onChange(async (value) => {
              if (!validateDateFormat(value, '消息文件日期格式')) return
              this.plugin.settings.singleFileDateFormat = value || 'yyyy-MM-dd'
              await this.plugin.saveSettings(true)
            }),
        )

      // 合并文件模板：新建合并文件时的初始内容（页眉 / 属性 / 页脚骨架）。
      // 留空 = 历史行为（空文件）；{{{messages}}} 标出消息插入区。
      //
      // 提示条：模板开头的 `---` 会被 Obsidian 当属性块起始，写歪了会吞正文 ——
      // 与「笔记属性模板」同款实时提示（只提示、不阻断保存）。
      // 样式走 styles.css 的 .notehelper-merge-template-status（含 .is-visible），
      // 不在 TS 里逐条写 element.style（obsidianmd/no-static-styles-assignment）。
      const mergeTplStatusEl = messageBody.createDiv({
        cls: 'notehelper-merge-template-status',
      })
      const updateMergeFileTemplateStatus = (value: string) => {
        const result = validateMergeFileTemplate(value)
        if (result.valid) {
          mergeTplStatusEl.removeClass('is-visible')
          mergeTplStatusEl.setText('')
          return
        }
        mergeTplStatusEl.addClass('is-visible')
        mergeTplStatusEl.setText(
          t('settings.sync.mergeFileTemplate.invalidWarning') + '\n' + (result.error ?? ''),
        )
      }

      const mergeFileTemplateSetting = new Setting(messageBody)
        .setName(t('settings.sync.mergeFileTemplate.name'))
        .setDesc(
          createFragment((fragment) => {
            fragment.append(
              t('settings.sync.mergeFileTemplate.desc'),
              fragment.createEl('br'),
              fragment.createEl('br'),
              t('settings.sync.mergeFileTemplate.varsIntro'),
              fragment.createEl('br'),
              t('settings.sync.mergeFileTemplate.varDate'),
              fragment.createEl('br'),
              t('settings.sync.mergeFileTemplate.varTitle'),
              fragment.createEl('br'),
              fragment.createEl('br'),
              t('settings.sync.mergeFileTemplate.examplesIntro'),
              fragment.createEl('br'),
              t('settings.sync.mergeFileTemplate.example1'),
              fragment.createEl('br'),
              t('settings.sync.mergeFileTemplate.example2'),
              fragment.createEl('br'),
              fragment.createEl('br'),
              t('settings.sync.mergeFileTemplate.hint'),
              fragment.createEl('br'),
              fragment.createEl('a', {
                text: t('settings.sync.mergeFileTemplate.debugLink'),
                href: 'https://obsidian.notebooksyncer.com/template-playground',
              }),
            )
          }),
        )
        .addTextArea((text) => {
          text
            .setPlaceholder(t('settings.sync.mergeFileTemplate.placeholder'))
            .setValue(this.plugin.settings.mergeFileTemplate ?? '')
            .onChange(async (value) => {
              if (!validateTemplate(value, '合并文件模板')) return
              updateMergeFileTemplateStatus(value)
              // 留空是合法且有意义的取值（=恢复空文件），不做默认值回填。
              this.plugin.settings.mergeFileTemplate = value
              await this.plugin.saveSettings(true)
            })
          text.inputEl.setAttr('rows', 4)
          text.inputEl.setAttr('cols', 30)
        })
        .addExtraButton((button) => {
          button
            .setIcon('reset')
            .setTooltip(t('settings.sync.mergeFileTemplate.resetTooltip'))
            .onClick(async () => {
              this.plugin.settings.mergeFileTemplate = DEFAULT_SETTINGS.mergeFileTemplate
              await this.plugin.saveSettings(true)
              this.display()
              new Notice(t('settings.sync.mergeFileTemplate.noticeReset'))
            })
        })
      // 稳定选择器：real-obsidian e2e 用它定位合并文件模板这一行
      mergeFileTemplateSetting.settingEl.addClass('notehelper-merge-file-template-row')
      // 提示条要跟在设置行下面（createEl 先建的话在上面），且首次打开就按现值校验一次
      mergeFileTemplateSetting.settingEl.insertAdjacentElement('afterend', mergeTplStatusEl)
      updateMergeFileTemplateStatus(this.plugin.settings.mergeFileTemplate ?? '')
    }


    // Templater 用法实时提示条（与合并文件模板的提示条同款样式）
    const assistantTplStatusEl = messageBody.createDiv({
      cls: 'notehelper-merge-template-status',
    })
    const updateAssistantTemplaterStatus = (value: string) => {
      const msg = this.templaterStatusText(value)
      if (!msg) {
        assistantTplStatusEl.removeClass('is-visible')
        assistantTplStatusEl.setText('')
        return
      }
      assistantTplStatusEl.addClass('is-visible')
      assistantTplStatusEl.setText(msg)
    }

    const assistantTemplateSetting = new Setting(messageBody)
      .setName(t('settings.advanced.assistantTemplate.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            t('settings.advanced.assistantTemplate.desc'),
            fragment.createEl('br'),
            fragment.createEl('br'),
            t('settings.advanced.assistantTemplate.varsIntro'),
            fragment.createEl('br'),
            t('settings.advanced.assistantTemplate.varDate'),
            fragment.createEl('br'),
            t('settings.advanced.assistantTemplate.varContent'),
            fragment.createEl('br'),
            t('settings.advanced.assistantTemplate.varTitle'),
            fragment.createEl('br'),
            t('settings.advanced.assistantTemplate.varId'),
            fragment.createEl('br'),
            fragment.createEl('br'),
            t('settings.advanced.assistantTemplate.examplesIntro'),
            fragment.createEl('br'),
            t('settings.advanced.assistantTemplate.example1'),
            fragment.createEl('br'),
            t('settings.advanced.assistantTemplate.example2'),
            fragment.createEl('br'),
            t('settings.advanced.assistantTemplate.example3'),
            fragment.createEl('br'),
            fragment.createEl('a', {
              text: t('settings.advanced.assistantTemplate.debugLink'),
              href: 'https://obsidian.notebooksyncer.com/template-playground',
            }),
          )
        }),
      )
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.advanced.assistantTemplate.placeholder'))
          .setValue(this.plugin.settings.wechatMessageTemplate)
          .onChange(async (value) => {
            if (!validateTemplate(value, '助手消息模板', { allowTemplaterTags: true })) return
            updateAssistantTemplaterStatus(value)
            this.plugin.settings.wechatMessageTemplate = value || '---\\n## 📅 {{{dateSaved}}}\\n{{{content}}}'
            await this.plugin.saveSettings(true)
          })
        text.inputEl.setAttr('rows', 4)
        text.inputEl.setAttr('cols', 30)
      })
      .addExtraButton((button) => {
        button
          .setIcon('reset')
          .setTooltip(t('settings.advanced.assistantTemplate.resetTooltip'))
          .onClick(async () => {
            this.plugin.settings.wechatMessageTemplate = DEFAULT_SETTINGS.wechatMessageTemplate
            await this.plugin.saveSettings(true)
            this.display()
            new Notice(t('settings.advanced.assistantTemplate.noticeReset'))
          })
      })
    // 提示条要跟在设置行下面，且首次打开就按现值校验一次
    assistantTemplateSetting.settingEl.insertAdjacentElement('afterend', assistantTplStatusEl)
    updateAssistantTemplaterStatus(this.plugin.settings.wechatMessageTemplate ?? '')


    // ▸ 模板设置（二级折叠，默认收起）
    const templateBody = this.createSection(
      pathBody,
      'path-template',
      t('settings.section.path.template'),
      '',
      { sub: true },
    )

    new Setting(templateBody)
      .setName(t('settings.content.escapeHashtags.name'))
      .setDesc(t('settings.content.escapeHashtags.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.escapeHashtags)
          .onChange(async (value) => {
            this.plugin.settings.escapeHashtags = value
            await this.plugin.saveSettings(true)
          }),
      )


    new Setting(templateBody)
      .setName(t('settings.advanced.frontMatter.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            t('settings.advanced.frontMatter.descMain'),
            fragment.createEl('br'),
            fragment.createEl('br'),
            t('settings.advanced.frontMatter.descBelow'),
          )
        }),
      )
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.advanced.frontMatter.placeholder'))
          .setValue(this.plugin.settings.frontMatterVariables.join(','))
          .onChange(async (value) => {
            const trimmed = value.trim()
            // detect template content entered in the wrong field
            if (trimmed && (trimmed.includes('{{{') || trimmed.includes('\n'))) {
              this.plugin.settings.frontMatterTemplate = trimmed
              this.plugin.settings.frontMatterVariables = []
              await this.plugin.saveSettings(true)
              new Notice(t('settings.advanced.frontMatter.noticeAutoMoved'), 6000)
              this.display()
              return
            }
            // validate front matter variables and deduplicate
            this.plugin.settings.frontMatterVariables = value
              .split(',')
              .map((v) => v.trim())
              .filter(
                (v, i, a) =>
                  FRONT_MATTER_VARIABLES.includes(v.split('::')[0]) &&
                  a.indexOf(v) === i,
              )
            await this.plugin.saveSettings(true)
          })
        text.inputEl.setAttr('rows', 4)
        text.inputEl.setAttr('cols', 30)
      })


    new Setting(templateBody)
      .setName(t('settings.advanced.dateSavedFormat.name'))
      .setDesc(t('settings.advanced.dateSavedFormat.desc'))
      .addText((text) =>
        text
           
          .setPlaceholder(t('settings.advanced.dateSavedFormat.placeholder'))
          .setValue(this.plugin.settings.dateSavedFormat)
          .onChange(async (value) => {
            if (!validateDateFormat(value, '保存日期格式')) return
            this.plugin.settings.dateSavedFormat = value
            await this.plugin.saveSettings(true)
          }),
      )


    new Setting(templateBody)
       
      .setName(t('settings.advanced.templateVars.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            t('settings.advanced.templateVars.descIntro'),
            fragment.createEl('a', {
              text: t('settings.advanced.templateVars.docLink'),
              href: 'https://www.notebooksyncer.com/blog/template-variables-guide/',
            }),
          )
        }),
      )

    // ============ 3. 图片处理 ============
    const imageBody = this.createSection(
      containerEl,
      'image',
      t('settings.image.heading'),
      t('settings.section.imageSub'),
    )

    new Setting(imageBody)
      .setName(t('settings.image.mode.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            t('settings.image.mode.descIntro'),
            fragment.createEl('br'),
            fragment.createEl('br'),
            '• ',
            fragment.createEl('strong', { text: t('settings.image.mode.labelLocal') }),
            `: ${t('settings.image.mode.descLocal')}`,
            fragment.createEl('br'),
            '• ',
            fragment.createEl('strong', { text: t('settings.image.mode.labelRemote') }),
            `: ${t('settings.image.mode.descRemote')}`,
            fragment.createEl('br'),
            '• ',
            fragment.createEl('strong', { text: t('settings.image.mode.labelDisabled') }),
            `: ${t('settings.image.mode.descDisabled')}`,
          )
        })
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption(ImageMode.LOCAL, t('settings.image.mode.optionLocal'))
          .addOption(ImageMode.REMOTE, t('settings.image.mode.optionRemote'))
          .addOption(ImageMode.DISABLED, t('settings.image.mode.optionDisabled'))
          .setValue(this.plugin.settings.imageMode)
          .onChange(async (value) => {
            this.plugin.settings.imageMode = value as ImageMode
            await this.plugin.saveSettings(true)
            // 刷新显示以显示/隐藏高级选项
            this.display()
          }),
      )

    // 只在本地模式下显示高级选项
    if (this.plugin.settings.imageMode === ImageMode.LOCAL) {
      new Setting(imageBody)
         
        .setName(t('settings.image.pngToJpeg.name'))
        .setDesc(t('settings.image.pngToJpeg.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.enablePngToJpeg)
            .onChange(async (value) => {
              this.plugin.settings.enablePngToJpeg = value
              await this.plugin.saveSettings(true)

              // Update ImageLocalizer with new setting
              if (this.plugin.imageLocalizer) {
                this.plugin.imageLocalizer.updateOptions({
                  enablePngToJpeg: this.plugin.settings.enablePngToJpeg,
                  jpegQuality: this.plugin.settings.jpegQuality,
                  attachmentFolder: this.plugin.settings.imageAttachmentFolder,
                  folderDateFormat: this.plugin.settings.folderDateFormat,
                  maxRetries: this.plugin.settings.imageDownloadRetries,
                  retryDelay: 1000,
                })
              }

              // 刷新显示以显示/隐藏质量设置
              this.display()
            }),
        )

      // 只在启用PNG转JPEG时显示质量设置
      if (this.plugin.settings.enablePngToJpeg) {
        new Setting(imageBody)
          .setName(t('settings.image.jpegQuality.name'))
          .setDesc(t('settings.image.jpegQuality.desc'))
          .addSlider((slider) =>
            slider
              .setLimits(0, 100, 5)
              .setValue(this.plugin.settings.jpegQuality)
              .setDynamicTooltip()
              .onChange(async (value) => {
                this.plugin.settings.jpegQuality = value
                await this.plugin.saveSettings(true)

                // Update ImageLocalizer with new quality setting
                if (this.plugin.imageLocalizer) {
                  this.plugin.imageLocalizer.updateOptions({
                    enablePngToJpeg: this.plugin.settings.enablePngToJpeg,
                    jpegQuality: this.plugin.settings.jpegQuality,
                    attachmentFolder: this.plugin.settings.imageAttachmentFolder,
                    folderDateFormat: this.plugin.settings.folderDateFormat,
                    maxRetries: this.plugin.settings.imageDownloadRetries,
                    retryDelay: 1000,
                  })
                }
              }),
          )
      }

      new Setting(imageBody)
        .setName(t('settings.image.retries.name'))
        .setDesc(t('settings.image.retries.desc'))
        .addText((text) =>
          text
            .setPlaceholder(t('settings.image.retries.placeholder'))
            .setValue(this.plugin.settings.imageDownloadRetries.toString())
            .onChange(async (value) => {
              const retries = parseInt(value)
              if (isNaN(retries) || retries < 0) {
                new Notice(t('settings.image.retries.noticeMustBeNonNegative'))
                return
              }
              const clampedRetries = clampImageDownloadRetries(retries)
              if (clampedRetries !== retries) {
                new Notice(
                  `${t('settings.image.retries.noticeMustBeNonNegative')} (0-${MAX_IMAGE_DOWNLOAD_RETRIES})`,
                )
                return
              }
              this.plugin.settings.imageDownloadRetries = clampedRetries
              await this.plugin.saveSettings(true)

              // Update ImageLocalizer with new retry setting
              if (this.plugin.imageLocalizer) {
                this.plugin.imageLocalizer.updateOptions({
                  enablePngToJpeg: this.plugin.settings.enablePngToJpeg,
                  jpegQuality: this.plugin.settings.jpegQuality,
                  attachmentFolder: this.plugin.settings.imageAttachmentFolder,
                  folderDateFormat: this.plugin.settings.folderDateFormat,
                  maxRetries: this.plugin.settings.imageDownloadRetries,
                  retryDelay: 1000,
                })
              }
            }),
        )

      new Setting(imageBody)
        .setName(t('settings.image.storageFolder.name'))
        .setDesc(t('settings.image.storageFolder.desc'))
        .addText((text) =>
          text
            .setPlaceholder(t('settings.image.storageFolder.placeholder'))
            .setValue(this.plugin.settings.imageAttachmentFolder)
            .onChange(async (value) => {
              if (!validateTemplate(value, '图片存储文件夹')) return
              this.plugin.settings.imageAttachmentFolder = value || DEFAULT_SETTINGS.imageAttachmentFolder
              await this.plugin.saveSettings(true)

              // Update ImageLocalizer with new path
              if (this.plugin.imageLocalizer) {
                this.plugin.imageLocalizer.updateOptions({
                  enablePngToJpeg: this.plugin.settings.enablePngToJpeg,
                  jpegQuality: this.plugin.settings.jpegQuality,
                  attachmentFolder: this.plugin.settings.imageAttachmentFolder,
                  folderDateFormat: this.plugin.settings.folderDateFormat,
                  maxRetries: this.plugin.settings.imageDownloadRetries,
                  retryDelay: 1000,
                })
              }
            }),
        )

      // 市场版：图床接力（跨插件特性）已整体移除
    }

    // ============ 4. 日记链接 ============
    const diaryBody = this.createSection(
      containerEl,
      'diary',
      t('settings.diary.heading'),
      t('settings.section.diarySub'),
    )

    new Setting(diaryBody)
      .setName(t('settings.diary.enable.name'))
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            t('settings.diary.enable.desc'),
            fragment.createEl('br'),
            fragment.createEl('br'),
            t('settings.diary.enable.usageIntro'),
            fragment.createEl('br'),
            t('settings.diary.enable.step1'),
            fragment.createEl('code', { text: '<!-- notehelper-links -->' }),
            fragment.createEl('br'),
            t('settings.diary.enable.step2'),
            fragment.createEl('br'),
            fragment.createEl('br'),
            '📖 ',
            fragment.createEl('a', {
              text: t('settings.diary.enable.tutorialLink'),
              href: 'https://www.notebooksyncer.com/blog/diary-link-tutorial/',
            }),
          )
        })
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDiaryLinks)
          .onChange(async (value) => {
            this.plugin.settings.enableDiaryLinks = value
            await this.plugin.saveSettings(true)
            this.display() // 刷新显示
          }),
      )

    // 仅在启用时显示详细设置
    if (this.plugin.settings.enableDiaryLinks) {
      new Setting(diaryBody)
        .setName(t('settings.diary.autoCreate.name'))
        .setDesc(t('settings.diary.autoCreate.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.autoCreateDiaryNote)
            .onChange(async (value) => {
              this.plugin.settings.autoCreateDiaryNote = value
              await this.plugin.saveSettings(true)
              this.display()
            }),
        )

      if (!this.plugin.settings.autoCreateDiaryNote) {
      new Setting(diaryBody)
        .setName(t('settings.diary.folder.name'))
        .setDesc(t('settings.diary.folder.desc'))
        .addText((text) => {
          new FolderSuggest(this.app, text.inputEl)
          text
             
            .setPlaceholder(t('settings.diary.folder.placeholder'))
            .setValue(this.plugin.settings.diaryFolder)
            .onChange(async (value) => {
              this.plugin.settings.diaryFolder = value
              await this.plugin.saveSettings(true)
            })
        })

      new Setting(diaryBody)
        .setName(t('settings.diary.dateFormat.name'))
        .setDesc(
          createFragment((fragment) => {
            fragment.append(
              t('settings.diary.dateFormat.descIntro'),
              fragment.createEl('br'),
              t('settings.diary.dateFormat.warnLiteral'),
              fragment.createEl('code', { text: t('settings.diary.dateFormat.exampleLiteral') }),
              fragment.createEl('br'),
              t('settings.diary.dateFormat.commonIntro'),
              fragment.createEl('code', { text: t('settings.diary.dateFormat.exampleCommon') }),
              fragment.createEl('br'),
              fragment.createEl('a', {
                text: t('settings.diary.dateFormat.docLink'),
                href: 'https://moment.github.io/luxon/#/formatting?id=table-of-tokens'
              })
            )
          })
        )
        .addText((text) => {
          const previewContainer = diaryBody.createDiv({
            cls: 'setting-item-description notehelper-inline-preview',
          })

          const updatePreview = (format: string) => {
            try {
              const preview = formatDate(new Date().toISOString(), format)
              previewContainer.setText(`✓ ${t('settings.diary.dateFormat.previewOk')}: ${preview}`)
              previewContainer.removeClass('mod-warning')
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              previewContainer.setText(`⚠️ ${t('settings.diary.dateFormat.previewError')}: ${msg}`)
              previewContainer.addClass('mod-warning')
            }
          }

          text
             
            .setPlaceholder(t('settings.diary.dateFormat.placeholder'))
            .setValue(this.plugin.settings.diaryDateFormat)
            .onChange(async (value) => {
              this.plugin.settings.diaryDateFormat = value
              await this.plugin.saveSettings(true)
              updatePreview(value || 'yyyy-MM-dd')
            })

          // 初始化预览
          updatePreview(this.plugin.settings.diaryDateFormat || 'yyyy-MM-dd')
        })
      }

      // 写入位置：默认「锚点之间」（历史行为）；选顶部/底部就不需要锚点了，
      // 锚点标识与写入顺序两行随之隐藏。
      const writePositionSetting = new Setting(diaryBody)
        .setName(t('settings.diary.writePosition.name'))
        .setDesc(t('settings.diary.writePosition.desc'))
        .addDropdown((dropdown) =>
          dropdown
            .addOption(DiaryWritePosition.ANCHOR, t('settings.diary.writePosition.optionAnchor'))
            .addOption(DiaryWritePosition.TOP, t('settings.diary.writePosition.optionTop'))
            .addOption(DiaryWritePosition.BOTTOM, t('settings.diary.writePosition.optionBottom'))
            .setValue(this.plugin.settings.diaryWritePosition)
            .onChange(async (value) => {
              this.plugin.settings.diaryWritePosition = value as DiaryWritePosition
              await this.plugin.saveSettings(true)
              this.display() // 切换后重渲染：锚点相关的两行跟着显示/隐藏
            }),
        )
      // 稳定选择器：real-obsidian e2e 用它定位这一行
      writePositionSetting.settingEl.addClass('notehelper-diary-write-position-row')

      if (this.plugin.settings.diaryWritePosition === DiaryWritePosition.ANCHOR) {
      new Setting(diaryBody)
        .setName(t('settings.diary.anchor.name'))
        .setDesc(
          createFragment((fragment) => {
            fragment.append(
              t('settings.diary.anchor.descIntro'),
              fragment.createEl('br'),
              fragment.createEl('code', { text: `<!-- ${this.plugin.settings.diaryAnchor} -->` }),
              fragment.createEl('br'),
              fragment.createEl('code', { text: `<!-- ${this.plugin.settings.diaryAnchor} -->` }),
              fragment.createEl('br'),
              t('settings.diary.anchor.descAfter'),
            )
          })
        )
        .addText((text) =>
          text
            .setPlaceholder(t('settings.diary.anchor.placeholder'))
            .setValue(this.plugin.settings.diaryAnchor)
            .onChange(async (value) => {
              this.plugin.settings.diaryAnchor = value || 'notehelper-links'
              await this.plugin.saveSettings(true)
            }),
        )

      const linkOrderSetting = new Setting(diaryBody)
        .setName(t('settings.diary.linkOrder.name'))
        .setDesc(t('settings.diary.linkOrder.desc'))
        .addDropdown((dropdown) =>
          dropdown
            .addOption(DiaryLinkOrder.DESC, t('settings.diary.linkOrder.optionDesc'))
            .addOption(DiaryLinkOrder.ASC, t('settings.diary.linkOrder.optionAsc'))
            .setValue(this.plugin.settings.diaryLinkOrder)
            .onChange(async (value) => {
              this.plugin.settings.diaryLinkOrder = value as DiaryLinkOrder
              await this.plugin.saveSettings(true)
            }),
        )
      linkOrderSetting.settingEl.addClass('notehelper-diary-link-order-row')
      }

      new Setting(diaryBody)
        .setName(t('settings.diary.linkType.name'))
        .setDesc(t('settings.diary.linkType.desc'))
        .addDropdown((dropdown) =>
          dropdown
            .addOption(DiaryLinkType.ALL, t('settings.diary.linkType.optionAll'))
            .addOption(DiaryLinkType.MESSAGES, t('settings.diary.linkType.optionMessages'))
            .addOption(DiaryLinkType.ARTICLES, t('settings.diary.linkType.optionArticles'))
            .setValue(this.plugin.settings.diaryLinkType)
            .onChange(async (value) => {
              this.plugin.settings.diaryLinkType = value as DiaryLinkType
              await this.plugin.saveSettings(true)
            }),
        )

      new Setting(diaryBody)
        .setName(t('settings.diary.linkPrefix.name'))
        .setDesc(t('settings.diary.linkPrefix.desc'))
        .addText((text) => {
          const previewContainer = diaryBody.createDiv({
            cls: 'setting-item-description notehelper-inline-preview',
          })

          const updatePrefixPreview = (prefix: string) => {
            const sampleTitle = t('settings.diary.linkPrefix.sampleTitle')
            const sample = `${prefix}[[${sampleTitle}|${sampleTitle}]]`
            previewContainer.setText(`${t('settings.diary.linkPrefix.previewLabel')}: ${sample}`)
          }

          text
            .setPlaceholder(t('settings.diary.linkPrefix.placeholder'))
            .setValue(this.plugin.settings.diaryLinkPrefix)
            .onChange(async (value) => {
              this.plugin.settings.diaryLinkPrefix = value
              await this.plugin.saveSettings(true)
              updatePrefixPreview(value)
            })

          updatePrefixPreview(this.plugin.settings.diaryLinkPrefix)
        })

      new Setting(diaryBody)
        .setName(t('settings.diary.linkMaxLength.name'))
        .setDesc(t('settings.diary.linkMaxLength.desc'))
        .addText((text) =>
          text
            .setPlaceholder(t('settings.diary.linkMaxLength.placeholder'))
            .setValue(String(this.plugin.settings.diaryLinkMaxLength))
            .onChange(async (value) => {
              const num = parseInt(value)
              if (value !== '' && (isNaN(num) || num < 0)) {
                new Notice(t('settings.diary.linkMaxLength.noticeMustBeNonNegative'))
                return
              }
              this.plugin.settings.diaryLinkMaxLength = value === '' ? 0 : num
              await this.plugin.saveSettings(true)
            }),
        )

      // 「日记不写 id」——与「消息不写 id」「笔记属性不写 id」同构的第三个开关。
      // 开启走 ConfirmModal 二次确认（警告跨设备不能用网盘方案 + 日记补写的代价），
      // 取消/点叉回滚 toggle；关闭直接保存。
      const noDiaryIdSetting = new Setting(diaryBody)
        .setName(t('settings.diary.noDiaryLinkId.name'))
        .setDesc(t('settings.diary.noDiaryLinkId.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.disableDiaryLinkMarkers)
            .onChange(async (value) => {
              if (value === true) {
                const confirmModal = new ConfirmModal(
                  this.app,
                  t('settings.diary.noDiaryLinkId.confirmTitle'),
                  t('settings.diary.noDiaryLinkId.confirmBody'),
                  async () => {
                    this.plugin.settings.disableDiaryLinkMarkers = true
                    await this.plugin.saveSettings(true)
                  },
                  [{ text: t('common.phonePcSyncLink'), url: PHONE_PC_SYNC_URL }]
                )
                // ConfirmModal 只有 onConfirm 回调；用关闭事件兜底：关闭时若未确认（仍 false），回滚 toggle。
                const origOnClose = confirmModal.onClose.bind(confirmModal) as () => void
                confirmModal.onClose = () => {
                  origOnClose()
                  if (!this.plugin.settings.disableDiaryLinkMarkers) {
                    toggle.setValue(false)
                  }
                }
                confirmModal.open()
              } else {
                this.plugin.settings.disableDiaryLinkMarkers = false
                await this.plugin.saveSettings(true)
              }
            }),
        )
      // 稳定选择器：real-obsidian e2e 用它定位开关行
      noDiaryIdSetting.settingEl.addClass('notehelper-no-diary-id-toggle-row')
    }

    // ============ 6. 系统设置 ============
    const systemBody = this.createSection(
      containerEl,
      'system',
      t('settings.section.system.name'),
      t('settings.section.system.sub'),
    )

    /**
     * 界面语言：选「中文」后强制中文，不管插件/Obsidian 是什么语言。
     * onChange → saveSettings(true)（内部 applyLanguagePreference 把语言同步给 i18n）
     * → display() 重渲染，整个设置面板立刻切到目标语言。
     **/
    new Setting(systemBody)
      .setName(t('settings.advanced.language.name'))
      .setDesc(t('settings.advanced.language.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption(PluginLanguage.AUTO, t('settings.advanced.language.optAuto'))
          .addOption(PluginLanguage.ZH, t('settings.advanced.language.optZh'))
          .addOption(PluginLanguage.EN, t('settings.advanced.language.optEn'))
          .setValue(this.plugin.settings.language ?? PluginLanguage.AUTO)
          .onChange(async (value) => {
            this.plugin.settings.language = value as PluginLanguage
            await this.plugin.saveSettings(true)
            // 重新渲染设置面板，使所有 t() 立即读到新语言
            this.display()
          }),
      )


    containerEl.createEl('p', {
      text: t('settings.advanced.footer'),
    })

    // 渲染完成后还原滚动位置
    window.requestAnimationFrame(() => {
      scroller.scrollTop = prevScrollTop
    })
  }


  private displayVersionInfo(containerEl: HTMLElement) {
    // 创建版本信息容器
    const versionContainer = containerEl.createDiv({
      cls: 'omnivore-version-container',
    })
    versionContainer.setCssStyles({
      marginBottom: '20px',
      padding: '15px',
      border: '1px solid var(--background-modifier-border)',
      borderRadius: '8px',
      background: 'var(--background-secondary)',
    })

    // 当前版本显示
    const currentVersion = this.plugin.manifest.version
    const versionInfo = versionContainer.createDiv({
      cls: 'omnivore-version-info',
    })

    const versionText = versionInfo.createSpan({
      text: `${t('versionCheck.versionLabel')}: ${currentVersion}`,
      cls: 'omnivore-current-version',
    })
    versionText.setCssStyles({
      fontWeight: 'bold',
      marginRight: '15px',
    })

    // 检查更新按钮
    const checkButton = versionInfo.createEl('button', {
      text: t('versionCheck.checkButton'),
      cls: 'mod-cta omnivore-check-update-btn',
    })
    checkButton.setCssStyles({
      marginLeft: '10px',
    })

    checkButton.onclick = () => {
      void this.checkForUpdates(versionContainer)
    }

    // 如果已经在检查更新，显示状态
    if (this.versionCheckPromise) {
      this.showVersionCheckStatus(versionContainer, t('versionCheck.checking'))
    }
  }

  /**
   * 手动「检查更新」：只查询市场渠道版本号并展示结果。
   * 市场版不做任何形式的自更新——发现新版本时引导用户去第三方插件页升级。
   */
  private async checkForUpdates(versionContainer: HTMLElement) {
    log('🔄 开始检查版本更新...')

    if (this.versionCheckPromise) {
      log('🔄 检查更新已在进行中，跳过...')
      return // 避免重复请求
    }

    this.showVersionCheckStatus(versionContainer, t('versionCheck.checking'))

    this.versionCheckPromise = this.fetchLatestVersion()

    try {
      await this.versionCheckPromise
      log('🔄 版本检查完成，显示结果...')
      this.showVersionStatus(versionContainer)
    } catch (error) {
      logError('🔄 版本检查失败:', error)
      this.showVersionCheckStatus(versionContainer, t('versionCheck.failGeneric'))
    } finally {
      this.versionCheckPromise = null
    }
  }

  private async fetchLatestVersion(): Promise<void> {
    log('🔄 开始请求最新版本信息...')

    try {
      // 市场渠道版本号端点：只返回 {"version": "x.y.z"}，不含任何下载地址。
      const response = await requestUrl({
        url: MARKET_VERSION_CHECK_URL,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      log('🔄 API响应状态:', response.status)
      log('🔄 API响应数据:', response.json)

      if (response.status === 200) {
        const data = response.json as { version: string }
        this.latestVersionInfo = {
          version: data.version,
        }
        log('🔄 最新版本信息已保存:', this.latestVersionInfo)
      } else {
        throw new Error(`HTTP ${response.status}`)
      }
    } catch (error) {
      logError('🔄 获取最新版本信息失败:', error)
      throw error
    }
  }

  private showVersionCheckStatus(versionContainer: HTMLElement, message: string) {
    // 移除之前的状态信息
    const existingStatus = versionContainer.querySelector('.omnivore-version-status')
    if (existingStatus) {
      existingStatus.remove()
    }

    // 显示新的状态信息
    const statusEl = versionContainer.createDiv({
      text: message,
      cls: 'omnivore-version-status',
    })
    statusEl.setCssStyles({
      marginTop: '10px',
      color: 'var(--text-muted)',
      fontSize: '0.9em',
    })
  }

  private showVersionStatus(versionContainer: HTMLElement) {
    log('🔄 开始显示版本状态...')

    // 移除之前的状态信息
    const existingStatus = versionContainer.querySelector('.omnivore-version-status')
    if (existingStatus) {
      existingStatus.remove()
    }

    if (!this.latestVersionInfo) {
      log('🔄 没有最新版本信息')
      this.showVersionCheckStatus(versionContainer, t('versionCheck.fetchFail'))
      return
    }

    const currentVersion = this.plugin.manifest.version
    const latestVersion = this.latestVersionInfo.version

    log('🔄 当前版本:', currentVersion)
    log('🔄 最新版本:', latestVersion)

    const isNewer = this.isNewerVersion(latestVersion, currentVersion)
    log('🔄 版本比较结果 - 有新版本:', isNewer)

    if (isNewer) {
      log('🔄 显示更新提示')
      // 有新版本可用
      const updateContainer = versionContainer.createDiv({
        cls: 'omnivore-update-available',
      })
      updateContainer.setCssStyles({
        marginTop: '10px',
        padding: '10px',
        background: 'var(--background-modifier-success)',
        borderRadius: '4px',
      })

      const updateText = updateContainer.createDiv({
        text: `${t('versionCheck.foundNew')} ${latestVersion}!`,
        cls: 'omnivore-update-text',
      })
      updateText.setCssStyles({
        color: 'var(--text-success)',
        fontWeight: 'bold',
        marginBottom: '8px',
      })

      // 市场版不提供任何下载/安装按钮：跳转 Obsidian 第三方插件页，由用户完成升级
      const goButton = updateContainer.createEl('button', {
        text: t('versionCheck.goToPluginPage'),
        cls: 'mod-cta omnivore-goto-plugin-page-btn',
      })
      goButton.onclick = () => {
        log('🔄 用户点击前往第三方插件页')
        this.plugin.openCommunityPluginsPage()
      }
    } else {
      log('🔄 显示已是最新版本提示')
      // 已是最新版本
      this.showVersionCheckStatus(versionContainer, t('versionCheck.upToDate'))
    }
  }

  private isNewerVersion(latestVersion: string, currentVersion: string): boolean {
    log('🔄 开始版本比较:', `最新版本: ${latestVersion}, 当前版本: ${currentVersion}`)

    // 简单的版本比较，假设版本格式为 x.y.z
    const parseVersion = (version: string) => {
      const parsed = version.split('.').map(num => parseInt(num, 10))
      log('🔄 解析版本:', version, '→', parsed)
      return parsed
    }

    const latest = parseVersion(latestVersion)
    const current = parseVersion(currentVersion)

    for (let i = 0; i < Math.max(latest.length, current.length); i++) {
      const latestNum = latest[i] || 0
      const currentNum = current[i] || 0

      log(`🔄 比较位置 ${i}: 最新 ${latestNum} vs 当前 ${currentNum}`)

      if (latestNum > currentNum) {
        log('🔄 版本比较结果: 有新版本')
        return true
      } else if (latestNum < currentNum) {
        log('🔄 版本比较结果: 当前版本更新')
        return false
      }
    }

    log('🔄 版本比较结果: 版本相同')
    return false // 版本相同
  }

  /**
   * 在设置页面打开时检查和执行配置迁移
   */
  private async checkAndPerformMigration(): Promise<void> {
    try {
      const manifestVersion = this.plugin.manifest.version
      const configMigrationManager = this.plugin.configMigrationManager

      log('设置页面：当前配置', {
        apiKey: this.plugin.settings.apiKey ? '***' : '(空)',
        version: this.plugin.settings.version,
        manifestVersion
      })

      if (configMigrationManager.isConfigMigrationNeeded(this.plugin.settings, manifestVersion)) {
        log('设置页面：检测到需要配置迁移')

        // 记录迁移前的关键配置
        const beforeMigration = {
          apiKey: this.plugin.settings.apiKey,
          syncAt: this.plugin.settings.syncAt
        }

        const migratedSettings = await configMigrationManager.performMigration(
          this.plugin.settings,
          manifestVersion
        )

        log('设置页面：迁移后的配置', {
          apiKey: migratedSettings.apiKey ? '***' : '(空)',
          version: migratedSettings.version,
          syncAt: migratedSettings.syncAt
        })

        // 检查是否实际恢复了有效配置
        const hasApiKeyRestored = migratedSettings.apiKey &&
          migratedSettings.apiKey !== beforeMigration.apiKey &&
          migratedSettings.apiKey.trim() !== ''

        const hasSyncTimeRestored = migratedSettings.syncAt &&
          migratedSettings.syncAt !== beforeMigration.syncAt &&
          migratedSettings.syncAt.trim() !== ''

        // 更新插件设置
        this.plugin.settings = migratedSettings
        // 恢复的备份可能带着未归一化的老自定义查询——补跑一次性归一化，
        // 保住「同步范围恒为默认」的不变式（否则同步被不可见地缩窄）
        normalizeRetiredQuerySettings(this.plugin.settings)
        await this.plugin.saveSettings(true)

        log('设置页面：配置保存完成')

        // 只在实际恢复了有效配置时显示通知
        if (hasApiKeyRestored || hasSyncTimeRestored) {
          new Notice(t('versionCheck.configRestored'), 5000)
          log('设置页面：成功恢复配置', {
            hasApiKeyRestored,
            hasSyncTimeRestored
          })
        } else {
          log('设置页面：未检测到有效的备份配置恢复')
        }
      } else {
        log('设置页面：无需配置迁移')
      }
    } catch (error) {
      logError('设置页面：配置迁移失败', error)
      // 迁移失败不应该影响设置页面的显示
    }
  }

  /**
   * 多设备运行时保护：检测除本机外是否还有近 30 天活跃的设备游标。
   * 有则弹 Notice 警告（仍允许开启），提醒用户阅后即焚仅适合单设备。
   */
  private warnIfOtherDevicesActive(): void {
    const cursors = this.plugin.settings.deviceSyncCursors
    if (!cursors) return

    // 本机 deviceId（getDeviceId 在 plugin 上是 public）
    let selfDeviceId: string | null = null
    try {
      selfDeviceId = this.plugin.getDeviceId()
    } catch {
      selfDeviceId = null
    }

    const now = Date.now()
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

    let otherActive = false
    let otherCursorCount = 0
    for (const [deviceId, cursor] of Object.entries(cursors)) {
      if (selfDeviceId !== null && deviceId === selfDeviceId) continue
      otherCursorCount++
      const ts = Date.parse(cursor)
      if (!Number.isNaN(ts) && now - ts <= THIRTY_DAYS_MS) {
        otherActive = true
      }
    }

    // 拿不到本机 deviceId 时保守降级：只要存在 >1 个游标也警告
    const shouldWarn =
      otherActive || (selfDeviceId === null && Object.keys(cursors).length > 1)
    if (shouldWarn) {
      log(`阅后即焚：检测到其它设备活跃游标（other=${otherCursorCount}），弹多设备警告`)
      new Notice(t('settings.burnAfterReading.multiDeviceWarn'), 10000)
    }
  }
}

// 确认对话框
class ConfirmModal extends Modal {
  private title: string
  private message: string
  private onConfirm: () => void | Promise<void>
  private links: Array<{ text: string; url: string }>

  constructor(
    app: App,
    title: string,
    message: string,
    onConfirm: () => void | Promise<void>,
    links: Array<{ text: string; url: string }> = []
  ) {
    super(app)
    this.title = title
    this.message = message
    this.onConfirm = onConfirm
    this.links = links
  }

  onOpen() {
    const { contentEl } = this

    contentEl.createEl('h2', { text: this.title })
    const messageEl = contentEl.createEl('p')
    this.renderMessage(messageEl)
    messageEl.setCssStyles({
      whiteSpace: 'pre-wrap',
      margin: '20px 0',
    })

    const buttonContainer = contentEl.createDiv()
    buttonContainer.setCssStyles({
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '10px',
      marginTop: '20px',
    })

    const cancelButton = buttonContainer.createEl('button', {
      text: t('common.cancel'),
    })
    cancelButton.setCssStyles({
      padding: '5px 15px',
    })
    cancelButton.onclick = () => {
      this.close()
    }

    const confirmButton = buttonContainer.createEl('button', {
      text: t('common.confirm'),
      cls: 'mod-warning',
    })
    confirmButton.setCssStyles({
      padding: '5px 15px',
    })
    confirmButton.onclick = () => {
      void this.onConfirm()
      this.close()
    }
  }

  /**
   * 渲染 message：links 中出现的文本替换为超链接（其余保持纯文本，pre-wrap 保留换行）。
   * 未传 links 时行为与原先纯文本渲染完全一致。
   */
  private renderMessage(el: HTMLElement) {
    let segments: Array<string | { text: string; url: string }> = [this.message]
    for (const link of this.links) {
      if (!link.text) continue
      const next: typeof segments = []
      for (const seg of segments) {
        if (typeof seg !== 'string') {
          next.push(seg)
          continue
        }
        const parts = seg.split(link.text)
        parts.forEach((part, i) => {
          if (i > 0) next.push(link)
          if (part) next.push(part)
        })
      }
      segments = next
    }
    for (const seg of segments) {
      if (typeof seg === 'string') {
        el.appendText(seg)
      } else {
        el.createEl('a', { text: seg.text, href: seg.url })
      }
    }
  }

  onClose() {
    const { contentEl } = this
    contentEl.empty()
  }
}

/**
 * 调试模式说明弹窗。用户在设置页打开「调试模式」开关时弹出，说明调试模式下的三条行为
 * （默认位置 / 近 24h / 自动打开），确认后才真正开启；取消/关闭则回滚开关。
 *
 * 用 titleEl.setText() 设标题（而非只在 contentEl 建 h2），让 real-obsidian e2e 能用
 * `.modal-title` 断言。类名 notehelper-debug-mode-modal 提供稳定选择器。
 */
class DebugModeConfirmModal extends Modal {
  private onConfirm: () => void | Promise<void>

  constructor(app: App, onConfirm: () => void | Promise<void>) {
    super(app)
    this.onConfirm = onConfirm
  }

  onOpen() {
    const { contentEl, titleEl } = this
    this.modalEl.addClass('notehelper-debug-mode-modal')
    titleEl.setText(t('settings.debugMode.modalTitle'))

    const list = contentEl.createEl('ul', { cls: 'notehelper-debug-mode-points' })
    list.createEl('li', { text: t('settings.debugMode.modalBody1') })
    list.createEl('li', { text: t('settings.debugMode.modalBody2') })
    list.createEl('li', { text: t('settings.debugMode.modalBody3') })

    const note = contentEl.createEl('p', { text: t('settings.debugMode.modalNote') })
    note.setCssStyles({ color: 'var(--text-muted)', fontSize: '13px', marginTop: '12px' })

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' })
    buttonContainer.setCssStyles({
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '10px',
      marginTop: '20px',
    })

    const cancelButton = buttonContainer.createEl('button', { text: t('common.cancel') })
    cancelButton.onclick = () => this.close()

    const confirmButton = buttonContainer.createEl('button', {
      text: t('settings.debugMode.confirm'),
      cls: 'mod-cta',
    })
    confirmButton.onclick = () => {
      void this.onConfirm()
      this.close()
    }
  }

  onClose() {
    this.contentEl.empty()
  }
}
