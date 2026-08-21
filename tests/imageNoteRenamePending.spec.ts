jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))
jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('attachments'),
}))

import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
import { UrlLocalMap } from '../src/imageLocalizer/urlLocalMap'

describe('笔记 rename 迁移图片续传状态', () => {
  it('pending 与 per-file URL 映射一起迁移到新路径', () => {
    const oldPath = 'Synced/old.md'
    const newPath = 'Archive/new.md'
    const remote = 'https://relay-1.bijitongbu.site/p/a.png'
    const local = 'attachments/a.png'
    const localFile = new TFile()
    localFile.path = local

    const pending = new PendingLocalizeStore()
    pending.upsert({
      filePath: oldPath,
      retryCount: 1,
      createdAt: 10,
      lastAttemptAt: 20,
    })
    const map = new UrlLocalMap()
    map.set(oldPath, remote, local)
    const vault = {
      getAbstractFileByPath: jest.fn((path: string) => path === local ? localFile : null),
    }
    const localizer = new ImageLocalizer(
      { vault } as any,
      {
        enablePngToJpeg: false,
        jpegQuality: 85,
        attachmentFolder: 'attachments',
        folderDateFormat: 'yyyy-MM-dd',
        maxRetries: 1,
        retryDelay: 0,
      },
      map,
      pending,
    )

    localizer.handleNoteRename(oldPath, newPath)

    expect(pending.get(oldPath)).toBeUndefined()
    expect(pending.get(newPath)).toMatchObject({
      filePath: newPath,
      retryCount: 1,
      lastAttemptAt: 20,
    })
    expect(map.hasFile(oldPath)).toBe(false)
    expect(map.get(newPath, remote)).toBe(local)
    expect(localizer.replayLocalizedUrls(`![](${remote})`, newPath)).toBe(
      `![[${local}]]`,
    )
  })
})
