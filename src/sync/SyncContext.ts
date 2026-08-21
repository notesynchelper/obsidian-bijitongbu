import { App, TFile } from 'obsidian'
import { OmnivoreSettings } from '../settings'
import { ImageLocalizer } from '../imageLocalizer/imageLocalizer'
import { AttachmentLocalizer } from '../attachmentLocalizer'
import { SuccessTracker } from './SuccessTracker'
import { BurnDeleteTracker } from './BurnDeleteTracker'
import { DiaryLinkProcessor } from './DiaryLinkProcessor'
import { DailyNoteResolver } from './DailyNoteResolver'
import { bloomHasId, BLOOM_ENCODED_LEN } from '../compressIds'
import { scanMessageMarkers } from './inlineMarker'
import { log } from '../logger'
import { LocalizerItemMeta } from '../common/localizerItemMeta'

/**
 * 取文件夹模板里第一个 `{{` 之前的静态前缀（去掉尾部 `/`）。
 * 例：`笔记同步助手/{{{date}}}` → `笔记同步助手`。无静态前缀时返回 ''。
 */
export function staticFolderPrefix(template: string): string {
	if (!template) return ''
	const idx = template.indexOf('{{')
	const raw = idx >= 0 ? template.slice(0, idx) : template
	return raw.replace(/\/+$/, '').trim()
}

/**
 * SyncContext - 同步过程中的共享状态容器
 *
 * 作用：
 * - 集中管理同步过程中的共享状态
 * - 避免在函数间传递大量参数
 * - 使用Map管理processedFiles，自动去重
 * - 构建全局 ID 索引，用于跨设备去重
 */
export class SyncContext {
	app: App
	settings: OmnivoreSettings
	successTracker: SuccessTracker
	/** 阅后即焚：游标真相 + 删除真相两个独立集合（仅 burn 模式填充） */
	burnTracker: BurnDeleteTracker
	imageLocalizer: ImageLocalizer | null
	attachmentLocalizer: AttachmentLocalizer | null
	diaryLinkProcessor: DiaryLinkProcessor

	// 调试模式：禁用跨库 ID 路由（buildIdIndex/findFileById* 全部空转）。
	// 目的：让调试重拉的每条 item 只按「默认路径」新建/更新，而不是命中用户自定义路径下的
	// 旧文件原地更新 —— 否则「写入默认位置」的承诺会被 ID 去重绕过（见 DebugMode / 设计 §1.3）。
	private disableIdRouting: boolean

	// 调试模式标记（与 disableIdRouting 同值）。MergeProcessor 用它旁路「无 id 模式」的
	// 游标去重：调试重拉的近 24h item 全落在游标之前，不旁路会一条都写不出来。
	readonly debugActive: boolean

	/**
	 * 本轮同步生效的消息模板 = settings.wechatMessageTemplate 经 Templater 接力
	 * （<% %> 插值）后的版本，由 main.ts fetchOmnivore 每轮开始时写入。
	 * MergeProcessor 渲染消息与生成锚点都要用它（两处不一致会导致日记双链锚点
	 * 指向不存在的标题）。未接力（无标签 / 未装 Templater）时与原模板相同。
	 * 不直接覆写 settings 字段：settings 是持久化对象，写脏会把渲染值存进配置。
	 */
	effectiveWechatMessageTemplate?: string

	// 改用Map管理已处理文件，key为文件路径，自动去重
	processedFiles: Map<string, TFile> = new Map()

	// ID → TFile 索引（用于跨设备去重）
	private singleIdIndex: Map<string, TFile> = new Map()
	private bloomIndex: { filter: string; file: TFile }[] = []

	// ——— 双写模式（MergeMode.DUAL）专用的分路索引 ———
	// 同一条消息在双写下同时存在于「合并文件」与「独立笔记」，两处都带同一个 id。
	// 通用 singleIdIndex 是单一 map，后写入者（标记扫描）会覆盖先写入者（frontmatter id），
	// 一个 id 只能记住一个文件 —— 拿它做路由必然把某一侧写到另一侧去：
	// 合并内容追加进独立笔记，或单篇正文覆写整份合并文件，两者都是不可逆的数据损坏。
	// 所以额外维护两套互不覆盖的索引 + 一个「这文件是合并文件」的判定集合。
	/** 文件级 frontmatter `id`（本插件只在单篇笔记写它）→ 文件 */
	private frontmatterIdIndex: Map<string, TFile> = new Map()
	/** 合并语义的 id（旧 messages 数组 / burnSyncedIds / 正文内联标记）→ 合并文件 */
	private mergeIdIndex: Map<string, TFile> = new Map()
	/** 带 syncedIds(Bloom) / burnSyncedIds / messages / 内联标记的文件路径 */
	private mergeFilePaths: Set<string> = new Set()

