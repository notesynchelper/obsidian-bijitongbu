/**
 * 图片处理器
 * 负责 MD5 计算、格式检测、PNG→JPEG 转换
 */

import { Vault, normalizePath, TAbstractFile, TFolder } from 'obsidian'
import { log, logError } from '../logger'
// 市场版审核建议弃用 crypto-js（已停维护），换 js-md5（纯 JS、~10KB）。
// 已实测两者对 Uint8Array 输入的 MD5 hex 输出逐字节一致 —— 哈希值决定图片
// 本地化落盘文件名，跨版本必须完全不变，否则破坏老用户附件去重。
import { md5 } from 'js-md5'

const MD5_SAMPLE_SIZE = 15000
const MD5_SAMPLE_THRESHOLD = MD5_SAMPLE_SIZE * 3

function calculateHexMD5(data: Uint8Array): string {
  return md5(data)
}

/**
 * 计算向后兼容的图片摘要：不超过 45KB 时哈希整包，超过时只哈希头、中、尾
 * 各 15KB。采样摘要允许碰撞；saveImageToVault 会在复用同名文件前逐字节比对，
 * 并为不同内容生成确定性的碰撞文件名。
 *
 * 保留采样算法是为了让老用户已落盘附件的文件名跨版本不变，同时避免在移动端
 * 对每张大图执行纯 JS 整包哈希。完整内容哈希仅在确实发生同名碰撞时计算。
 */
export function calculateMD5(data: ArrayBuffer): string {
  const uint8Array = new Uint8Array(data)
  let hashData = uint8Array

  if (uint8Array.byteLength > MD5_SAMPLE_THRESHOLD) {
    const middleStart = Math.floor(
      (uint8Array.byteLength - MD5_SAMPLE_SIZE) / 2,
    )
    const sampled = new Uint8Array(MD5_SAMPLE_THRESHOLD)
    sampled.set(uint8Array.subarray(0, MD5_SAMPLE_SIZE), 0)
    sampled.set(
      uint8Array.subarray(middleStart, middleStart + MD5_SAMPLE_SIZE),
      MD5_SAMPLE_SIZE,
    )
    sampled.set(
      uint8Array.subarray(uint8Array.byteLength - MD5_SAMPLE_SIZE),
      MD5_SAMPLE_SIZE * 2,
    )
    hashData = sampled
  }

  return `${calculateHexMD5(hashData)}_MD5`
}

function arrayBuffersEqual(first: ArrayBuffer, second: ArrayBuffer): boolean {
  if (first.byteLength !== second.byteLength) return false

  // 先按 32 位分组比较，减少大图严格比对时的 JS 循环次数；两个视图从同一
  // 字节偏移（0）按本机相同端序解释，所以 word 相等与对应 4 字节逐一相等
  // 完全等价。不足 4 字节的尾部仍逐字节收尾，不做采样或概率判断。
  const wordLength = Math.floor(first.byteLength / Uint32Array.BYTES_PER_ELEMENT)
  const firstWords = new Uint32Array(first, 0, wordLength)
  const secondWords = new Uint32Array(second, 0, wordLength)
  for (let index = 0; index < wordLength; index++) {
    if (firstWords[index] !== secondWords[index]) return false
  }

  const firstBytes = new Uint8Array(first)
  const secondBytes = new Uint8Array(second)
  for (
    let index = wordLength * Uint32Array.BYTES_PER_ELEMENT;
    index < firstBytes.length;
    index++
  ) {
    if (firstBytes[index] !== secondBytes[index]) return false
  }
  return true
}

/**
 * 读出某个路径已有的字节，并与待写入内容比较。
 *
 * 专供「createBinary 因路径已存在而失败」这条竞态路径：同一篇笔记里两张【内容相同】
 * 的图会算出同一个文件名，在有界并发下会同时落盘。此时不能只查
 * `getAbstractFileByPath` —— Obsidian 的 metadata cache 未必已经收录刚刚由另一路
 * 并发写出的文件，返回 null 会让我们误判成「不是竞态」而把错误抛上去，那张图就
 * 白白本地化失败了（2026-07-26 实测：image-localization 用例偶发红，单跑必绿）。
 * 所以这里优先走 adapter（不经 metadata cache 的真实文件系统读），
 * 不可用时再退回 Vault API。
 */
