/**
 * 修复 3 的回归护栏：附件「真过期（NoSuchKey）」是终态，不是可重试失败。
 *
 * 背景：修复 3 把「下载失败」从"无条件 markAsProcessed"改成"失败则放回队列等下次
 * 同步重试"，这对瞬态失败（500 / 网络抖动）是对的；但 `downloadAttachment` 的
 * `expired: true`（服务端 NoSuchKey，源站已删）是**永久**失败，再试多少次都不会回来。
 * 若把它也当可重试失败：
 *   1) 每次同步都会重新去下这个必然失败的附件（无意义地打服务器）；
 *   2) 每轮都会把 `⚠️已过期` 标记再追加一次，正文变成
 *      `📎 [x.pdf](url) ⚠️已过期 ⚠️已过期 ⚠️已过期 …` —— 用户可见的正文污染。
 * 实测（修复后未加本护栏时）3 轮 drain 就累积 3 个标记、发起 3 次下载。
 *
 * 本用例钉死两条不变式：
 *   A. 过期附件只下载一次、任务进入 processed，不再无限重排；
 *   B. 任何路径下 `⚠️已过期` 标记都只出现一次（正文替换必须幂等）。
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
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))

const mockDownload = downloadAttachment as jest.MockedFunction<typeof downloadAttachment>
const mockIsRemote = isRemoteAttachment as jest.MockedFunction<typeof isRemoteAttachment>

/** 建一个只有内存正文的 vault stub，process 走真实的读-改-写语义。 */
function makeLocalizer(initialBody: string) {
  const file = new TFile()
  file.path = 'notes/a.md'
  file.basename = 'a'
  const state = { body: initialBody }
  const vault = {
    read: jest.fn(async () => state.body),
    process: jest.fn(async (_f: TFile, fn: (content: string) => string) => {
      state.body = fn(state.body)
      return state.body
    }),
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
    createFolder: jest.fn().mockResolvedValue(undefined),
    createBinary: jest.fn().mockResolvedValue(undefined),
  }
  const localizer = new AttachmentLocalizer({ vault } as any, {
    attachmentFolder: 'attachments',
    folderDateFormat: 'yyyy-MM-dd',
    maxRetries: 0,
    retryDelay: 0,
  })
  return { localizer, file, state }
}

const markerCount = (body: string) => (body.match(/⚠️已过期/g) || []).length

describe('附件真过期是终态', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsRemote.mockReturnValue(true)
  })

  test('过期附件只下一次、标记只写一次、不再无限重排', async () => {
    const { localizer, file, state } = makeLocalizer(
      '📎 [x.pdf](http://127.0.0.1/x.pdf)',
    )
    mockDownload.mockResolvedValue({
      success: false,
      error: '文件已过期，无法下载',
      expired: true,
    })

    expect(await localizer.enqueueFile(file)).toBe('enqueued')
    await localizer.processQueue()

    expect(state.body).toBe('📎 [x.pdf](http://127.0.0.1/x.pdf) ⚠️已过期')
    // 终态：不留在队列里等下次同步重试
    expect(localizer.getQueueStats().pending).toBe(0)
    expect(localizer.getQueueStats().processed).toBe(1)

    // 后续同步再 drain 也不该重下 / 重标
    await localizer.processQueue()
    await localizer.processQueue()
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(markerCount(state.body)).toBe(1)
  })

  test('同文件里过期 + 瞬态失败并存时，重试不会让过期标记累积', async () => {
    const { localizer, file, state } = makeLocalizer(
      [
        '📎 [gone.pdf](http://127.0.0.1/gone.pdf)',
        '',
        '📎 [flaky.pdf](http://127.0.0.1/flaky.pdf)',
      ].join('\n'),
    )
    mockDownload.mockImplementation(async (url: string) => {
      if (url.includes('gone.pdf')) {
        return { success: false, error: '文件已过期，无法下载', expired: true }
      }
      // flaky：第一轮 500，第二轮成功
      return mockDownload.mock.calls.filter((c) => String(c[0]).includes('flaky')).length > 1
        ? { success: true, data: new ArrayBuffer(4) }
        : { success: false, error: 'HTTP 500' }
    })

    await localizer.enqueueFile(file)
    await localizer.processQueue()
    // 瞬态失败的那个把整篇留在队列里等重试（这是修复 3 的正确行为）
    expect(localizer.getQueueStats().pending).toBe(1)
    expect(markerCount(state.body)).toBe(1)

    await localizer.processQueue()
    // 重试轮不能把过期标记再追加一次
    expect(markerCount(state.body)).toBe(1)
    expect(state.body).toContain('📎 [[attachments/flaky.pdf|flaky.pdf]]')
  })
})
