/**
 * 市场版弱升级提醒 UpdateReminder：
 *  - 只查版本号（GET /plugversion-market），绝不下载/写文件
 *  - 版本比较正确、失败静默、去抖
 */
import * as obsidian from 'obsidian'
import {
  UpdateReminder,
  isNewerVersion,
  MARKET_VERSION_CHECK_URL,
} from '../src/updateReminder'

describe('isNewerVersion', () => {
  it.each([
    ['2.12.3', '2.12.2', true],
    ['2.13.0', '2.12.9', true],
    ['3.0.0', '2.99.99', true],
    ['2.12.2', '2.12.2', false],
    ['2.12.1', '2.12.2', false],
    ['2.12', '2.12.0', false],
    ['2.12.2.1', '2.12.2', true],
  ])('latest=%s current=%s → %s', (latest, current, expected) => {
    expect(isNewerVersion(latest, current)).toBe(expected)
  })
})

describe('UpdateReminder', () => {
  afterEach(() => jest.restoreAllMocks())

  it('端点返回更高版本时给出提醒信息，且只请求市场版本号端点', async () => {
    const spy = jest
      .spyOn(obsidian, 'requestUrl')
      .mockResolvedValue({ status: 200, json: { version: '2.12.9' } } as never)
    const r = new UpdateReminder('2.12.2')
    const info = await r.check()
    expect(info).toEqual({ latestVersion: '2.12.9' })
    expect(r.getKnown()).toEqual({ latestVersion: '2.12.9' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][0] as { url: string }).url).toBe(
      MARKET_VERSION_CHECK_URL,
    )
  })

  it('版本相同/更低时不提醒', async () => {
    jest
      .spyOn(obsidian, 'requestUrl')
      .mockResolvedValue({ status: 200, json: { version: '2.12.2' } } as never)
    const r = new UpdateReminder('2.12.2')
    expect(await r.check()).toBeNull()
    expect(r.getKnown()).toBeNull()
  })

  it('网络失败静默返回 null，不抛错', async () => {
    jest
      .spyOn(obsidian, 'requestUrl')
      .mockRejectedValue(new Error('network down'))
    const r = new UpdateReminder('2.12.2')
    await expect(r.check()).resolves.toBeNull()
  })

  it('去抖：窗口内的第二次 check 不再发请求', async () => {
    const spy = jest
      .spyOn(obsidian, 'requestUrl')
      .mockResolvedValue({ status: 200, json: { version: '2.12.2' } } as never)
    const r = new UpdateReminder('2.12.2')
    await r.check()
    await r.check()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('响应缺 version 字段时静默忽略', async () => {
    jest
      .spyOn(obsidian, 'requestUrl')
      .mockResolvedValue({ status: 200, json: {} } as never)
    const r = new UpdateReminder('2.12.2')
    expect(await r.check()).toBeNull()
  })
})
