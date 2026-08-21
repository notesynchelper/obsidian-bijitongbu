/**
 * 修复 1：processQueue 必须返回真实结果，失败 Notice 不得含“完成”。
 */

import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { formatRelocalizeNotice } from '../src/common/relocalizeNotice'

jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('attachments'),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
}))

function file(path: string): TFile {
  const value = new TFile()
  value.path = path
  value.basename = path.replace(/\.md$/, '')
  return value
}

describe('修复 1：右键结果如实透传', () => {
  test('processQueue 汇总成功/失败文件，失败文案不含“完成”且说明自动重试', async () => {
    const localizer = new ImageLocalizer(
      { vault: {} } as any,
      {
        enablePngToJpeg: false,
        jpegQuality: 85,
        attachmentFolder: 'attachments',
        folderDateFormat: 'yyyy-MM-dd',
        maxRetries: 0,
        retryDelay: 0,
      },
    )
    const okFile = file('ok.md')
    const badFile = file('bad.md')
    const queue = (localizer as any).queue
    queue.enqueue({ file: okFile, images: [], createdAt: 1, retryCount: 0 })
    queue.enqueue({ file: badFile, images: [], createdAt: 2, retryCount: 0 })
    jest
      .spyOn(localizer, 'localizeFile')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const result = await localizer.processQueue()

    expect(result).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
      failedFiles: ['bad.md'],
    })
    const notice = formatRelocalizeNotice({
      basename: 'bad',
      imageModeEnabled: true,
      failed: result.failed,
    })
    expect(notice).not.toContain('完成')
    expect(notice).toContain('仍是远程链接')
    expect(notice).toContain('自动重试')
  })
})
