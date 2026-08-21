/**
 * SyncNoticeManager 弱升级提醒行为：
 *  - completeSync / showNoArticles 的终态 Notice 下方附加一行提醒
 *  - 提醒先到 / 后到（异步版本检查竞态）两种时序都能挂上
 *  - 点击提醒行触发 onClick（用于跳转第三方插件页）
 *  - 无提醒时状态 Notice 不受影响
 */
import { Notice } from 'obsidian'
import type { FakeNoticeEl } from '../src/__mocks__/obsidian'
import { SyncNoticeManager } from '../src/sync/SyncNoticeManager'

function reminderLineOf(notice: Notice): FakeNoticeEl | undefined {
  return (notice as unknown as { noticeEl: FakeNoticeEl }).noticeEl.children.find(
    (c) => c.cls === 'notehelper-update-reminder',
  )
}

// 拿到 manager 内部创建的 mainNotice（mock Notice 实例）
function grabMainNotice(manager: SyncNoticeManager): Notice {
  return (manager as unknown as { mainNotice: Notice }).mainNotice
}

describe('SyncNoticeManager update reminder', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('提醒先登记、同步后完成：completeSync 渲染后提醒行挂在状态下方', () => {
    const m = new SyncNoticeManager()
    m.startSync()
    const notice = grabMainNotice(m)
    const onClick = jest.fn()
    m.setUpdateReminder({ text: '发现新版本 9.9.9，点击前往第三方插件页升级', onClick })

    m.completeSync(3)

    const line = reminderLineOf(notice)
    expect(line).toBeDefined()
    expect(line!.text).toContain('9.9.9')
    expect((notice as unknown as { message: string }).message).toContain('同步完成')
  })

  it('同步先完成、提醒后到（异步检查迟到）：立即补挂提醒行', () => {
    const m = new SyncNoticeManager()
    m.startSync()
    const notice = grabMainNotice(m)
    m.completeSync(1)
    expect(reminderLineOf(notice)).toBeUndefined()

    m.setUpdateReminder({ text: '发现新版本 9.9.9', onClick: jest.fn() })
    expect(reminderLineOf(notice)).toBeDefined()
  })

  it('showNoArticles（没有新文章）路径同样挂提醒行', () => {
    const m = new SyncNoticeManager()
    m.startSync()
    const notice = grabMainNotice(m)
    m.setUpdateReminder({ text: '发现新版本 9.9.9', onClick: jest.fn() })
    m.showNoArticles()
    expect(reminderLineOf(notice)).toBeDefined()
    expect((notice as unknown as { message: string }).message).toBe('没有新文章需要同步')
  })

  it('点击提醒行触发 onClick 回调', () => {
    const m = new SyncNoticeManager()
    m.startSync()
    const notice = grabMainNotice(m)
    const onClick = jest.fn()
    m.setUpdateReminder({ text: 'x', onClick })
    m.completeSync(0)
    reminderLineOf(notice)!.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('有提醒时延长自动隐藏：3 秒后仍未 hide，12 秒后 hide', () => {
    const m = new SyncNoticeManager()
    m.startSync()
    const notice = grabMainNotice(m)
    const hideSpy = jest.spyOn(notice, 'hide')
    m.setUpdateReminder({ text: 'x', onClick: jest.fn() })
    m.completeSync(2)

    jest.advanceTimersByTime(3500)
    expect(hideSpy).not.toHaveBeenCalled()
    jest.advanceTimersByTime(9000)
    expect(hideSpy).toHaveBeenCalled()
  })

  it('无提醒时行为不变：3 秒后自动隐藏、无附加行', () => {
    const m = new SyncNoticeManager()
    m.startSync()
    const notice = grabMainNotice(m)
    const hideSpy = jest.spyOn(notice, 'hide')
    m.completeSync(2)

    expect(reminderLineOf(notice)).toBeUndefined()
    jest.advanceTimersByTime(3100)
    expect(hideSpy).toHaveBeenCalled()
  })

  it('提醒行只挂一次（重复 setUpdateReminder 幂等）', () => {
    const m = new SyncNoticeManager()
    m.startSync()
    const notice = grabMainNotice(m)
    m.completeSync(1)
    m.setUpdateReminder({ text: 'x', onClick: jest.fn() })
    m.setUpdateReminder({ text: 'x', onClick: jest.fn() })
    const lines = (notice as unknown as { noticeEl: FakeNoticeEl }).noticeEl.children.filter(
      (c) => c.cls === 'notehelper-update-reminder',
    )
    expect(lines).toHaveLength(1)
  })
})
