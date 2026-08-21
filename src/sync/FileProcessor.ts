import { Item } from '@omnivore-app/api'
import { normalizePath, TFile } from 'obsidian'
import { SyncContext } from './SyncContext'
import { logError } from '../logger'
import {
	LocalizerItemMeta,
	itemToLocalizerMeta,
} from '../common/localizerItemMeta'
import { extractRemoteImageUrls, extractRemoteAttachmentUrls } from './burnResidual'
import { suppressTemplaterTriggerOnCreate } from './templaterRelay'

/**
 * FileProcessor - 单文件模式处理器
 *
 * 职责：
 * - 处理每条消息/文章创建独立文件
 * - 处理文件名冲突（带编号文件）
 * - 文件更新和创建
 * - 统一使用SuccessTracker记录成功
 */
/**
 * 双写模式（MergeMode.DUAL）下「消息的独立副本」这一次写入的选项。
 *
 * 该副本是合并副本之外的**额外**一份：合并副本才是这条消息的主真相
 * （游标 / 阅后即焚删除候选 / 日记双链都由 MergeProcessor 负责），
 * 所以这里必须：
 *  - 只按「独立笔记」索引路由（findStandaloneFileById），绝不命中合并文件；
 *  - 不登记阅后即焚删除候选（BurnDeleteTracker 按 id 单记录，登记会顶掉合并副本那条
 *    → 删云端前只复查了独立副本、合并副本的本地化残留失去把关，违反数据安全铁律）；
 *  - 不再打日记双链（日记按 item.id 去重，先到先得；沿用合并副本那条带锚点的链接）。
 */
export interface DualCopyOptions {
	/** true = 本次是双写的独立副本 */
	dualStandaloneCopy?: boolean
}

export class FileProcessor {
	constructor(private context: SyncContext) {}

	/**
	 * 处理单文件模式的文章/消息
	 */
	async process(
		item: Item,
		normalizedPath: string,
		content: string,
		folderName: string,
		customFilename: string,
		options: DualCopyOptions = {},
	): Promise<void> {
		// 用方法局部变量代替实例字段：避免同实例并发 process 时后一次覆盖前一次的
		// meta，造成 enqueue 把 file-A 的图片落进 file-B 的 siteName 路径。
		const meta = itemToLocalizerMeta(item)
		const dual = options.dualStandaloneCopy === true
		// 先查 ID 索引（跨设备去重）。阅后即焚模式用 exact-only 查找，
		// 避免 Bloom 假阳性把新 item 误路由到错误文件（design §6.3）。
		// 双写独立副本用 standalone-only 查找，避免拿单篇正文覆写整个合并文件。
		const burn = this.context.settings.burnAfterReading === true
		const indexed = dual
			? this.context.findStandaloneFileById(item.id)
			: burn
				? this.context.findFileByExactId(item.id)
				: this.context.findFileById(item.id)
		// 🔴 单篇写入绝不落进合并文件。updateFileIfNeeded 是整文件替换：把一篇正文写进
		// 装着一整天消息的 digest = 整天数据被一条消息顶掉，不可逆。
		// 双写模式下这尤其容易发生（同一 id 两处都有，通用索引只记得住其中一个），
		// 但模式切换（双写/仅合并 → 不合并、ALL → MESSAGES）同样会踩到，所以对所有路径生效：
		// 命中合并文件时退回「只认独立笔记」的索引，找不到就按路径新建/编号，宁可多一个文件。
		const existingByIndex = indexed && this.context.isMergeFilePath(indexed.path)
			? this.context.findStandaloneFileById(item.id)
			: indexed
		if (existingByIndex) {
			const existingContent = await this.context.app.vault.read(existingByIndex)
			const wf = { wrote: false }
			await this.updateFileIfNeeded(existingByIndex, existingContent, content, meta, wf)
			// 双写的独立副本不记成功：成功=可推进游标，而这条消息的主真相是合并副本。
			// 若合并落盘随后失败（flushMergeGroups 批量+逐条都失败），这里记了成功会让
			// 游标越过该 item → 合并副本永远不会被重试（codex P1）。
			if (dual) return
			this.context.successTracker.recordSuccess(item.id)
			this.recordBurn(item, existingByIndex, content, wf.wrote)
			this.context.diaryLinkProcessor.addLink(item, existingByIndex.basename, undefined)
			return
		}

		const omnivoreFile = this.context.app.vault.getAbstractFileByPath(normalizedPath)

		const writeFlag = { wrote: false }
		let resultFile: TFile | null
		if (omnivoreFile instanceof TFile) {
			// 文件已存在，检查ID
			resultFile = await this.handleExistingFile(
				item,
				omnivoreFile,
				content,
				folderName,
				customFilename,
				meta,
				writeFlag,
			)
		} else {
			// 文件不存在，创建新文件
			resultFile = await this.createNewFile(normalizedPath, content, meta, writeFlag)
		}

		// 双写独立副本不记成功（游标真相归合并副本，见上）
		if (dual) return
		// ✅ 统一在这里记录成功（自动去重）
		this.context.successTracker.recordSuccess(item.id)
		this.recordBurn(item, resultFile, content, writeFlag.wrote)

		// 添加日记链接：优先使用实际落盘文件的 basename，避免 ID 冲突路径下
		// 写入的链接 target 指向不存在的文件名。
		const linkTarget = resultFile ? resultFile.basename : customFilename
		this.context.diaryLinkProcessor.addLink(item, linkTarget, undefined)
	}

