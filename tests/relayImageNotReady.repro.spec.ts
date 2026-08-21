/**
 * REPRO（钉红）: relay-1 图床链接在「CF 源站尚未就绪」时的本地化行为
 *
 * 场景：笔记里有一条 `https://relay-1.bijitongbu.site/p/<hash>` 图片链接，但此刻
 * CF 源站（R2）还没缓存这张图。relay 此时可能：
 *   (A) 返回 HTTP 200 但 body 不是真图片（nginx warming 占位 / HTML 错误页 / 0 字节）
 *   (B) 返回 4xx/网络错误
 *
 * 本文件用【真实】downloadImage + imageProcessor + ImageLocalizer 全链路跑一遍，
 * 只 mock obsidian.requestUrl，断言两条铁律：
 *   Defect A: 没拿到真图片就【绝不】把 markdown 里的远程链接改成本地 wiki 链接
 *             （否则会出现「本地没有真图 + 原图床链接也丢了」的不可逆坏态）。
 *   Defect B: 下载失败后，任务必须留在续传清单（pendingStore）里，后续同步再重试，
 *             而不是被当成「成功」丢弃、永不重试。
 *
 * 修复前预期：两条断言都 fail（钉红）。修复后应转绿。
 */

import * as obsidian from 'obsidian'
import { TFile } from 'obsidian'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { isLikelyImageResponse } from '../src/imageLocalizer/imageDownloader'
import { UrlLocalMap } from '../src/imageLocalizer/urlLocalMap'
import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
import { ImageProcessOptions } from '../src/imageLocalizer/types'

jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('笔记同步助手/images'),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

const RELAY_URL = 'https://relay-1.bijitongbu.site/p/deadbeefdeadbeefdeadbeefdeadbeef'

/** 真 1x1 PNG（67 字节，标准），源站「就绪」后返回它 */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])
function pngResponse() {
  return {
    status: 200,
    headers: { 'content-type': 'image/png' },
    arrayBuffer: PNG_1x1.buffer.slice(0),
    text: '',
  } as unknown as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never
}

const OPTIONS: ImageProcessOptions = {
  enablePngToJpeg: false,
  jpegQuality: 85,
  attachmentFolder: '笔记同步助手/images',
  folderDateFormat: 'yyyy-MM-dd',
  maxRetries: 1, // 保持测试快（真实退避 sleep 会乘以 retryDelay）
  retryDelay: 1,
}

function makeFile(path: string): TFile {
  const f = new TFile()
  f.path = path
  f.basename = path.replace(/\.md$/, '').split('/').pop() || ''
  return f
}

/** 建一个能记录 createBinary 的最小 vault，并把 content 存在内存里供 process 读写 */
function makeVault(initialContent: string) {
  const store = { content: initialContent }
  const created: string[] = []
  const folders = new Set<string>()
  const binaries = new Map<string, ArrayBuffer>()
  const vault = {
    read: jest.fn(async () => store.content),
    modify: jest.fn(async (_f: TFile, data: string) => {
      store.content = data
    }),
    process: jest.fn(async (f: TFile, fn: (c: string) => string) => {
      const result = fn(store.content)
      store.content = result
      return result
    }),
    getAbstractFileByPath: jest.fn((p: string) => {
      if (folders.has(p)) {
        const folder = new obsidian.TFolder()
        folder.path = p
        return folder
      }
      if (binaries.has(p)) {
        const tf = new TFile()
        tf.path = p
        return tf
      }
      return null
    }),
    createFolder: jest.fn(async (p: string) => {
      folders.add(p)
    }),
    createBinary: jest.fn(async (p: string, data: ArrayBuffer) => {
      binaries.set(p, data)
      created.push(p)
    }),
  }
  return { vault, store, created, binaries }
}

