// Tests for the plugin-level forced language override (Advanced → Interface language).
//
// setForcedLang('zh') must make getLang()/t() return Chinese even when every
// auto-detect signal (localStorage.language, moment.locale, navigator.language)
// points at English — that's the whole point of the setting: "选中文后，不管插件
// 和 obs 是什么语言都将语言转为中文".

import { t, getLang, setForcedLang, getForcedLang, __dicts__ } from '../src/i18n'
import { DEFAULT_SETTINGS, PluginLanguage } from '../src/settings'

describe('default interface language', () => {
  test('defaults to forced Chinese (not auto)', () => {
    // Product decision: the plugin ships Chinese-by-default regardless of the
    // Obsidian / OS locale. A regression back to AUTO would let an English
    // Obsidian render the plugin in English on first install.
    expect(DEFAULT_SETTINGS.language).toBe(PluginLanguage.ZH)
  })
})

describe('forced language override', () => {
  // Mirror the env shim used by i18nKeyConsistency.spec.ts: node testEnvironment
  // has no window/navigator, so install a minimal localStorage + moment stub
  // and crank every auto-detect signal to English to prove the override wins.
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
    setForcedLang(null) // never leak the override across tests
  })

  afterAll(() => {
    setForcedLang(null)
    delete (globalThis as unknown as { window?: unknown }).window
    delete (globalThis as unknown as { navigator?: unknown }).navigator
  })

  test('forced zh overrides an all-English environment', () => {
    // Every signal says English…
    localStorageMock.setItem('language', 'en')
    momentLocale = 'en'
    navigatorLanguage = 'en-US'
    // …but the user forced Chinese in the plugin's own settings.
    setForcedLang('zh')
    expect(getForcedLang()).toBe('zh')
    expect(getLang()).toBe('zh')
    expect(t('common.refresh')).toBe(__dicts__.zh.common.refresh)
    expect(t('settings.advanced.heading')).toBe(__dicts__.zh.settings.advanced.heading)
  })

  test('forced en overrides an all-Chinese environment', () => {
    localStorageMock.setItem('language', 'zh')
    momentLocale = 'zh-cn'
    navigatorLanguage = 'zh-CN'
    setForcedLang('en')
    expect(getLang()).toBe('en')
    expect(t('common.refresh')).toBe(__dicts__.en.common.refresh)
  })

  test('clearing the override (null) falls back to auto-detection', () => {
    localStorageMock.setItem('language', 'en')
    setForcedLang('zh')
    expect(getLang()).toBe('zh')
    // "Follow system" → null → auto-detect picks up the explicit English signal.
    setForcedLang(null)
    expect(getForcedLang()).toBeNull()
    expect(getLang()).toBe('en')
  })

  test('invalid forced value is treated as null (auto)', () => {
    momentLocale = 'en'
    setForcedLang('fr' as unknown as 'en')
    expect(getForcedLang()).toBeNull()
    expect(getLang()).toBe('en')
  })

  test('the new language setting keys exist in both dictionaries', () => {
    expect(__dicts__.en.settings.advanced.language.optZh).toBeTruthy()
    expect(__dicts__.zh.settings.advanced.language.optAuto).toBe('跟随系统')
  })
})