	/**
	 * 阅后即焚：登记游标真相 + 删除候选。
	 * 单文件模式下文件以 item.id 为 frontmatter id 落地，落地即「本地已有」→ 可推进游标 + 可删云端。
	 * filePath + 原始 URL 供删除前的「本地化无残留」复查（见 main.ts 删除阶段 / burnResidual.ts）。
	 */
	private recordBurn(item: Item, file: TFile | null, content: string, wrote: boolean): void {
		if (this.context.settings.burnAfterReading !== true) return
		// 游标真相：本地已落地（含判重命中/no-op）→ 总是推进。
		this.context.burnTracker.recordCursor(item.id, item.updatedAt ?? '')
		// 删除真相：仅「本轮真实 create/modify 了字节」才算删除候选（codex P2 + design §5.2）。
		// 否则 exact-id no-op（如游标回退重拉已存在文件）会误删云端这篇的副本。
		if (file && wrote) {
			this.context.burnTracker.recordDelete({
				id: item.id,
				updatedAt: item.updatedAt ?? '',
				filePath: file.path,
				originalImageUrls: extractRemoteImageUrls(content),
				originalAttachmentUrls: extractRemoteAttachmentUrls(content),
			})
		}
	}

	/**
	 * 处理已存在的文件
	 * @returns 本次处理对应的实际文件（用于拿 basename 打双链）
	 */
	private async handleExistingFile(
		item: Item,
		omnivoreFile: TFile,
		content: string,
		folderName: string,
		customFilename: string,
		meta: LocalizerItemMeta,
		writeFlag?: { wrote: boolean },
	): Promise<TFile | null> {
		// 🔴 目标路径上坐着一个合并文件（用户把文章文件名模板配成了跟合并文件同名、
		// 或改过模板导致撞上旧的按天合并文件）→ 合并 digest 没有顶层 id，会被判成
		// 「无 id，原地更新」而被一条正文整份覆写。改走编号文件，宁可多一个文件。
		if (this.context.isMergeFilePath(omnivoreFile.path)) {
			logError(`⚠️ 目标路径是合并文件，改写编号文件避免覆盖: ${omnivoreFile.path}`)
			return this.handleIdConflict(item, content, folderName, customFilename, meta, writeFlag)
		}

		const existingContent = await this.context.app.vault.read(omnivoreFile)
		const existingId = this.extractIdFromContent(existingContent)

		if (existingId && existingId !== item.id) {
			// ID不同，需要创建带编号的文件
			return this.handleIdConflict(
				item,
				content,
				folderName,
				customFilename,
				meta,
				writeFlag,
			)
		}

		// ID相同或无ID，更新现有文件
		await this.updateFileIfNeeded(omnivoreFile, existingContent, content, meta, writeFlag)
		return omnivoreFile
	}

