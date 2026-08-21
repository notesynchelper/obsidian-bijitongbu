# 可用模板变量 / Available Template Variables

本文档列出了笔记同步助手插件中所有可在模板中使用的变量。

## 📅 日期时间变量 / Date & Time Variables

### 保存时间 / Saved

- `{{{dateSaved}}}` - 保存时间（按"文章文件夹日期格式"渲染）/ Saved date (full format)
- `{{{date}}}` - `{{{dateSaved}}}` 的别名 / alias of dateSaved
- `{{{yearSaved}}}` - 保存日期的年份（4 位）/ Year of saved date (4-digit)
- `{{{monthSaved}}}` - 保存日期的月份（2 位补零）/ Month of saved date (2-digit, zero-padded)
- `{{{daySaved}}}` - 保存日期的日（2 位补零）/ Day of saved date (2-digit, zero-padded)

### 发布时间 / Published（文章有 publishedAt 字段时可用）

- `{{{datePublished}}}` - 发布时间
- `{{{yearPublished}}}` / `{{{monthPublished}}}` / `{{{dayPublished}}}` - 发布日期年/月/日
- ⚠️ publishedAt 缺失时这几个变量渲染为空串

### 阅读时间 / Read（文章有 readAt 字段时可用）

- `{{{dateRead}}}`
- `{{{yearRead}}}` / `{{{monthRead}}}` / `{{{dayRead}}}`

### 归档时间 / Archived（文章 isArchived=true 时可用）

- `{{{dateArchived}}}` - 归档时间
  - ⚠️ 在文件夹 / 文件名模板里：按"文章文件夹日期格式"渲染
  - ⚠️ 在正文 / 前置元数据模板里：渲染为原始 ISO 串（方便下游工具解析）
- `{{{yearArchived}}}` / `{{{monthArchived}}}` / `{{{dayArchived}}}`

### 更新时间 / Updated

- `{{{updatedAt}}}` - 仅正文 / 前置元数据模板可用，始终是原始 ISO 串
- `{{{yearUpdated}}}` / `{{{monthUpdated}}}` / `{{{dayUpdated}}}` - 所有模板都可用

> 📝 所有 `year*/month*/day*` 拆解变量都基于**本地时区**从 ISO 时间戳解出，始终两位补零（月份、日）或四位年。不受"文章文件夹日期格式"设置影响 —— 这样写 `{{{yearSaved}}}/{{{monthSaved}}}` 拼文件夹路径时，不用再额外配日期格式。

## 📄 文章基本信息 / Article Basic Info

- `{{{id}}}` - 文章ID / Article ID
- `{{{title}}}` - 文章标题 / Article title
- `{{{author}}}` - 作者 / Author
- `{{{siteName}}}` - 网站名称 / Website name
- `{{{originalUrl}}}` - 原文链接 / Original URL

## 📝 内容与元数据 / Content & Metadata

- `{{{content}}}` - 文章内容 / Article content
- `{{{labels}}}` - 标签 / Labels
- `{{{type}}}` - 内容类型 / Content type (ARTICLE, FILE, etc.)
- `{{{state}}}` - 状态 / State (INBOX, READING, COMPLETED, ARCHIVED)
- `{{{wordsCount}}}` - 字数 / Word count

## 🔧 自定义函数 / Custom Functions

- `{{#lowerCase}}text{{/lowerCase}}` - 转小写 / Convert to lowercase
- `{{#upperCase}}text{{/upperCase}}` - 转大写 / Convert to uppercase
- `{{#upperCaseFirst}}text{{/upperCaseFirst}}` - 首字母大写 / Capitalize first letter
- `{{#formatDate}}dateSaved, yyyy-MM-dd{{/formatDate}}` - 自定义日期格式 / Custom date format
- `{{#mapValue}}取值\|规则表{{/mapValue}}` - 值映射 / Map a value by rules

### mapValue 值映射 / Value mapping

把某个变量的值按规则映射成另一个值，常用于把平台名转成业务分类（例如属性
`type` 写「视频转图文 / 播客整理」）。语法：

```
{{#mapValue}}<取值表达式>|<规则表>{{/mapValue}}
```

- `<取值表达式>` 先按模板渲染（可写 `{{{siteName}}}` 等），渲染后首尾空白被裁剪。
- `<规则表>` 是逗号分隔的 `pattern=result`：
  - 精确：`抖音=视频转图文` —— 取值完全等于「抖音」时命中
  - 通配：`*播客*=播客整理` —— 取值**含**「播客」时命中（contains）
  - 兜底：`*=其他` —— 上面都不命中时用它
- 命中优先级（与书写顺序无关）：**精确 > 通配 > 兜底 > 原值**（无规则命中且无兜底 → 原样返回取值）。

示例（属性/前置元数据模板里）：

```
type: {{#mapValue}}{{{siteName}}}|抖音=视频转图文,快手=视频转图文,*播客*=播客整理,*=其他{{/mapValue}}
```