describe('下载响应体图片校验 isLikelyImageResponse（codex 加固）', () => {
  const buf = (bytes: number[]) => new Uint8Array(bytes).buffer
  const textBuf = (s: string) => new TextEncoder().encode(s).buffer
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]

  test('空 body → 非图片（即使 content-type 声称 image/png）', () => {
    expect(isLikelyImageResponse(new ArrayBuffer(0), 'image/png')).toBe(false)
    expect(isLikelyImageResponse(undefined, 'image/png')).toBe(false)
  })

  test('真图片魔数（PNG）→ 是图片（无 content-type 也认）', () => {
    expect(isLikelyImageResponse(buf(PNG_MAGIC), '')).toBe(true)
  })

  test('codex#1：HTML body 但 content-type 谎称 image/png → 非图片', () => {
    expect(
      isLikelyImageResponse(textBuf('<!DOCTYPE html><html><body>oops</body></html>'), 'image/png'),
    ).toBe(false)
  })

  test('codex#2：带内联 <svg> 图标的 HTML 错误页 → 非图片（SVG 判定收紧为根级）', () => {
    expect(
      isLikelyImageResponse(
        textBuf('<!doctype html><html><body><svg viewBox="0 0 1 1"></svg> not found</body></html>'),
        '',
      ),
    ).toBe(false)
  })

  test('codex#3：text/plain 占位页 → 非图片', () => {
    expect(isLikelyImageResponse(textBuf('backend warming up, retry later'), 'text/plain')).toBe(false)
    expect(isLikelyImageResponse(textBuf('{"error":"not_ready"}'), 'application/json')).toBe(false)
    expect(isLikelyImageResponse(textBuf('[{"x":1}]'), '')).toBe(false) // JSON array
  })

  test('codex#4：大小写不敏感的 content-type（IMAGE/SVG+XML）→ 信任为图片', () => {
    // 未知二进制（无魔数）+ 大写 image/* content-type → 放行（覆盖 exotic 格式）
    expect(isLikelyImageResponse(buf([0x00, 0x11, 0x22, 0x33, 0x44]), 'IMAGE/SVG+XML')).toBe(true)
  })

  test('真 SVG（根级 <svg> / <?xml…<svg>）→ 是图片', () => {
    expect(isLikelyImageResponse(textBuf('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), '')).toBe(true)
    expect(
      isLikelyImageResponse(textBuf('<?xml version="1.0"?>\n<svg xmlns="..."><rect/></svg>'), ''),
    ).toBe(true)
  })

  test('非空未知二进制、无 content-type → 放行（不误杀 exotic 图片）', () => {
    // BMP 魔数
    expect(isLikelyImageResponse(buf([0x42, 0x4d, 0x00, 0x01]), '')).toBe(true)
    // 完全未知的非文本二进制
    expect(isLikelyImageResponse(buf([0x12, 0x34, 0x56, 0x78, 0x9a]), '')).toBe(true)
  })
})

describe('relay-1 图床未就绪时的本地化（钉红）', () => {
  afterEach(() => jest.restoreAllMocks())

  test('Defect A：relay 返回 200 但 body 非图片 → 绝不能把链接改成本地', async () => {
    // relay warming 占位：200 + text/html，body 是一段错误页 HTML（非真图片）
    const htmlBytes = new TextEncoder().encode(
      '<!DOCTYPE html><html><body>backend warming up</body></html>',
    ).buffer
    jest.spyOn(obsidian, 'requestUrl').mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      arrayBuffer: htmlBytes,
      text: 'backend warming up',
    } as unknown as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never)

    const content = `# note\n\n![封面](${RELAY_URL})\n\ntail.\n`
    const { vault, store, binaries } = makeVault(content)
    const localizer = new ImageLocalizer(
      { vault } as unknown as import('obsidian').App,
      OPTIONS,
      new UrlLocalMap(),
      new PendingLocalizeStore(),
    )
    const file = makeFile('Synced/note.md')

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    // 铁律 A：没有真图片落盘时，原始 relay 链接必须原样保留在正文里
    expect(store.content).toContain(RELAY_URL)
    // 且不应写入把 HTML 错误页当图片保存的坏文件
    expect(binaries.size).toBe(0)
  })

  test('Defect B：relay + 所有备用线路 404 → 任务必须留在续传清单待后续重试', async () => {
    // 全部线路 404（CF 源站还没这张图）；obsidian.requestUrl 对非 2xx 抛错
    jest.spyOn(obsidian, 'requestUrl').mockRejectedValue(
      new Error('Request failed, status 404'),
    )

    const content = `# note\n\n![封面](${RELAY_URL})\n\ntail.\n`
    const { vault, store } = makeVault(content)
    const pending = new PendingLocalizeStore()
    const localizer = new ImageLocalizer(
      { vault } as unknown as import('obsidian').App,
      OPTIONS,
      new UrlLocalMap(),
      pending,
    )
    const file = makeFile('Synced/note.md')

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    // 链接没被替换（这一点当前代码就对）
    expect(store.content).toContain(RELAY_URL)
    // 铁律 B：下载失败的图片任务必须留在续传清单里，供后续同步/重启重试。
    expect(pending.get('Synced/note.md')).toBeDefined()
  })
})

