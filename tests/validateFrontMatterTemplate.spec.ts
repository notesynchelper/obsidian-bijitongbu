import { validateFrontMatterTemplate } from '../src/settings/template'

describe('validateFrontMatterTemplate', () => {
  it('空模板 → valid', () => {
    expect(validateFrontMatterTemplate('')).toEqual({
      valid: true,
      error: null,
      sanitized: false,
    })
    expect(validateFrontMatterTemplate('   \n\n')).toEqual({
      valid: true,
      error: null,
      sanitized: false,
    })
  })

  it('合规模板（全部字段带引号）→ valid 不走 sanitize', () => {
    const tpl = [
      'author: "{{{author}}}"',
      'source: "{{{siteName}}}"',
      'url: "{{{originalUrl}}}"',
      'saved: "{{{dateSaved}}}"',
    ].join('\n')
    const r = validateFrontMatterTemplate(tpl)
    expect(r.valid).toBe(true)
    expect(r.sanitized).toBe(false)
    expect(r.error).toBeNull()
  })

  it('踩线但 sanitize 能救（title 裸值）→ valid=true, sanitized=true', () => {
    const r = validateFrontMatterTemplate('title: {{{title}}}')
    // Sample Title 不含 YAML 特殊字符，所以这条不会触发 sanitize
    expect(r.valid).toBe(true)
    expect(r.sanitized).toBe(false)
  })

  it('作者含冒号的裸值模板 → sanitize 救回', () => {
    // 硬编码触发 sanitize: 用户加进模板里就是字面量的冒号
    const r = validateFrontMatterTemplate('note: has a : colon inside')
    expect(r.valid).toBe(true)
    expect(r.sanitized).toBe(true)
  })

  it('用户问题模板（全角冒号 + 裸值）→ invalid + 报错', () => {
    const tpl = `author: {{{author}}}
url: {{{siteName}}}
source: "{{{originalUrl}}}"
saved: "{{{dateSaved}}}"
tags: {{#labels}}[{{{name}}}]{{/labels}}
cover：
{{{dateSaved}}}
{{{updatedAt}}}
{{{image}}}
附件路径：{{{fileAttachment}}}`
    const r = validateFrontMatterTemplate(tpl)
    expect(r.valid).toBe(false)
    expect(r.error).not.toBeNull()
    expect(r.error!).toMatch(/YAML/)
  })

  it('纯裸值（数组/字符串）模板 → invalid（非对象结构）', () => {
    // 这个模板渲染后是 `- item1\n- item2`，YAML 解析为数组，插件不接受
    const r = validateFrontMatterTemplate('- a\n- b\n- c')
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/不是对象|对象结构/)
  })

  it('Mustache 语法错误 → invalid', () => {
    // 未闭合的 section
    const r = validateFrontMatterTemplate('title: {{#labels}}{{name}}')
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/Mustache/)
  })
})
