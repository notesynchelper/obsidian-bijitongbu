import { App, Modal, TFile } from 'obsidian'

/**
 * 首次同步自动打开笔记 + 说明弹窗。
 *
 * 行为（整个插件生命周期只触发一次）：
 * - 当某轮同步是「第一次成功同步」（firstSyncAutoOpened 还是 false 且本轮真的落了盘）时，
 *   在所有本地化阶段（图片/附件/图床）跑完之后，自动打开最新同步的几篇笔记
 *   —— 桌面端最多 3 篇、手机端最多 1 篇。
 * - 打开后延迟 FIRST_SYNC_NOTICE_DELAY_MS（15s）弹出说明：首次同步会自动打开笔记，
 *   以后不再自动打开，可在左侧文件列表查看所有已同步笔记。
 * - 触发后把 firstSyncAutoOpened 置 true 并持久化，确保后续任何同步都不再打开/弹窗。
 *
 * 纯函数（selectNotesToOpen / shouldAutoOpenOnFirstSync / resolveFirstSyncNoticeDelay）
 * 抽出来便于单测，真正的「打开 leaf + 弹 Modal」副作用留在 main.ts，由 real-obsidian e2e 覆盖。
 */

/** 说明弹窗默认延迟：打开笔记后 15 秒。生产固定值，测试可通过 settings.firstSyncNoticeDelayMs 覆盖。 */
export const FIRST_SYNC_NOTICE_DELAY_MS = 15_000

/** 桌面端首次同步最多自动打开的笔记数。 */
export const DESKTOP_MAX_OPEN = 3

/** 手机端首次同步最多自动打开的笔记数。 */
export const MOBILE_MAX_OPEN = 1

/**
 * 从本轮同步处理过的文件里挑选首次同步要自动打开的笔记。
 *
 * 按处理顺序取前 N 篇（桌面端 N=3，手机端 N=1）。首次同步本来就是把账号里的笔记
 * 一次性拉下来，打开其中几篇只是给用户一个「同步成功了，长这样」的直观反馈，开哪几篇
 * 不影响正确性，所以取最简单稳定的「前 N 篇」即可。
 */
export function selectNotesToOpen(files: TFile[], isMobile: boolean): TFile[] {
  const max = isMobile ? MOBILE_MAX_OPEN : DESKTOP_MAX_OPEN
  if (max <= 0) return []
  return files.slice(0, max)
}

/**
 * 判断本轮同步是否应触发「首次同步自动打开 + 弹窗」。
 *
 * 三个条件全满足才触发：
 * - alreadyOpened=false：之前从未触发过（老用户在加载阶段已被标记为 true，不会进来）。
 * - successCount>0：本轮确实成功处理了文章（空轮不触发，留给真正有内容的首轮）。
 * - fileCount>0：确实有可打开的落盘文件。
 */
export function shouldAutoOpenOnFirstSync(opts: {
  alreadyOpened: boolean
  successCount: number
  fileCount: number
}): boolean {
  return !opts.alreadyOpened && opts.successCount > 0 && opts.fileCount > 0
}

/**
 * 加载阶段判断：是否应把老用户直接标记为「首次同步已触发」从而抑制自动打开+弹窗。
 *
 * 老用户 = 之前已经同步过的人。判定信号有两路，满足任一即视为有同步历史：
 * - initialSyncCompleted=true（该字段存在以来的版本，首轮成功后即置位）。
 * - hasSyncHistory=true：syncAt 或任一设备游标非空。这是为了覆盖**更老的、在
 *   initialSyncCompleted 字段出现之前**就同步过的用户——他们升级后 initialSyncCompleted
 *   默认 false，但 syncAt/设备游标里有真实历史，若只看 initialSyncCompleted 会被误判成
 *   新用户，下一次普通同步突然自动打开+弹窗（codex review P2）。
 *
 * 真正的新用户三者皆空 → 不抑制，首轮同步正常触发。
 * 已经标记过（firstSyncAutoOpened=true）的不必再处理，返回 false。
 */
export function shouldSuppressFirstSyncOnLoad(opts: {
  firstSyncAutoOpened: boolean
  initialSyncCompleted: boolean
  hasSyncHistory: boolean
}): boolean {
  return !opts.firstSyncAutoOpened && (opts.initialSyncCompleted || opts.hasSyncHistory)
}

/**
 * 解析说明弹窗延迟：优先用测试覆盖值（settings.firstSyncNoticeDelayMs），
 * 否则用生产固定值 15s。只接受有限的非负数覆盖，其它一律回退默认，避免 NaN/负值把 setTimeout 弄坏。
 */
export function resolveFirstSyncNoticeDelay(override: number | undefined): number {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return override
  }
  return FIRST_SYNC_NOTICE_DELAY_MS
}

/**
 * 首次同步说明弹窗。一次性 onboarding 提示，用户点「我知道了」或关闭即消失。
 * 标题固定为「笔记同步助手首次同步完成」，real-obsidian e2e 用它做 .modal-title 断言。
 */
export class FirstSyncNoticeModal extends Modal {
  constructor(app: App) {
    super(app)
  }

  onOpen(): void {
    const { contentEl, titleEl } = this
    this.modalEl.addClass('notehelper-first-sync-modal')
    titleEl.setText('笔记同步助手首次同步完成')
    contentEl.createEl('p', {
      text: '已自动为你打开最新同步的笔记。',
    })
    contentEl.createEl('p', {
      text: '以后同步不会再自动打开笔记，你可以随时在左侧文件列表中查看所有已同步的笔记。',
    })
    const btnRow = contentEl.createDiv({ cls: 'modal-button-container' })
    const okBtn = btnRow.createEl('button', { text: '我知道了', cls: 'mod-cta' })
    okBtn.addEventListener('click', () => this.close())
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
