// 校验 src/i18n/en.ts 与 src/i18n/zh.ts 的 key 集合完全一致。
// 任何一边缺 key、或值类型不是 string，CI 直接 fail。
//
// 这是 i18n 抽离的"安全网"：TypeScript 的 `Dict` 静态类型也在编译期约束 zh，
// 但这条 spec 多一层独立校验，并且把信息打印得更友好。

import en from '../src/i18n/en'
import zh from '../src/i18n/zh'
import { t, getLang, __dicts__ } from '../src/i18n'

type AnyDict = { [k: string]: AnyDict | string }

function flatKeys(obj: AnyDict, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') {
      out.push(path)
    } else if (v && typeof v === 'object') {
      out.push(...flatKeys(v as AnyDict, path))
    } else {
      out.push(`${path}::INVALID(${typeof v})`)
    }
  }
  return out.sort()
}

describe('i18n key consistency', () => {
  const enKeys = flatKeys(en as unknown as AnyDict)
  const zhKeys = flatKeys(zh as unknown as AnyDict)

  test('en.ts has no INVALID values (all leaves are strings)', () => {
    expect(enKeys.filter((k) => k.includes('INVALID'))).toEqual([])
  })

  test('zh.ts has no INVALID values (all leaves are strings)', () => {
    expect(zhKeys.filter((k) => k.includes('INVALID'))).toEqual([])
  })

  test('en and zh expose the same set of keys', () => {
    const onlyInEn = enKeys.filter((k) => !zhKeys.includes(k))
    const onlyInZh = zhKeys.filter((k) => !enKeys.includes(k))
    if (onlyInEn.length || onlyInZh.length) {
      // Custom message so the failure is actionable rather than just a diff dump.
      throw new Error(
        `i18n key drift detected.\n` +
          `  Missing in zh.ts: ${onlyInEn.join(', ') || '(none)'}\n` +
          `  Missing in en.ts: ${onlyInZh.join(', ') || '(none)'}\n`,
      )
    }
  })

  test('every key resolves to a non-empty string in both languages', () => {
    for (const key of enKeys) {
      const enVal = key.split('.').reduce<unknown>((acc, p) => (acc as AnyDict)[p], en)
      const zhVal = key.split('.').reduce<unknown>((acc, p) => (acc as AnyDict)[p], zh)
      expect(typeof enVal).toBe('string')
      expect(typeof zhVal).toBe('string')
      expect((enVal as string).length).toBeGreaterThan(0)
      expect((zhVal as string).length).toBeGreaterThan(0)
    }
  })
})

describe('t() runtime', () => {
  // jest is configured with testEnvironment:"node" (see jest.config.js), so
  // `window` is undefined by default. Install a minimal localStorage + moment
  // shim so we can exercise the same code path the Obsidian renderer uses.
  let store: Record<string, string> = {}
  let momentLocale = ''
  let navigatorLanguage = ''
  const localStorageMock = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v)
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => {
      store = {}
    },
  }

  beforeAll(() => {
    ;(
      globalThis as unknown as {
        window: { localStorage: typeof localStorageMock; moment: { locale: () => string } }
      }
    ).window = {
      localStorage: localStorageMock,
      moment: { locale: () => momentLocale },
    }
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      get: () => ({ language: navigatorLanguage }),
    })
  })

  afterEach(() => {
    store = {}
    momentLocale = ''
    navigatorLanguage = ''
  })

  afterAll(() => {
    delete (globalThis as unknown as { window?: unknown }).window
    delete (globalThis as unknown as { navigator?: unknown }).navigator
  })

  test('returns Chinese when no signal is available (default)', () => {
    expect(getLang()).toBe('zh')
    expect(t('common.refresh')).toBe(__dicts__.zh.common.refresh)
  })

  test('explicit zh in localStorage wins', () => {
    localStorageMock.setItem('language', 'zh')
    expect(getLang()).toBe('zh')
    expect(t('common.refresh')).toBe(__dicts__.zh.common.refresh)

    localStorageMock.setItem('language', 'zh-TW')
    expect(getLang()).toBe('zh')
  })

  test('explicit en in localStorage forces English even on a Chinese OS', () => {
    localStorageMock.setItem('language', 'en')
    momentLocale = 'zh-cn'
    navigatorLanguage = 'zh-CN'
    expect(getLang()).toBe('en')
    expect(t('common.refresh')).toBe(__dicts__.en.common.refresh)
  })

  test('moment.locale catches "Default + Chinese OS" (the original bug)', () => {
    // localStorage empty (Obsidian language dropdown left on "Default"),
    // but the Obsidian UI is showing Chinese because the OS locale is zh-CN.
    momentLocale = 'zh-cn'
    expect(getLang()).toBe('zh')
    expect(t('common.refresh')).toBe(__dicts__.zh.common.refresh)
  })

  test('moment.locale catches "Default + English OS"', () => {
    momentLocale = 'en'
    expect(getLang()).toBe('en')
    expect(t('common.refresh')).toBe(__dicts__.en.common.refresh)
  })

  test('navigator.language as last-resort probe', () => {
    navigatorLanguage = 'en-US'
    expect(getLang()).toBe('en')
  })

  test('unrecognised explicit locale + Chinese OS still picks zh', () => {
    // Plugin only ships zh + en; for a French user on a Chinese machine, the
    // weaker signals get to pick.
    localStorageMock.setItem('language', 'fr')
    momentLocale = 'zh-cn'
    expect(getLang()).toBe('zh')
  })

  test('returns the key string itself when path is unknown (defensive)', () => {
    // Cast through unknown to bypass the typed key constraint — we are
    // deliberately probing a missing path here, not adding a real call site.
    const fake = 'not.a.real.key' as unknown as Parameters<typeof t>[0]
    expect(t(fake)).toBe('not.a.real.key')
  })
})