type RacedPathState = 'same' | 'different' | 'unreadable'

async function inspectRacedPath(
  vault: Vault,
  filePath: string,
  data: ArrayBuffer,
): Promise<RacedPathState> {
  const adapter = (vault as unknown as {
    adapter?: { readBinary?: (p: string) => Promise<ArrayBuffer> }
  }).adapter
  if (adapter && typeof adapter.readBinary === 'function') {
    try {
      const existing = await adapter.readBinary(filePath)
      return arrayBuffersEqual(existing, data) ? 'same' : 'different'
    } catch {
      // adapter 读不到 → 再给 Vault API 一次机会（轻量替身 / 旧宿主）
    }
  }
  const file = vault.getAbstractFileByPath(filePath)
  if (!file) return 'unreadable'
  return (await fileHasSameContent(vault, file, data)) ? 'same' : 'different'
}

async function fileHasSameContent(
  vault: Vault,
  file: TAbstractFile,
  data: ArrayBuffer,
): Promise<boolean> {
  let existingData: ArrayBuffer
  // readBinary 声明只收 TFile，但这里刻意做鸭子类型双轨（真实 TFile / 只认路径的
  // 轻量 Vault 替身），失败统一按「不同内容」处理，所以把方法放宽成结构化签名，
  // 而不是把条目硬 cast 成 TFile。
  const readBinary = vault.readBinary.bind(vault) as (
    target: TAbstractFile | string,
  ) => Promise<ArrayBuffer>
  try {
    // 对同名条目直接尝试移动端安全的 Vault API；若它实际是文件夹或已损坏，
    // readBinary 会失败并按“不同内容”处理，不能误复用。
    existingData = await readBinary(file)
  } catch (error) {
    try {
      // 兼容只实现了路径参数的轻量 Vault 替身；真实 Obsidian 使用上面的 TFile。
      existingData = await readBinary(file.path)
    } catch {
      logError(`读取已有图片失败，按文件名碰撞处理: ${file.path}`, error)
      return false
    }
  }
  return arrayBuffersEqual(existingData, data)
}

/**
 * createFolder 失败后判断「目录其实已经可用」。
 * 优先信 adapter（真实文件系统，不经 metadata cache），其次看 Vault API，
 * 最后兜底认「already exists」文案 —— 三者都不成立才认为是真失败。
 */
async function folderUsable(
  vault: Vault,
  folderPath: string,
  error: unknown,
): Promise<boolean> {
  const adapter = (vault as unknown as {
    adapter?: { exists?: (p: string) => Promise<boolean> }
  }).adapter
  if (adapter && typeof adapter.exists === 'function') {
    try {
      if (await adapter.exists(folderPath)) return true
    } catch {
      // adapter 不可用 → 往下退
    }
  }
  if (vault.getAbstractFileByPath(folderPath) instanceof TFolder) return true
  const message = error instanceof Error ? error.message : String(error)
  return /already exists/i.test(message)
}

/**
 * 确保目录存在，且对**并发创建**免疫。
 *
 * 先查后建之间，另一路（同篇图片有界并发、或附件阶段）可能已经把目录建好，
 * 而 metadata cache 未必已收录 → createFolder 抛「Folder already exists」。
 * 这不是错误：吞掉它继续写文件，否则整张图/附件会白白本地化失败
 * （2026-07-26 实测：image-localization 偶发只改写一半，pending retryCount=1）。
 */
