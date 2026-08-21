/**
 * 修复 4：并发 processQueue 必须等待同一个 drain；扫描读失败必须可见且保留续传。
 */

import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'

jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('attachments'),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
}))

function createLocalizer(vault: unknown, pendingStore?: unknown): ImageLocalizer {
  return new ImageLocalizer(
    { vault } as any,
    {
      enablePngToJpeg: false,
      jpegQuality: 85,
      attachmentFolder: 'attachments',
      folderDateFormat: 'yyyy-MM-dd',
      maxRetries: 0,
      retryDelay: 0,
    },
    undefined,
    pendingStore as any,
  )
}

describe('修复 4：队列并发和入队结果', () => {
  test('第二个 processQueue 不提前返回，拿到同一个失败结果', async () => {
    const localizer = createLocalizer({})
    const file = new TFile()
    file.path = 'slow.md'
    const queue = (localizer as any).queue
    queue.enqueue({ file, images: [], createdAt: 1, retryCount: 0 })

    let finish!: (ok: boolean) => void
    jest.spyOn(localizer, 'localizeFile').mockImplementation(
      () => new Promise<boolean>((resolve) => { finish = resolve }),
    )

    const first = localizer.processQueue()
    let secondResolved = false
    const second = localizer.processQueue().then((result) => {
      secondResolved = true
      return result
    })
    await Promise.resolve()
    expect(secondResolved).toBe(false)

    finish(false)
    await expect(first).resolves.toEqual({
      total: 1,
      succeeded: 0,
      failed: 1,
      failedFiles: ['slow.md'],
    })
    await expect(second).resolves.toEqual({
      total: 1,
      succeeded: 0,
      failed: 1,
      failedFiles: ['slow.md'],
    })
  })

  test('enqueueFile 把读失败与无远程图分开，且读失败不删除续传记录', async () => {
    const pendingStore = {
      remove: jest.fn(),
      upsert: jest.fn(),
    }
    const file = new TFile()
    file.path = 'unreadable.md'
    const localizer = createLocalizer(
      { read: jest.fn().mockRejectedValue(new Error('EIO')) },
      pendingStore,
    )

    await expect(localizer.enqueueFile(file)).resolves.toBe('read-failed')
    expect(pendingStore.remove).not.toHaveBeenCalled()
    await expect(localizer.processQueue()).resolves.toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      failedFiles: [],
    })
  })
})
