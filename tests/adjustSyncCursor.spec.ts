/**
 * Test: adjustSyncCursor logic and initialSyncCompleted flag
 *
 * Covers:
 * - Read side: adjustSyncCursor decides whether to move syncAt back by 1 day
 * - Write side: initialSyncCompleted is set correctly after sync completes
 */
import { adjustSyncCursor, advanceSyncCursor, shouldMarkInitialSyncCompleted } from '../src/syncCursorAdjust'

describe('adjustSyncCursor', () => {
  it('returns empty string when syncAt is empty', () => {
    expect(adjustSyncCursor('', '笔记同步助手', false)).toBe('')
  })

  it('moves syncAt back 1 day when initialSyncCompleted is false', () => {
    expect(
      adjustSyncCursor("2026-03-09T10:00:00", '笔记同步助手', false)
    ).toBe("2026-03-08T10:00:00")
  })

  it('does NOT adjust syncAt when initialSyncCompleted is true', () => {
    expect(
      adjustSyncCursor("2026-03-09T10:00:00", '笔记同步助手', true)
    ).toBe("2026-03-09T10:00:00")
  })

  it('extracts baseFolder before {{{ template variable', () => {
    expect(
      adjustSyncCursor("2026-03-09T10:00:00", '笔记同步助手/{{{date}}}', false)
    ).toBe("2026-03-08T10:00:00")
  })

  it('does NOT adjust when folder is empty string', () => {
    expect(
      adjustSyncCursor("2026-03-09T10:00:00", '', false)
    ).toBe("2026-03-09T10:00:00")
  })

  it('strips trailing slashes from folder before checking', () => {
    expect(
      adjustSyncCursor("2026-03-09T10:00:00", 'myFolder/', false)
    ).toBe("2026-03-08T10:00:00")
  })
})

describe('advanceSyncCursor', () => {
  // Bug: cursor 落到秒精度后，服务器 `updated:<ts>` 不论 >= 还是严格 >，都会
  // 把 max(updatedAt) 那篇再次返回（毫秒被截断，floor < actual）。
  // 修复：输出毫秒级 ISO，并 +1ms —— 下一轮起点严格大于 maxUpdatedAt，
  // 同时不会漏掉同秒不同 ms 的并发新文章（不像 +1s 会跨越整秒）。
  const { parseDateTime } = require('../src/util')
  const { DateTime } = require('luxon')

  it('returns null when input is empty', () => {
    expect(advanceSyncCursor('')).toBeNull()
  })

  it('returns null when input is unparseable', () => {
    expect(advanceSyncCursor('not-a-date')).toBeNull()
  })

  it('bumps ISO timestamp forward by exactly 1 millisecond', () => {
    const result = advanceSyncCursor('2026-04-22T10:30:45.789Z')
    expect(result).not.toBeNull()
    const bumped = DateTime.fromISO(result!)
    expect(bumped.isValid).toBe(true)
    expect(bumped.toMillis() - DateTime.fromISO('2026-04-22T10:30:45.789Z').toMillis()).toBe(1)
  })

  it('bumps exactly by 1ms even when milliseconds are zero (defeats >= semantics)', () => {
    // 回归保障：即使原值为 .000，下一轮起点仍严格大于本轮 max
    const src = '2026-04-22T10:30:45.000Z'
    const result = advanceSyncCursor(src)!
    const bumped = DateTime.fromISO(result)
    expect(bumped.toMillis() - DateTime.fromISO(src).toMillis()).toBe(1)
  })

  it('stays within the same second — does NOT skip concurrent same-second updates', () => {
    // 关键防回归：若改回 +1s 会把整秒跨过去，同秒内 updatedAt 更大的并发新
    // 文章将被永久漏掉（codex P1）。这里确认新 cursor 仍落在 maxUpdatedAt
    // 所在的那一秒内。
    const src = '2026-04-22T10:30:45.789Z'
    const result = advanceSyncCursor(src)!
    const bumped = DateTime.fromISO(result).toUTC()
    expect(bumped.second).toBe(45)
    expect(bumped.millisecond).toBe(790)
  })

  it('accepts DATE_FORMAT-shaped fallback input and still bumps 1ms forward', () => {
    // 上一轮若是秒级 cursor（旧版本写盘），advanceSyncCursor 也能兼容。
    // 秒级输入视同 .000，+1ms 结果仍严格大于输入。
    const result = advanceSyncCursor('2026-04-22T10:30:45')!
    const bumped = parseDateTime(result)
    const orig = parseDateTime('2026-04-22T10:30:45')
    expect(bumped.isValid).toBe(true)
    expect(bumped.toMillis()).toBeGreaterThan(orig.toMillis())
  })

  it('parseDateTime round-trip: next cursor is strictly greater than original max', () => {
    // 与 adjustSyncCursor / getItems 路径一致，用 parseDateTime 回读
    const maxUpdatedAt = '2026-04-22T10:30:45.789Z'
    const next = advanceSyncCursor(maxUpdatedAt)!
    const nextDt = parseDateTime(next)
    const origDt = DateTime.fromISO(maxUpdatedAt)
    expect(nextDt.isValid).toBe(true)
    expect(nextDt.toMillis()).toBeGreaterThan(origDt.toMillis())
  })
})

describe('shouldMarkInitialSyncCompleted', () => {
  it('returns true when successCount > 0 and not yet completed', () => {
    expect(shouldMarkInitialSyncCompleted(5, false)).toBe(true)
  })

  it('returns false when already completed (no redundant write)', () => {
    expect(shouldMarkInitialSyncCompleted(5, true)).toBe(false)
  })

  it('returns false when successCount is 0 (sync failed)', () => {
    expect(shouldMarkInitialSyncCompleted(0, false)).toBe(false)
  })
})