	constructor(
		app: App,
		settings: OmnivoreSettings,
		imageLocalizer: ImageLocalizer | null,
		attachmentLocalizer: AttachmentLocalizer | null = null,
		disableIdRouting = false
	) {
		this.app = app
		this.settings = settings
		this.imageLocalizer = imageLocalizer
		this.attachmentLocalizer = attachmentLocalizer
		this.disableIdRouting = disableIdRouting
		this.debugActive = disableIdRouting
		this.successTracker = new SuccessTracker()
		this.burnTracker = new BurnDeleteTracker()
		const dailyNoteResolver = new DailyNoteResolver(app, settings)
		this.diaryLinkProcessor = new DiaryLinkProcessor(
			app,
			settings,
			dailyNoteResolver,
			this.debugActive,
		)
		this.buildIdIndex()
	}

	/**
	 * 从 metadataCache 构建全局 ID 索引
	 * 扫描 vault 中所有 md 文件的 front matter id 字段，用于跨设备去重
	 */
	private buildIdIndex(): void {
		// 调试模式：不建 **ID 路由** 索引，让每条 item 走「默认路径」新建/更新，不命中旧位置文件。
		// 但「哪些文件是合并文件」仍然要认——它不用于路由，只用于「单篇写入绝不覆盖合并文件」
		// 这条数据安全护栏（成本仅 metadataCache 查询，不读正文）。
		const routing = !this.disableIdRouting
		if (!routing) log('🐞 调试模式：跳过跨库 ID 路由索引（仍标记合并文件用于防覆写）')
		const startTime = Date.now()
		// frontmatter 值是宽松 any；索引键只认标量 id（YAML 里 id 正常就是
		// 字符串/数字）。对象值以前会退化成 "[object Object]" 垃圾键，现在直接跳过。
		const scalarKey = (v: unknown): string | null => {
			if (!v) return null
			switch (typeof v) {
				case 'string':
					return v
				case 'number':
				case 'boolean':
				case 'bigint':
					return String(v)
				default:
					return null
			}
		}
		const idOf = (v: unknown): string | null =>
			v && typeof v === 'object' ? scalarKey((v as { id?: unknown }).id) : null
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file)
			if (!cache?.frontmatter) continue
			const fm = cache.frontmatter as Record<string, unknown>

			// 单文件模式：front matter 顶层 id
			const id = scalarKey(fm.id)
			if (id && routing) {
				this.singleIdIndex.set(id, file)
				this.frontmatterIdIndex.set(id, file)
			}

			// 合并模式：syncedIds (Bloom filter) 或旧 messages 数组
			const syncedIds = fm.syncedIds
			if (typeof syncedIds === 'string' && syncedIds.length === BLOOM_ENCODED_LEN) {
				if (routing) this.bloomIndex.push({ filter: syncedIds, file })
				this.mergeFilePaths.add(file.path)
			} else {
				const messages = fm.messages
				if (Array.isArray(messages)) {
					this.mergeFilePaths.add(file.path)
					for (const msg of messages as unknown[]) {
						const msgId = idOf(msg)
						if (msgId && routing) {
							this.singleIdIndex.set(msgId, file)
							this.mergeIdIndex.set(msgId, file)
						}
					}
				}
			}

