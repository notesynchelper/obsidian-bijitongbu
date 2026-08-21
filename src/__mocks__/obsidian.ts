// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsYaml = require('js-yaml')

export function parseYaml(text: string): unknown {
  return jsYaml.load(text)
}

// Mirror Obsidian 1.8.7+ getLanguage(): tests drive language detection through
// a `globalThis.window.localStorage` stub (see forcedLang.spec), so delegate to
// it; absent a stub, return '' to let detection fall through to moment/navigator.
export function getLanguage(): string {
  try {
    const w = (globalThis as {
      window?: { localStorage?: { getItem(k: string): string | null } }
    }).window
    return w?.localStorage?.getItem('language') || ''
  } catch {
    return ''
  }
}

// Mirror Obsidian's `moment` export. Tests that stub `globalThis.window.moment`
// (DailyNoteResolver.spec) keep intercepting; everything else gets real moment.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realMoment = require('moment')
export const moment = (...args: unknown[]): unknown => {
  const w = (globalThis as {
    window?: { moment?: (...a: unknown[]) => unknown }
  }).window
  if (w && typeof w.moment === 'function') return w.moment(...args)
  return realMoment(...args)
}

export function stringifyYaml(obj: unknown): string {
  return jsYaml.dump(obj)
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/')
}

export class TFile {
  path = ''
  basename = ''
  name = ''
  extension = 'md'
  stat = { ctime: 0, mtime: 0, size: 0 }
  vault: unknown = null
  parent: unknown = null
}

export class TFolder {
  path = ''
  name = ''
  parent: unknown = null
  children: unknown[] = []
  vault: unknown = null
  isRoot(): boolean { return false }
}

/**
 * Minimal fake element for Notice.noticeEl so Jest can exercise the update
 * reminder line that SyncNoticeManager appends beneath the sync status notice.
 * Mimics the two behaviours the production code relies on:
 *   - createEl(tag, { text, cls }) appends and returns a child
 *   - setMessage() on the Notice wipes previously appended children
 */
export class FakeNoticeEl {
  tag: string
  text: string
  cls: string
  children: FakeNoticeEl[] = []
  private listeners: Record<string, Array<() => void>> = {}

  constructor(tag = 'div', opts?: { text?: string; cls?: string }) {
    this.tag = tag
    this.text = opts?.text ?? ''
    this.cls = opts?.cls ?? ''
  }

  createEl(tag: string, opts?: { text?: string; cls?: string }): FakeNoticeEl {
    const child = new FakeNoticeEl(tag, opts)
    this.children.push(child)
    return child
  }

  // Obsidian 的 createDiv 简写（prefer-create-el 规则要求生产代码用它）
  createDiv(opts?: { text?: string; cls?: string }): FakeNoticeEl {
    return this.createEl('div', opts)
  }

  addEventListener(type: string, fn: () => void): void {
    ;(this.listeners[type] ||= []).push(fn)
  }

  click(): void {
    for (const fn of this.listeners['click'] || []) fn()
  }

  empty(): void {
    this.children = []
  }
}

export class Notice {
  message: string
  duration: number
  noticeEl: FakeNoticeEl = new FakeNoticeEl('div')

  constructor(message: string | DocumentFragment, duration?: number) {
    this.message = typeof message === 'string' ? message : ''
    this.duration = duration ?? 5000
  }

  setMessage(message: string | DocumentFragment): this {
    this.message = typeof message === 'string' ? message : ''
    // Real Obsidian replaces noticeEl content on setMessage — appended children vanish.
    this.noticeEl.empty()
    return this
  }

  hide(): void {
    // no-op in tests
  }
}

export class Vault {}

export class App {}

// Minimal AbstractInputSuggest stub so `class FolderSuggest extends
// AbstractInputSuggest` evaluates under Jest. Popover behaviour is only
// exercised in the real-Obsidian e2e harness.
export class AbstractInputSuggest<T> {
  app: unknown
  limit = 100
  constructor(app: unknown, _textInputEl: unknown) {
    this.app = app
  }
  setValue(_value: string): void {}
  getValue(): string {
    return ''
  }
  open(): void {}
  close(): void {}
  onSelect(_cb: (value: T, evt: MouseEvent | KeyboardEvent) => unknown): this {
    return this
  }
}

// Minimal Modal stub so modules that `extends Modal` (e.g. FirstSyncOpener's
// FirstSyncNoticeModal) load under Jest. Real DOM/open behaviour is covered by
// the real-Obsidian e2e harness, not Jest.
export class Modal {
  app: unknown
  contentEl: unknown
  titleEl: unknown
  modalEl: unknown
  constructor(app: unknown) {
    this.app = app
  }
  open(): void {
    // no-op in tests
  }
  close(): void {
    // no-op in tests
  }
}

export function requestUrl(): Promise<unknown> {
  return Promise.resolve({ status: 200, text: '', headers: {}, arrayBuffer: new ArrayBuffer(0) })
}

export const mockObsidianApp = {
  // Mock implementation of the App API
  app: {
    platform: () => 'desktop',
    plugins: {
      getPlugins: () => [],
      isEnabled: () => true,
    },
  },

  // Mock implementation of the Workspace API
  workspace: {
    onLayoutReady: (callback: () => void) => {
      setTimeout(callback, 0)
    },
    getLeavesOfType: () => [],
    getConfig: () => ({}),
  },

  // Mock implementation of the MarkdownView API
  markdownView: {
    getMode: () => 'source',
    getMarkdown: () => '',
  },
}

// Mock implementation of the Obsidian global object
export const obsidian = {
  ...mockObsidianApp,
}
