// 中文字典。结构必须与 ./en.ts 完全一致，tests/i18nKeyConsistency.spec.ts 会校验。

import type { Dict } from './en'

const zh: Dict = {
  common: {
    refresh: '刷新',
    refreshing: '刷新中...',
    cancel: '取消',
    confirm: '确认',
    retry: '重试',
    phonePcSyncLink: '手机电脑同步',
  },
  versionCheck: {
    versionLabel: '笔记同步助手版本',
    checkButton: '检查更新',
    checking: '正在检查更新...',
    upToDate: '✅ 已是最新版本',
    fetchFail: '无法获取最新版本信息',
    failGeneric: '检查更新失败，请稍后重试',
    foundNew: '发现新版本',
    // 市场版：不做任何自更新，引导用户去 Obsidian 第三方插件页升级
    goToPluginPage: '前往第三方插件页升级',
    // 同步状态 Notice 下方的弱升级提醒行；{version} 会被替换成最新版本号
    reminderLine: '发现新版本 {version}，点击前往第三方插件页升级',
    configRestored: '配置已从备份恢复',
  },
  settings: {
    // Phase-2 IA：设置页分区（一级折叠 + VIP中心内二级折叠）的标题与摘要
    section: {
      vip: {
        name: 'VIP中心',
        sub: '会员、云空间与问题诊断',
      },
      vipCloud: {
        name: '云空间',
        sub: '内容数量与清理',
      },
      vipDiag: {
        name: '问题诊断',
        sub: '调试、配置导出与版本',
      },
      sync: {
        name: '同步设置',
        sub: '同步时机与同步位置',
      },
      path: {
        name: '路径设置',
        sub: '文章、消息与模板的存放与渲染',
        article: '文章设置',
        message: '消息处理',
        template: '模板设置',
      },
      imageSub: '图片下载与转换',
      diarySub: '同步完成后在日记中插入内容链接',
      system: {
        name: '系统设置',
        sub: '界面语言与更新检查',
      },
      clearCloud: {
        name: '清空云空间',
        desc: '永久删除云空间中的所有文章与消息，不可恢复。',
      },
    },
    apiKey: {
      name: '密钥',
      desc: '请关注《笔记同步助手》公众号获取密钥',
      placeholder: '输入您的密钥',
    },
    help: {
      name: '帮助与资源',
      desc: '教程、模拟器与云空间管理入口集中于此。',
      link: {
        tutorial: '详细教程',
        pathSimulator: '文件路径配置模拟器',
        contentProcessing: '云空间内容处理设置',
        openCloudSpace: '在线查看云空间',
      },
    },
    debugMode: {
      hint: '收到公众号推送的成功提醒，但 Obsidian 里不显示笔记？打开调试模式',
      name: '调试模式',
      desc: '排查专用。手动同步时，把近 24 小时的内容重新拉取到「默认位置」并自动打开笔记。不会改动你的设置，也不会删除任何数据。排查完请关闭。',
      modalTitle: '调试模式',
      modalBody1: '笔记会写入到「默认设置的位置」（忽略你自定义的文件夹/文件名模板）。若你改过保存位置，会在默认位置另存一份用于排查。',
      modalBody2: '会重新拉取「近 24 小时」的文章 / 消息。',
      modalBody3: '拉取后会自动打开新笔记（电脑端最多 3 篇，手机端最多 1 篇）。',
      modalNote: '仅影响手动同步；不会推进你的同步游标、不改动任何设置——关闭调试模式即可完全复原。',
      confirm: '开启调试模式',
      saveFailed: '保存调试模式失败，请重试。',
    },
    vip: {
      heading: '会员中心',
      delayNote:
        '插件端会员状态有约 15 分钟延迟。如需查看实时会员状态及有效期，请在「笔记同步助手」服务号底部「会员」菜单查询。',
      loading: '加载中...',
      qrAlt: '二维码',
      refreshFresh: '刷新高级权益状态',
      refreshFreshHint:
        '刚开通/续费会员但上方状态没更新？点此立即从服务器拉取最新的高级权益状态。',
      refreshed: '已刷新到最新会员状态',
      refreshFailed: '刷新失败，请检查网络后重试',
      rateLimited: '刷新过于频繁，请稍后再试（10 分钟内最多 10 次）。',
      needKey: '请先在上方填写密钥',
    },
    article: {
      heading: '文章管理',
      count: {
        name: '云空间内容数量',
        desc: '显示云空间中文章和消息的总数量。消息合并模式默认开启，一天的消息会合并到同一个笔记中。',
        currentLabel: '当前数量',
        currentLoading: '--',
        refreshing: '刷新中...',
        clearButton: '清空云空间',
        clearing: '清空中...',
        confirmTitle: '清空云空间文章',
        confirmBody:
          '⚠️ 此操作将删除云空间中的所有文章，且无法恢复。\n\n您确定要继续吗？',
        noticeClearStart: '正在清空文章...',
        noticeFetchFail: '获取文章数量失败，请检查API密钥是否正确',
        noticeClearFail: '清空文章失败，请稍后重试',
        noticeFetchFailShort: '获取失败',
      },
    },
    sync: {
      heading: '同步',
      syncOnStart: {
        name: '启动时同步（本设备）',
        desc: '勾选此选项在应用加载时自动同步。此设置仅对当前设备生效。',
        deviceIdLabel: '当前设备 ID',
        otherDevicesLabel: '其他设备已配置',
      },
      frequency: {
        name: '频率（本设备）',
        desc:
          '自动同步的间隔（秒）。0 表示仅手动同步；最低 60 秒，低于 60 将自动按 60 生效。此设置仅对当前设备生效。',
        placeholder: '输入频率（秒）',
        noticeMustBePositive: '频率必须是正整数',
        noticeClamped: '自动同步最低 60 秒，已按 60 生效',
      },
      lastSync: {
        name: '最后同步',
        desc: '上次同步的时间。同步命令将获取此时间戳之后更新的文章。您可以手动修改此时间来控制同步范围。',
        placeholder: '最后同步',
      },
      mergeMode: {
        name: '消息合并模式',
        descIntro: '选择文章和消息的合并方式：',
        labelNone: '不合并',
        descNone: '每篇文章独立文件（标题相同时自动添加数字后缀）。',
        labelMessages: '仅合并消息',
        descMessages: '企微消息按日期合并，普通文章独立保存（推荐）。',
        labelAll: '合并所有',
        descAll: '同名文章和消息都合并到一个文件。',
        labelDual: '双写',
        descDual: '消息按日期合并成一个文件的同时，每条消息再单独存一份笔记（两份内容互不影响）。',
        optionNone: '不合并',
        optionMessages: '仅合并消息',
        optionAll: '合并所有',
        optionDual: '双写（合并 + 独立各一份）',
      },
      messageSortOrder: {
        name: '消息排序',
        descIntro: '合并消息在文件中的排列顺序：',
        labelDesc: '按时间降序',
        descDesc: '新消息在前（默认）。',
        labelAsc: '按时间升序',
        descAsc: '新消息在后。',
        optionDesc: '按时间降序',
        optionAsc: '按时间升序',
      },
      messageFolder: {
        name: '消息文件夹',
        desc: '消息合并文件的存储路径，留空则使用文章文件夹路径。',
      },
      messageFileName: {
        name: '消息文件名称模板',
        descBefore: '设置消息合并文件的名称模板，使用 ',
        descAfter: ' 作为日期变量。',
        examplesIntro: '示例：',
        placeholder: '同步助手_{{{date}}}',
      },
      messageFileDateFormat: {
        name: '消息文件日期格式',
        desc: '设置消息文件名称中日期变量的格式。可参考 moment.js 的格式文档。',
        examplesIntro: '常用格式示例：',
        examplePrefix: '例',
        placeholder: '日期格式：yyyy-MM-dd',
      },
      mergeFileTemplate: {
        name: '合并文件模板',
        desc:
          '自定义合并消息文件的「文件头」：笔记属性、标题、说明。只在【新建】该合并文件时写一次，消息接在它下面。留空 = 保持现在的样子（空文件，只有消息）。已存在的文件不会被改写。',
        varsIntro: '可用变量：',
        varDate: '• {{{date}}} = 该文件的日期（按上方「消息文件日期格式」）',
        varTitle: '• {{{title}}} = 该文件的文件名',
        examplesIntro: '示例：',
        example1: '• # 📮 {{{date}}} 消息 → 一行日期标题',
        example2: '• ---\\ntags: [消息]\\n---\\n\\n# {{{title}}} → 带笔记属性 + 标题',
        hint:
          '提示：不会往笔记里写任何隐藏标记。按时间降序时新消息紧跟在文件头之下；你手动改过文件头之后，新消息会回到文件最前面。',
        debugLink: '在线调试模板',
        placeholder: '# 📮 {{{date}}} 消息',
        invalidWarning: '⚠ 这个模板落盘后会被 Obsidian 误读，请调整：',
        resetTooltip: '清空（恢复默认空文件）',
        noticeReset: '合并文件模板已清空',
      },
      noMessageMarker: {
        name: '消息不写 id',
        desc: '不再在合并消息末尾写入用于去重的隐藏注释符（<!--nh:…-->，内含消息 id），是否重复完全按时间（最新同步游标）判断。',
        confirmTitle: '确认消息不写 id？',
        confirmBody:
          '开启后，合并消息不再携带隐藏注释符，去重完全依靠最新同步游标（按时间判断）。\n\n⚠️ 重要：开启后跨设备同步【不能】使用网盘方案（坚果云、iCloud、OneDrive 等同步库文件夹）——网盘延迟大且通常不同步插件数据，会造成消息重复或丢失。Obsidian Sync、「手机电脑同步」插件均可正常使用。\n\n另外：手动回拨「最后同步」时间会让已有消息重复写入；已写入的历史注释符会保留、仍参与去重。',
      },
      articleFolder: {
        name: '文章文件夹',
        desc:
          '输入数据存储的文件夹路径。支持变量 {{{title}}}、{{{dateSaved}}}、{{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}。',
        placeholder: '输入文件夹',
      },
      articleFolderDateFormat: {
        name: '文章文件夹日期格式',
        desc: '文件夹路径里日期变量的格式，例如：yyyy-MM-dd。',
        placeholder: '日期格式',
      },
      attachmentFolder: {
        name: '附件文件夹',
        desc:
          '输入附件下载的文件夹路径。支持变量 {{{title}}}、{{{dateSaved}}}、{{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}。',
        placeholder: '输入附件文件夹',
      },
      articleFilename: {
        name: '文章文件名',
        desc:
          '输入数据存储的文件名。支持变量 {{id}}、{{{title}}}、{{{dateSaved}}}、{{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}。',
        debugLink: '在线调试模板',
        placeholder: '输入文件名',
      },
      articleFilenameDateFormat: {
        name: '文章文件名日期格式',
        desc: '文章文件名里日期变量的格式，可参考 moment.js 的格式文档。',
        placeholder: 'yyyy-MM-dd',
      },
    },
    content: {
      heading: '内容处理',
      escapeHashtags: {
        name: '转义文中标签',
        desc:
          '开启后，同步的文章正文中的 #标签 会被转义为 \\#标签，防止 Obsidian 将其识别为标签干扰你的标签体系。',
      },
    },
    // 文章模板 / 消息模板里 Templater 用法的实时提示（只提示、不阻断保存）
    templater: {
      warnUnclosed:
        '⚠️ 检测到未闭合的 <% 标签：请补全 %> 或删掉多余的 <%，否则模板可能渲染异常。',
      marketPassthrough:
        'ℹ️ 本版本不执行 Templater <% %> 插值，相关标签会原样保留在笔记中。',
    },
    advanced: {
      heading: '高级选项',
      language: {
        name: '界面语言',
        desc: '本插件界面的显示语言。选「中文」后，即使 Obsidian 和系统是英文也强制显示中文；「跟随系统」会根据 Obsidian / 操作系统自动判断。',
        optAuto: '跟随系统',
        optZh: '中文',
        optEn: 'English（英文）',
      },
      articleSubheading: '文章选项',
      frontMatter: {
        name: '前置元数据',
        descMain:
          '输入用于笔记的元数据，用逗号分隔。您也可以使用自定义别名，格式为 metadata::alias，例如 date_saved::date。',
        descBelow: '如果要使用自定义前置元数据模板，可在下方输入。',
        placeholder: 'title, author, tags, date_saved',
        noticeAutoMoved:
          '检测到模板格式，已自动保存到下方"前置元数据模板"字段。',
      },
      frontMatterTemplate: {
        name: '笔记属性模板',
        descMain: '输入 YAML 模板来渲染前置元数据。',
        descOverride: '如果设置了此模板，它将覆盖上方的前置元数据变量。',
        debugLink: '在线调试模板',
        placeholder: 'author: {{{author}}}\nsource: {{{siteName}}}\ntags: [同步]',
        resetTooltip: '重置前置元数据模板',
        noticeReset: '前置元数据模板已重置',
        invalidWarning:
          '⚠ 这个模板在同步时会触发 YAML 解析失败，用户字段会丢失，落盘只剩 id 和 omnivore_error：',
        invalidHint:
          '\n\n可以点上方"在线调试模板"链接在模拟器里定位具体问题行。',
        sanitizeWarning:
          '提示：首次 YAML 解析失败，插件会自动补双引号后解析成功。\n建议手动给含特殊字符的字段加 "..." 避免未来踩坑。',
      },
      omitFrontmatterId: {
        name: '笔记属性不写 id',
        desc: '同步的笔记属性（frontmatter）不再包含 id 字段（合并模式下也不再写 syncedIds），是否重复完全按时间（最新同步游标）判断。',
        confirmTitle: '确认笔记属性不写 id？',
        confirmBody:
          '开启后，新同步的笔记属性不再写入 id（合并模式下也不写 syncedIds），去重完全依靠最新同步游标（按时间判断）。\n\n代价与限制：\n• 插件无法再按 id 识别既有笔记：改名/移动过的笔记重新同步时可能重复建文件；同名的不同文章会被当成同一篇。\n• 跨设备同步【不能】使用网盘方案（坚果云、iCloud、OneDrive 等）；Obsidian Sync、「手机电脑同步」插件均可正常使用。\n• 手动回拨「最后同步」时间会导致重复写入。\n\n开启前已同步的笔记不会被批量改动（其中的 id / syncedIds 保留、仍参与去重）；但某篇笔记之后有内容更新时，更新落盘的新属性同样不再含 id。开启「阅后即焚」时本设置不生效（阅后即焚必须依赖 id 精确识别）。',
      },
      articleTemplate: {
        name: '文章模板',
        descMain: '输入文章渲染模板。',
        descBelow: '如果要使用自定义前置元数据模板，可在下方输入。',
        debugLink: '在线调试模板',
        placeholder: '输入模板',
        resetTooltip: '重置模板',
        noticeReset: '模板已重置',
      },
      dateSavedFormat: {
        name: '保存日期格式',
        desc: '渲染模板中 dateSaved 变量的日期格式，示例：yyyy-MM-dd\'T\'HH:mm:ss',
        placeholder: 'yyyy-MM-dd\'T\'HH:mm:ss',
      },
      assistantTemplate: {
        name: '助手消息模板',
        desc:
          '设置助手消息（标题格式：同步助手_yyyyMMdd_xxx）的显示模板。助手消息会自动使用此简洁模板，去除标题、标签等冗余信息。',
        varsIntro: '可用变量：',
        varDate: '• {{{dateSaved}}} = 保存时间',
        varContent: '• {{{content}}} = 消息内容',
        varTitle: '• {{{title}}} = 标题',
        varId: '• {{{id}}} = ID',
        examplesIntro: '示例：',
        example1: '• ---\\n## 📅 {{{dateSaved}}}\\n{{{content}}} → 使用分隔线和二级标题（推荐）',
        example2: '• {{{content}}} → 仅显示内容',
        example3: '• 📅 {{{dateSaved}}}\\n{{{content}}} → emoji + 时间 + 内容',
        debugLink: '在线调试模板',
        placeholder: '---\\n## 📅 {{{dateSaved}}}\\n{{{content}}}',
        resetTooltip: '重置为默认模板',
        noticeReset: '助手消息模板已重置',
      },
      templateVars: {
        name: '可用模板变量',
        descIntro: '查看所有可用的模板变量和使用示例：',
        docLink: '模板变量文档',
      },
      debugLog: {
        name: '调试日志',
        desc: '开启后可在浏览器控制台查看详细日志，便于排查问题。',
        noticeOn: '调试日志已开启',
        noticeOff: '调试日志已关闭',
      },
      exportConfig: {
        name: '导出当前配置',
        desc: '下载当前插件配置文件 data.json。',
        button: '导出',
        noticeOk: '配置已导出',
        noticeFail: '导出失败：',
      },
      footer: '更多信息请关注《笔记同步助手》服务号。',
    },
    diary: {
      heading: '日记链接',
      enable: {
        name: '启用日记链接',
        desc: '同步完成后，自动在日记文件中插入同步内容的链接。',
        usageIntro: '使用说明：',
        step1: '1. 在日记模板中添加锚点：',
        step2: '2. 同步后链接会自动插入到锚点下方。',
        tutorialLink: '查看详细教程',
      },
      autoCreate: {
        name: '自动创建日记',
        desc:
          '开启后，日记文件不存在时自动创建。支持 Daily Notes 核心插件和 Periodic Notes 社区插件，自动读取其日记路径和模板配置。',
      },
      folder: {
        name: '日记文件夹',
        desc: '日记文件夹路径。留空时自动读取 Daily Notes / Periodic Notes 插件配置。',
        placeholder: '留空自动读取 DN/PN 配置',
      },
      dateFormat: {
        name: '日记日期格式',
        descIntro: '日记文件名的日期格式，使用 Luxon 格式化规则。',
        warnLiteral: '⚠️ 固定文本需用单引号转义：',
        exampleLiteral: "'[Daily]' yyyy-MM-dd",
        commonIntro: '常用格式：yyyy-MM-dd, yyyyMMdd, yyyy/MM/dd, ',
        exampleCommon: "'日记' yyyy-MM-dd",
        docLink: '📖 Luxon 格式化文档',
        previewOk: '预览',
        previewError: '格式错误',
        placeholder: '留空自动读取 DN/PN 配置',
      },
      writePosition: {
        name: '日记写入位置',
        desc:
          '链接写到日记的哪个位置。「锚点之间」需要在日记里放两个相同的锚点标记（默认）；「文件顶部」写在前置元数据之后、正文最上方；「文件底部」追加到文件末尾。顶部/底部都不需要锚点，去重范围为整个日记文件。',
        optionAnchor: '锚点之间（默认）',
        optionTop: '文件顶部',
        optionBottom: '文件底部',
      },
      anchor: {
        name: '锚点标识',
        descIntro: '在日记模板中放置两个相同的锚点标记：',
        descAfter: '链接将在两个锚点之间添加和去重。',
        placeholder: '<!-- notehelper-links -->',
      },
      linkOrder: {
        name: '写入顺序',
        desc:
          '一次同步多条时，锚点区域内的排列方式。「时间降序」：新的在前，整批压在区域最上方；「时间升序」：新的在后，整批追加到区域最下方。',
        optionDesc: '时间降序（新的在前）',
        optionAsc: '时间升序（新的在后）',
      },
      linkType: {
        name: '链接类型',
        desc: '选择要链接到日记的内容类型。',
        optionAll: '消息 + 文章',
        optionMessages: '仅消息',
        optionArticles: '仅文章',
      },
      linkPrefix: {
        name: '双链前缀',
        desc: '默认 "- "（Markdown 列表项）。留空则直接输出 [[链接]]。',
        previewLabel: '预览',
        sampleTitle: '示例文章标题',
        placeholder: '- ',
      },
      linkMaxLength: {
        name: '双链最大字符数',
        desc: '双链显示文字（| 后面的部分）的最大字符数，超出截断为 …。0 = 不限制。',
        placeholder: '0',
        noticeMustBeNonNegative: '双链最大字符数必须是非负整数',
      },
      noDiaryLinkId: {
        name: '日记不写 id',
        desc: '不再在日记双链末尾写入用于去重的隐藏注释符（<!-- notehelper:id:… -->），是否重复完全按时间（最新同步游标）判断。',
        confirmTitle: '确认日记不写 id？',
        confirmBody:
          '开启后，新写入日记的双链不再携带隐藏注释符，去重完全依靠最新同步游标（按时间判断）。\n\n⚠️ 重要：开启后跨设备同步【不能】使用网盘方案（坚果云、iCloud、OneDrive 等同步库文件夹）——网盘延迟大且通常不同步插件数据，会造成日记双链重复或缺失。Obsidian Sync、「手机电脑同步」插件均可正常使用。\n\n代价与限制：\n• 日记文件当时不存在（或锚点还没放好）而被跳过的那批链接，之后【不会】再补写——它们已被游标越过。请先建好日记/锚点再开启。\n• 手动回拨「最后同步」时间会让已有双链重复写入。\n• 已写入的历史注释符会保留、仍参与去重。\n• 开启「阅后即焚」时本设置不生效（阅后即焚必须依赖 id 精确识别）。',
      },
    },
    image: {
      heading: '图片处理',
      mode: {
        name: '图片处理模式',
        descIntro: '选择如何处理笔记中的图片：',
        labelLocal: '下载到本地',
        descLocal: '下载图片到本地存储。',
        labelRemote: '保留原始链接',
        descRemote:
          '保持网络图片链接不变。若已在云空间开启「云端图床接力」，请将图片处理模式设为「保留原始链接」，以保留图床链接。⚠️ 注意：保留原始链接时图片可能随时失效（源站删图、防盗链、链接过期）；即便经云空间延长图片有效期，最长也仅 30 天（头等舱权益）。如需长期可靠保存，请改用「下载到本地」。',
        labelDisabled: '不加载图片',
        descDisabled: '注释掉图片语法，不显示图片。',
        optionLocal: '下载到本地',
        optionRemote: '保留原始链接',
        optionDisabled: '不加载图片',
      },
      pngToJpeg: {
        name: 'PNG 转 JPEG',
        desc: '勾选此选项将 PNG 图片转换为 JPEG 格式以节省空间。注意：会丢失透明度信息。',
      },
      jpegQuality: {
        name: 'JPEG 质量',
        desc: '设置 JPEG 压缩质量（0-100），默认 85。数值越高质量越好但文件越大。',
      },
      retries: {
        name: '下载重试次数',
        desc: '设置图片下载失败时的重试次数（指数退避），默认 5 次。图床源站未就绪时会保留原链接并在后续同步时再试。',
        placeholder: '5',
        noticeMustBeNonNegative: '重试次数必须是非负整数',
      },
      storageFolder: {
        name: '图片存储文件夹',
        desc:
          '设置本地化图片的存储路径。支持变量 {{{title}}}、{{{dateSaved}}}、{{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}。示例：笔记同步助手/{{{yearSaved}}}/{{{monthSaved}}}/images',
        placeholder: '笔记同步助手/images/{{{date}}}',
      },
    },
    burnAfterReading: {
      name: '阅后即焚',
      desc:
        '⚠️ 危险且不可逆。每成功落盘一篇笔记后，会把云端对应文章永久删除——没有回收站、删了无法恢复。其它尚未收到该笔记的设备将永远收不到。请仅在单台设备上开启。开启后消息合并改为增量、精确去重写入（不再因判重假阳性静默丢消息；但多设备使用会产生重复或数据丢失）。',
      confirmTitle: '确认开启阅后即焚？',
      confirmBody:
        '开启后，每篇文章落盘成功后会立即从云端永久删除。没有回收站，删除无法撤销。尚未同步的其它设备将永远收不到这些笔记。请仅在单台设备同步时开启。确定要开启吗？',
      multiDeviceWarn:
        '检测到其它设备仍在同步本账号。开启阅后即焚后，这些设备可能产生重复笔记或丢失数据。请仅在单台设备上同步。',
    },
  },
}

export default zh
