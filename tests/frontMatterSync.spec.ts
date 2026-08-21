/**
 * Test: front matter settings survive sync flow (single article mode)
 *
 * Bug scenario (user report):
 * 1. User opens settings, configures frontMatterVariables in advanced options
 * 2. User clicks sync
 * 3. Front matter settings appear cleared
 * 4. Synced single articles do NOT contain the configured front matter
 *
 * Root causes identified:
 * A. frontMatterTemplate with whitespace (space/newline/tab) is truthy,
 *    blocks frontMatterVariables from being used, YAML parses to null → only {id}
 * B. smartMergeSettings preferred backup over current → stale backup overwrites user config
 * C. isValidValue([]) returned true → empty arrays from backup counted as "valid"
 */
import { renderItemContent, DEFAULT_TEMPLATE } from '../src/settings/template'
import { Item } from '@omnivore-app/api'
import { DEFAULT_SETTINGS, FRONT_MATTER_VARIABLES } from '../src/settings'
import { ConfigMigrationManager } from '../src/configMigration'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsYaml = require('js-yaml')

/** Helper: extract front matter YAML from rendered content */
function extractFrontMatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)---/)
  if (!match) return null
  return jsYaml.load(match[1]) as Record<string, unknown>
}

/** Create a minimal article Item for testing */
function createMockArticle(overrides?: Partial<Item>): Item {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    title: 'Test Article Title',
    siteName: 'example.com',
    originalArticleUrl: 'https://example.com/article/test',
    author: 'John Doe',
    description: 'A test article description',
    slug: 'test-article-slug',
    labels: [
      { name: 'tech', color: '#ff0000', description: null },
      { name: 'reading', color: '#00ff00', description: null },
    ],
    highlights: [],
    updatedAt: '2024-01-15T12:00:00.000Z',
    savedAt: '2024-01-15T10:30:00.000Z',
    pageType: 'ARTICLE',
    content: 'This is test article content.',
    publishedAt: '2024-01-14T08:00:00.000Z',
    url: 'https://example.com/article/test',
    image: 'https://example.com/image.jpg',
    readAt: null,
    wordsCount: 100,
    readingProgressPercent: 0,
    isArchived: false,
    archivedAt: null,
    contentReader: null,
    ...overrides,
  }
}

/** Simulate the settingsTab onChange filter for frontMatterVariables */
function simulateOnChangeFilter(userInput: string): string[] {
  return userInput
    .split(',')
    .map((v) => v.trim())
    .filter(
      (v, i, a) =>
        FRONT_MATTER_VARIABLES.includes(v.split('::')[0]) &&
        a.indexOf(v) === i,
    )
}

/** Detect if input looks like a template (should go to frontMatterTemplate field) */
function looksLikeTemplate(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && (trimmed.includes('{{{') || trimmed.includes('\n'))
}

const DEFAULT_DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"

// ======================================================================
// Part 1: renderItemContent - single article front matter
// ======================================================================

