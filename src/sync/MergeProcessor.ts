import { Item } from '@omnivore-app/api'
import { stringifyYaml, TFile } from 'obsidian'
import Mustache from 'mustache'
import { SyncContext } from './SyncContext'
import { logError } from '../logger'
import {
	parseFrontMatterFromContent,
	removeFrontMatterFromContent,
	formatDate,
} from '../util'
import {
	isWeChatMessage,
	renderWeChatMessageSimple,
	generateMessageAnchor,
} from '../settings/template'
import {
	readSyncedFilter,
	bloomHasId,
	bloomAddId,
	createBloomFilter,
} from '../compressIds'
import {
	scanMessageMarkers,
	appendMarker,
} from './inlineMarker'
import {
	readBurnSyncedIds,
	isBurnSeen,
	addBurnSyncedId,
	pruneBurnSyncedIds,
	minIsoCursor,
} from './burnSyncedIds'
import { latestSyncCursor, isCursorCovered } from './cursorDedupe'
import { extractRemoteImageUrls, extractRemoteAttachmentUrls } from './burnResidual'
import { MessageSortOrder } from '../settings'
import { itemToLocalizerMeta } from '../common/localizerItemMeta'
import {
	buildMergeHeaderMatcher,
	insertIntoMergeBody,
	isHeaderOnlyBody,
	joinWechatMessageBlocks,
	mergeBodyHasContent,
} from './mergeFileTemplate'

export interface MergeBatchItem {
	item: Item
	content: string
}

export interface MergeGroup {
	file: TFile
	items: MergeBatchItem[]
}

/**
 * 把累积的合并分组一次性落盘：每个文件只调一次 processBatch。
 *
 * ⚠️ 关键不变量：main.ts 必须**跨所有 fetch 分页累积** merge item 到同一个
 * group，循环结束后再调一次本函数 —— 绝不能每分页各调一次 processBatch。
 * 原因：服务器对 `sort:saved-asc` 实际返回 newest-first 分页，每分页整块
 * desc 排序后 prepend 会把「老页」堆在文件顶部（顶部变最老而非最新）；而且
 * 逐页处理会让后页 item 对「已累积前页 id 的 filter」判重，撞 Bloom 假阳性
 * 被静默丢。累积后一次写入则全部 item 一起做全局 sortItems + 对同一份起始
 * filter 判重，两个问题都消除。回归见 MergeProcessorCrossBatchOrder.spec.ts。
 */
export async function flushMergeGroups(
	processor: MergeProcessor,
	groups: Iterable<MergeGroup>,
	onError?: (path: string, err: unknown) => void,
): Promise<void> {
	for (const { file, items } of groups) {
		if (items.length === 0) continue
		try {
			await processor.processBatch(items, file)
		} catch (error) {
			onError?.(file.path, error)
			// 批量失败回退逐条，尽量保住能处理的 item
			for (const { item, content } of items) {
				try {
					await processor.process(item, file, content)
				} catch (innerError) {
					onError?.(file.path, innerError)
				}
			}
		}
	}
}

export function sortItems(items: MergeBatchItem[], sortOrder: MessageSortOrder): MergeBatchItem[] {
	return [...items].sort((a, b) => {
		const timeA = new Date(a.item.savedAt).getTime()
		const timeB = new Date(b.item.savedAt).getTime()
		return sortOrder === MessageSortOrder.ASC ? timeA - timeB : timeB - timeA
	})
}

/**
 * 合并文件 frontmatter 里的「内部字段」：去重 / 历史状态，不属于文章业务元数据。
 * 判断单篇/多篇、决定哪些字段要下沉 section 时都按此排除。
 */
const INTERNAL_FM_KEYS = new Set(['syncedIds', 'burnSyncedIds', 'messages'])

/**
 * section 元数据块里额外隐藏的字段：内部字段 + id（裸 UUID 噪音，去重已靠 Bloom，
 * 对用户无意义）。
 */
const SECTION_HIDDEN_FM_KEYS = new Set([...INTERNAL_FM_KEYS, 'id'])

/**
 * 把一篇文章的 frontmatter 渲染成「section 内的属性块」（多篇合并时下沉用）。
 *
 * 用 Obsidian callout 包起来，视觉上接近 Properties；尊重用户 frontMatterTemplate
 * 定义的字段（每篇 key 相同、值不同），逐行 `key: value`。空元数据返回 ''。
 * 数组值（如 tags）按逗号连接。
 */
