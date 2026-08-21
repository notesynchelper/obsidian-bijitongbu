/**
 * 图片本地化续传（重启恢复）测试
 *
 * 设计文档：docs/image-localization-resume-design.md
 *
 * 覆盖：
 * 1. PendingLocalizeStore 单元：load 容错 / upsert / remove / clear / 上限淘汰 / flush
 * 2. ImageLocalizer 写路径对称：enqueue→upsert、成功→remove、整文件失败→重试→放弃→remove、
 *    0 图→清 stale、重复入队刷新 store meta
 * 3. 单图断点：urlLocalMap 命中 + vault 中是 TFile → 跳过下载
 * 4. resumePending：文件存在→带 retryCount 入队处理；文件缺失→store 清理
 * 5. in-flight 去重：activePath 命中时不重复入队
 */

import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import {
  PendingLocalizeStore,
  PendingTaskRecord,
  MAX_PENDING_TASKS,
} from '../src/imageLocalizer/pendingQueueStore'
import { UrlLocalMap } from '../src/imageLocalizer/urlLocalMap'
import { TFile } from 'obsidian'
import {
  downloadImage,
  isRemoteImage,
} from '../src/imageLocalizer/imageDownloader'
import {
  calculateMD5,
  detectImageFormat,
  saveImageToVault,
} from '../src/imageLocalizer/imageProcessor'

