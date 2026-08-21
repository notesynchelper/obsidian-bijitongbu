/**
 * 红测试：标题以 `.` 开头的文章落盘后「用户看不见」
 *
 * 用户现象：同步了 N 篇，Obsidian 里只看得到 115 篇。少掉的那些标题形如
 * `.NET 8 的新特性` —— `{{{title}}}` 渲染出的文件名以点开头，落盘成
 * `笔记同步助手/2026-07-27/.NET 8 的新特性.md`。Obsidian 对整个 vault 里
 * 以 `.` 开头的文件/文件夹一律不索引（`.obsidian` 就是靠这条规则隐身的），
 * 于是这篇笔记：
 *   - 文件浏览器里不显示、搜索搜不到、`getAbstractFileByPath()` 也查不到；
 *   - 二次同步因此走「文件不存在 → 新建」分支，反复冲突；
 *   - 日记链接 `[[.NET 8 的新特性]]` 指向一个 Obsidian 认为不存在的目标。
 *
 * 根因：`src/util.ts` 的 `ILLEGAL_CHAR_REGEX_FILE` 只管 `<>:"/\|?*` + 控制字符，
 * 前导 `.` 既不是「文件系统非法字符」也就没人管，一路原样落盘。
 *
 * 修复约定（本测试即规格）：
 *   1. 段首以 `.` 开头的名字，【前面补一个 `_`】：`.NET 8 的新特性` →
 *      `_.NET 8 的新特性`。**原文一个字都不改**，只是多了个前缀。
 *      ⚠️ 这是相对「把点替换成全角句点 `．`」方案的关键取舍：替换字符会让
 *      标题在全文搜索 / 快速切换 / `[[.NET` 补全里再也搜不到原文（用户搜
 *      `.NET` 得不到任何结果），等于用「看得见」换掉了「搜得到」。
 *      补前缀两者兼得 —— 原标题仍是文件名里的一个连续子串。
 *   2. 只动「段首」。中间/结尾的点（`v1.2.3 发布说明`、`结束了.`）逐字节不动，
 *      健康文件名的落盘路径必须完全不变，否则老用户会凭空多出重复笔记。
 *   3. 文件夹路径逐段处理（`笔记同步助手/.NET/2026` 的中间段同样会隐身），
 *      顺带消灭 `.` / `..` 这种父目录段。
 *   4. 清洗后为空的文件名（模板渲染成空串）兜底成 `untitled`，不再落成
 *      没有可见文件名的 `<folder>/.md`。
 *   5. 顺序：非法字符替换 → 剥不可见字符 → 段首补前缀。剥掉零宽字符后
 *      才暴露出来的前导点同样要接住。
 *   6. 幂等：已经补过前缀的名字再清洗一遍不能继续叠前缀（`__..x`）——
 *      同一个路径在管线里会被多处、多次清洗。
 *   7. 整段全是点（`.` / `..` / `...`）是例外：没有可搜索的原文要保，
 *      而补前缀会留下 `_..` 这种以点结尾的名字 —— Windows 建目录时会把结尾的
 *      点吃掉，真实落盘路径与插件算出来的对不上。这类段整段换成等长前缀。
 */

import { Item } from '@omnivore-app/api'
import { normalizePath, TFile } from 'obsidian'
import { render, renderFilename } from '../src/settings/template'
import { replaceIllegalCharsFile, replaceIllegalCharsFolder } from '../src/util'
import { AttachmentLocalizer } from '../src/attachmentLocalizer/attachmentLocalizer'
import { itemToLocalizerMeta } from '../src/common/localizerItemMeta'
import {
  downloadAttachment,
  isRemoteAttachment,
} from '../src/attachmentLocalizer/attachmentDownloader'

jest.mock('../src/attachmentLocalizer/attachmentDownloader')
jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))
jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return { ...actual, Notice: jest.fn() }
})

