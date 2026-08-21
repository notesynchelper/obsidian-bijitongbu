jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { TFile, TFolder } from 'obsidian'
import { saveImageToVault } from '../src/imageLocalizer/imageProcessor'

function makeVault() {
  const files = new Map<string, ArrayBuffer>()
  const folders = new Set<string>()
  return {
    files,
    getAbstractFileByPath: (path: string) => {
      if (folders.has(path)) {
        const folder = new TFolder()
        ;(folder as unknown as { path: string }).path = path
        return folder
      }
      if (files.has(path)) {
        const file = new TFile()
        file.path = path
        return file
      }
      return null
    },
    createFolder: async (path: string) => {
      folders.add(path)
    },
    createBinary: async (path: string, data: ArrayBuffer) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`)
      files.set(path, data)
    },
    readBinary: async (file: TFile | string) => {
      const path = typeof file === 'string' ? file : file.path
      const data = files.get(path)
      if (!data) throw new Error(`File not found: ${path}`)
      return data
    },
  }
}

describe('严格内容比较的 32 位快路径', () => {
  test('不足 4 字节的尾部仍逐字节比较，不同内容绝不复用', async () => {
    const firstData = new Uint8Array([1, 2, 3, 4, 5, 6, 7]).buffer
    const tailDiffers = new Uint8Array([1, 2, 3, 4, 5, 6, 8]).buffer
    const vault = makeVault()

    const firstPath = await saveImageToVault(
      vault as never,
      'attachments',
      'sample_MD5.png',
      firstData,
    )
    const secondPath = await saveImageToVault(
      vault as never,
      'attachments',
      'sample_MD5.png',
      tailDiffers,
    )

    expect(secondPath).not.toBe(firstPath)
    expect(vault.files.size).toBe(2)
  })

  test('包含 32 位分组和尾部的内容完全相同时仍复用', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7]).buffer
    const vault = makeVault()

    const firstPath = await saveImageToVault(
      vault as never,
      'attachments',
      'sample_MD5.png',
      data,
    )
    const secondPath = await saveImageToVault(
      vault as never,
      'attachments',
      'sample_MD5.png',
      data.slice(0),
    )

    expect(secondPath).toBe(firstPath)
    expect(vault.files.size).toBe(1)
  })
})