export async function ensureFolderExists(
  vault: Vault,
  normalizedFolder: string,
): Promise<void> {
  if (vault.getAbstractFileByPath(normalizedFolder) instanceof TFolder) return
  log(`创建文件夹: ${normalizedFolder}`)
  try {
    await vault.createFolder(normalizedFolder)
  } catch (error) {
    if (!(await folderUsable(vault, normalizedFolder, error))) throw error
    log(`文件夹已由并发路径创建，继续: ${normalizedFolder}`)
  }
}

function appendFileNameSuffix(fileName: string, suffix: string): string {
  const extensionIndex = fileName.lastIndexOf('.')
  if (extensionIndex <= 0) return `${fileName}${suffix}`
  return `${fileName.slice(0, extensionIndex)}${suffix}${fileName.slice(extensionIndex)}`
}

/**
 * 检测图片格式
 * 通过文件头魔数检测真实格式
 */
export function detectImageFormat(data: ArrayBuffer): string {
  const uint8Array = new Uint8Array(data)

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    uint8Array[0] === 0x89 &&
    uint8Array[1] === 0x50 &&
    uint8Array[2] === 0x4e &&
    uint8Array[3] === 0x47
  ) {
    return 'png'
  }

  // JPEG: FF D8 FF
  if (
    uint8Array[0] === 0xff &&
    uint8Array[1] === 0xd8 &&
    uint8Array[2] === 0xff
  ) {
    return 'jpg'
  }

  // GIF: 47 49 46 38
  if (
    uint8Array[0] === 0x47 &&
    uint8Array[1] === 0x49 &&
    uint8Array[2] === 0x46 &&
    uint8Array[3] === 0x38
  ) {
    return 'gif'
  }

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    uint8Array[0] === 0x52 &&
    uint8Array[1] === 0x49 &&
    uint8Array[2] === 0x46 &&
    uint8Array[3] === 0x46 &&
    uint8Array[8] === 0x57 &&
    uint8Array[9] === 0x45 &&
    uint8Array[10] === 0x42 &&
    uint8Array[11] === 0x50
  ) {
    return 'webp'
  }

  // SVG: 检测文本内容
  try {
    const text = new TextDecoder('utf-8').decode(uint8Array.slice(0, 100))
    if (text.includes('<svg') || text.includes('<?xml')) {
      return 'svg'
    }
  } catch {
    // 忽略解码错误
  }

  // 默认返回 unknown
  return 'unknown'
}

/**
 * PNG 转 JPEG
 * 使用 Canvas API 进行转换
 */
export async function convertPngToJpeg(
  data: ArrayBuffer,
  quality: number = 0.85
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    try {
      // 创建 Blob
      const blob = new Blob([data], { type: 'image/png' })

      // 创建 Image 对象
      const img = new Image()
      const url = URL.createObjectURL(blob)

      img.onload = () => {
        try {
          // 创建 Canvas
          const canvas = createEl('canvas')
          canvas.width = img.width
          canvas.height = img.height

          // 绘制图片
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            URL.revokeObjectURL(url)
            reject(new Error('无法创建 Canvas 上下文'))
            return
          }

          // 填充白色背景（JPEG不支持透明度）
          ctx.fillStyle = '#FFFFFF'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(img, 0, 0)

          // 转换为 JPEG Blob
          canvas.toBlob(
            (jpegBlob) => {
              if (!jpegBlob) {
                URL.revokeObjectURL(url)
                reject(new Error('转换 JPEG 失败'))
                return
              }

              // 转换为 ArrayBuffer
              jpegBlob.arrayBuffer().then((arrayBuffer) => {
                URL.revokeObjectURL(url)
                resolve(arrayBuffer)
              }).catch((err: unknown) => {
                URL.revokeObjectURL(url)
                reject(err instanceof Error ? err : new Error(String(err)))
              })
            },
            'image/jpeg',
            quality
          )
        } catch (error: unknown) {
          URL.revokeObjectURL(url)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }

      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('图片加载失败'))
      }

      img.src = url
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/**
 * 保存图片到 Vault
 * @param vault Obsidian Vault 对象
 * @param folderPath 目标文件夹路径
 * @param fileName 文件名（含扩展名）
 * @param data 图片数据
 * @returns 保存后的文件路径
 */
