// English dictionary for plugin UI strings.
// IMPORTANT: keep the shape identical to ./zh.ts — `tests/i18nKeyConsistency.spec.ts`
// will fail the build if any key is missing on either side.
//
// We deliberately do NOT use `as const` here. Locking values to string literals
// would force every translation file to repeat the English text. Without
// `as const`, TS infers the leaf type as plain `string`, which is exactly what
// we want: `type Dict = typeof en` then carries the full key tree but lets zh
// substitute its own wording for each leaf.

const en = {
  common: {
    refresh: 'Refresh',
    refreshing: 'Refreshing...',
    cancel: 'Cancel',
    confirm: 'Confirm',
    retry: 'Retry',
    phonePcSyncLink: 'Phone-PC Sync',
  },
  versionCheck: {
    versionLabel: 'NoteHelper version',
    checkButton: 'Check for updates',
    checking: 'Checking for updates...',
    upToDate: '✅ Up to date',
    fetchFail: 'Could not fetch the latest version info',
    failGeneric: 'Update check failed; please retry later',
    foundNew: 'Found a new version',
    // 市场版：不做任何自更新，引导用户去 Obsidian 第三方插件页升级
    goToPluginPage: 'Open Community plugins to update',
    // 同步状态 Notice 下方的弱升级提醒行；{version} 会被替换成最新版本号
    reminderLine: 'New version {version} available — click to update in Community plugins',
    configRestored: 'Configuration restored from backup',
  },
  settings: {
    // Phase-2 IA：设置页分区（一级折叠 + VIP中心内二级折叠）的标题与摘要
    section: {
      vip: {
        name: 'VIP center',
        sub: 'Membership, cloud space and troubleshooting',
      },
      vipCloud: {
        name: 'Cloud space',
        sub: 'Contents and cleanup',
      },
      vipDiag: {
        name: 'Troubleshooting',
        sub: 'Debugging, config export and version',
      },
      sync: {
        name: 'Sync',
        sub: 'Sync timing and position',
      },
      path: {
        name: 'Path settings',
        sub: 'Where articles, messages and templates go',
        article: 'Articles',
        message: 'Messages',
        template: 'Templates',
      },
      imageSub: 'Image download and conversion',
      diarySub: 'Insert links to synced content into your diary notes',
      system: {
        name: 'System',
        sub: 'Interface language and update check',
      },
      clearCloud: {
        name: 'Clear cloud space',
        desc: 'Permanently delete every article and message in your cloud space. This cannot be undone.',
      },
    },
    apiKey: {
      name: 'API Key',
      desc: 'Follow the "笔记同步助手" WeChat official account to obtain your key.',
      placeholder: 'Enter your API key',
    },
    help: {
      name: 'Help & resources',
      desc: 'Tutorials, simulators and cloud space management links.',
      link: {
        tutorial: 'Tutorial',
        pathSimulator: 'Path simulator',
        contentProcessing: 'Content processing',
        openCloudSpace: 'Open cloud space',
      },
    },
    debugMode: {
      hint: 'Got a "synced" notice from the official account but the note is nowhere in Obsidian? Turn on Debug Mode.',
      name: 'Debug mode',
      desc: 'For troubleshooting. On a manual sync, re-pull the last 24h to the DEFAULT location and auto-open the notes. Does not change your settings or delete anything. Turn it off when done.',
      modalTitle: 'Debug mode',
      modalBody1: 'Notes are written to the DEFAULT location (your custom folder/filename templates are ignored). If you changed the location, a diagnostic copy is saved to the default location.',
      modalBody2: 'The last 24 hours of articles / messages are re-pulled.',
      modalBody3: 'The freshly pulled notes are opened automatically (up to 3 on desktop, 1 on mobile).',
      modalNote: 'Only manual syncs are affected. Your sync cursor and settings are left untouched — turn debug mode off to fully restore.',
      confirm: 'Turn on debug mode',
      saveFailed: 'Failed to save debug mode. Please try again.',
    },
    vip: {
      heading: 'Membership',
      delayNote:
        'Membership status on the plugin side may lag by about 15 minutes. To check your real-time membership status and expiry date, open the "Membership" menu at the bottom of the "Notesync Helper" official account.',
      loading: 'Loading...',
      qrAlt: 'QR code',
      refreshFresh: 'Refresh membership status',
      refreshFreshHint:
        "Just subscribed or renewed but the status above hasn't updated? Click to fetch your latest membership status from the server right now.",
      refreshed: 'Membership status refreshed',
      refreshFailed: 'Refresh failed, please check your network and retry',
      rateLimited: 'Too many refreshes. Please try again later (max 10 per 10 minutes).',
      needKey: 'Please enter your API key above first',
    },
    article: {
      heading: 'Article management',
      count: {
        name: 'Cloud space content count',
        desc: 'Shows the total count of articles and messages in cloud space. Message merge mode is enabled by default; messages from the same day are merged into a single note.',
        currentLabel: 'Current',
        currentLoading: '--',
        refreshing: 'Refreshing...',
        clearButton: 'Clear cloud space',
        clearing: 'Clearing...',
        confirmTitle: 'Clear cloud space articles',
        confirmBody:
          '⚠️ This will delete every article in cloud space and cannot be undone.\n\nAre you sure you want to continue?',
        noticeClearStart: 'Clearing articles...',
        noticeFetchFail: 'Failed to fetch article count. Check your API key.',
        noticeClearFail: 'Failed to clear articles. Please retry later.',
        noticeFetchFailShort: 'Failed to fetch',
      },
    },
    sync: {
      heading: 'Sync',
      syncOnStart: {
        name: 'Sync on startup (this device)',
        desc: 'Toggle to auto-sync when Obsidian loads. Per-device setting.',
        deviceIdLabel: 'Device ID',
        otherDevicesLabel: 'Other devices configured',
      },
      frequency: {
        name: 'Frequency (this device)',
        desc:
          'Auto-sync interval in seconds. 0 means manual sync only; the minimum is 60 seconds — lower values are raised to 60. Per-device setting.',
        placeholder: 'Frequency in seconds',
        noticeMustBePositive: 'Frequency must be a positive integer.',
        noticeClamped: 'Minimum auto-sync interval is 60 seconds — set to 60.',
      },
      lastSync: {
        name: 'Last sync',
        desc:
          'Timestamp of the last sync. The sync command fetches articles updated after this. You can edit it manually to widen or narrow the sync window.',
        placeholder: 'Last sync',
      },
      mergeMode: {
        name: 'Message merge mode',
        descIntro: 'How articles and messages get merged into files:',
        labelNone: 'No merge',
        descNone: 'Each article in its own file (numeric suffix on duplicates).',
        labelMessages: 'Merge messages only',
        descMessages: 'Group WeChat messages by date, keep articles separate (recommended).',
        labelAll: 'Merge all',
        descAll: 'Merge same-name articles and messages into one file.',
        labelDual: 'Dual write',
        descDual: 'Group messages by date into one file AND keep a separate note per message (the two copies stay independent).',
        optionNone: 'No merge',
        optionMessages: 'Merge messages only',
        optionAll: 'Merge all',
        optionDual: 'Dual write (merged + separate)',
      },
      messageSortOrder: {
        name: 'Message sort order',
        descIntro: 'Order of merged messages within a file:',
        labelDesc: 'Newest first',
        descDesc: 'Newer messages on top (default).',
        labelAsc: 'Oldest first',
        descAsc: 'Newer messages at the bottom.',
        optionDesc: 'Newest first',
        optionAsc: 'Oldest first',
      },
      messageFolder: {
        name: 'Message folder',
        desc: 'Folder for merged message files. Leave empty to reuse the article folder path.',
      },
      messageFileName: {
        name: 'Message file name template',
        descBefore: 'Filename template for merged message files. Use ',
        descAfter: ' as the date variable.',
        examplesIntro: 'Examples:',
        placeholder: '同步助手_{{{date}}}',
      },
      messageFileDateFormat: {
        name: 'Message file date format',
        desc:
          'Format used to render the date variable in the message filename. See moment.js format reference for details.',
        examplesIntro: 'Common formats:',
        examplePrefix: 'example',
        placeholder: 'date format: yyyy-MM-dd',
      },
      mergeFileTemplate: {
        name: 'Merged file template',
        desc:
          'Customize the header of a merged message file: properties, a heading, an intro. Written once, when the merged file is CREATED; messages follow below it. Leave empty to keep the current behaviour (an empty file that only holds messages). Existing files are never rewritten.',
        varsIntro: 'Available variables:',
        varDate: '• {{{date}}} = the file date (uses "Message file date format" above)',
        varTitle: '• {{{title}}} = the file name',
        examplesIntro: 'Examples:',
        example1: '• # 📮 {{{date}}} messages → a dated heading',
        example2: '• ---\\ntags: [messages]\\n---\\n\\n# {{{title}}} → properties + heading',
        hint:
          'Note: no hidden markers are ever written into your notes. With newest-first ordering new messages land right below the header; once you edit the header yourself, new messages go back to the top of the file.',
        debugLink: 'Open template playground',
        placeholder: '# 📮 {{{date}}} messages',
        invalidWarning: '⚠ Obsidian will misread this template once written to disk. Please adjust:',
        resetTooltip: 'Clear (back to an empty file)',
        noticeReset: 'Merged file template cleared',
      },
      noMessageMarker: {
        name: 'Messages without id',
        desc:
          'Stop writing hidden dedup markers (<!--nh:…-->, which carry the message id) at the end of merged messages. Duplicates are then prevented purely by the latest sync cursor (time-based).',
        confirmTitle: 'Sync messages without id?',
        confirmBody:
          'Once enabled, merged messages no longer carry hidden markers, and deduplication relies solely on the latest sync cursor (time-based).\n\n⚠️ Important: with this enabled, cross-device sync must NOT use cloud-drive folder sync (Nutstore, iCloud, OneDrive, etc.) — their delays and missing plugin-data sync will cause duplicated or lost messages. Obsidian Sync and the "Phone-PC Sync" plugin both work fine.\n\nAlso note: manually rolling back "Last sync" will re-append messages that are already in your notes. Markers already written are kept and still count for dedup.',
      },
      articleFolder: {
        name: 'Article folder',
        desc:
          'Folder path for stored articles. Supports {{{title}}}, {{{dateSaved}}}, {{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}.',
        placeholder: 'Enter the folder',
      },
      articleFolderDateFormat: {
        name: 'Article folder date format',
        desc: 'Date format used inside the article folder path. Example: yyyy-MM-dd',
        placeholder: 'date format',
      },
      attachmentFolder: {
        name: 'Attachment folder',
        desc:
          'Folder path for downloaded attachments. Supports {{{title}}}, {{{dateSaved}}}, {{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}.',
        placeholder: 'Enter the attachment folder',
      },
      articleFilename: {
        name: 'Article filename',
        desc:
          'Filename template for stored articles. Supports {{id}}, {{{title}}}, {{{dateSaved}}}, {{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}.',
        debugLink: 'Debug template online',
        placeholder: 'Enter the filename',
      },
      articleFilenameDateFormat: {
        name: 'Article filename date format',
        desc:
          'Date format used in the article filename. See the moment.js format docs for details.',
        placeholder: 'yyyy-MM-dd',
      },
    },
    content: {
      heading: 'Content processing',
      escapeHashtags: {
        name: 'Escape hashtags in content',
        desc:
          'When enabled, #hashtags inside synced article bodies are rewritten to \\#hashtags so Obsidian does not pick them up as tags and pollute your tag tree.',
      },
    },
    // Live hints for Templater usage inside article / message templates
    templater: {
      warnUnclosed:
        '⚠️ Unclosed <% tag detected: close it with %> or remove the stray <%, otherwise the template may render incorrectly.',
      marketPassthrough:
        'ℹ️ This edition does not run Templater <% %> interpolation; such tags are kept as-is in your notes.',
    },
    advanced: {
      heading: 'Advanced',
      language: {
        name: 'Interface language',
        desc: 'Language for this plugin\'s UI. "中文" forces Chinese even when Obsidian and your system are in English. "Follow system" auto-detects from Obsidian / OS.',
        optAuto: 'Follow system',
        optZh: '中文 (Chinese)',
        optEn: 'English',
      },
      articleSubheading: 'Article',
      frontMatter: {
        name: 'Front matter',
        descMain:
          'Comma-separated list of metadata fields. You can also alias with metadata::alias, e.g. date_saved::date.',
        descBelow:
          'For a custom front matter template, use the field below.',
        placeholder: 'title, author, tags, date_saved',
        noticeAutoMoved:
          'Template syntax detected — auto-saved into the "front matter template" field below.',
      },
      frontMatterTemplate: {
        name: 'Note properties template',
        descMain: 'YAML template used to render the front matter.',
        descOverride: 'When set, this template overrides the front matter variables above.',
        debugLink: 'Debug template online',
        placeholder: 'author: {{{author}}}\nsource: {{{siteName}}}\ntags: [synced]',
        resetTooltip: 'Reset front matter template',
        noticeReset: 'Front matter template reset',
        invalidWarning:
          '⚠ This template breaks YAML parsing at sync time — user fields will be lost and only id + omnivore_error end up on disk:',
        invalidHint:
          '\n\nUse the "Debug template online" link above to locate the failing line.',
        sanitizeWarning:
          'Heads-up: YAML parsing failed once and was auto-fixed by adding double quotes.\nWrap fields containing special characters in "..." manually to avoid future trouble.',
      },
      omitFrontmatterId: {
        name: 'Note properties without id',
        desc:
          'Stop writing the id field into note properties (and syncedIds in merge mode). Duplicates are then prevented purely by the latest sync cursor (time-based).',
        confirmTitle: 'Drop id from note properties?',
        confirmBody:
          'Once enabled, newly synced notes no longer carry id in their properties (nor syncedIds in merge mode), and deduplication relies solely on the latest sync cursor (time-based).\n\nTrade-offs:\n• The plugin can no longer recognize existing notes by id — renamed/moved notes may be re-created on re-sync, and different articles sharing one title are treated as the same note.\n• Cross-device sync must NOT use cloud-drive folder sync (Nutstore, iCloud, OneDrive, etc.); Obsidian Sync and the "Phone-PC Sync" plugin both work fine.\n• Manually rolling back "Last sync" will write duplicates.\n\nNotes synced before enabling are not bulk-modified (their id / syncedIds stay and still count for dedup); however, when such a note later receives a content update, the freshly written properties will no longer include id. This setting has no effect while burn-after-reading is on (it requires exact id matching).',
      },
      articleTemplate: {
        name: 'Article template',
        descMain: 'Template used to render articles.',
        descBelow: 'For a custom front matter template, use the field below.',
        debugLink: 'Debug template online',
        placeholder: 'Enter the template',
        resetTooltip: 'Reset template',
        noticeReset: 'Template reset',
      },
      dateSavedFormat: {
        name: 'Date saved format',
        desc:
          'Format for the dateSaved variable inside rendered templates. Example: yyyy-MM-dd\'T\'HH:mm:ss',
        placeholder: 'yyyy-MM-dd\'T\'HH:mm:ss',
      },
      assistantTemplate: {
        name: 'Assistant message template',
        desc:
          'Template for assistant messages (titles like 同步助手_yyyyMMdd_xxx). Assistant messages use this clean template, dropping titles and tags.',
        varsIntro: 'Available variables:',
        varDate: '• {{{dateSaved}}} = saved date',
        varContent: '• {{{content}}} = message content',
        varTitle: '• {{{title}}} = title',
        varId: '• {{{id}}} = ID',
        examplesIntro: 'Examples:',
        example1: '• ---\\n## 📅 {{{dateSaved}}}\\n{{{content}}} → divider + heading + content (recommended)',
        example2: '• {{{content}}} → content only',
        example3: '• 📅 {{{dateSaved}}}\\n{{{content}}} → emoji + time + content',
        debugLink: 'Debug template online',
        placeholder: '---\\n## 📅 {{{dateSaved}}}\\n{{{content}}}',
        resetTooltip: 'Reset to default template',
        noticeReset: 'Assistant message template reset',
      },
      templateVars: {
        name: 'Available template variables',
        descIntro: 'View all available template variables and examples: ',
        docLink: 'Template variables documentation',
      },
      debugLog: {
        name: 'Debug log',
        desc:
          'When enabled, detailed logs are written to the developer console for troubleshooting.',
        noticeOn: 'Debug log enabled',
        noticeOff: 'Debug log disabled',
      },
      exportConfig: {
        name: 'Export current configuration',
        desc: 'Download the plugin’s current data.json file.',
        button: 'Export',
        noticeOk: 'Configuration exported',
        noticeFail: 'Export failed: ',
      },
      footer: 'For more, follow the "笔记同步助手" official account.',
    },
    diary: {
      heading: 'Diary links',
      enable: {
        name: 'Enable diary links',
        desc:
          'After each sync, insert wikilinks to the synced articles into your diary file.',
        usageIntro: 'How to use:',
        step1: '1. Add an anchor in your diary template: ',
        step2: '2. Links will be inserted below the anchor after sync.',
        tutorialLink: 'View detailed tutorial',
      },
      autoCreate: {
        name: 'Auto-create diary',
        desc:
          'When enabled, missing diary files are auto-created. Reads path/template from the Daily Notes core plugin or Periodic Notes community plugin.',
      },
      folder: {
        name: 'Diary folder',
        desc: 'Diary folder path. Leave empty to read from Daily Notes / Periodic Notes settings.',
        placeholder: 'Leave empty to auto-detect from DN/PN',
      },
      dateFormat: {
        name: 'Diary date format',
        descIntro: 'Diary filename date format, using Luxon formatting.',
        warnLiteral: '⚠️ Wrap literal text with single quotes: ',
        exampleLiteral: "'[Daily]' yyyy-MM-dd",
        commonIntro: 'Common formats: yyyy-MM-dd, yyyyMMdd, yyyy/MM/dd, ',
        exampleCommon: "'日记' yyyy-MM-dd",
        docLink: '📖 Luxon formatting docs',
        previewOk: 'Preview',
        previewError: 'Format error',
        placeholder: 'Leave empty to auto-detect from DN/PN',
      },
      writePosition: {
        name: 'Write position',
        desc:
          'Where links are written in the diary. "Between anchors" needs two identical anchor markers in the diary (default). "Top of file" writes right below the frontmatter, above the body. "Bottom of file" appends to the end. Top and bottom need no anchors; de-duplication then covers the whole diary file.',
        optionAnchor: 'Between anchors (default)',
        optionTop: 'Top of file',
        optionBottom: 'Bottom of file',
      },
      anchor: {
        name: 'Anchor identifier',
        descIntro: 'Place two identical anchor markers in your diary template:',
        descAfter: 'Links will be inserted between the two anchors and de-duplicated.',
        placeholder: '<!-- notehelper-links -->',
      },
      linkOrder: {
        name: 'Write order',
        desc:
          'How a batch of links is ordered inside the anchor region when one sync brings several. "Newest first": the batch is placed at the top of the region. "Oldest first": the batch is appended at the bottom of the region.',
        optionDesc: 'Newest first (descending)',
        optionAsc: 'Oldest first (ascending)',
      },
      linkType: {
        name: 'Link type',
        desc: 'Which content types to link into the diary.',
        optionAll: 'Messages + articles',
        optionMessages: 'Messages only',
        optionArticles: 'Articles only',
      },
      linkPrefix: {
        name: 'Link prefix',
        desc: 'Default "- " (Markdown list item). Leave empty for a bare [[wikilink]].',
        previewLabel: 'Preview',
        sampleTitle: 'Sample article title',
        placeholder: '- ',
      },
      noDiaryLinkId: {
        name: 'No id in diary',
        desc: 'Stop appending the hidden de-duplication comment (<!-- notehelper:id:… -->) after each diary link; duplicates are then judged purely by time (the latest sync cursor).',
        confirmTitle: 'Stop writing id in the diary?',
        confirmBody:
          'Once enabled, newly written diary links no longer carry the hidden comment, and de-duplication relies entirely on the latest sync cursor (time-based).\n\n⚠️ Important: cross-device sync must NOT use a cloud-drive folder (Nutstore, iCloud, OneDrive, …) — high latency and plugin data usually not synced, which causes duplicated or missing diary links. Obsidian Sync and the "phone-PC sync" plugin both work fine.\n\nCosts and limits:\n• Links skipped because the diary file (or its anchors) did not exist yet will NOT be back-filled later — the cursor has already moved past them. Create the diary/anchors first, then enable this.\n• Manually rewinding "last synced" time will re-insert existing links.\n• Hidden comments already written are kept and still count for de-duplication.\n• This setting has no effect while "burn after reading" is on (it requires exact id matching).',
      },
      linkMaxLength: {
        name: 'Link max length',
        desc:
          'Max characters for the display text (after | in [[link|display]]). Excess is truncated with …; 0 means no limit.',
        placeholder: '0',
        noticeMustBeNonNegative: 'Link max length must be a non-negative integer.',
      },
    },
    image: {
      heading: 'Image processing',
      mode: {
        name: 'Image processing mode',
        descIntro: 'Choose how to process images in notes:',
        labelLocal: 'Download to local',
        descLocal: 'Download images to local storage.',
        labelRemote: 'Keep remote links',
        descRemote:
          'Leave network image URLs untouched. If you have enabled cloud image relay in your cloud space, set the image processing mode to "Keep remote links" so the image-host URLs are preserved. ⚠️ Note: with remote links the images may break at any time (source deletes them, hotlink protection, expired URLs); even when relayed through the assistant cloud space "Image First Class", they are kept for at most 30 days. For long-term reliable storage, switch to "Download to local".',
        labelDisabled: 'Disable images',
        descDisabled: 'Comment out image syntax so images are not rendered.',
        optionLocal: 'Download to local',
        optionRemote: 'Keep remote links',
        optionDisabled: 'Disable images',
      },
      pngToJpeg: {
        name: 'Convert PNG to JPEG',
        desc:
          'Convert PNG images to JPEG to save disk space. Note: transparency will be lost.',
      },
      jpegQuality: {
        name: 'JPEG quality',
        desc:
          'JPEG compression quality (0–100; default 85). Higher values mean better quality but larger files.',
      },
      retries: {
        name: 'Download retries',
        desc: 'Number of retries (exponential backoff) when an image download fails. Default 5. If the image origin is not ready yet, the original link is kept and retried on later syncs.',
        placeholder: '5',
        noticeMustBeNonNegative: 'Retries must be a non-negative integer.',
      },
      storageFolder: {
        name: 'Image storage folder',
        desc:
          'Folder for localized images. Supports {{{title}}}, {{{dateSaved}}}, {{{yearSaved}}}/{{{monthSaved}}}/{{{daySaved}}}. Example: 笔记同步助手/{{{yearSaved}}}/{{{monthSaved}}}/images',
        placeholder: '笔记同步助手/images/{{{date}}}',
      },
    },
    burnAfterReading: {
      name: 'Burn after reading',
      desc:
        '⚠️ Dangerous & irreversible. After each note is successfully saved locally, the matching article is permanently deleted from the cloud — there is no recycle bin and it CANNOT be recovered. Any other device that has not yet received that note will NEVER get it again. Use only on a SINGLE device. When on, message merging switches to incremental, exact-deduplicated writes (no more silent message loss, but cross-device use will cause duplicates or data loss).',
      confirmTitle: 'Enable burn after reading?',
      confirmBody:
        'This will permanently delete each article from the cloud right after it is saved locally. There is no recycle bin and deletions cannot be undone. Other devices that have not yet synced will never receive those notes. Only enable this if you sync on a single device. Are you sure you want to enable it?',
      multiDeviceWarn:
        'Other devices are still actively syncing this account. With burn after reading on, those devices may produce duplicate notes or lose data. Please sync on a single device only.',
    },
  },
}

export default en
export type Dict = typeof en
