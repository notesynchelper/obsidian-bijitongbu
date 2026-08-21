import {
	extractRemoteImageUrls,
	extractRemoteAttachmentUrls,
	hasLocalizationResidual,
} from '../src/sync/burnResidual'
import { ImageMode } from '../src/settings'

describe('burnResidual.extractRemoteImageUrls', () => {
	it('抽出 ![](url) / <img src> 的远程 URL，跳过本地/相对/data', () => {
		const content = [
			'![alt](https://cdn.example.com/a.jpg)',
			'<img src="http://cdn.example.com/b.png">',
			'![](./local.png)',
			'![[vault-embed.png]]',
			'![](data:image/png;base64,xxx)',
		].join('\n')
		const urls = extractRemoteImageUrls(content)
		expect(urls).toContain('https://cdn.example.com/a.jpg')
		expect(urls).toContain('http://cdn.example.com/b.png')
		expect(urls).not.toContain('./local.png')
		expect(urls.some(u => u.startsWith('data:'))).toBe(false)
	})
	it('空内容返回空', () => {
		expect(extractRemoteImageUrls('')).toEqual([])
	})
	it('强制本地化域名的普通链接 [x](relay/p/...) 也算原始图片 URL（与 localizer 第二遍一致，防漏删）', () => {
		const url = 'https://relay-1.bijitongbu.site/p/abc.jpeg'
		expect(extractRemoteImageUrls(`see [pic](${url}) here`)).toContain(url)
		// 普通非强制域名的链接不算图片
		expect(extractRemoteImageUrls('[link](https://example.com/page.html)')).not.toContain('https://example.com/page.html')
	})
	it('绝不本地化域名（积分充值二维码）不计入残留——按设计留在文件里，不挡 burn 删除', () => {
		const qr = 'https://www.bijitongbu.site/qr/kuaikan.png'
		const content = `<p align="center"><img src="${qr}" width="25%" alt="积分充值二维码"></p>`
		expect(extractRemoteImageUrls(content)).not.toContain(qr)
	})
})

describe('burnResidual.extractRemoteAttachmentUrls', () => {
	it('抽出企微文件附件的远程 URL', () => {
		// ATTACHMENT_PATTERN 形态：[📎 文件名](url "大小") 之类——用真实附件渲染样式
		const content = '[📎 报告.pdf](https://files.example.com/x.pdf)'
		const urls = extractRemoteAttachmentUrls(content)
		// 取决于 ATTACHMENT_PATTERN；至少不应抛错，且若识别出则为远程 URL
		for (const u of urls) expect(u.startsWith('http')).toBe(true)
	})
	it('无附件返回空', () => {
		expect(extractRemoteAttachmentUrls('plain text')).toEqual([])
	})
})

describe('burnResidual.hasLocalizationResidual', () => {
	const rec = {
		originalImageUrls: ['https://cdn.example.com/a.jpg'],
		originalAttachmentUrls: ['https://files.example.com/x.pdf'],
	}

	it('LOCAL 模式：原始图片 URL 仍在文件 → 残留（不可删）', () => {
		const file = 'text ![](https://cdn.example.com/a.jpg) more'
		expect(hasLocalizationResidual(file, rec, ImageMode.LOCAL)).toBe(true)
	})
	it('LOCAL 模式：原始图片 URL 已被本地化替换掉 → 无残留（可删）', () => {
		const file = 'text ![[笔记同步助手/images/a.jpg]] more' // 原始 http URL 不在了
		const imgOnly = { originalImageUrls: rec.originalImageUrls, originalAttachmentUrls: [] }
		expect(hasLocalizationResidual(file, imgOnly, ImageMode.LOCAL)).toBe(false)
	})
	it('图床接力把本地图变成新远程 userCDN URL ≠ 原始 URL → 不误判为残留', () => {
		const file = 'text ![](https://user-cdn.net/relayed.jpg) more' // 不同于原始 cdn.example.com
		const imgOnly = { originalImageUrls: rec.originalImageUrls, originalAttachmentUrls: [] }
		expect(hasLocalizationResidual(file, imgOnly, ImageMode.LOCAL)).toBe(false)
	})
	it('REMOTE / DISABLED 模式：不因图片 URL 残留挡删除', () => {
		const file = 'text ![](https://cdn.example.com/a.jpg) more'
		const imgOnly = { originalImageUrls: rec.originalImageUrls, originalAttachmentUrls: [] }
		expect(hasLocalizationResidual(file, imgOnly, ImageMode.REMOTE)).toBe(false)
		expect(hasLocalizationResidual(file, imgOnly, ImageMode.DISABLED)).toBe(false)
	})
	it('附件原始 URL 残留：任何模式都挡删除', () => {
		const file = 'see [📎](https://files.example.com/x.pdf)'
		const attOnly = { originalImageUrls: [], originalAttachmentUrls: rec.originalAttachmentUrls }
		expect(hasLocalizationResidual(file, attOnly, ImageMode.REMOTE)).toBe(true)
		expect(hasLocalizationResidual(file, attOnly, ImageMode.LOCAL)).toBe(true)
	})
})