export async function saveImageToVault(
  vault: Vault,
  folderPath: string,
  fileName: string,
  data: ArrayBuffer
): Promise<string> {
  try {
    // 规范化文件夹路径
    const normalizedFolder = normalizePath(folderPath)

    // 检查文件夹是否存在，不存在则创建。
    // ⚠️ 并发安全：同篇图片是有界并发下载的，多路会同时走到这里；先查后建之间
    // 另一路可能已经把目录建好，而 metadata cache 未必已收录 → createFolder 抛
    // 「Folder already exists」。这不是错误，必须吞掉继续，否则整张图会本地化失败
    // （2026-07-26 实测：image-localization 偶发只改写一半，pending retryCount=1）。
    await ensureFolderExists(vault, normalizedFolder)

    // 完整文件路径
    const filePath = normalizePath(`${normalizedFolder}/${fileName}`)

    // 同名文件只有在内容逐字节一致时才能复用；采样摘要本身允许碰撞。
    const existingFile = vault.getAbstractFileByPath(filePath)
    if (!existingFile) {
      try {
        await vault.createBinary(filePath, data)
        log(`图片保存成功: ${filePath}`)
        return filePath
      } catch (error) {
        // 并发保存可能在 get 与 create 之间创建同一路径；用 adapter 直读复查
        // （不能只信 metadata cache，它未必已收录另一路刚写出的文件）。
        const raced = await inspectRacedPath(vault, filePath, data)
        if (raced === 'same') {
          log(`并发写入同一路径且内容相同，复用: ${filePath}`)
          return filePath
        }
        // 'different' → 落到下面的碰撞命名分支；'unreadable' → 创建失败另有原因，如实抛出
        if (raced === 'unreadable') throw error
      }
    } else if (await fileHasSameContent(vault, existingFile, data)) {
      log(`文件内容相同，复用: ${filePath}`)
      return filePath
    }

    // 采样摘要撞名时才计算整包指纹。完整指纹使同一份内容稳定命中同一路径；
    // 若该指纹路径也被不同内容占用，则稳定序号确保仍不覆盖任何已有文件。
    const contentFingerprint = calculateHexMD5(new Uint8Array(data))
    for (let sequence = 0; ; sequence++) {
      const suffix = sequence === 0
        ? `-${contentFingerprint}`
        : `-${contentFingerprint}-${sequence}`
      const collisionFileName = appendFileNameSuffix(fileName, suffix)
      const collisionPath = normalizePath(
        `${normalizedFolder}/${collisionFileName}`,
      )
      const collisionFile = vault.getAbstractFileByPath(collisionPath)

      if (!collisionFile) {
        try {
          await vault.createBinary(collisionPath, data)
          log(`摘要撞名，图片保存为: ${collisionPath}`)
          return collisionPath
        } catch (error) {
          const raced = await inspectRacedPath(vault, collisionPath, data)
          if (raced === 'same') {
            log(`并发写入碰撞路径且内容相同，复用: ${collisionPath}`)
            return collisionPath
          }
          if (raced === 'unreadable') throw error
          continue   // 'different' → 换下一个序号继续找空位
        }
      }

      if (await fileHasSameContent(vault, collisionFile, data)) {
        log(`碰撞文件内容相同，复用: ${collisionPath}`)
        return collisionPath
      }
    }
  } catch (error) {
    logError(`保存图片失败: ${folderPath}/${fileName}`, error)
    throw error
  }
}

/**
 * 从 URL 提取文件名
 */
export function extractFilenameFromUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    const filename = pathname.substring(pathname.lastIndexOf('/') + 1)

    // 移除查询参数
    return filename.split('?')[0] || 'image'
  } catch {
    return 'image'
  }
}

/**
 * 清理文件名中的非法字符
 */
export function sanitizeFilename(filename: string): string {
  // 移除或替换 Windows/macOS 非法字符
  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 200) // 限制长度
}