const mockDownloadAttachment = downloadAttachment as jest.MockedFunction<
  typeof downloadAttachment
>
const mockIsRemoteAttachment = isRemoteAttachment as jest.MockedFunction<
  typeof isRemoteAttachment
>

/** 段首点的护卫前缀：只在前面补一个字符，原文保持可搜索 */
const G = '_'
/** 文件名清洗后为空时的兜底名 */
const FALLBACK_NAME = 'untitled'

const DOT_TITLE = '.NET 8 的新特性'

function mockItem(overrides?: Partial<Item>): Item {
  return {
    id: 'id-1',
    title: 'Test',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/a',
    author: 'Author',
    description: '',
    slug: 's',
    labels: [],
    highlights: [],
    updatedAt: '2026-07-27T12:00:00.000Z',
    savedAt: '2026-07-27T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: '<p>x</p>',
    publishedAt: null,
    url: 'https://example.com/a',
    image: null,
    readAt: null,
    wordsCount: 1,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  }
}

/** 对齐 main.ts 的文件名处理流程 */
function processFilename(item: Item, template = '{{{title}}}', fmt = 'yyyy-MM-dd') {
  return replaceIllegalCharsFile(renderFilename(item, template, fmt))
}

/** 对齐 main.ts 的文件夹处理流程 */
function processFolder(folder: string, item: Item, fmt = 'yyyy-MM-dd') {
  return replaceIllegalCharsFolder(
    normalizePath(render(item, folder, fmt, { pathSafe: true })),
  )
}

/** vault 里任何一段以 `.` 开头 → Obsidian 整段隐身 */
function hasHiddenSegment(vaultPath: string): boolean {
  return vaultPath.split('/').some((seg) => seg.startsWith('.'))
}

// ============================================================
// §1 文件名：段首点
// ============================================================
describe('§1 replaceIllegalCharsFile：段首点不再让笔记隐身', () => {
  it('用户原报告：.NET 8 的新特性 → 段首补前缀，不再隐身', () => {
    const r = replaceIllegalCharsFile(DOT_TITLE)
    expect(r.startsWith('.')).toBe(false)
    expect(r).toBe(`${G}${DOT_TITLE}`)
  })

  it('🔍 原标题必须原样保留在文件名里（否则用户搜不到这篇）', () => {
    // 本条即「补前缀」取代「换全角句点」的全部理由：
    // 全文搜索 / 快速切换 / [[ 补全都是子串匹配，标题被改字就再也搜不到。
    for (const title of [DOT_TITLE, '..隐藏的笔记', '.env 配置说明']) {
      const r = replaceIllegalCharsFile(title)
      expect(r).toContain(title)
      expect(r.startsWith('.')).toBe(false)
    }
  })

  it('连续多个前导点：只补一个前缀，点本身全留着', () => {
    expect(replaceIllegalCharsFile('..隐藏的笔记')).toBe(`${G}..隐藏的笔记`)
  })

  it('整段全是点（`.` / `..`）→ 换成等长前缀，不留 Windows 会吃掉的结尾点', () => {
    // 这类段没有可搜索的原文要保；补前缀会得到 `_..` 这种以点结尾的名字，
    // Windows 建目录时会把结尾的点吃掉 → 真实落盘路径与插件算出来的对不上。
    expect(replaceIllegalCharsFile('.')).toBe(`${G}`)
    expect(replaceIllegalCharsFile('..')).toBe(`${G}${G}`)
    expect(replaceIllegalCharsFile('...')).toBe(`${G}${G}${G}`)
    for (const n of ['.', '..', '...']) {
      expect(replaceIllegalCharsFile(n).endsWith('.')).toBe(false)
    }
  })

  it('幂等：已经补过前缀的名字再清洗一遍不叠加', () => {
    const once = replaceIllegalCharsFile(DOT_TITLE)
    expect(replaceIllegalCharsFile(once)).toBe(once)
    expect(replaceIllegalCharsFile(replaceIllegalCharsFile('...'))).toBe(
      `${G}${G}${G}`,
    )
  })

  it('剥掉不可见字符后才暴露的前导点也要接住（清洗顺序）', () => {
    // ​ 零宽空格会被 out-of-character 剥掉，剥完 `.` 就跑到段首了
    const r = replaceIllegalCharsFile('​.NET 8')
    expect(r.startsWith('.')).toBe(false)
    expect(r).toBe(`${G}.NET 8`)
  })

  it('健康文件名逐字节不变：中间点、结尾点、纯文本一律不动', () => {
    // 改动这些会让老用户凭空多出一份重复笔记，属于回归
    for (const name of [
      'v1.2.3 发布说明',
      'React 18 新特性',
      '结束了.',
      'a.b.c',
      '2026.07.27 周报',
    ]) {
      expect(replaceIllegalCharsFile(name)).toBe(name)
    }
  })

  it('既有的非法字符替换行为不变（仍然替成 `-`）', () => {
    expect(replaceIllegalCharsFile('a<b>c:d"e/f\\g|h?i*j')).toBe(
      'a-b-c-d-e-f-g-h-i-j',
    )
  })

  it('清洗后为空 → 兜底名，不再落成没有可见文件名的 .md', () => {
    expect(replaceIllegalCharsFile('')).toBe(FALLBACK_NAME)
    expect(replaceIllegalCharsFile('   ')).toBe(FALLBACK_NAME)
    // 只有零宽字符的标题，剥完同样是空
    expect(replaceIllegalCharsFile('​​')).toBe(FALLBACK_NAME)
  })
})

