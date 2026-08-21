/**
 * 端到端钉死：图片/附件本地化器现已支持完整模板变量集。
 *
 * 用户原报告：
 *   设置里 attachmentFolder = "同步/{{{siteName}}}/{{{date}}}/{{{title}}}/images"
 *   实际落盘到          = "同步/{{{date}}}/{{{title}}}/images"   （少一段 siteName）
 *
 * 根因 + 修复：
 *   localizer 的 generateFolderPath 现在接收 LocalizerItemMeta；sync 流水线
 *   (FileProcessor / MergeProcessor) 通过 itemToLocalizerMeta(item) 把真实
 *   Item 字段（siteName / author / originalUrl / publishedAt / readAt /
 *   archivedAt / updatedAt / id / slug / pageType / isArchived /
 *   readingProgressPercent / wordsCount / image / description）喂进 task；
 *   relocalize 路径走 metaFromFrontmatter 从笔记 frontmatter 按 alias 表回填。
 *
 *   §1 端到端单变量验证（用户原报告场景的 siteName）
 *   §2 端到端变量矩阵：所有原本失效的变量逐一驱动 ImageLocalizer
 *   §3 端到端多变量组合
 *   §4 基线变量保持不回归
 *   §5 stub-Item 兜底（不传 meta 时仍渲染为空，保持向后兼容）
 *   §6 siteName 三段 fallback：null+originalArticleUrl / null+url / ''
 */

import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { render } from '../src/settings/template'
import {
  itemToLocalizerMeta,
  LocalizerItemMeta,
} from '../src/common/localizerItemMeta'
import { TFile } from 'obsidian'
import {
  downloadImage,
  isRemoteImage,
} from '../src/imageLocalizer/imageDownloader'
import {
  calculateMD5,
  detectImageFormat,
  saveImageToVault,
} from '../src/imageLocalizer/imageProcessor'

jest.mock('../src/imageLocalizer/imageDownloader')
jest.mock('../src/imageLocalizer/imageProcessor')
// 故意不 mock '../src/settings/template'，要走真 render() 才能完整验证
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

const mockDownloadImage = downloadImage as jest.MockedFunction<typeof downloadImage>
const mockIsRemoteImage = isRemoteImage as jest.MockedFunction<typeof isRemoteImage>
const mockCalculateMD5 = calculateMD5 as jest.MockedFunction<typeof calculateMD5>
const mockDetectImageFormat = detectImageFormat as jest.MockedFunction<typeof detectImageFormat>
const mockSaveImageToVault = saveImageToVault as jest.MockedFunction<typeof saveImageToVault>

function createMockFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.replace(/\.md$/, '').split('/').pop() || ''
  return file
}

function createMockVault(content: string) {
  const vault: any = {
    read: jest.fn().mockResolvedValue(content),
    modify: jest.fn(),
    process: null as any,
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
    createBinary: jest.fn(),
    createFolder: jest.fn(),
  }
  vault.process = jest.fn().mockImplementation(async (_f: any, fn: (s: string) => string) => {
    const c = await vault.read(_f)
    const r = fn(c)
    await vault.modify(_f, r)
    return r
  })
  return vault
}

const SAVED_AT = '2026-05-25T10:30:00.000Z'
const PUBLISHED_AT = '2026-05-20T08:00:00.000Z'
const READ_AT = '2026-05-25T11:00:00.000Z'
const ARCHIVED_AT = '2026-05-25T13:00:00.000Z'
const UPDATED_AT = '2026-05-25T12:00:00.000Z'
const DATE_FORMAT = 'yyyy-MM-dd'
const NOTE_TITLE = 'My Article'
const REMOTE_IMG = 'https://cdn.example.com/pic.jpg'

/** 真实笔记 Item（sync 流水线手里的形态） */
function buildRealItem(savedAt: string = SAVED_AT) {
  return {
    id: 'note-id-abc',
    title: NOTE_TITLE,
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/post/1',
    author: 'Alice',
    description: 'Sample description',
    slug: 'post-1',
    labels: null,
    highlights: null,
    updatedAt: UPDATED_AT,
    savedAt,
    pageType: 'ARTICLE',
    content: 'body',
    publishedAt: PUBLISHED_AT,
    url: 'https://example.com/post/1',
    image: null,
    readAt: READ_AT,
    wordsCount: 100,
    readingProgressPercent: 50,
    isArchived: true,
    archivedAt: ARCHIVED_AT,
    contentReader: null,
  } as any
}

/**
 * 端到端驱动 ImageLocalizer，捕获 saveImageToVault 收到的 folder 参数。
 */
