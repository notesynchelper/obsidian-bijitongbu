/**
 * 市场版合规：正文里的「积分充值二维码」推广图必须在写入 vault 前剥掉。
 *  - HTML <img> 与 markdown 两种形式都删
 *  - 只删图不注入文字；周围服务端说明文字保留
 *  - 同站非 /qr/ 路径、其它域名的图片一律不动
 */
import { stripPromoQrImages } from '../src/common/imageRelay'

const QR = 'https://www.bijitongbu.site/qr/recharge.png'

describe('stripPromoQrImages', () => {
  it('删除 HTML 排版里的充值二维码 <img>（保留周围文字与容器）', () => {
    const content =
      '正文内容\n<div align="center">积分不足，请充值<img src="' + QR + '" width="200" alt="充值"></div>\n后续'
    const out = stripPromoQrImages(content)
    expect(out).not.toContain('/qr/')
    expect(out).toContain('积分不足，请充值')
    expect(out).toContain('正文内容')
    expect(out).toContain('后续')
  })

  it("单引号/无引号 src 的 <img> 同样删除", () => {
    expect(stripPromoQrImages("<img src='" + QR + "'>")).toBe('')
    expect(stripPromoQrImages('<img width=180 src=' + QR + ' >')).toBe('')
  })

  it('删除 markdown 形式的充值二维码图片', () => {
    const out = stripPromoQrImages('前文\n![充值](' + QR + ')\n后文')
    expect(out).not.toContain('/qr/')
    expect(out).toContain('前文')
    expect(out).toContain('后文')
  })

  it('带 title 的 markdown 图片也删除', () => {
    expect(stripPromoQrImages('![](' + QR + ' "扫码充值")')).toBe('')
  })

  it('不误删：同站非 /qr/ 路径与其它域名的图片', () => {
    const keep1 = '<img src="https://www.bijitongbu.site/logo.png">'
    const keep2 = '![图](https://relay-1.bijitongbu.site/p/abc.png)'
    const keep3 = '![外](https://example.com/qr/looks-like.png)'
    const content = [keep1, keep2, keep3].join('\n')
    expect(stripPromoQrImages(content)).toBe(content)
  })

  it('无 QR 内容原样返回（同一引用，零开销路径）', () => {
    const content = '# 普通笔记\n![img](https://pic.clipfx.app/a.jpg)'
    expect(stripPromoQrImages(content)).toBe(content)
  })

  it('多个 QR 全部删除', () => {
    const content = '<img src="' + QR + '">\n中间\n![x](' + QR + ')'
    const out = stripPromoQrImages(content)
    expect(out).not.toContain('/qr/')
    expect(out).toContain('中间')
  })
})