- `siteName=抖音` → `视频转图文`
- `siteName=小宇宙播客` → `播客整理`（命中 `*播客*`）
- `siteName=知乎` → `其他`（命中兜底）

> 局限：`pattern` 不能含 `=`；`pattern`/`result` 不能含 `,`（都是分隔符）；通配仅支持
> `*xxx*` 两端星号的 contains，不支持前缀/后缀/正则。取值表达式渲染后可安全包含 `|`。

## 🔗 Templater 变量接力 / Templater Interop（文章模板 + 消息模板）

装有 [Templater](https://github.com/SilentVoid13/Templater) 插件时，**文章模板**与
**助手消息模板**里的 `<% %>` 插值会在**每轮同步开始时**由 Templater 渲染一次，例如：

```
<% tp.web.random_picture("512x384", "landscape") %>
日期:: [[<% tp.date.now("YYYY-MM-DD") %>]]
{{{content}}}
```

规则 / Rules：

- 只支持 `<% 表达式 %>` 插值；`<%* 执行块 %>` 不支持，会**原样保留**在笔记里不执行。
- 不支持依赖目标文件上下文的调用：`tp.file.*`、`tp.frontmatter.*`、`tp.config.*`、
  `tp.hooks.*`、`tp.system.prompt/suggester` —— 一律原样保留（渲染时目标文件往往尚未创建，
  给出错误值比不渲染更糟）。
- `tp.date.now` 取的是**本轮同步时刻**（一轮内所有消息相同）；每条消息各自的时间请继续用
  `{{{dateSaved}}}`。
- 未安装/未启用 Templater、渲染失败或超时：标签原样落盘，同步照常（非破坏降级）。
- 未闭合的 `<%` 或 `<%%` 会让 Templater 静默放弃整个模板的渲染，设置页会实时提醒。

## 💡 使用示例 / Examples

### 文件名示例 / Filename Examples

```
{{{yearSaved}}}-{{{monthSaved}}}-{{{daySaved}}}-{{{title}}}
```
结果：2025-01-23-文章标题

### 文件夹示例 / Folder Examples

```
{{{yearSaved}}}/{{{monthSaved}}}
```
结果：2025/01

### 自定义日期格式 / Custom Date Format

```
{{#formatDate}}dateSaved, yyyy年MM月dd日{{/formatDate}}
```
结果：2025年01月23日

## 应用场景 / Use Cases

### 1. 文件夹路径 (Folder Path)
可在"文件夹"设置中使用这些变量来动态组织文件结构。

### 2. 文件名 (Filename)
可在"文件名"设置中使用这些变量来自动命名文件。

### 3. 文章模板 (Article Template)
可在"文章模板"设置中使用这些变量来自定义文章内容的显示格式。

### 4. 前置元数据模板 (Front Matter Template)
可在"前置元数据模板"设置中使用这些变量来自定义 YAML 格式的元数据。

### 5. 助手消息模板 (Assistant Message Template)
可在"助手消息模板"设置中使用这些变量来自定义企微消息的显示格式。

### 6. 合并文件模板 (Merged File Template)
可在"合并文件模板"设置中自定义**合并消息文件的文件头**（新建那一刻写进去的：笔记属性 /
标题 / 说明）。留空 = 保持历史行为（创建空文件，只有消息）。

> ⚠️ 这个模板的变量集与上面几处**不同**（它渲染的是"文件"而不是"某一篇内容"），
> 只有以下两个：

| 变量 | 含义 |
|------|------|
| `{{{date}}}` | 该合并文件的日期，按"消息文件日期格式"渲染（与文件名里的 `{{{date}}}` 同值） |
| `{{{title}}}` | 该合并文件的文件名（不含 `.md`） |

示例：

```
---
tags: [消息]
---

# 📮 {{{date}}} 的消息
```

说明：

- **不会往笔记里写任何隐藏标记 / 锚点。** 插件靠"由模板反推出来的正则"在正文开头认出
  文件头（模板里的变量位置是通配符，所以日期换了也认得），把新消息插在它下面。
- 按时间**降序**（默认）时新消息紧跟在文件头之下；**升序**时追加到文件末尾。
- 你**手动改过文件头**之后插件就认不出了，此时新消息回到文件最前面 —— 只是排版退回旧样子，
  绝不会改动或删除你已有的任何内容。
- 只影响**新建**的合并文件；已经存在的文件不会被改写。
- 模板**第一行的 `---` 会被 Obsidian 当作属性块起始**。想画分割线请挪到第二行之后；
  设置页会实时红字提示。

## 注意事项 / Notes

1. 使用三个大括号 `{{{variable}}}` 表示不转义 HTML
2. 使用两个大括号 `{{variable}}` 表示转义 HTML
3. 日期格式遵循标准的日期格式化规范
4. 自定义函数可以嵌套使用

---

更多信息请关注《笔记同步助手》服务号。