export function renderSectionMeta(fm: Record<string, unknown>): string {
	const lines: string[] = []
	for (const k of Object.keys(fm)) {
		if (SECTION_HIDDEN_FM_KEYS.has(k)) continue
		const v = fm[k]
		if (v === undefined || v === null || v === '') continue
		// 仅渲染标量 / 标量数组；嵌套对象（或对象数组）不可读地变成 [object Object]，跳过。
		let raw: string
		if (Array.isArray(v)) {
			if (v.some((e) => e !== null && typeof e === 'object')) continue
			raw = v.join(', ')
		} else if (typeof v === 'string') {
			raw = v
		} else if (
			typeof v === 'number' ||
			typeof v === 'boolean' ||
			typeof v === 'bigint'
		) {
			raw = String(v)
		} else {
			// 对象/symbol/function 等非标量：属性块里没有可读表示，跳过
			continue
		}
		// 折叠换行：callout 每行一个 `> `，值里的换行会破坏块结构（frontMatterTemplate
		// 渲染时已折过一道，这里对存量/手填值再兜底一次）。
		const val = raw.replace(/[\r\n]+/g, ' ')
		if (!val.trim()) continue
		lines.push(`> ${k}: ${val}`)
	}
	if (lines.length === 0) return ''
	return ['> [!note] 笔记属性', ...lines].join('\n')
}

/**
 * MergeProcessor - 合并模式处理器
 *
 * 职责：
 * - 处理企微消息合并（简洁模式追加）
 * - 处理普通文章合并（分隔符模式）
 * - 统一使用SuccessTracker记录成功
 */
export class MergeProcessor {
	constructor(private context: SyncContext) {}

	/**
	 * 处理合并模式的文章/消息（委托给 processBatch）
	 */
	async process(
		item: Item,
		omnivoreFile: TFile,
		content: string
	): Promise<void> {
		return this.processBatch([{ item, content }], omnivoreFile)
	}