describe('修复后：重试（指数退避）+ 续传 + 最终本地化（策略验证）', () => {
  afterEach(() => jest.restoreAllMocks())

  test('主线路失败 → 退避重试 maxRetries+1 次（退避真的发生、且总耗时符合退避阶梯）', async () => {
    // 用无备用线路的普通域名隔离「主线路重试」计数，避免 relay fallback 干扰。
    const url = 'https://example.com/x.jpg'
    const calls: number[] = []
    let prev = 0
    jest.spyOn(obsidian, 'requestUrl').mockImplementation(((): Promise<never> => {
      const now = Date.now()
      calls.push(prev ? now - prev : 0)
      prev = now
      return Promise.reject(new Error('boom'))
    }) as unknown as typeof obsidian.requestUrl)

    const { downloadImage, IMAGE_RETRY_DELAY_CAP_MS } = await import(
      '../src/imageLocalizer/imageDownloader'
    )
    const maxRetries = 5
    // 基础退避取 20ms（原来是 2ms）：2ms 级别的间隔在 CPU 被 jest 并行占满时抖动
    // 就能超过间隔本身，导致「相邻间隔单调不减」这种逐对比较随机翻红（本用例
    // 2026-07-25 就这么飘过：单跑绿、全量并行跑红）。改成断言「总耗时 ≥ 退避阶梯之和
    // 的 70%」+「逐对比较留够容差」，既保住原意（退避确实发生且递增），又不吃调度抖动。
    const base = 20
    const startedAt = Date.now()
    const res = await downloadImage(url, maxRetries, base)
    const elapsed = Date.now() - startedAt

    expect(res.success).toBe(false)
    // 全线路共享的机会数 = maxRetries+1（此 URL 无备用线路，全部落在主线路）
    expect(obsidian.requestUrl).toHaveBeenCalledTimes(maxRetries + 1)

    // 退避阶梯（含封顶）之和：base*2^0 … base*2^(maxRetries-1)，每项不超过封顶
    const expectedSum = Array.from({ length: maxRetries }, (_, i) =>
      Math.min(IMAGE_RETRY_DELAY_CAP_MS, base * 2 ** i),
    ).reduce((a, b) => a + b, 0)
    expect(elapsed).toBeGreaterThanOrEqual(Math.floor(expectedSum * 0.7))

    // 递增性：留 15ms 容差，只抓「退避被改成恒定/递减」这类真回归
    const gaps = calls.slice(1)
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] - 15)
    }
  })

  test('relay 未就绪 → 首同步留 pending；源站就绪后再同步 → 真图落盘 + 改写链接 + 清 pending', async () => {
    const content = `# note\n\n![封面](${RELAY_URL})\n\ntail.\n`
    const { vault, store, binaries } = makeVault(content)
    const pending = new PendingLocalizeStore()
    const localizer = new ImageLocalizer(
      { vault } as unknown as import('obsidian').App,
      { ...OPTIONS, maxRetries: 5 },
      new UrlLocalMap(),
      pending,
    )
    const file = makeFile('Synced/note.md')
    const resolve = (p: string) => (p === 'Synced/note.md' ? file : null)

    // 第一次同步：源站未就绪（所有线路 404）
    const spy = jest
      .spyOn(obsidian, 'requestUrl')
      .mockRejectedValue(new Error('Request failed, status 404'))
    await localizer.enqueueFile(file)
    await localizer.processQueue()

    expect(store.content).toContain(RELAY_URL) // 未替换
    expect(binaries.size).toBe(0) // 无坏文件
    expect(pending.get('Synced/note.md')).toBeDefined() // 留 pending

    // 源站就绪：翻转为返回真 PNG。模拟「后续再同步」——重挂 pending + 再处理。
    spy.mockResolvedValue(pngResponse())
    const requeued = await localizer.enqueuePendingRecords(resolve)
    expect(requeued).toBe(1)
    await localizer.processQueue()

    // 真图落盘（有二进制写入）
    expect(binaries.size).toBeGreaterThanOrEqual(1)
    // 落盘的是真 PNG 字节（首 8 字节为 PNG 魔数）
    const savedBytes = new Uint8Array([...binaries.values()][0])
    expect(Array.from(savedBytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    // 链接已改写为本地 wiki 链接，远程 URL 不再残留
    expect(store.content).not.toContain(RELAY_URL)
    expect(store.content).toMatch(/!\[\[[^\]]+\.png[^\]]*\]\]/)
    // pending 记录已清除
    expect(pending.get('Synced/note.md')).toBeUndefined()
  })

  test('续传重挂冷却：距上次失败太近的任务本轮跳过，冷却=0 或过期后才重挂', async () => {
    const content = `# note\n\n![封面](${RELAY_URL})\n\ntail.\n`
    const { vault } = makeVault(content)
    const pending = new PendingLocalizeStore()
    const localizer = new ImageLocalizer(
      { vault } as unknown as import('obsidian').App,
      OPTIONS,
      new UrlLocalMap(),
      pending,
    )
    const file = makeFile('Synced/note.md')
    const resolve = (p: string) => (p === 'Synced/note.md' ? file : null)

    // 模拟一条「刚刚失败过」的续传记录
    pending.upsert({
      filePath: 'Synced/note.md',
      retryCount: 1,
      createdAt: Date.now(),
      lastAttemptAt: Date.now(),
    })

    // 冷却窗口内（大 cooldown）→ 跳过，不重挂
    const skipped = await localizer.enqueuePendingRecords(resolve, 5 * 60 * 1000)
    expect(skipped).toBe(0)
    expect(localizer.getQueueStats().queueSize).toBe(0)

    // 冷却=0（如重启 resumePending）→ 立即重挂
    const requeued = await localizer.enqueuePendingRecords(resolve, 0)
    expect(requeued).toBe(1)
    expect(localizer.getQueueStats().queueSize).toBe(1)
  })
})
