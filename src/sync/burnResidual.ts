import { isRemoteImage } from '../imageLocalizer/imageDownloader'
import { isRemoteAttachment, extractFileAttachmentFromContent } from '../attachmentLocalizer'
import { isAlwaysLocalizeDomain, isNeverLocalizeUrl } from '../common/imageRelay'
import { ImageMode } from '../settings'
import { scanImageSyntax } from '../imageLocalizer/imageSyntax'

/**
 * 与 ImageLocalizer 共用 imageSyntax.ts 的小型扫描器（![alt](url) / ![[url]] /
 * <img src>），避免残留复查与本地化判定因两份正则漂移而打架。
 * 源真相：src/imageLocalizer/imageSyntax.ts。
 */
/** 抽出 item 渲染正文里、本地化器会去本地化的「原始远程图片 URL」集合。 */
export function extractRemoteImageUrls(content: string): string[] {
	if (!content) return []
	const out = new Set<string>()

	// 第一遍：标准图片语法 ![](url) / ![[url]] / <img src>
	for (const match of scanImageSyntax(content)) {
		const url = match.url
		if (!url || !isRemoteImage(url)) continue
		// 绝不本地化的 UI 元素（如积分充值二维码）按设计留在文件里，
		// 不计入残留 —— 否则 burn 删除会被它永久卡成 localization-pending。
		if (isNeverLocalizeUrl(url)) continue
		out.add(url)
	}

	// 第二遍：强制本地化域名在普通链接 [text](url)（非图片语法）里的资源。
	// 必须与 imageLocalizer.detectRemoteImages 第二遍一致，否则这类链接本地化失败时
	// originalImageUrls 漏掉 → 残留门槛挡不住 → 误删云端（codex review P2 / 数据安全）。
	const linkRe = /(?<!!)\[([^\]]*)\]\(([^)\n]+)\)/g
	let lm: RegExpExecArray | null
	while ((lm = linkRe.exec(content)) !== null) {
		const url = lm[2]
		if (!url || !isRemoteImage(url) || !isAlwaysLocalizeDomain(url)) continue
		// 跳过 📎 附件链接（由 originalAttachmentUrls 覆盖）
		const prefix = content.substring(Math.max(0, lm.index - 10), lm.index)
		if (prefix.includes('📎')) continue
		out.add(url)
	}

	return Array.from(out)
}

/** 抽出 item 渲染正文里的「原始远程附件 URL」（企微文件消息等）。 */
export function extractRemoteAttachmentUrls(content: string): string[] {
	if (!content) return []
	const att = extractFileAttachmentFromContent(content)
	if (att && att.url && isRemoteAttachment(att.url)) return [att.url]
	return []
}

/**
 * 删除前的「本地化无残留」复查：只检查该 item **自己的原始 URL** 是否仍残留在文件里。
 *
 * - 图片：仅 `imageMode===LOCAL` 才检查（REMOTE 保留原链是预期；DISABLED 把原链注释成
 *   `<!-- ![](url) -->` 也是预期 —— 这两种模式不该因图片 URL 残留挡删除）。
 * - 附件：任何模式都检查。
 * - 图床接力把本地图变成的新远程 userCDN URL ≠ 原始 URL，故不会被误判为失败。
 *
 * 返回 true = 仍有残留 = 本地化没成功 = 本轮不删（转 pending 下轮重试）。
 */
export function hasLocalizationResidual(
	fileContent: string,
	record: { originalImageUrls: string[]; originalAttachmentUrls: string[] },
	imageMode: ImageMode,
): boolean {
	if (!fileContent) return false
	if (imageMode === ImageMode.LOCAL) {
		for (const u of record.originalImageUrls) {
			if (u && fileContent.includes(u)) return true
		}
	}
	for (const u of record.originalAttachmentUrls) {
		if (u && fileContent.includes(u)) return true
	}
	return false
}
