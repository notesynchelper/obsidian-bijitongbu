import {
  DESKTOP_MAX_OPEN,
  FIRST_SYNC_NOTICE_DELAY_MS,
  MOBILE_MAX_OPEN,
  resolveFirstSyncNoticeDelay,
  selectNotesToOpen,
  shouldAutoOpenOnFirstSync,
  shouldSuppressFirstSyncOnLoad,
} from '../src/sync/FirstSyncOpener'

// TFile 在这些纯函数里只被当 slice 的元素用，不触碰 obsidian 运行时；用最小 stub 即可。
function fakeFiles(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({ path: `Synced/note-${i}.md`, basename: `note-${i}` }))
}

describe('FirstSyncOpener 常量', () => {
  it('生产说明弹窗延迟固定为 15 秒', () => {
    // 这条断言把「真实 15s」钉死在单测里 —— e2e 为加速会覆盖延迟，靠这条保证生产值不被误改。
    expect(FIRST_SYNC_NOTICE_DELAY_MS).toBe(15_000)
  })

  it('桌面端最多 3 篇、手机端最多 1 篇', () => {
    expect(DESKTOP_MAX_OPEN).toBe(3)
    expect(MOBILE_MAX_OPEN).toBe(1)
  })
})

describe('selectNotesToOpen', () => {
  it('桌面端取最新（最靠前）的 3 篇', () => {
    const picked = selectNotesToOpen(fakeFiles(5), false)
    expect(picked).toHaveLength(3)
    expect(picked.map((f) => f.basename)).toEqual(['note-0', 'note-1', 'note-2'])
  })

  it('手机端只取最新 1 篇', () => {
    const picked = selectNotesToOpen(fakeFiles(5), true)
    expect(picked).toHaveLength(1)
    expect(picked[0].basename).toBe('note-0')
  })

  it('文件不足上限时全开（不报错）', () => {
    expect(selectNotesToOpen(fakeFiles(2), false)).toHaveLength(2)
    expect(selectNotesToOpen(fakeFiles(0), false)).toHaveLength(0)
    expect(selectNotesToOpen(fakeFiles(0), true)).toHaveLength(0)
  })

  it('不修改入参数组', () => {
    const files = fakeFiles(5)
    selectNotesToOpen(files, false)
    expect(files).toHaveLength(5)
  })
})

describe('shouldAutoOpenOnFirstSync', () => {
  it('未触发过 + 有成功 + 有文件 → 触发', () => {
    expect(shouldAutoOpenOnFirstSync({ alreadyOpened: false, successCount: 3, fileCount: 3 })).toBe(true)
  })

  it('已触发过 → 不再触发（防止后续同步误打开）', () => {
    expect(shouldAutoOpenOnFirstSync({ alreadyOpened: true, successCount: 3, fileCount: 3 })).toBe(false)
  })

  it('本轮没有成功处理文章 → 不触发（空轮留给真正有内容的首轮）', () => {
    expect(shouldAutoOpenOnFirstSync({ alreadyOpened: false, successCount: 0, fileCount: 0 })).toBe(false)
  })

  it('成功数 >0 但没有可打开文件 → 不触发', () => {
    expect(shouldAutoOpenOnFirstSync({ alreadyOpened: false, successCount: 2, fileCount: 0 })).toBe(false)
  })
})

describe('shouldSuppressFirstSyncOnLoad（老用户升级兼容）', () => {
  it('老用户（已完成初次同步、还没标记过）→ 抑制', () => {
    expect(shouldSuppressFirstSyncOnLoad({ firstSyncAutoOpened: false, initialSyncCompleted: true, hasSyncHistory: false })).toBe(true)
  })

  it('更老用户（initialSyncCompleted=false 但有 syncAt/设备游标历史）→ 也抑制（codex P2）', () => {
    expect(shouldSuppressFirstSyncOnLoad({ firstSyncAutoOpened: false, initialSyncCompleted: false, hasSyncHistory: true })).toBe(true)
  })

  it('真正新用户（三者皆空）→ 不抑制，首轮正常触发', () => {
    expect(shouldSuppressFirstSyncOnLoad({ firstSyncAutoOpened: false, initialSyncCompleted: false, hasSyncHistory: false })).toBe(false)
  })

  it('已经标记过的 → 不必再处理', () => {
    expect(shouldSuppressFirstSyncOnLoad({ firstSyncAutoOpened: true, initialSyncCompleted: true, hasSyncHistory: true })).toBe(false)
    expect(shouldSuppressFirstSyncOnLoad({ firstSyncAutoOpened: true, initialSyncCompleted: false, hasSyncHistory: false })).toBe(false)
  })
})

describe('resolveFirstSyncNoticeDelay', () => {
  it('无覆盖（生产）→ 15s', () => {
    expect(resolveFirstSyncNoticeDelay(undefined)).toBe(FIRST_SYNC_NOTICE_DELAY_MS)
  })

  it('合法非负覆盖（测试加速）→ 用覆盖值', () => {
    expect(resolveFirstSyncNoticeDelay(4000)).toBe(4000)
    expect(resolveFirstSyncNoticeDelay(0)).toBe(0)
  })

  it('非法覆盖（负数 / NaN / 非有限）→ 回退默认，避免 setTimeout 被弄坏', () => {
    expect(resolveFirstSyncNoticeDelay(-1)).toBe(FIRST_SYNC_NOTICE_DELAY_MS)
    expect(resolveFirstSyncNoticeDelay(NaN)).toBe(FIRST_SYNC_NOTICE_DELAY_MS)
    expect(resolveFirstSyncNoticeDelay(Infinity)).toBe(FIRST_SYNC_NOTICE_DELAY_MS)
  })
})
