/**
 * 修复 4 的回归护栏：等待「别人的 drain」不能把自己入队的任务漏掉。
 *
 * 修复 4 让并发 processQueue 共享同一个 drain Promise（右键不再提前 resolve）。
 * 但 drainQueue 的 `while (!queue.isEmpty())` 只在每次迭代【开始前】查队列：
 * 存在一个窗口 —— 上一轮已经退出循环、属主还没来得及清空 drainPromise ——
 * 此时新入队的任务不会被那一轮处理。若 processQueue 无脑返回那一轮的结果，
 * 右键就会拿着一份【根本不包含自己文件】的成功结果弹「本地化完成」。
 *
 * 本用例白盒地复现这个窗口：drainPromise 指向一个【已结束】的 drain，同时队列里
 * 还压着一个任务 —— processQueue 必须自己再 drain 一轮，并把该文件的真实结果
 * （这里是失败）合并进返回值。
 */

import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'

jest.mock('../src/imageLocalizer/imageDownloader', () => ({
  downloadImage: jest.fn(),
  isRemoteImage: jest.fn().mockReturnValue(true),
  getFallbackUrls: jest.fn().mockReturnValue([]),
}))
jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('images'),
}))
jest.mock('../src/logger', () => ({ log: jest.fn(), logError: jest.fn() }))

function makeFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/\.md$/, '')
  return file
}

test('drain 刚结束但引用未清空时，新任务不会被漏掉也不会被误报成功', async () => {
  const body = '![a](http://127.0.0.1/a.png)'
  const vault = {
    read: jest.fn(async () => body),
    process: jest.fn(async (_f: TFile, fn: (c: string) => string) => fn(body)),
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
  }
  const localizer = new ImageLocalizer({ vault } as any, {
    attachmentFolder: 'images',
    folderDateFormat: 'yyyy-MM-dd',
    maxRetries: 0,
    retryDelay: 0,
    enablePngToJpeg: false,
    jpegQuality: 80,
  } as any)

  // 这个文件必然本地化失败（下载 mock 未 resolve 成功数据）
  const file = makeFile('late.md')
  jest.spyOn(localizer, 'localizeFile').mockResolvedValue(false)

  expect(await localizer.enqueueFile(file)).toBe('enqueued')

  // 白盒制造窗口：drainPromise 指向一个即将结束的上一轮 drain。属主的 finally
  // 会在它 settle 时清空引用（这里用 .then 还原真实时序），而我们的任务是在
  // 那一轮退出循环之后才入队的 —— 它不可能出现在那一轮的结果里。
  const internals = localizer as unknown as { drainPromise: Promise<unknown> | null }
  const stale = Promise.resolve({
    total: 3,
    succeeded: 3,
    failed: 0,
    failedFiles: [] as string[],
  }).then((r) => {
    internals.drainPromise = null
    return r
  })
  internals.drainPromise = stale

  const result = await localizer.processQueue()

  // 必须把自己那一轮真实结果合并进来，而不是直接吞下上一轮的全成功
  expect(result.failedFiles).toContain('late.md')
  expect(result.failed).toBe(1)
  expect(result.total).toBe(4)
})
