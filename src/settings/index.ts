import { HighlightColors } from '../api'
import { DEFAULT_TEMPLATE } from './template'
import { getEndpointUrl } from './local-test'

export const FRONT_MATTER_VARIABLES = [
  'title',
  'author',
  'tags',
  'date_saved',
  'date_published',
  'omnivore_url',
  'site_name',
  'original_url',
  'description',
  'note',
  'type',
  'date_read',
  'words_count',
  'read_length',
  'state',
  'date_archived',
  'image',
]

export enum Filter {
  ALL = '同步所有文章',
}

export enum HighlightOrder {
  LOCATION = 'the location of highlights in the article',
  TIME = 'the time that highlights are updated',
}

export enum HighlightManagerId {
  HIGHLIGHTR = 'hltr',
  OMNIVORE = 'omni',
}

export enum ImageMode {
  LOCAL = 'local',       // 缓存到本地
  REMOTE = 'remote',     // 保留原始链接
  DISABLED = 'disabled'  // 不加载图片（注释掉）
}

export enum MergeMode {
  NONE = 'none',           // 不合并（每篇文章独立文件）
  MESSAGES = 'messages',   // 仅合并企微消息
  ALL = 'all',             // 合并所有文章
  // 双写：消息「一份进合并文件 + 再单独落一份文章笔记」，两份互不影响。
  // 展开设置与 MESSAGES 完全一致（合并副本用消息文件夹/消息文件名模板，
  // 独立副本用文章文件夹/文章文件名模板 = NONE 模式那一份）。
  DUAL = 'dual'
}

export enum MessageSortOrder {
  DESC = 'desc',   // 按时间降序（新消息在前）
  ASC = 'asc',     // 按时间升序（新消息在后）
}

export enum DiaryLinkType {
  ALL = 'all',           // 消息+文章
  MESSAGES = 'messages', // 仅消息
  ARTICLES = 'articles'  // 仅文章
}

/**
 * 日记双链的写入位置。
 * - ANCHOR：写在两个相同锚点标记之间（默认，历史行为；缺锚点则跳过）
 * - TOP：写在日记文件顶部（前置元数据之后），不需要锚点
 * - BOTTOM：追加到日记文件末尾，不需要锚点
 *
 * TOP / BOTTOM 没有锚点圈定的区域，去重范围放大到整个日记文件
 * （靠 <!-- notehelper:id:xxx --> 标记 + 整条 wikilink 串匹配），
 * 因此从 ANCHOR 切过来也不会把区域里已有的链接再插一遍。
 */
export enum DiaryWritePosition {
  ANCHOR = 'anchor',
  TOP = 'top',
  BOTTOM = 'bottom',
}

/**
 * 一批链接的写入顺序（仅「锚点之间」位置可选；顶部恒按降序、底部恒按升序）。
 * - DESC：时间降序，新的在前 —— 批次内按 savedAt 从新到旧排，整批插在区域【顶部】
 * - ASC：时间升序，新的在后 —— 批次内按 savedAt 从旧到新排，整批插在区域【底部】
 *
 * 注意这两件事是绑定的：只调批次内顺序而不调整批插入端，多轮同步后整体时间轴会拧成
 * 「批次之间降序、批次之内升序」的锯齿。
 */
export enum DiaryLinkOrder {
  DESC = 'desc',
  ASC = 'asc',
}

/**
 * 插件界面语言。
 * - AUTO：跟随 Obsidian / 系统语言（i18n 的三段探测：localStorage.language →
 *   moment.locale → navigator.language，最终兜底中文）。
 * - ZH：强制中文，不管插件/Obsidian 是什么语言。
 * - EN：强制英文。
 */
export enum PluginLanguage {
  AUTO = 'auto',
  ZH = 'zh',
  EN = 'en',
}

export type HighlightColorMapping = { [key in HighlightColors]: string }

/** 单台设备独立的自动同步配置 */
export interface DeviceAutoSyncConfig {
  frequency: number      // 自动同步间隔（秒）；0 表示关闭自动同步
  syncOnStart: boolean   // 启动时是否自动同步
}

/**
 * 自动同步的最低间隔（秒）。0（仅手动同步）不受此限；
 * 1~59 的输入与存量值在生效时一律按此值处理（2026-08 Phase 2 起，原下限 15）。
 */
export const MIN_AUTO_SYNC_FREQUENCY = 60

/** 旧版默认前置元数据模板，仅用于迁移比对 */
export const OLD_DEFAULT_FRONT_MATTER_TEMPLATE =
  'author: {{{author}}}\nsource: {{{siteName}}}\nurl: {{{originalUrl}}}\nsaved: {{{dateSaved}}}\ntags: {{#labels}}[{{{name}}}]{{/labels}}'

