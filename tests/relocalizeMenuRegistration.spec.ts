/**
 * v3.1.6 菜单注册护栏（codex 交叉验证发现的两个问题）：
 * 1. 启动竞态——localizer 尚未初始化（延迟 ~3s）时菜单也必须显示，
 *    否则 onClick 的懒初始化兜底永远触达不了。
 * 2. 右键文件夹节点也要有「将本文件夹…」项（并且没有单笔记项）。
 */

jest.mock('obsidian', () => {
  const actual = jest.requireActual('../src/__mocks__/obsidian')

  class Plugin {
    app: unknown

    constructor(app?: unknown) {
      this.app = app
    }
  }

  return {
    ...actual,
    addIcon: jest.fn(),
    Plugin,
  }
})

jest.mock('../src/settingsTab', () => ({
  OmnivoreSettingTab: jest.fn(),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { TFile, TFolder } from 'obsidian'
import OmnivorePlugin from '../src/main'
import { ImageMode } from '../src/settings'

type MenuRecord = { title: string; onClick: (() => unknown) | null }

function collectMenu(plugin: OmnivorePlugin, file: unknown): MenuRecord[] {
  let handler: ((menu: unknown, file: unknown) => void) | null = null
  Object.assign(plugin, {
    registerEvent: jest.fn(),
    app: {
      workspace: {
        on: jest.fn((_name: string, cb: (menu: unknown, file: unknown) => void) => {
          handler = cb
          return {}
        }),
      },
    },
  })
  ;(plugin as unknown as { registerFileMenu(): void }).registerFileMenu()
  if (!handler) throw new Error('file-menu handler not registered')

  const items: MenuRecord[] = []
  const menu = {
    addItem: (configure: (item: unknown) => void) => {
      const record: MenuRecord = { title: '', onClick: null }
      const item = {
        setTitle(title: string) { record.title = title; return item },
        setIcon() { return item },
        onClick(cb: () => unknown) { record.onClick = cb; return item },
      }
      configure(item)
      items.push(record)
      return menu
    },
  }
  ;(handler as (menu: unknown, file: unknown) => void)(menu, file)
  return items
}

function mdFile(path: string, parent: TFolder | null): TFile {
  const file = new TFile()
  file.path = path
  file.extension = 'md'
  file.parent = parent
  return file
}

describe('v3.1.6 右键菜单注册', () => {
  function plugin(imageMode: ImageMode): OmnivorePlugin {
    const value = Object.create(OmnivorePlugin.prototype) as OmnivorePlugin
    Object.assign(value, {
      settings: { imageMode },
      // 关键：两个 localizer 都还没初始化（启动头几秒的真实状态）
      imageLocalizer: undefined,
      attachmentLocalizer: undefined,
    })
    return value
  }

  test('localizer 未初始化时（启动竞态）笔记菜单仍显示两项', () => {
    const folder = new TFolder()
    folder.path = 'Synced'
    const items = collectMenu(plugin(ImageMode.LOCAL), mdFile('Synced/a.md', folder))
    expect(items.map(item => item.title)).toEqual([
      '将本笔记图片重新本地化',
      '将本文件夹图片重新本地化',
    ])
  })

  test('右键文件夹节点只显示「将本文件夹…」一项', () => {
    const folder = new TFolder()
    folder.path = 'Synced'
    const items = collectMenu(plugin(ImageMode.LOCAL), folder)
    expect(items.map(item => item.title)).toEqual(['将本文件夹图片重新本地化'])
  })

  test('REMOTE 模式显示附件文案；非 md 文件不显示任何项', () => {
    const folder = new TFolder()
    folder.path = 'Synced'
    const remoteItems = collectMenu(plugin(ImageMode.REMOTE), mdFile('Synced/a.md', folder))
    expect(remoteItems.map(item => item.title)).toEqual([
      '将本笔记附件重新本地化',
      '将本文件夹附件重新本地化',
    ])

    const png = new TFile()
    png.path = 'Synced/pic.png'
    png.extension = 'png'
    expect(collectMenu(plugin(ImageMode.LOCAL), png)).toEqual([])
  })
})