async function runImageLocalizerWithMeta(
  template: string,
  meta?: LocalizerItemMeta,
): Promise<string> {
  jest.clearAllMocks()
  mockIsRemoteImage.mockImplementation(
    (url: string) => url.startsWith('http://') || url.startsWith('https://'),
  )
  const localizer = new ImageLocalizer(
    { vault: createMockVault(`![](${REMOTE_IMG})`) } as any,
    {
      enablePngToJpeg: false,
      jpegQuality: 85,
      attachmentFolder: template,
      folderDateFormat: DATE_FORMAT,
      maxRetries: 1,
      retryDelay: 1,
    },
  )
  mockDownloadImage.mockResolvedValueOnce({
    success: true,
    data: new ArrayBuffer(10),
  })
  mockDetectImageFormat.mockReturnValueOnce('jpg')
  mockCalculateMD5.mockReturnValueOnce('cafe')
  mockSaveImageToVault.mockImplementation(
    async (_v: any, folder: string, name: string) => `${folder}/${name}`,
  )
  const file = createMockFile(`notes/${NOTE_TITLE}.md`)
  await localizer.enqueueFile(file, meta)
  await localizer.processQueue()
  expect(mockSaveImageToVault).toHaveBeenCalledTimes(1)
  return mockSaveImageToVault.mock.calls[0][1]
}

// ============================================================
// §1 用户原报告：图片本地化器路径应含 siteName 段
// ============================================================
describe('§1 用户原报告：图片本地化器路径含 siteName', () => {
  test('attachmentFolder = "同步/{{{siteName}}}/{{{date}}}/{{{title}}}/images" 渲染 siteName 段', async () => {
    const USER_TEMPLATE = '同步/{{{siteName}}}/{{{date}}}/{{{title}}}/images'
    const folder = await runImageLocalizerWithMeta(
      USER_TEMPLATE,
      itemToLocalizerMeta(buildRealItem()),
    )
    expect(folder).toBe(`同步/example.com/2026-05-25/${NOTE_TITLE}/images`)
  })
})

// ============================================================
// §2 端到端变量矩阵：每个模板变量都驱动 ImageLocalizer
// ============================================================
describe('§2 localizer 端到端模板变量支持矩阵', () => {
  // [测试名, 模板片段, 端到端落盘 folder 应等于]
  const cases: Array<[string, string, string]> = [
    ['siteName',       'p/{{{siteName}}}',       'p/example.com'],
    // pathSafe 围栏：变量值里的 URL `/` 折成 `-`，不再炸成多级目录（只有模板字面 `/` 才分层）
    ['originalUrl',    'p/{{{originalUrl}}}',    'p/https:-example.com-post-1'],
    ['omnivoreUrl',    'p/{{{omnivoreUrl}}}',    'p/https:-omnivore.app-me-post-1'],
    ['author',         'p/{{{author}}}',         'p/Alice'],
    ['id',             'p/{{{id}}}',             'p/note-id-abc'],
    ['datePublished',  'p/{{{datePublished}}}',  'p/2026-05-20'],
    ['yearPublished',  'p/{{{yearPublished}}}',  'p/2026'],
    ['monthPublished', 'p/{{{monthPublished}}}', 'p/05'],
    ['dayPublished',   'p/{{{dayPublished}}}',   'p/20'],
    ['dateRead',       'p/{{{dateRead}}}',       'p/2026-05-25'],
    ['yearRead',       'p/{{{yearRead}}}',       'p/2026'],
    ['monthRead',      'p/{{{monthRead}}}',      'p/05'],
    ['dayRead',        'p/{{{dayRead}}}',        'p/25'],
    ['dateArchived',   'p/{{{dateArchived}}}',   'p/2026-05-25'],
    ['yearArchived',   'p/{{{yearArchived}}}',   'p/2026'],
    ['monthArchived',  'p/{{{monthArchived}}}',  'p/05'],
    ['dayArchived',    'p/{{{dayArchived}}}',    'p/25'],
    ['yearUpdated',    'p/{{{yearUpdated}}}',    'p/2026'],
    ['monthUpdated',   'p/{{{monthUpdated}}}',   'p/05'],
    ['dayUpdated',     'p/{{{dayUpdated}}}',     'p/25'],
    ['state',          'p/{{{state}}}',          'p/ARCHIVED'],
  ]

  test.each(cases)(
    '%s 端到端落盘 folder',
    async (_name, template, expected) => {
      const folder = await runImageLocalizerWithMeta(
        template,
        itemToLocalizerMeta(buildRealItem()),
      )
      expect(folder).toBe(expected)
    },
  )
})

