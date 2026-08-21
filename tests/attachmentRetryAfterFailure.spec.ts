/**
 * 修复 3：附件下载失败不得标记 processed，下一次同步必须能重新入队。
 */

import { TFile } from 'obsidian'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import {
  downloadAttachment,
  isRemoteAttachment,
} from '../src/attachmentLocalizer/attachmentDownloader'

jest.mock('../src/attachmentLocalizer/attachmentDownloader')
jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('attachments'),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
}))

const mockDownload = downloadAttachment as jest.MockedFunction<typeof downloadAttachment>
const mockIsRemote = isRemoteAttachment as jest.MockedFunction<typeof isRemoteAttachment>

describe('修复 3：附件失败后可重试', () => {
  test('第一次失败保留远程链接且不标 processed，第二次成功改写', async () => {
    const file = new TFile()
    file.path = 'notes/a.md'
    file.basename = 'a'
    let body = '📎 [x.pdf](http://127.0.0.1/x.pdf)'
    const vault = {
      read: jest.fn(async () => body),
      process: jest.fn(async (_file: TFile, fn: (content: string) => string) => {
        body = fn(body)
        return body
      }),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      createFolder: jest.fn().mockResolvedValue(undefined),
      createBinary: jest.fn().mockResolvedValue(undefined),
    }
    const localizer = new AttachmentLocalizer(
      { vault } as any,
      {
        attachmentFolder: 'attachments',
        folderDateFormat: 'yyyy-MM-dd',
        maxRetries: 0,
        retryDelay: 0,
      },
    )
    mockIsRemote.mockReturnValue(true)
    mockDownload
      .mockResolvedValueOnce({ success: false, error: 'HTTP 500' })
      .mockResolvedValueOnce({ success: true, data: new ArrayBuffer(4) })

    expect(await localizer.enqueueFile(file)).toBe('enqueued')
    const first = await localizer.processQueue()
    expect(first.failedFiles).toEqual(['notes/a.md'])
    expect(localizer.getQueueStats().processed).toBe(0)
    expect(localizer.getQueueStats().pending).toBe(1)
    expect(body).toContain('http://127.0.0.1/x.pdf')

    // 下一次同步无需重新抓到该文章：失败任务仍在同一 localizer 队列中。
    const second = await localizer.processQueue()
    expect(second).toMatchObject({ total: 1, succeeded: 1, failed: 0 })
    expect(localizer.getQueueStats().processed).toBe(1)
    expect(body).toContain('📎 [[attachments/x.pdf|x.pdf]]')
    expect(body).not.toContain('http://127.0.0.1/x.pdf')
  })
})
