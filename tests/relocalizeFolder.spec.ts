const mockNoticeMessages: string[] = []

jest.mock('obsidian', () => {
  const actual = jest.requireActual('../src/__mocks__/obsidian')

  class Plugin {
    app: unknown

    constructor(app?: unknown) {
      this.app = app
    }
  }

  class CapturingNotice extends actual.Notice {
    constructor(message: string | DocumentFragment, duration?: number) {
      super(message, duration)
      mockNoticeMessages.push(this.message)
    }

    setMessage(message: string | DocumentFragment): this {
      super.setMessage(message)
      mockNoticeMessages.push(this.message)
      return this
    }
  }

  return {
    ...actual,
    addIcon: jest.fn(),
    Plugin,
    Notice: CapturingNotice,
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

function file(path: string, extension = 'md'): TFile {
  const value = new TFile()
  value.path = path
  value.name = path.split('/').pop() ?? path
  value.basename = value.name.replace(/\.[^.]+$/, '')
  value.extension = extension
  return value
}

function folder(path: string, children: Array<TFile | TFolder> = []): TFolder {
  const value = new TFolder()
  value.path = path
  value.name = path.split('/').pop() ?? ''
  value.children = children
  for (const child of children) child.parent = value
  return value
}

function createPlugin(
  imageLocalizer: Record<string, jest.Mock>,
  attachmentLocalizer: Record<string, jest.Mock>,
): OmnivorePlugin {
  const plugin = Object.create(OmnivorePlugin.prototype) as OmnivorePlugin
  Object.assign(plugin, {
    settings: { imageMode: ImageMode.LOCAL },
    imageLocalizer,
    attachmentLocalizer,
    app: {
      metadataCache: {
        getFileCache: jest.fn((value: TFile) => ({
          frontmatter: {
            author: `author:${value.path}`,
            source: `source:${value.path}`,
          },
        })),
      },
    },
    initializeImageLocalizer: jest.fn(),
    initializeAttachmentLocalizer: jest.fn(),
  })
  return plugin
}

describe('relocalizeFolder 批量编排', () => {
  beforeAll(() => {
    jest.useFakeTimers()
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockNoticeMessages.length = 0
  })

  test('递归收集后整批入队，每个 localizer 只 drain 一次，失败按文件去重', async () => {
    const noteA = file('资料/A.md')
    const noteB = file('资料/B.md')
    const noteC = file('资料/子目录/C.md')
    const nested = folder('资料/子目录', [noteC])
    const root = folder('资料', [
      noteA,
      file('资料/忽略.txt', 'txt'),
      noteB,
      nested,
    ])

    const imageLocalizer = {
      clearProcessedMark: jest.fn(),
      enqueueFile: jest.fn().mockResolvedValue('enqueued'),
      processQueue: jest.fn().mockResolvedValue({
        total: 3,
        succeeded: 2,
        failed: 1,
        failedFiles: [noteA.path],
      }),
    }
    const attachmentLocalizer = {
      clearProcessedMark: jest.fn(),
      enqueueFile: jest.fn().mockResolvedValue('enqueued'),
      processQueue: jest.fn().mockResolvedValue({
        total: 3,
        succeeded: 1,
        failed: 2,
        failedFiles: [noteA.path, noteB.path],
      }),
    }
    const plugin = createPlugin(imageLocalizer, attachmentLocalizer)

    await (plugin as unknown as {
      relocalizeFolder(value: TFolder): Promise<void>
    }).relocalizeFolder(root)

    const expectedPaths = [noteA.path, noteB.path, noteC.path]
    expect(imageLocalizer.clearProcessedMark.mock.calls.flat()).toEqual(
      expectedPaths,
    )
    expect(attachmentLocalizer.clearProcessedMark.mock.calls.flat()).toEqual(
      expectedPaths,
    )
    expect(imageLocalizer.enqueueFile).toHaveBeenCalledTimes(3)
    expect(attachmentLocalizer.enqueueFile).toHaveBeenCalledTimes(3)
    expect(imageLocalizer.processQueue).toHaveBeenCalledTimes(1)
    expect(attachmentLocalizer.processQueue).toHaveBeenCalledTimes(1)

    for (const value of [noteA, noteB, noteC]) {
      expect(imageLocalizer.enqueueFile).toHaveBeenCalledWith(
        value,
        expect.objectContaining({
          author: `author:${value.path}`,
          siteName: `source:${value.path}`,
        }),
      )
      expect(attachmentLocalizer.enqueueFile).toHaveBeenCalledWith(
        value,
        expect.objectContaining({
          author: `author:${value.path}`,
          siteName: `source:${value.path}`,
        }),
      )
    }

    expect(mockNoticeMessages).toContain(
      '本地化未成功：2 个笔记仍有远程链接，稍后会自动重试',
    )
  })

  test('共享 drain 返回的文件夹外失败不计入本文件夹结果', async () => {
    // 3.1.5 起 processQueue 共享 drain：并发同步入队的其它文件失败也会出现在
    // failedFiles 里。文件夹批量必须只统计自己范围内的失败，否则会把无关失败
    // 误报成本夹失败。
    const noteA = file('资料/A.md')
    const root = folder('资料', [noteA])

    const imageLocalizer = {
      clearProcessedMark: jest.fn(),
      enqueueFile: jest.fn().mockResolvedValue('enqueued'),
      processQueue: jest.fn().mockResolvedValue({
        total: 2,
        succeeded: 1,
        failed: 1,
        failedFiles: ['别处/无关笔记.md'],
      }),
    }
    const attachmentLocalizer = {
      clearProcessedMark: jest.fn(),
      enqueueFile: jest.fn().mockResolvedValue('enqueued'),
      processQueue: jest.fn().mockResolvedValue({
        total: 1,
        succeeded: 1,
        failed: 0,
        failedFiles: [],
      }),
    }
    const plugin = createPlugin(imageLocalizer, attachmentLocalizer)

    await (plugin as unknown as {
      relocalizeFolder(value: TFolder): Promise<void>
    }).relocalizeFolder(root)

    expect(mockNoticeMessages).toContain('本地化完成: 资料（1 个笔记）')
    expect(
      mockNoticeMessages.some(text => text.includes('未成功')),
    ).toBe(false)
  })

  test('空文件夹只提示无可处理笔记，不 drain 队列', async () => {
    const imageLocalizer = {
      clearProcessedMark: jest.fn(),
      enqueueFile: jest.fn(),
      processQueue: jest.fn(),
    }
    const attachmentLocalizer = {
      clearProcessedMark: jest.fn(),
      enqueueFile: jest.fn(),
      processQueue: jest.fn(),
    }
    const plugin = createPlugin(imageLocalizer, attachmentLocalizer)

    await (plugin as unknown as {
      relocalizeFolder(value: TFolder): Promise<void>
    }).relocalizeFolder(folder('空目录', [file('空目录/忽略.pdf', 'pdf')]))

    expect(mockNoticeMessages).toEqual(['该文件夹没有可处理的笔记'])
    expect(imageLocalizer.enqueueFile).not.toHaveBeenCalled()
    expect(attachmentLocalizer.enqueueFile).not.toHaveBeenCalled()
    expect(imageLocalizer.processQueue).not.toHaveBeenCalled()
    expect(attachmentLocalizer.processQueue).not.toHaveBeenCalled()
  })
})
