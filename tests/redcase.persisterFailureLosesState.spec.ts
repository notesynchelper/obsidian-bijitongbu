/**
 * 🔴 红测试：侧车 JSON 写盘失败一次 → 续传记录 / url→本地路径映射【永久静默丢失】
 *
 * 来源：codex 复检（2026-07-25）指出的 P0。机制：
 *   src/imageLocalizer/pendingQueueStore.ts:scheduleSave —— 防抖回调里先
 *   `this.dirty = false` 然后才 `void persister.save(...).catch(logError)`。
 *   一旦这次 save 被 reject（磁盘瞬时报错、配额、vault 正被同步工具锁、移动端存储抖动），
 *   状态就【没写进磁盘】而内存里的 dirty 已经被清掉：
 *     - 不会重试；
 *     - 之后 onunload 的 flush() 因为 `!this.dirty` 直接 return，也不会补写；
 *   → 下次启动 load() 读到的是旧内容（或空），**这条续传任务/映射就永远消失了**。
 *   用户观感：图片再也不会本地化，且插件一声不响。
 *   UrlLocalMap 的 scheduleSave 是同款写法（urlLocalMap.ts），同样受影响。
 *
 * 铁律对照：项目自己立的规矩是「图床未就绪属瞬态，绝不能丢任务」
 *   （imageLocalizer.ts drainQueue 注释）。写盘失败同样是瞬态，更不该丢。
 *
 * 修复方向：save 失败要保持/恢复 dirty（并重排一次防抖或指数退避重试），
 *   flush 要能把「上次失败的内容」补写出去。
 */

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { PendingLocalizeStore } from '../src/imageLocalizer/pendingQueueStore'
import { UrlLocalMap } from '../src/imageLocalizer/urlLocalMap'

/** 第一次 save 失败、之后恢复正常的持久化器（模拟磁盘瞬时错误）。 */
function makeFailOncePersister() {
  let saved: unknown = null
  let calls = 0
  return {
    calls: () => calls,
    saved: () => saved,
    load: async () => saved,
    save: async (data: unknown) => {
      calls++
      if (calls === 1) throw new Error('EIO: transient disk failure')
      saved = JSON.parse(JSON.stringify(data))
    },
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DEBOUNCE_WAIT = 800 // > SAVE_DEBOUNCE_MS(500)

describe('🔴 侧车 JSON 写盘瞬时失败不得丢状态', () => {
  it('PendingLocalizeStore：首次防抖保存失败后，flush 必须把记录补写出去', async () => {
    const p = makeFailOncePersister()
    const store = new PendingLocalizeStore(p)

    store.upsert({ filePath: 'Synced/a.md', retryCount: 1, createdAt: 1, lastAttemptAt: 2 })
    await tick(DEBOUNCE_WAIT)          // 防抖触发 → 第 1 次 save 失败
    expect(p.calls()).toBe(1)
    expect(p.saved()).toBeNull()       // 确实没写进去（前提自检）

    await store.flush()                // 关键：失败后的补救机会

    // 今天必红：flush 看到 dirty=false 直接 return → 磁盘上永远没有这条记录
    const snap = p.saved() as { tasks?: Array<{ filePath: string }> } | null
    expect(snap).not.toBeNull()
    expect((snap?.tasks || []).map((t) => t.filePath)).toContain('Synced/a.md')
  })

  it('PendingLocalizeStore：写盘失败后新实例 load 必须仍能看到这条待办', async () => {
    const p = makeFailOncePersister()
    const store = new PendingLocalizeStore(p)
    store.upsert({ filePath: 'Synced/b.md', retryCount: 2, createdAt: 1, lastAttemptAt: 3 })
    await tick(DEBOUNCE_WAIT)
    await store.flush()

    const reborn = new PendingLocalizeStore(p)
    await reborn.load()
    expect(reborn.list().map((r) => r.filePath)).toContain('Synced/b.md')
  })

  it('UrlLocalMap：同款写法，写盘失败后 flush 也必须补写', async () => {
    const p = makeFailOncePersister()
    const map = new UrlLocalMap(p)

    map.set('Synced/a.md', 'http://relay-1.bijitongbu.site/p/x.png', '附件/x.png')
    await tick(DEBOUNCE_WAIT)
    expect(p.calls()).toBe(1)
    expect(p.saved()).toBeNull()

    await map.flush()

    const reborn = new UrlLocalMap(p)
    await reborn.load()
    expect(reborn.get('Synced/a.md', 'http://relay-1.bijitongbu.site/p/x.png')).toBe('附件/x.png')
  })
})