// ============================================================
// §2 文件夹：逐段处理
// ============================================================
describe('§2 replaceIllegalCharsFolder：逐段处理，中间段隐身同样致命', () => {
  it('中间段以点开头 → 整个子树在 Obsidian 里消失', () => {
    const r = replaceIllegalCharsFolder('笔记同步助手/.NET/2026-07-27')
    expect(hasHiddenSegment(r)).toBe(false)
    expect(r).toBe(`笔记同步助手/${G}.NET/2026-07-27`)
  })

  it('首段以点开头（含误配到 .obsidian 配置目录）也要改写', () => {
    expect(replaceIllegalCharsFolder('.obsidian/plugins')).toBe(
      `${G}.obsidian/plugins`,
    )
  })

  it('`.` / `..` 段被消灭，路径不再能往上跳', () => {
    const r = replaceIllegalCharsFolder('笔记/../etc')
    expect(r.split('/')).not.toContain('..')
    expect(r.split('/')).not.toContain('.')
    expect(r).toBe(`笔记/${G}${G}/etc`)
    // Windows 会吃掉目录名结尾的点 → 真实落盘路径会与插件算出来的不一致
    expect(r.split('/').some((seg) => seg.endsWith('.'))).toBe(false)
  })

  it('幂等：整条路径再清洗一遍不叠前缀', () => {
    const once = replaceIllegalCharsFolder('笔记同步助手/.NET/2026-07-27')
    expect(replaceIllegalCharsFolder(once)).toBe(once)
  })

  it('健康路径逐字节不变，`/` 依旧保留为目录层级', () => {
    for (const p of [
      '笔记同步助手/2026-07-27',
      '同步/example.com/2026/v1.2 归档',
      'Synced',
    ]) {
      expect(replaceIllegalCharsFolder(p)).toBe(p)
    }
    // 文件夹的非法字符集不含 `/`（多级模板要用），既有行为不变
    expect(replaceIllegalCharsFolder('笔记/a:b')).toBe('笔记/a-b')
  })
})