/**
 * 上一版默认前置元数据模板，仅用于迁移比对。
 * 这一版本里 `tags: [笔记同步助手]{{#labels}}[{{{name}}}]{{/labels}}` 渲染出
 * 形如 `tags: [笔记同步助手][a][b]` 的非法 YAML，会被 sanitize 兜底为单个字符串
 * `'[笔记同步助手][a][b]'` —— 多 label 用户的 tags 会被挤成一坨，对 Obsidian
 * 标签面板不可用。新版默认改成 flow 风格 + 逗号分隔（见 DEFAULT_SETTINGS.frontMatterTemplate）。
 */
export const PREV_DEFAULT_FRONT_MATTER_TEMPLATE =
  'author: {{{author}}}\nsource: {{{siteName}}}\nurl: {{{originalUrl}}}\nsaved: {{{dateSaved}}}\ntags: [笔记同步助手]{{#labels}}[{{{name}}}]{{/labels}}'

export const DEFAULT_SETTINGS: OmnivoreSettings = {
  dateHighlightedFormat: 'yyyy-MM-dd HH:mm:ss',
  dateSavedFormat: 'yyyy-MM-dd HH:mm:ss',
  apiKey: '',
  filter: 'ALL',
  syncAt: '',
  customQuery: '',
  customQueryNormalized: false,
  template: DEFAULT_TEMPLATE,
  highlightOrder: 'LOCATION',
  folder: '笔记同步助手/{{{date}}}',
  folderDateFormat: 'yyyy-MM-dd',
  endpoint: getEndpointUrl('https://obsidian.notebooksyncer.com/api/graphql'),
  filename: '{{{title}}}',
  filenameDateFormat: 'yyyy-MM-dd',
  attachmentFolder: '笔记同步助手/attachments',
  version: '0.0.0',
  mergeMode: MergeMode.MESSAGES,  // 默认仅合并企微消息
  messageSortOrder: MessageSortOrder.DESC,  // 消息排序：默认按时间降序（新消息在前）
  messageFolder: '',  // 消息文件夹路径（空字符串时回退到 folder）
  frequency: 0,
  intervalId: 0,
  frontMatterVariables: [],
  frontMatterTemplate: 'author: {{{author}}}\nsource: {{{siteName}}}\nurl: {{{originalUrl}}}\nsaved: {{{dateSaved}}}\ntags: [笔记同步助手{{#labels}}, {{{name}}}{{/labels}}]',
  syncOnStart: false,
  enableHighlightColorRender: false,
  highlightManagerId: HighlightManagerId.OMNIVORE,
  highlightColorMapping: {
    [HighlightColors.Yellow]: '#fff3a3',
    [HighlightColors.Red]: '#ff5582',
    [HighlightColors.Blue]: '#adccff',
    [HighlightColors.Green]: '#bbfabb',
  },
  singleFileName: '同步助手_{{{date}}}',  // 新增: 单文件模式的文件名模板
  singleFileDateFormat: 'yyyy-MM-dd',  // 新增: 单文件模式的日期格式
  // 合并文件模板：新建合并文件时的初始内容（页眉/属性/页脚骨架）。
  // 默认空 = 历史行为（创建空文件），零回归；见 sync/mergeFileTemplate.ts
  mergeFileTemplate: '',
  sectionSeparator: '%%{{{dateSaved}}}_start%%',  // 新增: 单文件模式中消息分隔符起始标记(空字符串表示不分隔)
  sectionSeparatorEnd: '%%{{{dateSaved}}}_end%%',  // 新增: 单文件模式中消息分隔符结束标记
  wechatMessageTemplate: '---\n#### {{{heading}}}\n## 📅 {{{dateSaved}}}\n{{{content}}}',  // 新增: 企微消息简洁模板（heading为内容摘要，用于日记链接锚点）
  // 图片处理设置
  imageMode: ImageMode.LOCAL,  // 图片处理模式（默认缓存到本地）
  enablePngToJpeg: false,  // PNG转JPEG（默认关闭）
  jpegQuality: 85,  // JPEG质量（0-100，默认85）
  imageDownloadRetries: 5,  // 图片下载重试次数（默认5，指数退避；图床源站未就绪属瞬态，多退避几次更稳）
  imageAttachmentFolder: '笔记同步助手/images',  // 图片存储文件夹
  // 日记链接设置
  enableDiaryLinks: false,              // 启用日记链接功能
  diaryFolder: 'Daily Notes',           // 日记文件夹路径
  diaryDateFormat: 'yyyy-MM-dd',        // 日记文件名日期格式
  diaryAnchor: 'notehelper-links',      // 锚点标识
  diaryWritePosition: DiaryWritePosition.ANCHOR,  // 写入位置：默认锚点之间（历史行为）
  diaryLinkOrder: DiaryLinkOrder.DESC,  // 锚点区域内写入顺序：默认时间降序（新的在前，历史行为）
  diaryLinkType: DiaryLinkType.ALL,     // 链接类型
  autoCreateDiaryNote: false,            // 自动创建日记文件
  diaryLinkPrefix: '- ',                 // 双链前缀
  diaryLinkMaxLength: 0,                 // 双链显示文字最大字符数（0=不限制）
  // 设备级同步游标
  deviceSyncCursors: {},                 // 各设备独立的同步时间戳
  initialSyncCompleted: false,           // 首次同步是否已完成
  firstSyncAutoOpened: false,            // 首次同步是否已自动打开笔记并弹过说明（只触发一次）
  // 设备级自动同步配置（每台设备独立的 frequency/syncOnStart）
  deviceAutoSync: {},                    // { [deviceId]: { frequency, syncOnStart } }
  deviceAutoSyncMigrated: false,         // 是否已把顶层 frequency/syncOnStart 迁移到当前设备
  // 内容处理
  escapeHashtags: false,                 // 转义正文中的 # 标签（默认关闭）
  // 界面语言（默认中文，无视插件/Obsidian 语言；用户可在高级设置改为「跟随系统」或英文）
  language: PluginLanguage.ZH,
  // 调试日志
  enableDebugLog: false,                 // 运行时开启调试日志
  // 调试模式：一键把最近笔记按「默认位置 + 近 24h + 自动打开」重新拉一份用于排查
  // 「收到公众号推送成功但 Obsidian 里看不到笔记」。默认关；仅手动同步生效；运行期覆盖位置字段，
  // 不落盘覆盖用户配置；强制关闭阅后即焚；不推进游标。
  debugMode: false,
  // 阅后即焚（默认关闭）
  burnAfterReading: false,               // 成功落盘+本地化后删除云端文章；合并改非 lossy 精确去重
  burnAfterReadingEnabledAt: '',         // 开启确认时写入 ISO；为空=从未开过。legacy Bloom 迁移阈值用
  pendingBurnDeletes: [],                // 持久化：删除/本地化失败的待重试队列（游标已越过、内存记录会丢，必须落盘）
  // 「无 id」模式（默认都关；开启需设置页二次确认弹窗）
  disableMessageMarkers: false,          // 合并消息不再写 <!--nh:id--> 隐形注释符，去重纯靠最新同步游标（时间）
  omitFrontmatterId: false,              // 笔记属性不写 id（合并模式也不写 syncedIds），去重纯靠最新同步游标
  disableDiaryLinkMarkers: false,        // 日记双链不写 <!-- notehelper:id:… --> 隐形注释符，去重纯靠最新同步游标
}