// ============================================================
// §3 多变量组合
// ============================================================
describe('§3 端到端多变量组合模板', () => {
  test('siteName + author + yearPublished + title 全部解析', async () => {
    const TEMPLATE = '附件/{{{siteName}}}/{{{author}}}/{{{yearPublished}}}/{{{title}}}/images'
    const folder = await runImageLocalizerWithMeta(
      TEMPLATE,
      itemToLocalizerMeta(buildRealItem()),
    )
    expect(folder).toBe(`附件/example.com/Alice/2026/${NOTE_TITLE}/images`)
  })
})

// ============================================================
// §4 基线：基础变量不被回归
// ============================================================
describe('§4 基线（应保持绿）', () => {
  const baseline: Array<[string, string, string]> = [
    ['title',     '{{{title}}}',     NOTE_TITLE],
    ['date',      '{{{date}}}',      '2026-05-25'],
    ['dateSaved', '{{{dateSaved}}}', '2026-05-25'],
    ['yearSaved', '{{{yearSaved}}}', '2026'],
    ['monthSaved','{{{monthSaved}}}','05'],
    ['daySaved',  '{{{daySaved}}}',  '25'],
    ['type',      '{{{type}}}',      'ARTICLE'],
  ]

  test.each(baseline)('%s 在 stub Item 路径中已可用', (_n, template, expected) => {
    // 不传 meta：保留旧"全 null stub Item"行为，savedAt 走 DateTime.now() 兜底
    // 这些字段不依赖 meta，所以 meta=undefined 也能渲染对
    const stubItem = {
      id: '', title: NOTE_TITLE, siteName: null, originalArticleUrl: null,
      author: null, description: null, slug: '', labels: null, highlights: null,
      updatedAt: null, savedAt: SAVED_AT, pageType: 'ARTICLE', content: null,
      publishedAt: null, url: '', image: null, readAt: null, wordsCount: null,
      readingProgressPercent: 0, isArchived: false, archivedAt: null,
      contentReader: null,
    } as any
    expect(render(stubItem, template, DATE_FORMAT)).toBe(expected)
  })
})

// ============================================================
// §5 不传 meta 时回退到旧行为（向后兼容）
// ============================================================
describe('§5 不传 meta 时回退（兼容性）', () => {
  test('enqueueFile(file) 无第二参 → siteName 仍渲染为空（与旧行为等价）', async () => {
    const TEMPLATE = '兜底/{{{siteName}}}/{{{title}}}'
    const folder = await runImageLocalizerWithMeta(TEMPLATE)
    // siteName 段空，normalizePath 把 "兜底//Title" 折叠成 "兜底/Title"
    expect(folder).toBe(`兜底/${NOTE_TITLE}`)
  })

  test('enqueueFile(file, savedAtString) 旧兼容签名仍工作', async () => {
    const TEMPLATE = '兜底/{{{date}}}/{{{title}}}'
    // 走 overload string 分支
    const folder = await runImageLocalizerWithMeta(TEMPLATE, SAVED_AT as any)
    expect(folder).toBe(`兜底/2026-05-25/${NOTE_TITLE}`)
  })
})

// ============================================================
// §6 siteName 三段 fallback
// ============================================================
describe('§6 siteName fallback 链路', () => {
  test('meta.siteName null + originalArticleUrl 有值 → 渲染 host', async () => {
    const folder = await runImageLocalizerWithMeta(
      'p/{{{siteName}}}',
      {
        savedAt: SAVED_AT,
        siteName: null,
        originalArticleUrl: 'https://blog.example.org/posts/x',
      },
    )
    expect(folder).toBe('p/blog.example.org')
  })

  test('meta.siteName + meta.originalArticleUrl 全 null，url 有值 → host 兜底', async () => {
    const folder = await runImageLocalizerWithMeta(
      'p/{{{siteName}}}',
      {
        savedAt: SAVED_AT,
        siteName: null,
        originalArticleUrl: null,
        url: 'https://files.example.net/some.pdf',
      },
    )
    expect(folder).toBe('p/files.example.net')
  })

  test('meta.siteName="" + 无 URL → siteName 段为空，路径折叠', async () => {
    const folder = await runImageLocalizerWithMeta(
      'p/{{{siteName}}}/{{{title}}}',
      { savedAt: SAVED_AT, siteName: '' },
    )
    expect(folder).toBe(`p/${NOTE_TITLE}`)
  })
})