	async processBatch(
		batchItems: MergeBatchItem[],
		omnivoreFile: TFile
	): Promise<void> {
		if (batchItems.length === 0) return

		const sortOrder = this.context.settings.messageSortOrder ?? MessageSortOrder.DESC
		// 「合并文件模板」的文件头定位器：由模板反推的正则，认得出用户写的文件头，
		// 好让新消息插在它**下面**。绝不往文件里写锚点；认不出就退回历史插入行为。
		const mergeFileTemplate = this.context.settings.mergeFileTemplate ?? ''
		const templateActive = mergeFileTemplate.trim().length > 0
		const headerRe = buildMergeHeaderMatcher(mergeFileTemplate)

		// Split into WeChat messages and regular articles
		const wechatItems = batchItems.filter(b => isWeChatMessage(b.item))
		const articleItems = batchItems.filter(b => !isWeChatMessage(b.item))

		// --- Phase A: Pre-render WeChat messages ---
		const sortedWechat = sortItems(wechatItems, sortOrder)
		// Templater 接力后的本轮生效消息模板（无标签/未装 Templater 时与 settings 相同）
		const wechatTemplate =
			this.context.effectiveWechatMessageTemplate ??
			this.context.settings.wechatMessageTemplate
		const renderedWechat = sortedWechat.map(b => {
			const rendered = renderWeChatMessageSimple(
				b.item,
				this.context.settings.dateSavedFormat,
				wechatTemplate
			).trimEnd()
			if (!rendered) {
				logError(`Warning: rendered message content is empty, ID: ${b.item.id}`)
			}
			return { item: b.item, rendered }
		})

		// --- 阅后即焚 setup ---
		const burn = this.context.settings.burnAfterReading === true
		const burnEnabledAt = this.context.settings.burnAfterReadingEnabledAt || ''
		const burnMinCursor = burn
			? minIsoCursor(Object.values(this.context.settings.deviceSyncCursors ?? {}))
			: ''
		const burnPendingIds = burn
			? new Set((this.context.settings.pendingBurnDeletes ?? []).map(p => p.id))
			: new Set<string>()
		// 本轮真实新写入的 item（+其内容，用于抽原始 URL）。在 vault.process 回调内 staged，
		// **回调成功返回后**才 commit 到 burnTracker（vault.process 可能重试多次，故回调顶部重置）。
		let stagedNew: { item: Item; content: string }[] = []

		// --- 「无 id」模式（游标去重）setup ---
		// burn 优先级更高：阅后即焚删云端文章，必须保留精确去重（burnSyncedIds），
		// 两个「无 id」开关在 burn 下不生效。调试模式旁路游标去重（重拉的近 24h item
		// 全落在游标之前，不旁路一条都写不出来，见 cursorDedupe.ts）。
		const noMarkers = this.context.settings.disableMessageMarkers === true && !burn
		const omitId = this.context.settings.omitFrontmatterId === true && !burn
		const cursorDedupeOn = (noMarkers || omitId) && this.context.debugActive !== true
		const latestCursor = cursorDedupeOn ? latestSyncCursor(this.context.settings) : ''
		const cursorSeen = (item: Item): boolean =>
			isCursorCovered(item.updatedAt || item.savedAt, latestCursor)

		// --- Phase B: vault.process - update body AND frontmatter atomically ---
		// We build the complete file (frontmatter + body) in one pass to avoid
		// a race where a separate processFrontMatter call misparses body content
		// (e.g. message templates starting with "---") as frontmatter delimiters.
		await this.context.app.vault.process(omnivoreFile, (content) => {
			// vault.process 回调可能被调用多次（内容竞争重试）：每次重置 staged，只让最终一次生效。
			stagedNew = []
			// Extract frontmatter block verbatim, body is the rest
			// 支持空 frontmatter (---\n---) 和正常 frontmatter (---\n...\n---)
			// ⚠️ 顺序敏感：必须先试「空 frontmatter」精确匹配 —— 通用 lazy 正则遇到
			// `---\n---\n\n---\n(消息模板正文)` 会把正文首条消息的 `---` 分隔线吞进
			// fm 块（每 sync 蚕食一行，no-id 真机 E2E 抓到的字节漂移）。
			const fmMatch = content.match(/^(---\r?\n---)(?:\r?\n+|$)/) || content.match(/^(---\r?\n[\s\S]*?\r?\n---)\n*/)
			const fmBlock = fmMatch ? fmMatch[0] : ''
			let body = content.slice(fmBlock.length)

			// Read syncedIds from latest content for dedup.
			// ⚠️ 只解析上面抠出来的 fmBlock，**不要**拿整份 content 去解：
			// parseFrontMatterFromContent 的 `/^---\n(.*?)\n---/s` 不认「空 frontmatter」
			// （`---\n---`），会一路吃到正文里下一处 `---`（合并文件模板的页脚分隔线 /
			// 消息模板自带的 `---`）当成 YAML → 抛 YAMLException → 整份写入失败、消息同步不进来。
			// fmBlock 是用「先空 fm 精确匹配」的正则抠的，喂它才准。
			const rawFm = (parseFrontMatterFromContent(fmBlock) ?? {}) as Record<string, unknown>
			const parsedFm = Array.isArray(rawFm) ? { messages: rawFm } : rawFm
			let syncedIds = readSyncedFilter(parsedFm)

			// 阅后即焚：判重改读「非 lossy 精确数组」（零假阳性，永不静默丢消息）；
			// 仍维护 Bloom syncedIds 以保持 SyncContext 索引一致性（design §6.2）。
			const legacyBloom = syncedIds // 快照：burn legacy 回退用（早于 burn 启用的旧 item）
			let burnRecords = burn ? readBurnSyncedIds(parsedFm) : []
			const seen = (item: Item): boolean =>
				burn
					? isBurnSeen(burnRecords, legacyBloom, item.id, item.savedAt, burnEnabledAt)
					: bloomHasId(syncedIds, item.id)
			const markSynced = (item: Item, appendedContent: string): void => {
				// omitId（非 burn）：不再累积 Bloom —— syncedIds 保持原值（legacy 文件的旧值
				// 原样保留作回退判重；新文件恒为空走下方 delete 分支，frontmatter 零机器字段），
				// 防重复交给游标（cursorSeen）。
				if (!omitId) syncedIds = bloomAddId(syncedIds, item.id)
				if (burn) {
					burnRecords = addBurnSyncedId(burnRecords, item.id, item.savedAt, item.updatedAt ?? '')
					stagedNew.push({ item, content: appendedContent })
				}
			}

			// --- 企微消息去重：内联隐形标记（方案 A，仅非 burn）---
			// body 里已存在的标记集合 = 精确「已同步」判据（零假阳性，永不静默丢）。
			// 旧文件（burn 启用前用 Bloom 写过）无标记 → 回退查 legacy Bloom：只对
			// 「不在标记集合」的 id 补一道兜底，接受其假阳性仅作用于迁移前的旧消息，
			// 保证跨 day 文件滚动后新文件全走精确标记。burn 模式保持原精确路径（消息块
			// 读后会被删，标记随之消失，去重真相在 burnSyncedIds）。
			const markerSet = scanMessageMarkers(content)
			const emptyFilter = createBloomFilter()
			const hadLegacyBloom = syncedIds !== emptyFilter
			// 标记在两种模式下都算「已同步」：非 burn 时期写下的标记，在用户后来开启
			// burn 后仍要认（否则 burn 分支既无 burnSyncedIds 也无 legacy Bloom，会把
			// pre-burn 的老消息重复追加并误标删除，codex P2）。burn 再叠加精确记录判重。
			// noMarkers（取消注释符）：新消息不再写标记，跨轮判重改靠最新同步游标
			// （cursorSeen）；已有标记 / legacy Bloom 仍认（存量文件的历史消息不重复）。
			const seenWechat = (item: Item): boolean =>
				markerSet.has(item.id) ||
				(burn
					? seen(item)
					: (hadLegacyBloom && bloomHasId(syncedIds, item.id)) ||
						(noMarkers && cursorSeen(item)))

			// --- Process WeChat messages ---
			// 批内去重：同一轮 fetch 若把同 id 重复返回（游标边界项），只写一次。
			const wechatSeenThisBatch = new Set<string>()
			const newWechat = renderedWechat.filter(p => {
				if (seenWechat(p.item)) return false
				if (wechatSeenThisBatch.has(p.item.id)) return false
				wechatSeenThisBatch.add(p.item.id)
				return true
			})
			if (newWechat.length > 0) {
				const markerless = burn || noMarkers
				const concatenated = newWechat.reduce((joined, p, index) => {
					const block = markerless ? p.rendered : appendMarker(p.rendered, p.item.id)
					return index > 0 ? joinWechatMessageBlocks(joined, block) : block
				}, '')

				// 启用「合并文件模板」时：降序的新消息插在用户文件头之下（不写任何锚点）。
				// 无模板 / 认不出文件头时等价于历史的 prepend/append。
				body = insertIntoMergeBody(body, concatenated, sortOrder, headerRe, {
					compactWechatMessageSpacing: true,
				})

				for (const p of newWechat) {
					// 非 burn：标记已写进 body 即为去重真相，不再往 Bloom 里加（不污染 frontmatter）。
					// burn：维持原精确路径（Bloom 索引一致性 + burnSyncedIds 真相 + 删除候选）。
					if (burn) markSynced(p.item, p.rendered)
				}
			}

			// --- Process regular articles ---
			// omitId 游标去重：已被最新游标覆盖的文章 = 某台设备已同步过 → 本轮整条跳过。
			// 不能放进 existing 替换路径 —— 无分隔符时那条路径会把内容再追加一遍，正是要防的重复。
			const liveArticles = omitId
				? articleItems.filter(b => !cursorSeen(b.item))
				: articleItems
			// omitId 下文件里没有 id/Bloom 身份可查：改用「该篇渲染出的分隔符是否已在正文中」
			// 识别被更新重下发的既有文章（savedAt 跨更新稳定 ⇒ 分隔符渲染稳定），命中走
			// Step 1 原地替换而不是追加重复 section（codex round2 P1）。
			const sectionPresent = (b: MergeBatchItem): boolean => {
				if (!this.context.settings.sectionSeparator || !this.context.settings.sectionSeparatorEnd) return false
				const dateSaved = formatDate(b.item.savedAt, this.context.settings.dateSavedFormat)
				const articleView = { id: b.item.id, title: b.item.title, dateSaved }
				const renderedStart = Mustache.render(this.context.settings.sectionSeparator, articleView)
				const renderedEnd = Mustache.render(this.context.settings.sectionSeparatorEnd, articleView)
				const idxStart = body.indexOf(renderedStart)
				if (idxStart < 0) return false
				return body.indexOf(renderedEnd, idxStart + renderedStart.length) >= 0
			}
			const seenArticle = (b: MergeBatchItem): boolean =>
				seen(b.item) || (omitId && sectionPresent(b))
			const existingArticles = liveArticles.filter(seenArticle)
			const newArticles = liveArticles.filter(b => !seenArticle(b))

			// --- 文章 frontmatter 单篇/多篇决策（修工单：ALL 合并把文章属性收成 syncedIds-only）---
			// 单篇文章文件（文件最终只含 1 篇文章、且无企微消息）→ 把该篇完整业务元数据写到
			// 文件级 frontmatter，读起来等同独立文章笔记；否则（多篇 / 含企微 / 已是 digest）→
			// 文件级 frontmatter 维持原状（只随 syncedIds 更新，且**保留用户手填字段**），
			// 文章业务元数据下沉到各自 section（callout 属性块）。
			//
			// ⚠️ 不做「按 key 剥离」——用户手填的 frontmatter（如 tags）必须跨同步保留
			// （回归见 MergeProcessorBatch『preserves user-customized frontmatter』）。文章
			// 元数据本就只在 b.content 里、不在文件 parsedFm 里，所以多篇分支无需剥离。
			// 「现有文件是单篇完整 fm」用文件级 id 判定：本插件只在【单篇】文章笔记把 id 写到
			// 文件级 frontmatter（与 NONE 模式一致）；多篇 digest / 企微文件只有 syncedIds、无 id。
			// 这样用户给 digest 手填 tags 之类也不会被误判成单篇。
			const existingIsSingleFull =
				typeof parsedFm.id === 'string' && (parsedFm.id).length > 0
			// 「已有正文」= 文件头之外已有内容。启用合并文件模板时新建文件天生带文件头，
			// 裸 body.trim() 会把它误判成「已是 digest」，让单篇文章属性被错误下沉进 callout。
			const existingHasBody = mergeBodyHasContent(body, headerRe)
			const hasWechatInFile = wechatItems.length > 0
			// 刚按合并文件模板新建、文件头之下还空着的文件（无模板 / 认不出文件头时恒 false）。
			// 必须排在 existingIsSingleFull 之前判：用户如果在模板属性里写了 `id:`，那个 id
			// 与本批文章的 UUID 不同 → 会把一个「全新空文件」误判成 digest，单篇文章属性被
			// 错误下沉进 callout（codex P2）。
			const freshTemplatedFile = isHeaderOnlyBody(body, headerRe, templateActive)
			let isSingleArticleFile: boolean
			if (hasWechatInFile) {
				isSingleArticleFile = false                       // 含企微 → digest
			} else if (freshTemplatedFile) {
				isSingleArticleFile = liveArticles.length === 1
			} else if (existingIsSingleFull) {
				// 现有文件带文件级 id（单篇，或「首篇为主」过渡后仍保留首篇 id 的多篇文件）。
				// 仅当「本批恰好只有这一篇、且就是文件首篇（id 匹配）、且无新增文章」才判单篇。
				// 三个条件缺一不可：
				//   - articleItems.length === 1：避免「过渡后多篇文件重同步时本批含多篇」被误判单篇，
				//     进而用 articleItems[0]（顺序相关）覆盖文件级 fm → 漂移（codex v3 阻断）。
				//   - id === parsedFm.id：本批那一篇必须就是文件首篇，防 Bloom 假阳性 / 改写别篇时劫持。
				//   - newArticles.length === 0：有新增文章即进入「首篇为主」多篇路径。
				// （omitId 游标去重后按 liveArticles 计：被游标跳过的文章不参与单篇判定/替换）
				isSingleArticleFile =
					newArticles.length === 0 &&
					liveArticles.length === 1 &&
					liveArticles[0].item.id === parsedFm.id
			} else if (!existingHasBody) {
				// 全新空文件：本批恰好 1 篇文章 → 单篇
				isSingleArticleFile = liveArticles.length === 1
			} else {
				// 现有 minimal fm + 已有正文 = 已是 digest（多篇/历史企微）→ 多篇
				isSingleArticleFile = false
			}

			// 单篇→多篇过渡（已有单篇文件后又来新文章 / 企微）采用「首篇为主」：**不**改动
			// 已落盘的文件级 frontmatter（保留首篇属性 + 用户手填字段，作为该文件的代表属性），
			// 只让【新增】文章各自带 section 属性块。
			// 这样做的理由（数据安全铁律：宁可不下沉，绝不丢数据）：把已落盘文件级属性「下沉」回
			// 正文需要不可逆地删除文件级 key，会连带搬走/破坏用户的 aliases / cssclass / tags 等
			// 真·Obsidian 文件属性，且与 Bloom 假阳性、企微排序叠加易错位。首篇为主零删除、零搬移、
			// 跨同步稳定收敛，代价仅是 digest 的 Properties 显示首篇属性（不影响任何数据）。

			// 渲染一篇「新」文章的 section 正文：多篇时在正文前加属性块，单篇时不加（属性进文件级）。
			const articleSection = (b: MergeBatchItem): string => {
				const raw = removeFrontMatterFromContent(b.content)
				if (isSingleArticleFile) return raw
				const itemFmRaw = parseFrontMatterFromContent(b.content)
				const itemFm = (itemFmRaw && !Array.isArray(itemFmRaw) ? itemFmRaw : {}) as Record<string, unknown>
				const header = renderSectionMeta(itemFm)
				return header ? `${header}\n\n${raw}` : raw
			}

			// Step 1: Apply replacements for existing articles
			for (const b of existingArticles) {
				const contentWithoutFrontmatter = removeFrontMatterFromContent(b.content)
				if (this.context.settings.sectionSeparator && this.context.settings.sectionSeparatorEnd) {
					const dateSaved = formatDate(b.item.savedAt, this.context.settings.dateSavedFormat)
					const articleView = { id: b.item.id, title: b.item.title, dateSaved }
					const renderedStart = Mustache.render(this.context.settings.sectionSeparator, articleView)
					const renderedEnd = Mustache.render(this.context.settings.sectionSeparatorEnd, articleView)
					const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
					const regex = new RegExp(`${escapeRegex(renderedStart)}.*?${escapeRegex(renderedEnd)}`, 's')
					body = body.replace(regex, contentWithoutFrontmatter)
				} else {
					body = insertIntoMergeBody(body, contentWithoutFrontmatter, sortOrder, headerRe)
				}
			}

			// Step 2: Append/prepend new articles in sorted order
			if (newArticles.length > 0) {
				const sortedNew = sortItems(newArticles, sortOrder)
				const concatenated = sortedNew
					.map(b => articleSection(b))
					.join('\n\n')

				body = insertIntoMergeBody(body, concatenated, sortOrder, headerRe)

				for (const b of sortedNew) {
					markSynced(b.item, removeFrontMatterFromContent(b.content))
				}
			}

			// Build updated frontmatter with syncedIds.
			// 单篇文章文件：把该篇完整业务元数据写到文件级（等同独立笔记，工单修复）；
			// 其余情况：维持 {...parsedFm}（保留用户手填字段 + 原内部字段），元数据已下沉各 section。
			const updatedFm: Record<string, unknown> = { ...parsedFm }
			if (isSingleArticleFile && liveArticles.length >= 1) {
				// 用这唯一一篇的完整 frontmatter 补齐业务字段（新文件 / 重同步都从 item content 取）；
				// 文章字段为权威，覆盖 parsedFm 里的同名旧值，但保留 parsedFm 独有的用户手填 key。
				const onlyFmRaw = parseFrontMatterFromContent(liveArticles[0].content)
				if (onlyFmRaw && !Array.isArray(onlyFmRaw)) {
					for (const [k, v] of Object.entries(onlyFmRaw as Record<string, unknown>)) {
						if (!INTERNAL_FM_KEYS.has(k)) updatedFm[k] = v
					}
				}
			}
			// 其余情况（全新多篇 / 已有 digest / 仅企微 / 单篇→多篇过渡）维持 {...parsedFm}：
			// 既保留用户手填字段，也保留「首篇为主」的已落盘属性；新增文章的业务元数据只进各 section。
			// 纯企微消息文件（非 burn、无文章、无 legacy Bloom）：syncedIds 恒为空 →
			// 省掉这个字段，frontmatter 保持干净（用户诉求）。burn 模式仍写（索引一致性）；
			// ALL 模式有文章、或旧文件带 legacy Bloom 时 syncedIds 非空 → 保留作去重/回退。
			if (burn || syncedIds !== emptyFilter) {
				updatedFm.syncedIds = syncedIds
			} else {
				delete updatedFm.syncedIds
			}
			if (burn) {
				// 写精确数组（裁剪掉所有设备游标都已越过且非 pending 的旧记录）
				updatedFm.burnSyncedIds = pruneBurnSyncedIds(burnRecords, burnMinCursor, burnPendingIds)
			}
			if ('messages' in updatedFm) delete updatedFm.messages
			// 空对象在真机 stringifyYaml 输出字面量 "{}"，落盘成 `---\n{}\n---` 噪音
			// （纯消息文件删掉 syncedIds 后就是空对象）；归一成空 frontmatter。
			let fmYaml = stringifyYaml(updatedFm)
			if (fmYaml.trim() === '{}') fmYaml = ''
			const newFmBlock = `---\n${fmYaml}---\n\n`

			const merged = newFmBlock + body
			// 写入前 replay 已知 (filePath, url)→localPath 映射，避免合并模式下也把本地化结果覆盖回远程链接
			const localizer = this.context.imageLocalizer
			return localizer ? localizer.replayLocalizedUrls(merged, omnivoreFile.path) : merged
		})

		// 阅后即焚：vault.process 成功返回后才 commit（崩溃/写盘失败则不污染游标/删除集）。
		// cursorRecords = 本批全部 item（都已落地，可推进游标）；deleteRecords = 仅本轮真实新写入的。
		if (burn) {
			for (const b of batchItems) {
				this.context.burnTracker.recordCursor(b.item.id, b.item.updatedAt ?? '')
			}
			for (const { item, content } of stagedNew) {
				this.context.burnTracker.recordDelete({
					id: item.id,
					updatedAt: item.updatedAt ?? '',
					filePath: omnivoreFile.path,
					originalImageUrls: extractRemoteImageUrls(content),
					originalAttachmentUrls: extractRemoteAttachmentUrls(content),
				})
			}
		}

		// --- Phase C (removed): processFrontMatter was eliminated ---
		// Previously used a separate processFrontMatter call to update syncedIds,
		// but that could misparse body content starting with "---" as frontmatter
		// delimiters, silently dropping the first message (in DESC order).
		// Now handled atomically in Phase B above.

		// --- Phase D: Post-processing ---
		// 合并模式下一个笔记文件对应多个 item，localizer 的文件夹路径模板可能
		// 引用 {{{siteName}}} / {{{author}}} / {{{originalUrl}}} 等 per-item 字段。
		// 取 batch 第一条 input item 作为 owner —— 与历史 batchSavedAt = batchItems[0]
		// 同源，MergeProcessorBatch.spec.ts 也钉死了"按输入顺序首条"的语义。
		// 用户若要 per-item 附件分目录，应切到 single-file 模式。
		const batchOwnerItem = batchItems[0]?.item
		const batchMeta = batchOwnerItem
			? itemToLocalizerMeta(batchOwnerItem)
			: undefined
		await this.context.enqueueFileForImageLocalization(omnivoreFile, batchMeta)
		await this.context.enqueueFileForAttachmentLocalization(omnivoreFile, batchMeta)
		this.context.addProcessedFile(omnivoreFile)

		for (const b of wechatItems) {
			this.context.successTracker.recordSuccess(b.item.id)
			const anchor = generateMessageAnchor(
				b.item,
				this.context.settings.dateSavedFormat,
				// 与 Phase A 渲染用同一份接力后模板，锚点才与文件里的实际标题一致
				wechatTemplate
			)
			this.context.diaryLinkProcessor.addLink(b.item, omnivoreFile.basename, anchor)
		}
		for (const b of articleItems) {
			this.context.successTracker.recordSuccess(b.item.id)
			this.context.diaryLinkProcessor.addLink(b.item, omnivoreFile.basename, undefined)
		}
	}
}
