/**
 * calculateMD5 golden-value regression test.
 *
 * 背景：黄金值最初由整包 crypto-js 计算；市场版（审核弃用停维护的 crypto-js）
 * 已换 js-md5 实现。其它测试都把 calculateMD5 mock 掉了，真实 MD5 路径无人
 * 覆盖，因此这里用预先算好的"黄金值"锁死输出，保证换实现与 minify 之后哈希
 * 仍然逐字节一致 —— 哈希变了会改变图片本地化文件名，破坏跨版本去重。
 *
 * 大文件摘要刻意只覆盖头、中、尾各 15KB，因此允许未采样区不同的内容撞名。
 * 这是附件文件名向后兼容与移动端性能契约；防串图由 saveImageToVault 在复用前
 * 比对完整字节并生成确定性碰撞文件名来保证，不由摘要唯一性保证。
 */
import { calculateMD5 } from '../src/imageLocalizer/imageProcessor'

describe('calculateMD5 (js-md5 implementation, crypto-js era golden values)', () => {
  it('小文件按完整内容哈希，结果与整包 crypto-js 一致', () => {
    const small = new Uint8Array([0, 1, 2, 3, 4, 5, 250, 128, 99, 42, 7, 255, 16, 32, 64])
    expect(calculateMD5(small.buffer)).toBe('7405146128c7e107b6ab6b5f94744478_MD5')
  })

  it('大文件保持历史三段采样黄金值，确保附件文件名不变', () => {
    const big = new Uint8Array(60000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff
    expect(calculateMD5(big.buffer)).toBe('118d9679c753bd89d875846ac2d92d42_MD5')
  })

  it('同一内容幂等，且结果格式恒为 <hex32>_MD5', () => {
    const data = new Uint8Array([9, 8, 7, 6, 5])
    const first = calculateMD5(data.buffer)
    expect(calculateMD5(data.buffer)).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{32}_MD5$/)
  })
})