jest.mock('../src/imageLocalizer/imageDownloader')
jest.mock('../src/imageLocalizer/imageProcessor')
jest.mock('../src/settings/template', () => ({
  render: jest.fn().mockReturnValue('test-folder'),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

const mockDownloadImage = downloadImage as jest.MockedFunction<typeof downloadImage>
const mockIsRemoteImage = isRemoteImage as jest.MockedFunction<typeof isRemoteImage>
const mockCalculateMD5 = calculateMD5 as jest.MockedFunction<typeof calculateMD5>
const mockDetectImageFormat = detectImageFormat as jest.MockedFunction<typeof detectImageFormat>
const mockSaveImageToVault = saveImageToVault as jest.MockedFunction<typeof saveImageToVault>

function createMockFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/\.md$/, '').split('/').pop() || ''
  return file
}

/** 内存 persister：保存最后一次 save 的快照，供断言 */
function createMemoryPersister(initial: unknown = null) {
  let stored: unknown = initial
  return {
    saves: [] as unknown[],
    load: jest.fn(async () => stored),
    save: jest.fn(async (data: unknown) => {
      stored = data
      return undefined
    }),
    get stored() {
      return stored
    },
  }
}

const defaultOptions = {
  enablePngToJpeg: false,
  jpegQuality: 85,
  attachmentFolder: 'images',
  folderDateFormat: 'yyyy-MM-dd',
  maxRetries: 2,
  retryDelay: 1,
}

function record(filePath: string, extra: Partial<PendingTaskRecord> = {}): PendingTaskRecord {
  return { filePath, retryCount: 0, createdAt: Date.now(), ...extra }
}

// ============================================================
// 1. PendingLocalizeStore 单元
// ============================================================
describe('PendingLocalizeStore', () => {
  test('load: persister 返回正常快照 → 记录恢复', async () => {
    const persister = createMemoryPersister({
      version: 1,
      tasks: [
        { filePath: 'a.md', retryCount: 1, createdAt: 100, meta: { savedAt: '2026-01-01' } },
        { filePath: 'b.md', retryCount: 0, createdAt: 200 },
      ],
    })
    const store = new PendingLocalizeStore(persister)
    await store.load()
    expect(store.list().map((r) => r.filePath)).toEqual(['a.md', 'b.md'])
    expect(store.get('a.md')?.retryCount).toBe(1)
    expect(store.get('a.md')?.meta?.savedAt).toBe('2026-01-01')
  })

  test('load: 损坏数据（数组/null/字段非法）→ 空表且不抛', async () => {
    for (const bad of [null, [], 'junk', { version: 1, tasks: 'nope' }, { version: 1, tasks: [{ retryCount: 0 }] }]) {
      const store = new PendingLocalizeStore(createMemoryPersister(bad))
      await expect(store.load()).resolves.toBeUndefined()
      expect(store.list()).toEqual([])
    }
  })

  test('load: persister.load 抛异常 → 空表且不抛', async () => {
    const persister = createMemoryPersister()
    persister.load.mockRejectedValue(new Error('disk error'))
    const store = new PendingLocalizeStore(persister)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.list()).toEqual([])
  })

  test('upsert/remove/clear + flush 落盘 round-trip', async () => {
    const persister = createMemoryPersister()
    const store = new PendingLocalizeStore(persister)
    store.upsert(record('a.md', { meta: { savedAt: 's1' } }))
    store.upsert(record('b.md'))
    store.remove('b.md')
    await store.flush()

    const saved = persister.stored as { version: number; tasks: PendingTaskRecord[] }
    expect(saved.version).toBe(1)
    expect(saved.tasks.map((t) => t.filePath)).toEqual(['a.md'])

    // 另一个 store 从同一 persister 恢复
    const store2 = new PendingLocalizeStore(persister)
    await store2.load()
    expect(store2.get('a.md')?.meta?.savedAt).toBe('s1')

    store2.clear()
    await store2.flush()
    expect((persister.stored as { tasks: unknown[] }).tasks).toEqual([])
  })

  test('upsert 同 filePath 覆盖而非追加', async () => {
    const store = new PendingLocalizeStore()
    store.upsert(record('a.md', { retryCount: 0 }))
    store.upsert(record('a.md', { retryCount: 2 }))
    expect(store.list()).toHaveLength(1)
    expect(store.get('a.md')?.retryCount).toBe(2)
  })

  test('超过 MAX_PENDING_TASKS 时淘汰最旧记录', () => {
    const store = new PendingLocalizeStore()
    for (let i = 0; i < MAX_PENDING_TASKS + 3; i++) {
      store.upsert(record(`f${i}.md`))
    }
    expect(store.list()).toHaveLength(MAX_PENDING_TASKS)
    expect(store.get('f0.md')).toBeUndefined()
    expect(store.get('f2.md')).toBeUndefined()
    expect(store.get('f3.md')).toBeDefined()
    expect(store.get(`f${MAX_PENDING_TASKS + 2}.md`)).toBeDefined()
  })

  test('防抖：连续 upsert 只触发一次 save', async () => {
    jest.useFakeTimers()
    try {
      const persister = createMemoryPersister()
      const store = new PendingLocalizeStore(persister)
      store.upsert(record('a.md'))
      store.upsert(record('b.md'))
      expect(persister.save).not.toHaveBeenCalled()
      jest.advanceTimersByTime(600)
      // setTimeout 回调里是异步 save，flush microtask
      await Promise.resolve()
      expect(persister.save).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

// ============================================================
// 2-5. ImageLocalizer 接入
// ============================================================
describe('ImageLocalizer 续传接入', () => {
  let mockVault: {
    read: jest.Mock
    modify: jest.Mock
    process: jest.Mock
    getAbstractFileByPath: jest.Mock
    createBinary: jest.Mock
    createFolder: jest.Mock
  }
  let mockApp: { vault: typeof mockVault }
  let store: PendingLocalizeStore
  let urlLocalMap: UrlLocalMap

  function makeLocalizer(options = defaultOptions) {
    return new ImageLocalizer(mockApp as never, options, urlLocalMap, store)
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockVault = {
      read: jest.fn(),
      modify: jest.fn(),
      process: jest.fn().mockImplementation(async (_file: unknown, fn: (data: string) => string) => {
        const content = await mockVault.read(_file)
        const result = fn(content)
        await mockVault.modify(_file, result)
        return result
      }),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      createBinary: jest.fn(),
      createFolder: jest.fn(),
    }
    mockApp = { vault: mockVault }
    store = new PendingLocalizeStore()
    urlLocalMap = new UrlLocalMap()
    mockIsRemoteImage.mockImplementation(
      (url: string) => url.startsWith('http://') || url.startsWith('https://'),
    )
  })

  test('enqueueFile 入队 → store 出现记录（含 meta）', async () => {
    const localizer = makeLocalizer()
    const file = createMockFile('Synced/a.md')
    mockVault.read.mockResolvedValue('![x](https://e.com/1.jpg)')

    await localizer.enqueueFile(file, { savedAt: '2026-06-01', siteName: 'qa' })

    const rec = store.get('Synced/a.md')
    expect(rec).toBeDefined()
    expect(rec?.retryCount).toBe(0)
    expect(rec?.meta?.siteName).toBe('qa')
  })

  test('processQueue 成功 → store 记录移除', async () => {
    const localizer = makeLocalizer()
    const file = createMockFile('Synced/a.md')
    mockVault.read.mockResolvedValue('![x](https://e.com/1.jpg)')
    mockDownloadImage.mockResolvedValue({ success: true, data: new ArrayBuffer(8) })
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockReturnValue('h1_MD5')
    mockSaveImageToVault.mockResolvedValue('test-folder/h1_MD5.jpg')

    await localizer.enqueueFile(file)
    expect(store.get('Synced/a.md')).toBeDefined()
    await localizer.processQueue()
    expect(store.get('Synced/a.md')).toBeUndefined()
    expect(localizer.getQueueStats().processedCount).toBe(1)
  })

  test('整文件失败（vault.process 抛异常）→ 保留续传记录待后续重试，不标记 processed，会话内不狂刷', async () => {
    const localizer = makeLocalizer()
    const file = createMockFile('Synced/a.md')
    mockVault.read.mockResolvedValue('![x](https://e.com/1.jpg)')
    mockDownloadImage.mockResolvedValue({ success: true, data: new ArrayBuffer(8) })
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockReturnValue('h1_MD5')
    mockSaveImageToVault.mockResolvedValue('test-folder/h1_MD5.jpg')
    // 链接改写阶段持续失败（整文件级失败）
    mockVault.process.mockRejectedValue(new Error('write failed'))

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    // 修复后：失败【不再丢弃】——保留续传记录，交给后续同步 / 重启再试（写失败多为瞬态）。
    const rec = store.get('Synced/a.md')
    expect(rec).toBeDefined()
    expect(rec?.retryCount).toBe(1) // 跨会话诊断计数累加
    expect(localizer.getQueueStats().processedCount).toBe(0) // 失败不算 processed
    expect(localizer.getQueueStats().queueSize).toBe(0)
    // 会话内不再立即重排狂刷（退避重试在下载层，文件层只跑一次）
    expect(mockVault.process).toHaveBeenCalledTimes(1)
  })

  test('enqueueFile 检出 0 张远程图 → 清掉 store 中的 stale 记录', async () => {
    const localizer = makeLocalizer()
    const file = createMockFile('Synced/a.md')
    // 上个会话残留的记录
    store.upsert(record('Synced/a.md'))
    // 内容已不含远程图
    mockVault.read.mockResolvedValue('![[images/done.jpg]]')

    await localizer.enqueueFile(file)

    expect(store.get('Synced/a.md')).toBeUndefined()
    expect(localizer.getQueueStats().queueSize).toBe(0)
  })

  test('重复入队刷新 meta → store 同步更新（内存/磁盘一致）', async () => {
    const localizer = makeLocalizer()
    const file = createMockFile('Synced/a.md')
    mockVault.read.mockResolvedValue('![x](https://e.com/1.jpg)')

    await localizer.enqueueFile(file, { savedAt: 'v1' })
    await localizer.enqueueFile(file, { savedAt: 'v2', siteName: 'new' })

    expect(localizer.getQueueStats().queueSize).toBe(1)
    expect(store.get('Synced/a.md')?.meta?.savedAt).toBe('v2')
    expect(store.get('Synced/a.md')?.meta?.siteName).toBe('new')
  })

  test('单图断点：urlLocalMap 命中且 vault 中是 TFile → 不再下载', async () => {
    const localizer = makeLocalizer()
    const file = createMockFile('Synced/a.md')
    const content = '![x](https://e.com/1.jpg)\n![y](https://e.com/2.jpg)'
    mockVault.read.mockResolvedValue(content)

    // 上个会话已经下载过 1.jpg
    urlLocalMap.set('Synced/a.md', 'https://e.com/1.jpg', 'test-folder/h1_MD5.jpg')
    const localImg = createMockFile('test-folder/h1_MD5.jpg')
    mockVault.getAbstractFileByPath.mockImplementation((p: string) =>
      p === 'test-folder/h1_MD5.jpg' ? localImg : null,
    )

    // 2.jpg 正常下载
    mockDownloadImage.mockResolvedValue({ success: true, data: new ArrayBuffer(8) })
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockReturnValue('h2_MD5')
    mockSaveImageToVault.mockResolvedValue('test-folder/h2_MD5.jpg')

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    // 只有 2.jpg 走了下载
    expect(mockDownloadImage).toHaveBeenCalledTimes(1)
    expect(mockDownloadImage).toHaveBeenCalledWith('https://e.com/2.jpg', expect.anything(), expect.anything())
    // 两张图都被改写
    const modified = mockVault.modify.mock.calls[0][1] as string
    expect(modified).toContain('![[test-folder/h1_MD5.jpg|x]]')
    expect(modified).toContain('![[test-folder/h2_MD5.jpg|y]]')
  })

  test('单图断点：urlLocalMap 命中但 vault 文件不是 TFile（文件夹/缺失）→ 照常下载', async () => {
    const localizer = makeLocalizer()
    const file = createMockFile('Synced/a.md')
    mockVault.read.mockResolvedValue('![x](https://e.com/1.jpg)')

    urlLocalMap.set('Synced/a.md', 'https://e.com/1.jpg', 'test-folder/h1_MD5.jpg')
    // getAbstractFileByPath 返回非 TFile 对象（如 TFolder）
    mockVault.getAbstractFileByPath.mockReturnValue({ path: 'test-folder/h1_MD5.jpg' })

    mockDownloadImage.mockResolvedValue({ success: true, data: new ArrayBuffer(8) })
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockReturnValue('h1_MD5')
    mockSaveImageToVault.mockResolvedValue('test-folder/h1_MD5.jpg')

    await localizer.enqueueFile(file)
    await localizer.processQueue()

    expect(mockDownloadImage).toHaveBeenCalledTimes(1)
  })

  test('resumePending：文件存在 → 重新入队并处理完成；文件缺失 → store 清理', async () => {
    const localizer = makeLocalizer()
    const fileA = createMockFile('Synced/a.md')
    store.upsert(record('Synced/a.md', { meta: { savedAt: 'sa' } }))
    store.upsert(record('Synced/gone.md'))

    mockVault.read.mockResolvedValue('![x](https://e.com/1.jpg)')
    mockDownloadImage.mockResolvedValue({ success: true, data: new ArrayBuffer(8) })
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockReturnValue('h1_MD5')
    mockSaveImageToVault.mockResolvedValue('test-folder/h1_MD5.jpg')

    const resumed = await localizer.resumePending((p) =>
      p === 'Synced/a.md' ? fileA : null,
    )

    expect(resumed).toBe(1)
    expect(store.get('Synced/gone.md')).toBeUndefined() // 文件已删 → 放弃
    expect(store.get('Synced/a.md')).toBeUndefined() // 处理成功 → 移除
    expect(mockVault.modify).toHaveBeenCalledTimes(1)
    expect(localizer.getQueueStats().processedCount).toBe(1)
  })

  test('resumePending：持久化的 retryCount 不重置、跨会话累加；失败仍保留记录待再试', async () => {
    const localizer = makeLocalizer()
    const file = createMockFile('Synced/a.md')
    // 上个会话已累加的重试计数
    store.upsert(record('Synced/a.md', { retryCount: defaultOptions.maxRetries }))

    mockVault.read.mockResolvedValue('![x](https://e.com/1.jpg)')
    mockDownloadImage.mockResolvedValue({ success: true, data: new ArrayBuffer(8) })
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockReturnValue('h1_MD5')
    mockSaveImageToVault.mockResolvedValue('test-folder/h1_MD5.jpg')
    mockVault.process.mockRejectedValue(new Error('still failing'))

    await localizer.resumePending((p) => (p === 'Synced/a.md' ? file : null))

    // 会话内只跑 1 次（不在文件层狂刷）；失败仍保留记录（不再丢弃），retryCount 继续累加。
    expect(mockVault.process).toHaveBeenCalledTimes(1)
    const rec = store.get('Synced/a.md')
    expect(rec).toBeDefined()
    expect(rec?.retryCount).toBe(defaultOptions.maxRetries + 1)
    expect(localizer.getQueueStats().queueSize).toBe(0)
  })

  test('resumePending：store 为空 → 直接返回 0，不触碰队列', async () => {
    const localizer = makeLocalizer()
    const resumed = await localizer.resumePending(() => null)
    expect(resumed).toBe(0)
  })

  test('in-flight 去重：正在处理中的文件再次 enqueue 不入队', async () => {
    const localizer = makeLocalizer()
    const file = createMockFile('Synced/a.md')
    mockVault.read.mockResolvedValue('![x](https://e.com/1.jpg)')
    mockDetectImageFormat.mockReturnValue('jpg')
    mockCalculateMD5.mockReturnValue('h1_MD5')
    mockSaveImageToVault.mockResolvedValue('test-folder/h1_MD5.jpg')

    // 下载挂起时（处理中窗口）从另一条路径 enqueue 同一文件
    let resolveDownload: (v: { success: boolean; data?: ArrayBuffer }) => void = () => undefined
    mockDownloadImage.mockImplementation(
      () => new Promise((resolve) => { resolveDownload = resolve }),
    )

    await localizer.enqueueFile(file)
    const processing = localizer.processQueue()
    // 等下载真正挂起（task 已 dequeue，处于 in-flight 窗口）
    await new Promise((r) => setTimeout(r, 10))
    await localizer.enqueueFile(file) // 现状缺陷：会重复入队 → 顺序重复本地化
    expect(localizer.getQueueStats().queueSize).toBe(0) // in-flight 去重生效

    resolveDownload({ success: true, data: new ArrayBuffer(8) })
    await processing
    expect(localizer.getQueueStats().processedCount).toBe(1)
    // 整轮只本地化一次
    expect(mockVault.process).toHaveBeenCalledTimes(1)
  })
})
