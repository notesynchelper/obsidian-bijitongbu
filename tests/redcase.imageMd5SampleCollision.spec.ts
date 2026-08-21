/**
 * 🔴 红测试：采样 MD5 撞名 → 两张不同的图串成同一张（数据损坏）
 *              —— 同时要求【不改变既有附件文件名】
 *
 * 背景与两次口径变化（重要，别再来回改）
 * ------------------------------------------------------------------
 * 缺陷来源（codex 复检 2026-07-25 提出的 P0）：
 *   `imageProcessor.ts:calculateMD5` 对 >45KB 文件只取头/中/尾各 15KB 参与哈希，
 *   未采样区不同的两张图会算出**同一个摘要**；而摘要就是附件文件名，
 *   `saveImageToVault`（imageProcessor.ts:203-208）发现同名文件存在就**直接返回该路径、
 *   不比对内容** → 第二张图被静默替换成第一张，笔记里两处嵌入指向同一个文件，
 *   且原始远程链接已被改写，不可逆。用户观感：「配图串了」。
 *
 * 第一版修复把 calculateMD5 改成整包哈希，确实消灭了碰撞，但带来了副作用：
 *   **>45KB 图片的附件文件名全变了** —— 老用户 vault 里已落盘的附件是旧采样摘要命名，
 *   一旦 urlLocalMap 丢失/损坏而正文里又出现远程 URL，重下会生成新文件名、旧文件成孤儿；
 *   而且整包 MD5 是纯 JS，几 MB 的图会明显占用移动端主线程。
 *
 * 因此本轮把要求收敛成【行为契约】而不是【实现方式】：
 *   1. **向后兼容**：同一份字节算出的摘要必须与历史版本一致（文件名不变，老附件继续复用）。
 *   2. **不串图**：两张不同内容的图即使摘要撞名，也必须各自落成独立文件、各自字节正确。
 *   3. **正常去重不受影响**：同一张图重复保存仍复用同一个文件，不能为了防碰撞无脑写副本。
 * 也就是说：摘要可以继续采样（保持文件名稳定），但**复用同名文件之前必须比对内容**，
 * 撞名时要落到一个不同的文件名上。
 */

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { TFile, TFolder } from 'obsidian'
import { calculateMD5, saveImageToVault } from '../src/imageLocalizer/imageProcessor'

/** 历史黄金值：60000 字节、`(i*31+7)&0xff` 填充的样本在旧版采样实现下的摘要。 */
const LEGACY_BIG_DIGEST = '118d9679c753bd89d875846ac2d92d42_MD5'

function legacyBigSample(): ArrayBuffer {
  const big = new Uint8Array(60000)
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff
  return big.buffer
}

/**
 * 造两个「等长、头 15KB / 中 15KB / 尾 15KB 完全相同、只在未采样区不同」的 buffer。
 * 采样窗口：head=[0,15000)、middle=[len/2-7500, len/2+7500)、tail=[len-15000,len)。
 * 100KB 时未采样区是 [15000,43400) 与 (57500,85000)，差异点放在 30000。
 */
function makeCollidingPair(): { a: ArrayBuffer; b: ArrayBuffer; diffOffset: number } {
  const len = 100 * 1024
  const a = new Uint8Array(len)
  for (let i = 0; i < len; i++) a[i] = (i * 7 + 11) & 0xff
  const b = new Uint8Array(a)
  const diffOffset = 30000
  b[diffOffset] ^= 0xff
  b[diffOffset + 1] ^= 0xff
  return { a: a.buffer, b: b.buffer, diffOffset }
}

/** 最小 vault 假件：只实现 saveImageToVault 用得到的几个方法。 */
function makeVault() {
  const files = new Map<string, ArrayBuffer>()
  const folders = new Set<string>()
  const vault = {
    files,
    getAbstractFileByPath: (p: string) => {
      if (folders.has(p)) {
        const f = new TFolder()
        ;(f as unknown as { path: string }).path = p
        return f
      }
      if (files.has(p)) {
        const f = new TFile()
        f.path = p
        return f
      }
      return null
    },
    createFolder: async (p: string) => { folders.add(p) },
    createBinary: async (p: string, data: ArrayBuffer) => {
      if (files.has(p)) throw new Error(`File already exists: ${p}`)
      files.set(p, data)
    },
    readBinary: async (p: string) => {
      const d = files.get(p)
      if (!d) throw new Error(`File not found: ${p}`)
      return d
    },
  }
  return vault
}

const bytesEqual = (x: ArrayBuffer, y: ArrayBuffer) => {
  const ax = new Uint8Array(x)
  const ay = new Uint8Array(y)
  if (ax.length !== ay.length) return false
  for (let i = 0; i < ax.length; i++) if (ax[i] !== ay[i]) return false
  return true
}

describe('🔴 采样摘要撞名不得串图，且不得改变既有附件文件名', () => {
  it('向后兼容：历史大文件样本的摘要必须与旧版一致（老附件文件名不变）', () => {
    // 这条钉的是「不许为了修碰撞而改掉全体 >45KB 图片的文件名」。
    expect(calculateMD5(legacyBigSample())).toBe(LEGACY_BIG_DIGEST)
  })

  it('同一份字节的摘要恒定（断点续传/去重依赖它）', () => {
    const { a } = makeCollidingPair()
    expect(calculateMD5(a)).toBe(calculateMD5(a))
    const small = new Uint8Array(1024).fill(7).buffer
    expect(calculateMD5(small)).toBe(calculateMD5(small))
  })

  it('撞名的两张图必须各自落盘、各自字节正确（绝不复用彼此）', async () => {
    const { a, b, diffOffset } = makeCollidingPair()
    // 前提自检：确实是「不同内容」
    expect(new Uint8Array(a)[diffOffset]).not.toBe(new Uint8Array(b)[diffOffset])

    const vault = makeVault()
    const folder = '笔记同步助手/images'
    const nameA = `${calculateMD5(a)}.png`
    const nameB = `${calculateMD5(b)}.png`

    const pathA = await saveImageToVault(vault as never, folder, nameA, a)
    const pathB = await saveImageToVault(vault as never, folder, nameB, b)

    // 今天必红：nameA === nameB（采样撞名）→ 第二次 saveImageToVault 看到同名文件
    // 直接返回旧路径 → pathB === pathA，B 的字节从未落盘，笔记里两处嵌入同一张图。
    expect(pathB).not.toBe(pathA)
    expect(vault.files.size).toBe(2)
    expect(bytesEqual(vault.files.get(pathA) as ArrayBuffer, a)).toBe(true)
    expect(bytesEqual(vault.files.get(pathB) as ArrayBuffer, b)).toBe(true)
  })

  it('同一张图重复保存仍然复用同一个文件（防碰撞不能退化成无脑写副本）', async () => {
    const { a } = makeCollidingPair()
    const vault = makeVault()
    const folder = '笔记同步助手/images'
    const name = `${calculateMD5(a)}.png`

    const first = await saveImageToVault(vault as never, folder, name, a)
    const second = await saveImageToVault(vault as never, folder, name, a)

    expect(second).toBe(first)
    expect(vault.files.size).toBe(1)
  })
})