describe('renderItemContent: single article front matter', () => {

  it('includes configured frontMatterVariables in output', () => {
    const article = createMockArticle()
    const result = renderItemContent(
      article, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DEFAULT_DATE_FORMAT, DEFAULT_DATE_FORMAT,
      false, ['title', 'author', 'tags', 'site_name', 'original_url'], '',
      '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm).not.toBeNull()
    expect(fm!.id).toBe(article.id)
    expect(fm!.title).toBe('Test Article Title')
    expect(fm!.author).toBe('John Doe')
    expect(fm!.site_name).toBe('example.com')
    expect(fm!.original_url).toBe('https://example.com/article/test')
    expect(fm!.tags).toEqual(['tech', 'reading'])
  })

  it('renders frontMatterTemplate with article variables', () => {
    const article = createMockArticle()
    const fmTemplate = `author: {{{author}}}
source: {{{siteName}}}
url: {{{originalUrl}}}
tags: [sync]`

    const result = renderItemContent(
      article, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DEFAULT_DATE_FORMAT, DEFAULT_DATE_FORMAT,
      false, [], fmTemplate,
      '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm).not.toBeNull()
    expect(fm!.id).toBe(article.id)
    expect(fm!.author).toBe('John Doe')
    expect(fm!.source).toBe('example.com')
    expect(fm!.tags).toEqual(['sync'])
  })

  it('with empty frontMatterVariables and no template, only id appears', () => {
    const article = createMockArticle()
    const result = renderItemContent(
      article, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DEFAULT_DATE_FORMAT, DEFAULT_DATE_FORMAT,
      false, [], '', '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm).not.toBeNull()
    expect(fm!.id).toBe(article.id)
    expect(fm!.title).toBeUndefined()
    expect(fm!.author).toBeUndefined()
  })

  it('includes aliased variables (variable::alias format)', () => {
    const article = createMockArticle()
    const result = renderItemContent(
      article, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DEFAULT_DATE_FORMAT, DEFAULT_DATE_FORMAT,
      false, ['author::writer', 'site_name::source'], '',
      '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm).not.toBeNull()
    expect(fm!.writer).toBe('John Doe')
    expect(fm!.source).toBe('example.com')
    expect(fm!.author).toBeUndefined()
  })

  it('frontMatterTemplate takes priority over frontMatterVariables when both set', () => {
    const article = createMockArticle()
    const result = renderItemContent(
      article, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DEFAULT_DATE_FORMAT, DEFAULT_DATE_FORMAT,
      false, ['title', 'author'],
      'custom_key: custom_value\nsource: {{{siteName}}}',
      '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm).not.toBeNull()
    expect(fm!.custom_key).toBe('custom_value')
    expect(fm!.source).toBe('example.com')
    expect(fm!.title).toBeUndefined()
  })
})

// ======================================================================
// Part 2: BUG - whitespace-only frontMatterTemplate blocks variables
// ======================================================================

describe('BUG FIX: whitespace-only frontMatterTemplate must not block frontMatterVariables', () => {

  const article = createMockArticle()
  const vars = ['title', 'author', 'tags']

  it.each([
    ['" "   (space)',        ' '],
    ['"\\n"  (newline)',     '\n'],
    ['"\\t"  (tab)',         '\t'],
    ['" \\n "(space+newline)', ' \n '],
  ])('frontMatterTemplate = %s → falls through to frontMatterVariables', (_label, whitespace) => {
    const result = renderItemContent(
      article, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DEFAULT_DATE_FORMAT, DEFAULT_DATE_FORMAT,
      false, vars, whitespace,
      '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm).not.toBeNull()
    expect(fm!.id).toBe(article.id)
    // These MUST be present - frontMatterVariables should be used
    expect(fm!.title).toBe('Test Article Title')
    expect(fm!.author).toBe('John Doe')
    expect(fm!.tags).toEqual(['tech', 'reading'])
  })

  it('empty string frontMatterTemplate correctly falls through to variables', () => {
    const result = renderItemContent(
      article, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DEFAULT_DATE_FORMAT, DEFAULT_DATE_FORMAT,
      false, vars, '',
      '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm!.title).toBe('Test Article Title')
    expect(fm!.author).toBe('John Doe')
    expect(fm!.tags).toEqual(['tech', 'reading'])
  })

  it('non-whitespace frontMatterTemplate correctly takes priority', () => {
    const result = renderItemContent(
      article, DEFAULT_TEMPLATE, 'LOCATION', undefined,
      DEFAULT_DATE_FORMAT, DEFAULT_DATE_FORMAT,
      false, vars, 'custom: value',
      '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm!.custom).toBe('value')
    // variables should NOT appear when a real template is set
    expect(fm!.title).toBeUndefined()
  })
})

// ======================================================================
// Part 3: onChange filter for frontMatterVariables
// ======================================================================

describe('settingsTab onChange filter: valid inputs survive', () => {

  it('standard variables pass the filter', () => {
    expect(simulateOnChangeFilter('title, author, tags')).toEqual(['title', 'author', 'tags'])
  })

  it('all available variables pass', () => {
    const allVars = FRONT_MATTER_VARIABLES.join(', ')
    expect(simulateOnChangeFilter(allVars)).toEqual(FRONT_MATTER_VARIABLES)
  })

  it('variables with aliases pass', () => {
    expect(simulateOnChangeFilter('author::writer, site_name::source'))
      .toEqual(['author::writer', 'site_name::source'])
  })

  it('invalid variable names are silently removed', () => {
    expect(simulateOnChangeFilter('title, invalid_var, author'))
      .toEqual(['title', 'author'])
  })

  it('camelCase variants are rejected (must use snake_case)', () => {
    expect(simulateOnChangeFilter('dateSaved, siteNaMe')).toEqual([])
  })

  it('duplicates are removed', () => {
    expect(simulateOnChangeFilter('title, author, title')).toEqual(['title', 'author'])
  })

  it('empty input produces empty array', () => {
    expect(simulateOnChangeFilter('')).toEqual([])
  })

  it('trailing comma produces no empty entries', () => {
    expect(simulateOnChangeFilter('title,')).toEqual(['title'])
  })
})

// ======================================================================
// Part 3b: template-in-wrong-field detection
// ======================================================================

describe('detect template content entered in variables field', () => {

  it('detects user exact input as template (contains {{{ and newlines)', () => {
    const userInput = `author: {{{author}}}
source: {{{siteName}}}
url: {{{originalUrl}}}
saved: {{{dateSaved}}}
tags: [同步]`
    expect(looksLikeTemplate(userInput)).toBe(true)
    // This input is silently rejected by the variables filter:
    expect(simulateOnChangeFilter(userInput)).toEqual([])
  })

  it('detects multi-line YAML as template', () => {
    expect(looksLikeTemplate('author: John\ntags: [sync]')).toBe(true)
  })

  it('detects Mustache variables as template', () => {
    expect(looksLikeTemplate('author: {{{author}}}')).toBe(true)
  })

  it('does NOT flag plain comma-separated variable names', () => {
    expect(looksLikeTemplate('title, author, tags')).toBe(false)
  })

  it('does NOT flag single variable name', () => {
    expect(looksLikeTemplate('title')).toBe(false)
  })

  it('does NOT flag empty input', () => {
    expect(looksLikeTemplate('')).toBe(false)
    expect(looksLikeTemplate('  ')).toBe(false)
  })

  it('when template detected, auto-redirect saves to frontMatterTemplate', () => {
    const userInput = `author: {{{author}}}
source: {{{siteName}}}
url: {{{originalUrl}}}
saved: {{{dateSaved}}}
tags: [同步]`

    // Simulate the fixed onChange behavior
    const settings = { ...DEFAULT_SETTINGS }
    if (looksLikeTemplate(userInput)) {
      settings.frontMatterTemplate = userInput
      settings.frontMatterVariables = []
    }

    expect(settings.frontMatterTemplate).toBe(userInput)
    expect(settings.frontMatterVariables).toEqual([])

    // Now sync should use the template
    const article = createMockArticle()
    const result = renderItemContent(
      article,
      settings.template || DEFAULT_TEMPLATE,
      'LOCATION', undefined,
      settings.dateHighlightedFormat, settings.dateSavedFormat,
      false,
      settings.frontMatterVariables,
      settings.frontMatterTemplate,
      '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm).not.toBeNull()
    expect(fm!.id).toBe(article.id)
    expect(fm!.author).toBe('John Doe')
    expect(fm!.source).toBe('example.com')
    expect(fm!.url).toBe('https://example.com/article/test')
    expect(fm!.saved).toBeDefined()
    expect(fm!.tags).toEqual(['同步'])
  })
})

// ======================================================================
// Part 4: full user flow simulation
// ======================================================================

describe('user flow: configure front matter → sync single article', () => {

  it('end-to-end: user configures variables, sync produces article with front matter', () => {
    // Step 1: User types in settings textarea
    const userInput = 'title, author, tags, date_saved, site_name'
    const frontMatterVariables = simulateOnChangeFilter(userInput)
    expect(frontMatterVariables).toHaveLength(5)

    // Step 2: Settings saved (simulated)
    const settings = {
      ...DEFAULT_SETTINGS,
      frontMatterVariables,
      frontMatterTemplate: '', // user did not set a template
    }

    // Step 3: Sync runs, renders article
    const article = createMockArticle()
    const result = renderItemContent(
      article,
      settings.template || DEFAULT_TEMPLATE,
      'LOCATION', undefined,
      settings.dateHighlightedFormat,
      settings.dateSavedFormat,
      false,
      settings.frontMatterVariables,
      settings.frontMatterTemplate,
      '', '',
    )

    // Step 4: Article has all configured front matter
    const fm = extractFrontMatter(result)
    expect(fm).not.toBeNull()
    expect(fm!.id).toBe(article.id)
    expect(fm!.title).toBe('Test Article Title')
    expect(fm!.author).toBe('John Doe')
    expect(fm!.tags).toEqual(['tech', 'reading'])
    expect(fm!.date_saved).toBeDefined()
    expect(fm!.site_name).toBe('example.com')
  })

  it('settings remain intact after simulated sync saveSettings', () => {
    // User's settings
    const settings = {
      ...DEFAULT_SETTINGS,
      apiKey: 'user-key',
      frontMatterVariables: ['title', 'author', 'tags'] as string[],
      frontMatterTemplate: '',
    }

    // Sync modifies only syncAt and deviceSyncCursors, then saves
    settings.syncAt = '2024-01-15 12:00:00'
    settings.deviceSyncCursors = { 'device-1': '2024-01-15 12:00:00' }

    // Simulate saveSettings: shallow copy → serialize → deserialize
    const settingsToSave = { ...settings }
    const serialized = JSON.stringify(settingsToSave)
    const loaded = JSON.parse(serialized)

    // frontMatterVariables must survive the save/load cycle
    expect(loaded.frontMatterVariables).toEqual(['title', 'author', 'tags'])
    expect(loaded.frontMatterTemplate).toBe('')
    expect(loaded.apiKey).toBe('user-key')
    expect(loaded.syncAt).toBe('2024-01-15 12:00:00')
  })
})

// ======================================================================
// Part 5: ConfigMigrationManager fixes
// ======================================================================

describe('ConfigMigrationManager: smart merge fixes', () => {

  let migrationManager: ConfigMigrationManager

  beforeEach(() => {
    migrationManager = new ConfigMigrationManager({} as any, {} as any)
  })

  it('isConfigMigrationNeeded: version mismatch triggers migration', () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'valid-key', version: '2.9.3' }
    expect(migrationManager.isConfigMigrationNeeded(settings, '2.9.4')).toBe(true)
  })

  it('isConfigMigrationNeeded: empty apiKey triggers migration', () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: '', version: '2.9.4' }
    expect(migrationManager.isConfigMigrationNeeded(settings, '2.9.4')).toBe(true)
  })

  it('isConfigMigrationNeeded: valid apiKey + matching version → no migration', () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'valid-key', version: '2.9.4' }
    expect(migrationManager.isConfigMigrationNeeded(settings, '2.9.4')).toBe(false)
  })

  it('smartMerge: current non-empty array wins over backup empty array', () => {
    const current = { ...DEFAULT_SETTINGS, apiKey: 'key', frontMatterVariables: ['title', 'author', 'tags'] }
    const backup = { ...DEFAULT_SETTINGS, apiKey: 'key', frontMatterVariables: [] as string[] }
    const merged = migrationManager.smartMergeSettings(current, backup, '2.9.5')
    expect(merged.frontMatterVariables).toEqual(['title', 'author', 'tags'])
  })

  it('smartMerge: current non-empty template wins over backup empty template', () => {
    const current = { ...DEFAULT_SETTINGS, apiKey: 'key', frontMatterTemplate: 'author: {{{author}}}' }
    const backup = { ...DEFAULT_SETTINGS, apiKey: 'key', frontMatterTemplate: '' }
    const merged = migrationManager.smartMergeSettings(current, backup, '2.9.5')
    expect(merged.frontMatterTemplate).toBe('author: {{{author}}}')
  })

  it('smartMerge: backup restores values when current is empty (settings lost)', () => {
    // 设置丢失后，current 通过 Object.assign({}, DEFAULT, {}) 得到新默认值
    const current = { ...DEFAULT_SETTINGS, apiKey: '' }
    const backup = { ...DEFAULT_SETTINGS, apiKey: 'restored-key', frontMatterVariables: ['title', 'author'], frontMatterTemplate: 'author: {{{author}}}' }
    const merged = migrationManager.smartMergeSettings(current, backup, '2.9.5')
    expect(merged.apiKey).toBe('restored-key')
    expect(merged.frontMatterVariables).toEqual(['title', 'author'])
    expect(merged.frontMatterTemplate).toBe('author: {{{author}}}')
  })

  it('smartMerge: current apiKey wins when both present', () => {
    const current = { ...DEFAULT_SETTINGS, apiKey: 'current-key' }
    const backup = { ...DEFAULT_SETTINGS, apiKey: 'old-backup-key' }
    const merged = migrationManager.smartMergeSettings(current, backup, '2.9.5')
    expect(merged.apiKey).toBe('current-key')
  })
})

// ======================================================================
// Part 6: race condition fix
// ======================================================================

describe('race condition fix: migration preserves fresh user edits', () => {

  it('user edits are preserved even when migration fires after', () => {
    const migrationManager = new ConfigMigrationManager({} as any, {} as any)

    const settingsAfterUserEdit = {
      ...DEFAULT_SETTINGS,
      apiKey: 'user-key',
      version: '2.9.3',
      frontMatterTemplate: '',  // 用户选择用 variables 模式，清空了模板
      frontMatterVariables: ['title', 'author', 'tags', 'date_saved'] as string[],
    }
    const staleBackup = {
      ...DEFAULT_SETTINGS,
      apiKey: 'user-key',
      version: '2.9.3',
      frontMatterTemplate: '',
      frontMatterVariables: [] as string[],
    }

    expect(migrationManager.isConfigMigrationNeeded(settingsAfterUserEdit, '2.9.4')).toBe(true)

    const afterMigration = migrationManager.smartMergeSettings(
      settingsAfterUserEdit, staleBackup, '2.9.4',
    )

    // User's config preserved
    expect(afterMigration.frontMatterVariables).toEqual(['title', 'author', 'tags', 'date_saved'])

    // Sync works with preserved config
    const article = createMockArticle()
    const result = renderItemContent(
      article,
      afterMigration.template || DEFAULT_TEMPLATE,
      'LOCATION', undefined,
      afterMigration.dateHighlightedFormat,
      afterMigration.dateSavedFormat,
      false,
      afterMigration.frontMatterVariables,
      afterMigration.frontMatterTemplate,
      '', '',
    )

    const fm = extractFrontMatter(result)
    expect(fm!.title).toBe('Test Article Title')
    expect(fm!.author).toBe('John Doe')
    expect(fm!.tags).toEqual(['tech', 'reading'])
    expect(fm!.date_saved).toBeDefined()
  })
})
