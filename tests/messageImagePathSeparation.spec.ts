/**
 * 文章/消息图片（及附件、文件夹、文件名）按 isMessage 模板变量分流落盘
 *
 * 需求：用户想把「文章的图片」和「企微消息的图片」存到不同文件夹。
 * 方案：render() 的 view 注入布尔变量 isMessage（= isWeChatMessage(item)），
 *       用户在任意路径模板里用 Mustache section 分支：
 *
 *   笔记同步助手/{{#isMessage}}messages{{/isMessage}}{{^isMessage}}articles{{/isMessage}}/images
 *
 * 企微消息判定沿用既有 isWeChatMessage：item.title 以「同步助手_」开头。
 * 图片本地化时 generateFolderPath 用 file.basename 当 title，所以消息合并文件
 * （basename「同步助手_<date>」）天然命中，文章笔记天然走 ^isMessage 分支。
 *
 * 这是「配置是否生效」的 E2E：从 settings 模板 → render() / ImageLocalizer
 * 真实落盘文件夹，断言两类内容分到不同目录。
 */

import { Item } from '@omnivore-app/api'
import { render, renderFilename } from '../src/settings/template'
import { ImageLocalizer } from '../src/imageLocalizer/imageLocalizer'
import { TFile, normalizePath } from 'obsidian'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return { ...actual, Notice: jest.fn() }
})

jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

/** 分流模板：消息 → messages 段，文章 → articles 段 */
const SPLIT_TPL =
  '笔记同步助手/{{#isMessage}}messages{{/isMessage}}{{^isMessage}}articles{{/isMessage}}/images'

const DATE_FORMAT = 'yyyy-MM-dd'

function createItem(overrides?: Partial<Item>): Item {
  return {
    id: 'id-1',
    title: 'My Great Article',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/a',
    author: 'Author',
    description: 'desc',
    slug: 'slug',
    labels: [],
    highlights: [],
    updatedAt: '2026-06-17T12:00:00.000Z',
    savedAt: '2026-06-17T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: '<p>hi</p>',
    publishedAt: null,
    url: 'https://example.com/a',
    image: null,
    readAt: null,
    wordsCount: 100,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  }
}

/** 企微消息：标题以「同步助手_」开头（isWeChatMessage 判定） */
const messageItem = () => createItem({ title: '同步助手_2026-06-17' })
const articleItem = () => createItem({ title: 'My Great Article' })

describe('render() 注入 isMessage 模板变量', () => {
  it('企微消息走 {{#isMessage}} 分支 → messages 目录', () => {
    const out = render(messageItem(), SPLIT_TPL, DATE_FORMAT, { pathSafe: true })
    expect(out).toBe('笔记同步助手/messages/images')
  })

  it('普通文章走 {{^isMessage}} 分支 → articles 目录', () => {
    const out = render(articleItem(), SPLIT_TPL, DATE_FORMAT, { pathSafe: true })
    expect(out).toBe('笔记同步助手/articles/images')
  })

  it('文章与消息渲染出的图片文件夹不同', () => {
    const msg = render(messageItem(), SPLIT_TPL, DATE_FORMAT, { pathSafe: true })
    const art = render(articleItem(), SPLIT_TPL, DATE_FORMAT, { pathSafe: true })
    expect(msg).not.toBe(art)
  })

  it('判定按标题前缀，不看 pageType：FILE 类型的消息仍走 messages', () => {
    const out = render(
      createItem({ title: '同步助手_2026-06-17', pageType: 'FILE' }),
      SPLIT_TPL,
      DATE_FORMAT,
      { pathSafe: true },
    )
    expect(out).toBe('笔记同步助手/messages/images')
  })

  it('isMessage 也可用于文件名模板（renderFilename 内部走 render）', () => {
    const msgName = renderFilename(
      messageItem(),
      '{{#isMessage}}消息_{{/isMessage}}{{^isMessage}}文章_{{/isMessage}}{{{title}}}',
      DATE_FORMAT,
    )
    const artName = renderFilename(
      articleItem(),
      '{{#isMessage}}消息_{{/isMessage}}{{^isMessage}}文章_{{/isMessage}}{{{title}}}',
      DATE_FORMAT,
    )
    expect(msgName.startsWith('消息_')).toBe(true)
    expect(artName.startsWith('文章_')).toBe(true)
  })

  it('不使用 isMessage 的存量路径模板渲染结果不变（向后兼容）', () => {
    const tpl = '笔记同步助手/images/{{{yearSaved}}}/{{{monthSaved}}}'
    const out = render(articleItem(), tpl, DATE_FORMAT, { pathSafe: true })
    expect(out).toBe('笔记同步助手/images/2026/06')
  })
})

