/**
 * 改名接力导致 urlLocalMap 失效的回归测试（codex P2）
 *
 * 「改名接力」（Paste image rename）把已本地化图片从 md5 路径挪走后，若不同步更新
 * urlLocalMap，下次同步 replayLocalizedUrls 会因旧路径文件找不到而**丢弃映射 → 重复下载**。
 * 修复：主程序订阅 vault.on('rename') → ImageLocalizer.handleAttachmentRename →
 * UrlLocalMap.renameLocalPath 把映射改指到新路径。
 */
import type { App } from 'obsidian'
import { UrlLocalMap } from '../src/imageLocalizer/urlLocalMap'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'

describe('UrlLocalMap.renameLocalPath', () => {
  it('把所有指向 oldPath 的 localPath 更新到 newPath，返回更新条数', () => {
    const m = new UrlLocalMap()
    m.set('noteA.md', 'https://x/1.jpg', '图/a3f9c2.png')
    m.set('noteB.md', 'https://x/1.jpg', '图/a3f9c2.png') // 另一个笔记引用同一张图
    m.set('noteA.md', 'https://x/2.jpg', '图/other.png') // 不该被动到

    const n = m.renameLocalPath('图/a3f9c2.png', '图/我的笔记.png')

    expect(n).toBe(2)
    expect(m.get('noteA.md', 'https://x/1.jpg')).toBe('图/我的笔记.png')
    expect(m.get('noteB.md', 'https://x/1.jpg')).toBe('图/我的笔记.png')
    expect(m.get('noteA.md', 'https://x/2.jpg')).toBe('图/other.png')
  })

  it('无匹配 / 同路径 / 空参数 → 返回 0，不改动', () => {
    const m = new UrlLocalMap()
    m.set('n.md', 'u', '图/a.png')
    expect(m.renameLocalPath('图/不存在.png', '图/x.png')).toBe(0)
    expect(m.renameLocalPath('图/a.png', '图/a.png')).toBe(0)
    expect(m.renameLocalPath('', '图/x.png')).toBe(0)
    expect(m.renameLocalPath('图/a.png', '')).toBe(0)
    expect(m.get('n.md', 'u')).toBe('图/a.png')
  })
})

describe('ImageLocalizer.handleAttachmentRename + replay（回归 codex：改名后映射失效）', () => {
  const REMOTE = 'https://example.com/pic.jpg'
  const OLD = '笔记同步助手/images/a3f9c2.png'
  const NEW = '笔记同步助手/images/我的笔记.png'
  const CONTENT = `# 标题\n\n![图片](${REMOTE})\n`

  function makeLocalizer(existingPaths: Set<string>) {
    const app = {
      vault: {
        getAbstractFileByPath: (p: string) => (existingPaths.has(p) ? { path: p } : null),
      },
    } as unknown as App
    const map = new UrlLocalMap()
    map.set('note.md', REMOTE, OLD) // 首次本地化落下的 md5 路径映射
    const loc = new ImageLocalizer(
      app,
      {
        enablePngToJpeg: false,
        jpegQuality: 80,
        attachmentFolder: '笔记同步助手/images',
        folderDateFormat: 'yyyy-MM-dd',
        maxRetries: 1,
        retryDelay: 0,
      },
      map,
    )
    return { loc, map }
  }

  it('bug 现场：图片已被改名走（旧 md5 路径不存在）→ replay 判失效、保留远程链接', () => {
    // vault 里只有改名后的新文件，旧 md5 路径已不存在
    const { loc } = makeLocalizer(new Set([NEW]))
    const replayed = loc.replayLocalizedUrls(CONTENT, 'note.md')
    // 没有修复时：映射被判失效丢弃，远程 URL 原样保留 → 下次同步会重新下载
    expect(replayed).toContain(REMOTE)
  })

  it('修复后：handleAttachmentRename 更新映射 → replay 命中新路径，远程链接被替换掉', () => {
    const { loc, map } = makeLocalizer(new Set([NEW]))
    loc.handleAttachmentRename(OLD, NEW)
    expect(map.get('note.md', REMOTE)).toBe(NEW)

    const replayed = loc.replayLocalizedUrls(CONTENT, 'note.md')
    expect(replayed).not.toContain(REMOTE)
    expect(replayed).toContain(NEW)
  })
})
