/**
 * 🔴 红测试：附件下载的两处错误分类（codex 复检 2026-07-25 提出）
 *
 * 背景：附件链路（📎 链接 / media30d / sync.bijitongbu.site）与图片链路是两套独立代码，
 * 但共用同一个重试设置。图片侧的问题（无超时、退避无封顶、不校验内容）附件侧【同样存在】，
 * 修复必须两边都覆盖，否则用户的 PDF/文档会以另一种方式坏掉。这里钉两条最要命的：
 *
 * 【红 1｜数据损坏】200 + text/html 占位页被当成附件保存
 *   机制：src/attachmentLocalizer/attachmentDownloader.ts:74-93 —— 对 text/xml 类响应
 *   只识别 `NoSuchKey`，其它 200 占位页（CDN 登录页 / 人机校验页 / 运营商劫持页）
 *   一律 `success: true` 原样返回。上层把 HTML 存成 `.pdf`/`.docx` 落进 vault 并改写链接，
 *   用户点开是一堆乱码，原始链接也没了。
 *   对照：图片侧早就有 isLikelyImageResponse 拦这种（imageDownloader.ts:44），附件侧没有。
 *
 * 【红 2｜错误分类 + 无效重试】权威源站的 404 拿不到「已过期」结论
 *   机制：requestUrl 的 `throw` 默认 true，>=4xx 在 Obsidian 内部就 reject 了，
 *   message 只有 `Request failed, status 404`——既没有 status 也没有 body。于是
 *   :61-71（看 response.status/body）永远走不到，:98-105（从异常 message 里找 NoSuchKey）
 *   也匹配不上 → 权威源站（isOriginHost：pic/media/media30d/sync）明确说「对象不存在」时，
 *   插件不认，继续把 4 个 relay 节点全试一遍（每节点 2 次），最后只报一个泛化失败，
 *   笔记也拿不到「⚠️已过期」标记。用户看到的是长时间卡顿 + 没有任何结论。
 *
 * ⚠️ 注意既有 tests/attachmentDownloaderFallback.spec.ts 把 404 建模成「resolve 出
 * status=404 的响应」，那与生产不符（生产是 reject）——本文件按生产真实语义建模。
 * 修复时请把两个文件的模型统一，别让「测试绿但线上那条分支根本走不到」再发生。
 */

jest.mock('obsidian', () => ({
  ...jest.requireActual('obsidian'),
  requestUrl: jest.fn(),
}))
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { requestUrl } from 'obsidian'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'

const mockRequestUrl = requestUrl as jest.Mock

const LOGIN_PAGE_HTML =
  '<!DOCTYPE html><html><head><title>请先登录</title></head>' +
  '<body><form action="/login">需要登录后下载</form></body></html>'

function textToArrayBuffer(s: string): ArrayBuffer {
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff
  return bytes.buffer
}

/** 真实 PDF 头部（%PDF-1.7）+ 少量内容 */
function pdfBytes(): ArrayBuffer {
  const head = '%PDF-1.7\n%%EOF\n'
  return textToArrayBuffer(head)
}

/** CDN 登录页：HTTP 200，content-type 是 text/html，body 是 HTML */
function loginPageResponse() {
  return {
    status: 200,
    text: LOGIN_PAGE_HTML,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    arrayBuffer: textToArrayBuffer(LOGIN_PAGE_HTML),
  }
}

function pdfResponse() {
  return {
    status: 200,
    text: '',
    headers: { 'content-type': 'application/pdf' },
    arrayBuffer: pdfBytes(),
  }
}

/** 生产语义的 404：requestUrl 直接 reject，message 里只有状态码，没有 body */
function reject404() {
  return Promise.reject(new Error('Request failed, status 404'))
}

beforeEach(() => mockRequestUrl.mockReset())

describe('🔴 附件下载：200 占位页绝不能当成附件保存', () => {
  it('主线路回 200 登录页 → 必须视为失败并切备用线路，最终拿到真 PDF', async () => {
    // 主线路（relay-1）回登录页；第一个备用线路回真 PDF
    mockRequestUrl
      .mockResolvedValueOnce(loginPageResponse())   // relay-1 尝试 1
      .mockResolvedValueOnce(loginPageResponse())   // relay-1 尝试 2（maxRetries=1）
      .mockResolvedValue(pdfResponse())             // 之后任何节点都给真 PDF

    const r = await downloadAttachment(
      'https://relay-1.bijitongbu.site/m30/abc.pdf', 1, 0,
    )

    expect(r.success).toBe(true)
    const bytes = new Uint8Array(r.data as ArrayBuffer)
    const head = String.fromCharCode(...bytes.slice(0, 5))
    // 今天必红：登录页会被当成功直接返回，head 是 '<!DOC'
    expect(head).toBe('%PDF-')
  })

  it('所有线路都只回 200 登录页 → 必须整体失败（绝不返回 HTML 字节）', async () => {
    mockRequestUrl.mockResolvedValue(loginPageResponse())

    const r = await downloadAttachment(
      'https://relay-1.bijitongbu.site/m30/abc.pdf', 0, 0,
    )

    // 今天必红：success=true 且 data 是 HTML → 上层会把它存成 .pdf 并改写链接
    expect(r.success).toBe(false)
    if (r.data) {
      const bytes = new Uint8Array(r.data)
      const head = String.fromCharCode(...bytes.slice(0, 5))
      expect(head).not.toBe('<!DOC')
    }
  })
})

describe('🔴 附件下载：权威源站 404 必须判为「已过期」并短路', () => {
  it('源站 media30d 回 404（生产语义：reject）→ expired=true 且只请求 1 次', async () => {
    mockRequestUrl.mockImplementation(() => reject404())

    const r = await downloadAttachment('https://media30d.clipfx.app/abc.pdf', 0, 0)

    // 今天必红：拿不到 status/body → 不认 expired → 把 4 个 relay 全试一遍
    expect(r.expired).toBe(true)
    expect(r.success).toBe(false)
    expect(mockRequestUrl).toHaveBeenCalledTimes(1)
  })

  it('relay 单点 404 不能直接判过期，但跨节点全 404 后要给出过期结论', async () => {
    mockRequestUrl.mockImplementation(() => reject404())

    const r = await downloadAttachment('https://relay-1.bijitongbu.site/m30/abc.pdf', 0, 0)

    // relay 是反向代理，单点 404 需要交叉验证（这条是既有设计，保留）；
    // 但所有 relay + 源站都 404 之后，必须给出 expired 结论而不是泛化失败。
    expect(r.success).toBe(false)
    expect(r.expired).toBe(true)
    // 请求次数要有界：4 个 relay + 源站，每个 1 次（maxRetries=0）
    expect(mockRequestUrl.mock.calls.length).toBeLessThanOrEqual(6)
  })
})