	/**
	 * 处理ID冲突（寻找或创建带编号的文件）
	 * @returns 本次命中或新建的真实文件
	 */
	private async handleIdConflict(
		item: Item,
		content: string,
		folderName: string,
		customFilename: string,
		meta: LocalizerItemMeta,
		writeFlag?: { wrote: boolean },
	): Promise<TFile> {
		let suffix = 2
		let newPageName = `${folderName}/${customFilename} ${suffix}.md`
		let newNormalizedPath = normalizePath(newPageName)
		let newOmnivoreFile = this.context.app.vault.getAbstractFileByPath(newNormalizedPath)

		// 「笔记属性不写 id」模式：本插件写出的编号文件没有 id 可比对。若不认无 id
		// 的编号文件，同一篇文章每次更新都会新开一个编号（Title 2/3/4…无限增殖，
		// codex round2 P2）。该模式语义本就是「同名视为同一篇」，所以无 id 的编号
		// 文件按同篇原地更新。burn 恒写 id，不受此分支影响。
		const omitIdMode =
			this.context.settings.omitFrontmatterId === true &&
			this.context.settings.burnAfterReading !== true

		// 循环寻找：1) 相同ID的文件（更新）或 2) 不存在的文件名（创建）
		while (newOmnivoreFile instanceof TFile) {
			try {
				// 编号位上也可能坐着合并文件 —— 同样跳过，绝不覆写
				if (this.context.isMergeFilePath(newOmnivoreFile.path)) {
					suffix++
					newPageName = `${folderName}/${customFilename} ${suffix}.md`
					newNormalizedPath = normalizePath(newPageName)
					newOmnivoreFile = this.context.app.vault.getAbstractFileByPath(newNormalizedPath)
					continue
				}
				const checkContent = await this.context.app.vault.read(newOmnivoreFile)
				const checkId = this.extractIdFromContent(checkContent)

				if (checkId === item.id || (omitIdMode && checkId === null)) {
					// 找到相同ID的文件（或无 id 模式下的同名无 id 文件），更新
					await this.updateFileIfNeeded(newOmnivoreFile, checkContent, content, meta, writeFlag)
					return newOmnivoreFile
				}

				// 尝试下一个编号
				suffix++
				newPageName = `${folderName}/${customFilename} ${suffix}.md`
				newNormalizedPath = normalizePath(newPageName)
				newOmnivoreFile = this.context.app.vault.getAbstractFileByPath(newNormalizedPath)
			} catch (error) {
				// ✅ 添加错误处理：文件可能被删除
				const errorMsg = error instanceof Error ? error.message : String(error)
				if (errorMsg.includes('ENOENT') || errorMsg.includes('no such file')) {
					// 文件在检查过程中被删除，尝试下一个编号
					suffix++
					newPageName = `${folderName}/${customFilename} ${suffix}.md`
					newNormalizedPath = normalizePath(newPageName)
					newOmnivoreFile = this.context.app.vault.getAbstractFileByPath(newNormalizedPath)
					continue
				}
				throw error // 其他错误抛出
			}
		}

		// 找到可用文件名，创建新文件
		// P0 加固：预挂 Templater trigger_on_file_creation 抑制条目（同步内容=不可信输入）
		const releaseSuppress = suppressTemplaterTriggerOnCreate(this.context.app, newNormalizedPath)
		let createdFile: TFile
		try {
			createdFile = await this.context.app.vault.create(newNormalizedPath, content)
		} finally {
			releaseSuppress()
		}
		if (writeFlag) writeFlag.wrote = true
		await this.context.enqueueFileForImageLocalization(createdFile, meta)
		await this.context.enqueueFileForAttachmentLocalization(createdFile, meta)
		this.context.addProcessedFile(createdFile)
		return createdFile
	}

	/**
	 * 更新文件（如果内容有变化）
	 */
	private async updateFileIfNeeded(
		file: TFile,
		existingContent: string,
		newContent: string,
		meta: LocalizerItemMeta,
		writeFlag?: { wrote: boolean },
	): Promise<void> {
		// 写入前 replay 已知 (filePath, url)→localPath 映射，避免本地化结果被覆盖回远程链接。
		// 必须在确定目标文件后按其路径 replay：每个笔记的附件可能落在不同目录。
		if (this.context.imageLocalizer) {
			newContent = this.context.imageLocalizer.replayLocalizedUrls(newContent, file.path)
		}
		if (existingContent !== newContent) {
			await this.context.app.vault.modify(file, newContent)
			if (writeFlag) writeFlag.wrote = true
		}
		await this.context.enqueueFileForImageLocalization(file, meta)
		await this.context.enqueueFileForAttachmentLocalization(file, meta)
		this.context.addProcessedFile(file)
	}

	/**
	 * 创建新文件
	 * @returns 实际创建或复用的文件；并发冲突后拿不到也有可能返回 null
	 */
	private async createNewFile(
		normalizedPath: string,
		content: string,
		meta: LocalizerItemMeta,
		writeFlag?: { wrote: boolean },
	): Promise<TFile | null> {
		// P0 加固：预挂 Templater trigger_on_file_creation 抑制条目（同步内容=不可信输入）
		const releaseSuppress = suppressTemplaterTriggerOnCreate(this.context.app, normalizedPath)
		try {
			let createdFile: TFile
			try {
				createdFile = await this.context.app.vault.create(normalizedPath, content)
			} finally {
				releaseSuppress()
			}
			if (writeFlag) writeFlag.wrote = true
			await this.context.enqueueFileForImageLocalization(createdFile, meta)
			await this.context.enqueueFileForAttachmentLocalization(createdFile, meta)
			this.context.addProcessedFile(createdFile)
			return createdFile
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)
			if (errorMsg.includes('File already exists')) {
				// 文件已存在（并发创建），尝试获取并处理
				const existingFile = this.context.app.vault.getAbstractFileByPath(normalizedPath)
				if (existingFile instanceof TFile) {
					await this.context.enqueueFileForImageLocalization(existingFile, meta)
					await this.context.enqueueFileForAttachmentLocalization(existingFile, meta)
					this.context.addProcessedFile(existingFile)
					return existingFile
				}
				return null
			}
			logError(`🔧 文件创建失败: ${normalizedPath}`, error)
			throw error // 重新抛出以便上层处理
		}
	}

	/**
	 * 从文件内容中提取ID
	 */
	private extractIdFromContent(content: string): string | null {
		const idMatch = content.match(/^---\r?\n(?:[\s\S]*?)^id:\s*(.+?)\s*$/m)
		return idMatch ? idMatch[1].trim() : null
	}
}