// ============================================================
// §3 同步管线组合：真的能被 Obsidian 索引到
// ============================================================
describe('§3 同步管线：.NET 标题走完 render→清洗，落盘路径可见', () => {
  it('默认配置（folder=笔记同步助手/{{{date}}}, filename={{{title}}}）', () => {
    const item = mockItem({ title: DOT_TITLE })
    const folderName = processFolder('笔记同步助手/{{{date}}}', item)
    const customFilename = processFilename(item)
    const pageName = normalizePath(`${folderName}/${customFilename}.md`)

    expect(hasHiddenSegment(pageName)).toBe(false)
    expect(pageName).toBe(`笔记同步助手/2026-07-27/${G}${DOT_TITLE}.md`)
  })

  it('文件夹模板含 {{{title}}} 时，文件夹段同样可见', () => {
    const item = mockItem({ title: DOT_TITLE })
    const folderName = processFolder('Synced/{{{title}}}', item)
    expect(hasHiddenSegment(folderName)).toBe(false)
    expect(folderName).toBe(`Synced/${G}${DOT_TITLE}`)
  })

  it('文件名模板渲染成空 → 兜底名，不落成 <folder>/.md', () => {
    const item = mockItem({ title: DOT_TITLE })
    const customFilename = processFilename(item, '{{{__no_such_var__}}}')
    const pageName = normalizePath(`Synced/${customFilename}.md`)

    expect(hasHiddenSegment(pageName)).toBe(false)
    expect(pageName).toBe(`Synced/${FALLBACK_NAME}.md`)
  })

  it('健康标题的落盘路径逐字节不变（回归护栏）', () => {
    const item = mockItem({ title: 'v1.2.3 发布说明' })
    const pageName = normalizePath(
      `${processFolder('笔记同步助手/{{{date}}}', item)}/${processFilename(item)}.md`,
    )
    expect(pageName).toBe('笔记同步助手/2026-07-27/v1.2.3 发布说明.md')
  })
})

// ============================================================
// §4 附件/图片本地化：落图目录同样不能隐身
// ============================================================
describe('§4 本地化目录：段首点的变量值不得把附件目录藏起来', () => {
  const NOTE_CONTENT = `## 附件\n📎 [report.pdf](https://cdn.example.com/file.pdf) (1MB)\n`

  function createMockFile(p: string): TFile {
    const file = new TFile()
    file.path = p
    file.basename = p.replace(/\.md$/, '').split('/').pop() || ''
    return file
  }

  /** 端到端驱动 AttachmentLocalizer，捕获 createBinary 落盘路径的 folder 段 */
  async function runAttachmentLocalizer(
    template: string,
    item: Item,
    noteBasename = 'My Note',
  ): Promise<string> {
    jest.clearAllMocks()
    mockIsRemoteAttachment.mockReturnValue(true)

    const captured = { folder: '' }
    const vault: any = {
      read: jest.fn().mockResolvedValue(NOTE_CONTENT),
      modify: jest.fn(),
      process: null as any,
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      createBinary: jest.fn(async (filePath: string) => {
        captured.folder = filePath.replace(/\/[^/]+$/, '')
      }),
      createFolder: jest.fn(),
    }
    vault.process = jest
      .fn()
      .mockImplementation(async (_f: any, fn: (s: string) => string) => {
        const c = await vault.read(_f)
        const r = fn(c)
        await vault.modify(_f, r)
        return r
      })

    const localizer = new AttachmentLocalizer({ vault } as any, {
      attachmentFolder: template,
      folderDateFormat: 'yyyy-MM-dd',
      maxRetries: 1,
      retryDelay: 1,
    })

    mockDownloadAttachment.mockResolvedValueOnce({
      success: true,
      data: new ArrayBuffer(10),
    })

    await localizer.enqueueFile(
      createMockFile(`notes/${noteBasename}.md`),
      itemToLocalizerMeta(item),
    )
    await localizer.processQueue()
    return captured.folder
  }

  it('author 以点开头（`.NET 团队`）→ 附件目录不隐身', async () => {
    const folder = await runAttachmentLocalizer(
      '附件/{{{author}}}',
      mockItem({ author: '.NET 团队' }),
    )
    expect(hasHiddenSegment(folder)).toBe(false)
    expect(folder).toBe(`附件/${G}.NET 团队`)
  })

  it('笔记标题段（file.basename）以点开头 → 附件目录不隐身', async () => {
    const folder = await runAttachmentLocalizer(
      '附件/{{{title}}}',
      mockItem(),
      DOT_TITLE,
    )
    expect(hasHiddenSegment(folder)).toBe(false)
    expect(folder).toBe(`附件/${G}${DOT_TITLE}`)
  })

  it('健康模板的附件目录逐字节不变（回归护栏）', async () => {
    const folder = await runAttachmentLocalizer(
      '笔记同步助手/attachments',
      mockItem(),
    )
    expect(folder).toBe('笔记同步助手/attachments')
  })
})

