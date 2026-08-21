/**
 * 并发落盘竞态：同一篇笔记里两张【内容相同】的图会算出同一个文件名，
 * 在有界并发（IMAGE_LOCALIZE_CONCURRENCY=3）下会同时 createBinary 同一路径。
 *
 * 真机复现（2026-07-26）：`image-localization` 用例偶发红——它的 /a.png 与 /b.png
 * 返回同一张 1x1 PNG，两路并发同时落盘，其中一路的 createBinary 失败后，代码用
 * `getAbstractFileByPath` 复查，但 Obsidian 的 **metadata cache 未必已经收录**
 * 刚由另一路写出的文件 → 返回 null → 误判成「不是竞态」把错误抛上去 →
 * 那张图本地化失败（正文保留远程链接）。单跑必绿、并发才红，是典型竞态。
 *
 * 修复：竞态复查改走 adapter（真实文件系统读，不经 metadata cache），
 * adapter 不可用时才退回 Vault API。
 */

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { TFile, TFolder } from 'obsidian'
import { saveImageToVault } from '../src/imageLocalizer/imageProcessor'

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer
}

/**
 * 模拟「另一路并发已经把文件写进去了，但 metadata cache 还没收录」：
 * - createBinary 对已存在路径抛错（真 Obsidian 行为）
 * - getAbstractFileByPath 对该路径返回 null（cache 滞后）
 * - adapter.readBinary 能读到真实字节（文件系统真相）
 */
function makeLaggyVault(prewritten: Map<string, ArrayBuffer>) {
  const folders = new Set<string>()
  const created: string[] = []
  return {
    created,
    getAbstractFileByPath: (p: string) => {
      if (folders.has(p)) {
        const f = new TFolder()
        ;(f as unknown as { path: string }).path = p
        return f
      }
      return null // ← metadata cache 滞后：即使文件已在磁盘上也查不到
    },
    createFolder: async (p: string) => { folders.add(p) },
    createBinary: async (p: string, data: ArrayBuffer) => {
      if (prewritten.has(p)) throw new Error(`File already exists: ${p}`)
      prewritten.set(p, data)
      created.push(p)
    },
    readBinary: async () => { throw new Error('metadata cache miss') },
    adapter: {
      readBinary: async (p: string) => {
        const d = prewritten.get(p)
        if (!d) throw new Error(`not found: ${p}`)
        return d
      },
    },
  }
}

describe('落盘竞态：metadata cache 滞后时不得把图片丢掉', () => {
  const folder = '笔记同步助手/images'
  const name = 'abc_MD5.png'
  const path = `${folder}/${name}`

  it('另一路并发已写入【相同内容】→ 复用该路径，绝不抛错', async () => {
    const data = bytes(1, 2, 3, 4, 5)
    const disk = new Map<string, ArrayBuffer>([[path, data]])
    const vault = makeLaggyVault(disk)

    const result = await saveImageToVault(vault as never, folder, name, bytes(1, 2, 3, 4, 5))

    expect(result).toBe(path)
    expect(vault.created).toHaveLength(0) // 没有重复写盘
  })

  it('另一路并发写入的是【不同内容】→ 落到确定性的碰撞文件名，不覆盖、不抛错', async () => {
    const disk = new Map<string, ArrayBuffer>([[path, bytes(9, 9, 9, 9, 9)]])
    const vault = makeLaggyVault(disk)

    const mine = bytes(1, 2, 3, 4, 5)
    const result = await saveImageToVault(vault as never, folder, name, mine)

    expect(result).not.toBe(path)
    expect(result.startsWith(`${folder}/abc_MD5-`)).toBe(true)
    expect(result.endsWith('.png')).toBe(true)
    // 原有文件必须原样保留
    expect(new Uint8Array(disk.get(path) as ArrayBuffer)).toEqual(new Uint8Array(bytes(9, 9, 9, 9, 9)))
    // 自己的内容确实落盘了
    expect(new Uint8Array(disk.get(result) as ArrayBuffer)).toEqual(new Uint8Array(mine))
  })

  it('adapter 不可用时退回 Vault API（轻量替身/旧版宿主）', async () => {
    const data = bytes(7, 7, 7)
    const disk = new Map<string, ArrayBuffer>([[path, data]])
    const vault = makeLaggyVault(disk) as Record<string, unknown>
    delete vault.adapter
    // 没有 adapter，且 metadata cache 也查不到 → 只能如实抛错，绝不静默复用
    await expect(
      saveImageToVault(vault as never, folder, name, bytes(7, 7, 7)),
    ).rejects.toThrow()
  })
})

describe('并发建目录竞态：createFolder 抛 already exists 不得让图片失败', () => {
  const folder = '笔记同步助手/images'
  const name = 'abc_MD5.png'

  /** 目录在「查」与「建」之间被另一路抢先建好：查不到、建报错、但目录其实可用。 */
  function makeFolderRaceVault(adapterExists: boolean) {
    const files = new Map<string, ArrayBuffer>()
    const vault: Record<string, unknown> = {
      files,
      getAbstractFileByPath: (p: string) => {
        if (files.has(p)) { const f = new TFile(); f.path = p; return f }
        return null   // 目录也查不到（metadata cache 滞后）
      },
      createFolder: async () => { throw new Error('Folder already exists.') },
      createBinary: async (p: string, data: ArrayBuffer) => { files.set(p, data) },
      readBinary: async (p: string) => {
        const d = files.get(p); if (!d) throw new Error('nf'); return d
      },
    }
    if (adapterExists) {
      vault.adapter = { exists: async () => true, readBinary: async (p: string) => {
        const d = files.get(p); if (!d) throw new Error('nf'); return d
      } }
    }
    return vault
  }

  it('adapter 说目录已存在 → 继续写文件，不抛错', async () => {
    const vault = makeFolderRaceVault(true)
    const data = bytes(1, 2, 3)
    const p = await saveImageToVault(vault as never, folder, name, data)
    expect(p).toBe(`${folder}/${name}`)
    expect((vault.files as Map<string, ArrayBuffer>).has(p)).toBe(true)
  })

  it('没有 adapter 时，凭 already exists 文案也要继续（不能让整张图失败）', async () => {
    const vault = makeFolderRaceVault(false)
    const data = bytes(4, 5, 6)
    const p = await saveImageToVault(vault as never, folder, name, data)
    expect(p).toBe(`${folder}/${name}`)
    expect((vault.files as Map<string, ArrayBuffer>).has(p)).toBe(true)
  })

  it('createFolder 因其它原因失败 → 必须如实抛出', async () => {
    const vault = makeFolderRaceVault(false)
    vault.createFolder = async () => { throw new Error('EACCES: permission denied') }
    await expect(
      saveImageToVault(vault as never, folder, name, bytes(7)),
    ).rejects.toThrow(/EACCES/)
  })
})
