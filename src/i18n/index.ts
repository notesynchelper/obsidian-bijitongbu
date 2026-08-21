// Lightweight i18n facade.
//
// Why not i18next/react-intl: Obsidian's settings UI is plain DOM string assembly,
// not a React tree, so we don't need re-render plumbing. A dictionary lookup with
// dot-path keys is enough — see docs in CLAUDE.md and the i18n discussion thread.
//
// Language detection (three signals, in order of explicitness):
//   1. Obsidian's public getLanguage() (1.8.7+) — the ISO code of the app's
//      current UI language, covering both an explicit Settings → About →
//      Language choice and the "Default" (OS-derived) case.
//   2. window.moment.locale() — Obsidian mirrors the active UI language onto
//      moment, kept as a belt-and-suspenders probe for contexts where
//      getLanguage is unavailable (tests, very old hosts).
//   3. navigator.language — last-ditch renderer signal, mostly useful before
//      moment finishes loading.
// Fallback when no signal resolves: Chinese, since this plugin's primary
// audience is Chinese-speaking and we only ship zh + en dictionaries.
//
// Re-evaluation: t() reads the current language at every call. Obsidian rebuilds
// the settings tab DOM on every open via display(), so a language flip from
// the test harness becomes visible without any extra wiring.

import { getLanguage } from 'obsidian'
import en, { type Dict } from './en'
import zh from './zh'

export type SupportedLang = 'en' | 'zh'

function safeGetLanguage(): string {
  try {
    if (typeof getLanguage === 'function') {
      return getLanguage() || ''
    }
  } catch {
    // getLanguage may be missing on exotic hosts (tests stub it via the
    // obsidian module mock); detection then falls through to moment/navigator.
  }
  return ''
}

function safeGetMomentLocale(): string {
  try {
    const w = typeof window !== 'undefined' ? (window as unknown as { moment?: { locale?: () => string } }) : undefined
    const loc = w?.moment?.locale?.()
    return typeof loc === 'string' ? loc : ''
  } catch {
    return ''
  }
}

function safeGetNavigatorLanguage(): string {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
      return navigator.language
    }
  } catch {
    // navigator may not exist in test/SSR environments.
  }
  return ''
}

// Plugin-level forced language. When the user picks a concrete language in the
// plugin's own Advanced settings (not "auto"), it overrides every auto-detected
// signal below — so "中文" forces zh even when Obsidian and the OS are English.
// null = follow auto-detection. Kept in sync by the plugin (see main.ts
// applyLanguagePreference, called on load and on every saveSettings).
let forcedLang: SupportedLang | null = null

export function setForcedLang(lang: SupportedLang | null): void {
  forcedLang = lang === 'en' || lang === 'zh' ? lang : null
}

export function getForcedLang(): SupportedLang | null {
  return forcedLang
}

export function getLang(): SupportedLang {
  // 0. Plugin's own language override wins over everything (incl. explicit
  //    Obsidian language), because it's the most deliberate, plugin-scoped choice.
  if (forcedLang === 'zh' || forcedLang === 'en') return forcedLang

  // 1. Explicit user choice trumps everything: respect en even on Chinese OS.
  const explicit = safeGetLanguage().toLowerCase()
  if (explicit.startsWith('zh')) return 'zh'
  if (explicit.startsWith('en')) return 'en'
  // Explicit but unrecognised (fr, de, …) falls through — we only ship zh/en
  // and probing weaker signals lets us match a Chinese OS at least.

  // 2. Obsidian's moment locale reflects "Default" + OS locale.
  const mo = safeGetMomentLocale().toLowerCase()
  if (mo.startsWith('zh')) return 'zh'
  if (mo.startsWith('en')) return 'en'

  // 3. Renderer's navigator.language as final probe.
  const nav = safeGetNavigatorLanguage().toLowerCase()
  if (nav.startsWith('zh')) return 'zh'
  if (nav.startsWith('en')) return 'en'

  // No signal pointed to zh or en — default Chinese.
  return 'zh'
}

const DICTS: Record<SupportedLang, Dict> = { en, zh }

// Dot-path keys with TypeScript autocomplete.
type Leaves<T> = T extends string
  ? ''
  : {
      [K in keyof T & string]: Leaves<T[K]> extends '' ? K : `${K}.${Leaves<T[K]>}`
    }[keyof T & string]

export type TKey = Leaves<Dict>

function lookup(dict: Dict, key: string): string | undefined {
  const parts = key.split('.')
  let cur: unknown = dict
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return typeof cur === 'string' ? cur : undefined
}

export function t(key: TKey): string {
  const lang = getLang()
  const fromActive = lookup(DICTS[lang], key)
  if (fromActive !== undefined) return fromActive
  // Fall back to English to avoid showing the raw key if a translation goes missing
  // between releases. The jest spec keeps zh in sync with en, so this is just a
  // belt-and-suspenders runtime guard.
  const fromEn = lookup(DICTS.en, key)
  return fromEn !== undefined ? fromEn : (key)
}

// Exposed for tests so we don't have to mutate window.localStorage in node.
export const __dicts__ = DICTS