			// 阅后即焚：精确数组 burnSyncedIds 的每个 id 也入 exact 索引，
			// 让 burn 模式的 findFileByExactId 能命中 burn 写入的合并文件（不依赖 Bloom）。
			const burnSyncedIds = fm.burnSyncedIds
			if (Array.isArray(burnSyncedIds)) {
				this.mergeFilePaths.add(file.path)
				for (const rec of burnSyncedIds as unknown[]) {
					const recId = idOf(rec)
					if (recId && routing) {
						this.singleIdIndex.set(recId, file)
						this.mergeIdIndex.set(recId, file)
					}
				}
			}
		}
		log(`🔍 ID 索引构建完成: ${this.singleIdIndex.size} 个单 ID, ${this.bloomIndex.length} 个 Bloom 文件, 耗时 ${Date.now() - startTime}ms`)
	}

	/**
	 * 扫描内联标记（<!--nh:id-->）合并文件的正文，把 id 补进 exact 索引。
	 *
	 * buildIdIndex 只看 metadataCache 的 frontmatter，看不到 body 里的隐形标记；
	 * 而方案 A 的纯消息合并文件 frontmatter 不再写 syncedIds，若不补这一步，
	 * 文件被改名 / 文件夹或文件名模板变更后，resolveOrCreateMergeTarget 按 id
	 * 找不到旧文件 → 重新建一个同内容文件（codex P2）。
	 *
	 * 成本控制：**只扫合并文件夹静态前缀下**的文件（插件自己的按天笔记，数量有界），
	 * 不扫用户整库。前缀内每个文件都读正文扫标记（不按 frontmatter 跳过——混合文件
	 * 如「ALL 模式 digest 带文章 id」或「旧 Bloom 文件后来又收了 marker-only 新消息」，
	 * 它们的消息 id 只在正文标记里、不在 frontmatter，跳过会漏索引 → 路径变更后重复
	 * 建文件，codex P2）。异步，需在 sync 用到索引前 await。
	 *
	 * ⚠️ 已知边界（不修，文档化）：若用户**改了文件夹模板的静态前缀**，旧前缀下的
	 * marker-only 文件不在本次扫描范围 → 那些消息重取时会被当新消息、可能重复建文件。
	 * 覆盖它需要扫全库正文（移动端同步热路径上的持续开销），代价过大；且失败仅是
	 * 「多一个可合并的文件」而非丢数据，旧的 Bloom 索引在此场景也会误路由（更糟）。
	 * 常见的「同文件夹内改名 / 跨设备同模板」都被本方法覆盖。
	 */
	async buildMarkerIndex(): Promise<void> {
		// 调试模式不建 id 路由；标记扫描要读正文，成本高于 buildIdIndex 的 frontmatter 查询，
		// 因此这里整体跳过（防覆写护栏靠 buildIdIndex 标记的 frontmatter 类合并文件 +
		// 本轮 markMergeFile 登记的目标兜底）。
		if (this.disableIdRouting) return
		const folderTpl = this.settings.messageFolder || this.settings.folder || ''
		const prefix = staticFolderPrefix(folderTpl)
		// 模板无静态前缀（如以 {{ 开头）→ 放弃 body 扫描，避免全库读；
		// 代价仅是这种非常规配置下跨模板变更的路由兜底失效（不会丢数据，最多多一个文件）。
		if (!prefix) return
		const start = Date.now()
		let scanned = 0
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.path !== prefix && !file.path.startsWith(prefix + '/')) continue
			let content: string
			try {
				content = await this.app.vault.cachedRead(file)
			} catch {
				continue
			}
			const ids = scanMessageMarkers(content)
			if (ids.size === 0) continue
			scanned++
			this.mergeFilePaths.add(file.path)
			for (const id of ids) {
				this.singleIdIndex.set(id, file)
				this.mergeIdIndex.set(id, file)
			}
		}
		log(`🔖 标记索引: ${scanned} 个含标记合并文件, 总计 ${this.singleIdIndex.size} 个 exact id, 耗时 ${Date.now() - start}ms`)
	}

	/**
	 * 通过 ID 查找已存在的文件（用于跨设备去重）
	 */
	findFileById(itemId: string): TFile | undefined {
		if (this.disableIdRouting) return undefined
		const direct = this.singleIdIndex.get(itemId)
		if (direct) return direct

		for (const entry of this.bloomIndex) {
			if (bloomHasId(entry.filter, itemId)) return entry.file
		}
		return undefined
	}

	/**
	 * 仅按 exact id 索引查找（不查 Bloom）。
	 * 阅后即焚模式下所有文件路由都用它，避免 Bloom 假阳性把新 item 误路由到错误文件。
	 */
	findFileByExactId(itemId: string): TFile | undefined {
		if (this.disableIdRouting) return undefined
		return this.singleIdIndex.get(itemId)
	}

	/**
	 * 双写模式专用：只找「合并文件」（带 syncedIds / burnSyncedIds / messages / 内联标记的）。
	 *
	 * 双写下同一条消息的 id 同时落在合并文件与独立笔记上，通用 findFileById 可能返回
	 * 独立笔记 → 合并追加会写进那篇独立文章，把两份内容搅在一起。此方法把独立笔记排除在外；
	 * 找不到时上层按路径新建合并文件（与「无标记」模式现有行为一致）。
	 *
	 * @param exactOnly 阅后即焚下必须传 true：Bloom 有假阳性（50 个 id 约 8%），
	 *   命中错误的合并文件会把新消息追加到别人的文件里，而 burn 随后按该文件复查残留、
	 *   删掉云端原件 —— 精确性在 burn 下不可让步（与 findFileByExactId 同一条铁律）。
	 */
	findMergeFileById(itemId: string, exactOnly = false): TFile | undefined {
		if (this.disableIdRouting) return undefined
		const direct = this.mergeIdIndex.get(itemId)
		if (direct) return direct
		// 文件级 id 也可能属于合并文件（ALL 模式下「首篇为主」的单篇 digest）
		const byFm = this.frontmatterIdIndex.get(itemId)
		if (byFm && this.mergeFilePaths.has(byFm.path)) return byFm
		if (exactOnly) return undefined
		for (const entry of this.bloomIndex) {
			if (bloomHasId(entry.filter, itemId)) return entry.file
		}
		return undefined
	}

	/** 该路径是否是「合并文件」（含本轮 markMergeFile 登记的目标）。单篇写入据此避让。 */
	isMergeFilePath(filePath: string): boolean {
		return this.mergeFilePaths.has(filePath)
	}

	/**
	 * 登记「本轮被选作合并目标」的文件。
	 * 本轮新建的按天合并文件不在启动时的索引里，不登记的话同轮的单篇写入会把它当普通文件覆写。
	 */
	markMergeFile(file: TFile): void {
		this.mergeFilePaths.add(file.path)
	}

	/**
	 * 双写模式专用：只找「独立笔记」（exact id 命中且不是合并文件）。
	 *
	 * 不查 Bloom（Bloom 只属于合并文件，且有假阳性）。找不到时上层按路径新建/更新独立笔记，
	 * 绝不会拿单篇正文覆写整个合并文件。
	 */
	findStandaloneFileById(itemId: string): TFile | undefined {
		if (this.disableIdRouting) return undefined
		const direct = this.frontmatterIdIndex.get(itemId)
		if (direct && !this.mergeFilePaths.has(direct.path)) return direct
		return undefined
	}

	/**
	 * 添加已处理文件（自动去重）
	 */
	addProcessedFile(file: TFile): void {
		this.processedFiles.set(file.path, file)
	}

	/**
	 * 获取所有已处理文件的数组
	 */
	getProcessedFilesArray(): TFile[] {
		return Array.from(this.processedFiles.values())
	}

	/**
	 * 将文件加入图片本地化队列
	 *
	 * @param metaOrSavedAt 推荐传 LocalizerItemMeta，让 generateFolderPath 拿到
	 *   完整模板变量上下文。传字符串 savedAt 时走兼容 overload（仅模板里
	 *   {{{date}}} 系列生效，其它 Item 字段仍空）。
	 */
	async enqueueFileForImageLocalization(
		file: TFile,
		metaOrSavedAt?: LocalizerItemMeta | string,
	): Promise<void> {
		if (this.imageLocalizer) {
			await this.imageLocalizer.enqueueFile(file, metaOrSavedAt)
		}
	}

	/**
	 * 将文件加入附件本地化队列
	 */
	async enqueueFileForAttachmentLocalization(
		file: TFile,
		metaOrSavedAt?: LocalizerItemMeta | string,
	): Promise<void> {
		if (this.attachmentLocalizer) {
			await this.attachmentLocalizer.enqueueFile(file, metaOrSavedAt)
		}
	}
}