// ============================================================
// §5 附件「文件名本身」以点开头（.gitignore / .env / .zshrc …）
// ============================================================
// 企微转发过来的文件、或正文里 📎 链接指向的文件，文件名本身就可能以点开头。
// 落盘成 `<folder>/.gitignore` 后 Obsidian 同样不索引 → 笔记里那条
// `📎 [[附件目录/.gitignore]]` 点开是空的（用户视角：附件丢了）。
// 与文件夹段同源，走同一条修正。
describe('§5 附件文件名以点开头 → 落盘后附件链接必须点得开', () => {
  function createMockFile(p: string): TFile {
    const file = new TFile()
    file.path = p
    file.basename = p.replace(/\.md$/, '').split('/').pop() || ''
    return file
  }

  /** 端到端驱动 AttachmentLocalizer，返回 createBinary 的完整落盘路径 + 改写后的正文 */
  async function localizeAttachment(
    attachmentName: string,
  ): Promise<{ filePath: string; body: string }> {
    jest.clearAllMocks()
    mockIsRemoteAttachment.mockReturnValue(true)

    const noteContent = `## 附件\n📎 [${attachmentName}](https://cdn.example.com/f) (1MB)\n`
    const captured = { filePath: '', body: '' }
    const vault: any = {
      read: jest.fn().mockResolvedValue(noteContent),
      modify: jest.fn(async (_f: any, c: string) => {
        captured.body = c
      }),
      process: null as any,
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
      createBinary: jest.fn(async (filePath: string) => {
        captured.filePath = filePath
      }),
      createFolder: jest.fn(),
    }
    vault.process = jest
      .fn()
      .mockImplementation(async (_f: any, fn: (s: string) => string) => {
        const c = await vault.read(_f)
        const r = fn(c)
        await vault.modify(_f, r)
        return r
      })

    const localizer = new AttachmentLocalizer({ vault } as any, {
      attachmentFolder: '笔记同步助手/attachments',
      folderDateFormat: 'yyyy-MM-dd',
      maxRetries: 1,
      retryDelay: 1,
    })

    mockDownloadAttachment.mockResolvedValueOnce({
      success: true,
      data: new ArrayBuffer(10),
    })

    await localizer.enqueueFile(
      createMockFile('notes/My Note.md'),
      itemToLocalizerMeta(mockItem()),
    )
    await localizer.processQueue()
    return captured
  }

  it('`.gitignore` 落盘后不是隐藏文件，正文链接指向同一个可见路径', async () => {
    const { filePath, body } = await localizeAttachment('.gitignore')

    expect(hasHiddenSegment(filePath)).toBe(false)
    expect(filePath).toBe(`笔记同步助手/attachments/${G}.gitignore`)
    // 正文改写后的 wikilink 必须指向真正落盘的那个路径，否则点开是空的
    expect(body).toContain(`[[${filePath}|`)
  })

  it('健康附件名逐字节不变（回归护栏）', async () => {
    const { filePath } = await localizeAttachment('report.pdf')
    expect(filePath).toBe('笔记同步助手/attachments/report.pdf')
  })
})
