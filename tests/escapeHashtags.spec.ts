import { escapeContentHashtags } from '../src/util'

describe('escapeContentHashtags', () => {
  it('should escape a simple hashtag', () => {
    expect(escapeContentHashtags('这是 #标签 的内容')).toBe('这是 \\#标签 的内容')
  })

  it('should escape multiple hashtags', () => {
    expect(escapeContentHashtags('#tag1 hello #tag2')).toBe('\\#tag1 hello \\#tag2')
  })

  it('should handle WeChat-style double-hash topic tags', () => {
    // 微信公众号格式：#话题标签# — 首个 # 被转义，末尾 # 后为空格/行尾不会被 Obsidian 识别
    expect(escapeContentHashtags('这是 #话题标签# 的内容')).toBe('这是 \\#话题标签# 的内容')
  })

  it('should not escape markdown headings', () => {
    expect(escapeContentHashtags('# 标题')).toBe('# 标题')
    expect(escapeContentHashtags('## 二级标题')).toBe('## 二级标题')
    expect(escapeContentHashtags('### 三级标题')).toBe('### 三级标题')
  })

  it('should not escape headings inside blockquotes', () => {
    expect(escapeContentHashtags('> # 引用中的标题')).toBe('> # 引用中的标题')
    expect(escapeContentHashtags('>> ## 嵌套引用标题')).toBe('>> ## 嵌套引用标题')
  })

  it('should not escape content inside fenced code blocks (backticks)', () => {
    const input = '```\n#tag inside code\n```'
    expect(escapeContentHashtags(input)).toBe(input)
  })

  it('should not escape content inside fenced code blocks (tildes)', () => {
    const input = '~~~\n#tag inside code\n~~~'
    expect(escapeContentHashtags(input)).toBe(input)
  })

  it('should not escape content inside fenced code blocks with language', () => {
    const input = '```javascript\nconst x = #value\n```'
    expect(escapeContentHashtags(input)).toBe(input)
  })

  it('should not escape inline code', () => {
    expect(escapeContentHashtags('use `#tag` in code')).toBe('use `#tag` in code')
  })

  it('should not escape hashtags in URLs', () => {
    expect(escapeContentHashtags('visit https://example.com/page#section for details'))
      .toBe('visit https://example.com/page#section for details')
  })

  it('should not escape hashtags in markdown links', () => {
    expect(escapeContentHashtags('[link](https://example.com#anchor)'))
      .toBe('[link](https://example.com#anchor)')
  })

  it('should not double-escape already escaped hashtags', () => {
    expect(escapeContentHashtags('已转义 \\#tag')).toBe('已转义 \\#tag')
  })

  it('should not escape consecutive ##', () => {
    expect(escapeContentHashtags('这是 ## 标记')).toBe('这是 ## 标记')
  })

  it('should escape hashtags inside parentheses', () => {
    expect(escapeContentHashtags('(#标签)')).toBe('(\\#标签)')
  })

  it('should return empty string for empty input', () => {
    expect(escapeContentHashtags('')).toBe('')
  })

  it('should return the same value for null/undefined input', () => {
    expect(escapeContentHashtags(null as unknown as string)).toBe(null)
    expect(escapeContentHashtags(undefined as unknown as string)).toBe(undefined)
  })

  it('should handle mixed content correctly', () => {
    const input = [
      '# 文章标题',
      '',
      '这篇文章讲了 #话题标签# 和 #另一个标签 的内容。',
      '',
      '```python',
      '# this is a comment',
      'print("#hello")',
      '```',
      '',
      '详见 https://example.com/page#section',
      '',
      '> # 引用标题',
      '> 引用中的 #标签',
    ].join('\n')

    const expected = [
      '# 文章标题',
      '',
      '这篇文章讲了 \\#话题标签# 和 \\#另一个标签 的内容。',
      '',
      '```python',
      '# this is a comment',
      'print("#hello")',
      '```',
      '',
      '详见 https://example.com/page#section',
      '',
      '> # 引用标题',
      '> 引用中的 \\#标签',
    ].join('\n')

    expect(escapeContentHashtags(input)).toBe(expected)
  })

  it('should escape hashtag at the very beginning of content', () => {
    expect(escapeContentHashtags('#开头标签 后面内容')).toBe('\\#开头标签 后面内容')
  })

  it('should not escape # followed by space (not a tag)', () => {
    expect(escapeContentHashtags('# ')).toBe('# ')
    expect(escapeContentHashtags('text # more text')).toBe('text # more text')
  })

  // Codex review 发现的 edge cases
  it('should not escape markdown anchor links', () => {
    expect(escapeContentHashtags('[jump to section](#heading)'))
      .toBe('[jump to section](#heading)')
    expect(escapeContentHashtags('[TOC](#table-of-contents)'))
      .toBe('[TOC](#table-of-contents)')
  })

  it('should not escape wikilink internal heading references', () => {
    expect(escapeContentHashtags('[[page#heading]]')).toBe('[[page#heading]]')
    expect(escapeContentHashtags('[[#heading]]')).toBe('[[#heading]]')
  })

  it('should not escape content inside blockquote fenced code blocks', () => {
    const input = '> ```\n> #in code\n> ```\n> #outside'
    const expected = '> ```\n> #in code\n> ```\n> \\#outside'
    expect(escapeContentHashtags(input)).toBe(expected)
  })

  it('should be idempotent (double-apply produces same result)', () => {
    const input = '这是 #标签 的内容'
    const once = escapeContentHashtags(input)
    const twice = escapeContentHashtags(once)
    expect(twice).toBe(once)
  })

  // Codex review [P1]: 缩进代码块（CommonMark indented code block）同样应跳过
  it('should not escape hashtags inside 4-space indented code blocks', () => {
    const input = [
      '前面段落',
      '',
      '    #include <stdio.h>',
      '    # this is C preprocessor, not a tag',
      '',
      '后面的 #tag',
    ].join('\n')
    const expected = [
      '前面段落',
      '',
      '    #include <stdio.h>',
      '    # this is C preprocessor, not a tag',
      '',
      '后面的 \\#tag',
    ].join('\n')
    expect(escapeContentHashtags(input)).toBe(expected)
  })

  it('should not escape hashtags inside tab-indented code blocks', () => {
    // 注意：内容故意选用 #tagX（# 后紧跟字母，不是标题）才能真正触发转义逻辑
    const input = '段落\n\n\t#tagA some_code()\n\treturn #tagB\n\n普通 #tag'
    const expected = '段落\n\n\t#tagA some_code()\n\treturn #tagB\n\n普通 \\#tag'
    expect(escapeContentHashtags(input)).toBe(expected)
  })

  it('should not escape hashtags inside indented code blocks within blockquotes', () => {
    const input = [
      '> paragraph',
      '>',
      '>     #include <stdio.h>',
      '>     # not a heading, indented C code',
      '>',
      '> after #tag',
    ].join('\n')
    const expected = [
      '> paragraph',
      '>',
      '>     #include <stdio.h>',
      '>     # not a heading, indented C code',
      '>',
      '> after \\#tag',
    ].join('\n')
    expect(escapeContentHashtags(input)).toBe(expected)
  })

  it('should resume escaping after an indented code block ends', () => {
    const input = [
      '段落A',
      '',
      '    #code1',
      '    #code2',
      '',
      '段落B 包含 #realtag',
      '',
      '    #code3 again',
      '',
      '结尾 #lasttag',
    ].join('\n')
    const expected = [
      '段落A',
      '',
      '    #code1',
      '    #code2',
      '',
      '段落B 包含 \\#realtag',
      '',
      '    #code3 again',
      '',
      '结尾 \\#lasttag',
    ].join('\n')
    expect(escapeContentHashtags(input)).toBe(expected)
  })
})