describe('ImageLocalizer 图片落盘文件夹按 isMessage 分流（E2E 配置生效）', () => {
  function makeLocalizer(attachmentFolder: string): ImageLocalizer {
    const options = {
      enablePngToJpeg: false,
      jpegQuality: 85,
      attachmentFolder,
      folderDateFormat: DATE_FORMAT,
      maxRetries: 2,
      retryDelay: 10,
    }
    return new ImageLocalizer({ vault: {} } as any, options)
  }

  function makeFile(basename: string): TFile {
    const f = new TFile()
    f.basename = basename
    f.path = `somewhere/${basename}.md`
    return f
  }

  /** 调私有方法 generateFolderPath（真实 render，不 mock）验证 settings → 落盘目录 */
  function folderFor(localizer: ImageLocalizer, file: TFile, meta?: unknown): string {
    return (localizer as any).generateFolderPath(file, meta)
  }

  it('消息合并文件（basename 同步助手_*）的图片落 messages 目录', () => {
    const localizer = makeLocalizer(SPLIT_TPL)
    const folder = folderFor(localizer, makeFile('同步助手_2026-06-17'), {
      pageType: 'ARTICLE',
      savedAt: '2026-06-17T10:30:00.000Z',
    })
    expect(folder).toBe(normalizePath('笔记同步助手/messages/images'))
  })

  it('普通文章笔记的图片落 articles 目录', () => {
    const localizer = makeLocalizer(SPLIT_TPL)
    const folder = folderFor(localizer, makeFile('My Great Article'), {
      pageType: 'ARTICLE',
      savedAt: '2026-06-17T10:30:00.000Z',
    })
    expect(folder).toBe(normalizePath('笔记同步助手/articles/images'))
  })

  it('同一份分流配置下，消息与文章图片目录确实不同', () => {
    const localizer = makeLocalizer(SPLIT_TPL)
    const msgFolder = folderFor(localizer, makeFile('同步助手_2026-06-17'), {})
    const artFolder = folderFor(localizer, makeFile('My Great Article'), {})
    expect(msgFolder).not.toBe(artFolder)
    expect(msgFolder).toContain('messages')
    expect(artFolder).toContain('articles')
  })

  // —— 回归：自定义 singleFileName 文件名（去掉「同步助手_」前缀）时 —— //
  // 这是 codex 复检指出的洞：从 file.basename 反推会误判。sync 管线把按真实
  // 标题算好的 meta.isMessage 传进来后，分流仍正确。
  it('自定义消息文件名（无「同步助手_」前缀）+ meta.isMessage=true → 仍落 messages', () => {
    const localizer = makeLocalizer(SPLIT_TPL)
    // 用户把 singleFileName 改成「企微消息_{{{date}}}」→ basename 无 同步助手_ 前缀
    const folder = folderFor(localizer, makeFile('企微消息_2026-06-17'), {
      isMessage: true,
      savedAt: '2026-06-17T10:30:00.000Z',
    })
    expect(folder).toBe(normalizePath('笔记同步助手/messages/images'))
  })

  it('meta.isMessage=false 时即便 basename 巧合带「同步助手_」也走 articles（meta 为准）', () => {
    const localizer = makeLocalizer(SPLIT_TPL)
    const folder = folderFor(localizer, makeFile('同步助手_看起来像消息的文章'), {
      isMessage: false,
      savedAt: '2026-06-17T10:30:00.000Z',
    })
    expect(folder).toBe(normalizePath('笔记同步助手/articles/images'))
  })

  it('meta 不带 isMessage（relocalize 兜底）→ 回退按 basename 反推', () => {
    const localizer = makeLocalizer(SPLIT_TPL)
    // 没有 meta.isMessage 字段时，render 回退 isWeChatMessage(basename)
    const validSaved = '2026-06-17T10:30:00.000Z'
    const msg = folderFor(localizer, makeFile('同步助手_2026-06-17'), { savedAt: validSaved })
    const art = folderFor(localizer, makeFile('普通文章'), { savedAt: validSaved })
    expect(msg).toContain('messages')
    expect(art).toContain('articles')
  })
})

describe('itemToLocalizerMeta 按真实标题填 isMessage', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { itemToLocalizerMeta } = require('../src/common/localizerItemMeta')

  it('消息 Item → meta.isMessage=true', () => {
    expect(itemToLocalizerMeta(messageItem()).isMessage).toBe(true)
  })

  it('文章 Item → meta.isMessage=false', () => {
    expect(itemToLocalizerMeta(articleItem()).isMessage).toBe(false)
  })
})