export interface OmnivoreSettings {
  apiKey: string
  // 高级/测试用：覆盖 VIP 状态接口（/user-config[/refresh]）的基址。
  // 生产用户不设置（恒为 undefined → 打生产域名）；仅 E2E harness 写入指向本地 mock。
  vipApiBase?: string
  filter: string
  syncAt: string
  customQuery: string
  // 「筛选器/自定义查询」下线后的一次性归一化标记（见 settings/queryNormalize.ts）
  customQueryNormalized: boolean
  highlightOrder: string
  template: string
  folder: string
  folderDateFormat: string
  endpoint: string
  dateHighlightedFormat: string
  dateSavedFormat: string
  filename: string
  attachmentFolder: string
  version: string
  mergeMode: MergeMode
  messageSortOrder: MessageSortOrder  // 消息排序方式
  messageFolder: string  // 消息文件夹路径（空字符串时回退到 folder）
  frequency: number
  intervalId: number
  frontMatterVariables: string[]
  frontMatterTemplate: string
  filenameDateFormat: string
  syncOnStart: boolean
  enableHighlightColorRender: boolean
  highlightManagerId: HighlightManagerId
  highlightColorMapping: HighlightColorMapping
  singleFileName: string  // 新增: 单文件模式的文件名模板
  singleFileDateFormat: string  // 新增: 单文件模式的日期格式
  // 合并文件模板：新建合并文件时写入的初始内容（Mustache；空 = 创建空文件，历史行为）
  mergeFileTemplate: string
  sectionSeparator: string  // 新增: 单文件模式中消息分隔符起始标记(空字符串表示不分隔)
  sectionSeparatorEnd: string  // 新增: 单文件模式中消息分隔符结束标记
  wechatMessageTemplate: string  // 新增: 企微消息简洁模板
  // 图片处理设置
  imageMode: ImageMode  // 图片处理模式
  enablePngToJpeg: boolean  // PNG转JPEG
  jpegQuality: number  // JPEG质量（0-100）
  imageDownloadRetries: number  // 图片下载重试次数
  imageAttachmentFolder: string  // 图片存储文件夹
  // 日记链接设置
  enableDiaryLinks: boolean           // 启用日记链接功能
  diaryFolder: string                 // 日记文件夹路径
  diaryDateFormat: string             // 日记文件名日期格式
  diaryAnchor: string                 // 锚点标识
  diaryWritePosition: DiaryWritePosition  // 写入位置：锚点之间 / 文件顶部 / 文件底部
  diaryLinkOrder: DiaryLinkOrder      // 批次写入顺序（仅锚点位置可选）
  diaryLinkType: DiaryLinkType        // 链接类型
  autoCreateDiaryNote: boolean          // 自动创建日记文件
  diaryLinkPrefix: string               // 双链前缀
  diaryLinkMaxLength: number            // 双链显示文字最大字符数（0=不限制）
  // 设备级同步游标
  deviceSyncCursors: Record<string, string>  // 各设备独立的同步时间戳
  initialSyncCompleted: boolean              // 首次同步是否已完成
  // 首次同步：成功落盘+本地化后自动打开最新笔记并延迟弹窗说明，整个生命周期只触发一次
  firstSyncAutoOpened: boolean               // 首次同步自动打开+弹窗是否已发生过
  // 高级/测试用：覆盖首次同步说明弹窗的延迟（毫秒）。
  // 生产用户不设置（恒为 undefined → 用 FIRST_SYNC_NOTICE_DELAY_MS=15000）；仅 E2E harness 写入以加速测试。
  firstSyncNoticeDelayMs?: number
  // 设备级自动同步配置
  deviceAutoSync: Record<string, DeviceAutoSyncConfig>  // 每台设备独立的 frequency/syncOnStart
  deviceAutoSyncMigrated: boolean                       // 是否已把顶层 frequency/syncOnStart 迁移到当前设备
  // 内容处理
  escapeHashtags: boolean                    // 转义正文中的 # 标签
  // 界面语言：AUTO 跟随系统；ZH 强制中文；EN 强制英文
  language: PluginLanguage
  // 调试日志
  enableDebugLog: boolean                    // 运行时开启调试日志
  // 调试模式：手动同步时按「默认位置 + 近 24h + 自动打开」重新拉一份，用于排查「收到推送但看不到笔记」
  debugMode: boolean
  // 高级/测试用：覆盖调试模式的时间窗口（毫秒）。
  // 生产用户不设置（恒为 undefined → 用 DEBUG_WINDOW_MS=24h）；仅 E2E harness 写入以加速/确定化测试。
  debugWindowMs?: number
  // 阅后即焚
  burnAfterReading: boolean                  // 成功落盘+本地化后删除云端文章；合并改非 lossy 精确去重
  burnAfterReadingEnabledAt: string          // 开启确认时写入 ISO；为空=从未开过。legacy Bloom 迁移阈值
  pendingBurnDeletes: PendingBurnDelete[]    // 持久化：删除/本地化失败的待重试队列
  // 「无 id」模式（开启需二次确认；去重退化为「最新同步游标」，多设备须用实时同步方案，见 cursorDedupe.ts）
  disableMessageMarkers: boolean             // 合并消息不写 <!--nh:id--> 注释符，去重纯靠最新同步游标
  omitFrontmatterId: boolean                 // 笔记属性不写 id（合并模式也不写 syncedIds），去重纯靠最新同步游标
  // 日记双链不写 <!-- notehelper:id:… --> 注释符，去重纯靠最新同步游标。
  // ⚠️ 与另外两个同构但作用面不同：它管的是【日记文件】。开启后 addLink 会按游标
  // 提前筛掉「已同步过」的 item —— 因为没有标记可查，不筛就只剩脆弱的整条 wikilink
  // 串匹配兜底（标题/正文微变即重复，见 diaryLinkRepeatSync.spec.ts）。
  disableDiaryLinkMarkers: boolean
}

/**
 * 阅后即焚：持久化的「待删除/待重试」记录。
 * 删除失败或本地化未完成时，游标可能已越过该 item → 下轮不会再被拉到、
 * 内存记录也随同步结束丢失，所以必须落盘到 settings，每轮同步开头补删。
 */
export interface PendingBurnDelete {
  id: string
  updatedAt: string              // 用于精确数组裁剪阈值比对（updatedAt 系）
  filePath: string               // 目标笔记，用于本地化残留复查
  originalImageUrls: string[]    // 本地化前的原始远程图片 URL（仅 imageMode=LOCAL 时复查残留）
  originalAttachmentUrls: string[] // 本地化前的原始远程附件 URL（任何模式都复查）
  reason: string                 // 'delete-failed' | 'localization-pending'
  lastTriedAt: string            // 上次尝试时间 ISO
}
