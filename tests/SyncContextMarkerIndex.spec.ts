/**
 * SyncContext.buildMarkerIndex —— 内联标记合并文件的跨文件 id 路由索引（codex P2 #2）
 *
 * 方案 A 下纯消息合并文件 frontmatter 不再写 syncedIds，buildIdIndex 只看
 * frontmatter 就索引不到它们。buildMarkerIndex 补扫**合并文件夹静态前缀下**
 * 文件的正文 <!--nh:id-->，把 id 补进 exact 索引，保证改名 / 模板变更后仍能
 * 按 id 路由回旧文件，不重复建文件。且：
 *   - 只扫前缀下的文件（不扫用户整库）；
 *   - 跳过已有可索引 frontmatter id 来源的文件（buildIdIndex 已覆盖）。
 */
import { createBloomFilter } from '../src/compressIds'
import { SyncContext, staticFolderPrefix } from '../src/sync/SyncContext'

const ID_A = 'a0000000-0000-4000-8000-00000000000a' // marker-only 文件
const ID_B = 'b0000000-0000-4000-8000-00000000000b' // 有 syncedIds 的旧文件（marker 应被跳过）
const ID_C = 'c0000000-0000-4000-8000-00000000000c' // 前缀外的文件（不该被扫）
const ID_D = 'd0000000-0000-4000-8000-00000000000d' // 单篇 frontmatter id 文件

function fakeFile(path: string) {
  return { path, basename: path.split('/').pop()!.replace(/\.md$/, '') } as any
}

const fileA = fakeFile('笔记同步助手/2026-07-13/同步助手_2026-07-13.md')
const fileB = fakeFile('笔记同步助手/2026-07-12/同步助手_2026-07-12.md')
const fileC = fakeFile('我的笔记/随手记.md')
const fileD = fakeFile('笔记同步助手/2026-07-11/某文章.md')

const BODIES: Record<string, string> = {
  [fileA.path]: `#### x\n## 2026-07-13 08:00:00\nmsg-a\n<!--nh:${ID_A}-->`,
  [fileB.path]: `#### y\n## 2026-07-12 08:00:00\nmsg-b\n<!--nh:${ID_B}-->`,
  [fileC.path]: `随手写的\n<!--nh:${ID_C}-->`,
  [fileD.path]: `文章正文`,
}

const FRONTMATTER: Record<string, Record<string, unknown> | undefined> = {
  [fileA.path]: undefined,                       // marker-only（无 frontmatter）
  [fileB.path]: { syncedIds: createBloomFilter() }, // 旧 Bloom 文件
  [fileC.path]: undefined,
  [fileD.path]: { id: ID_D },                     // 单篇文章
}

function makeApp() {
  const files = [fileA, fileB, fileC, fileD]
  return {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: jest.fn(async (f: any) => BODIES[f.path] ?? ''),
    },
    metadataCache: {
      getFileCache: (f: any) => ({ frontmatter: FRONTMATTER[f.path] }),
    },
    workspace: {},
  } as any
}

const SETTINGS = {
  folder: '笔记同步助手/{{{date}}}',
  messageFolder: '',
} as any

describe('staticFolderPrefix', () => {
  it('取 {{ 前的静态前缀，去尾部斜杠', () => {
    expect(staticFolderPrefix('笔记同步助手/{{{date}}}')).toBe('笔记同步助手')
    expect(staticFolderPrefix('a/b/{{{date}}}')).toBe('a/b')
    expect(staticFolderPrefix('a/b')).toBe('a/b')
  })
  it('模板以 {{ 开头 → 无静态前缀', () => {
    expect(staticFolderPrefix('{{{date}}}')).toBe('')
    expect(staticFolderPrefix('')).toBe('')
  })
})

describe('SyncContext.buildMarkerIndex', () => {
  it('扫前缀下所有文件的正文标记进 exact 索引；前缀外不扫', async () => {
    const app = makeApp()
    const ctx = new SyncContext(app, SETTINGS, null)
    await ctx.buildMarkerIndex()

    // marker-only 文件的 id 通过正文扫描进了 exact 索引
    expect(ctx.findFileByExactId(ID_A)).toBe(fileA)
    // 混合文件（有 syncedIds 又含 marker 新消息）的 marker id 也要被索引（codex P2）
    expect(ctx.findFileByExactId(ID_B)).toBe(fileB)
    // 前缀外的文件不扫 → 找不到
    expect(ctx.findFileByExactId(ID_C)).toBeUndefined()
    // 单篇 frontmatter id 由 buildIdIndex 覆盖
    expect(ctx.findFileByExactId(ID_D)).toBe(fileD)

    // 前缀内文件都读正文（不按 frontmatter 跳过）；前缀外文件不进循环
    const readPaths = app.vault.cachedRead.mock.calls.map((c: any[]) => c[0].path)
    expect(readPaths).toContain(fileA.path)
    expect(readPaths).toContain(fileB.path)
    expect(readPaths).toContain(fileD.path)
    expect(readPaths).not.toContain(fileC.path)
  })

  it('debug 模式（disableIdRouting）→ 不扫正文', async () => {
    const app = makeApp()
    const ctx = new SyncContext(app, SETTINGS, null, null, true)
    await ctx.buildMarkerIndex()
    expect(app.vault.cachedRead).not.toHaveBeenCalled()
    expect(ctx.findFileByExactId(ID_A)).toBeUndefined()
  })
})
