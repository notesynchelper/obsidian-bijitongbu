/**
 * 合并消息「内联隐形标记」去重（方案 A）。
 *
 * 每条渲染出的企微消息块尾部挂一个 HTML 注释标记 `<!--nh:<item.id>-->`：
 *  - 阅读视图不渲染（对用户隐形），只在源码模式可见；
 *  - 用完整 item.id（omnivore 侧为 UUID）→ 零碰撞、精确判重；
 *  - 标记随消息块一起 append/prepend/排序，天然与内容同生共灭。
 *
 * 去重 = 每次同步扫 body 收集已存在标记集合，精确比对。取代会假阳性静默
 * 丢消息、且一坨 base64 blob 挂在 frontmatter 的 264-bit Bloom `syncedIds`。
 * 详见 project_bloom_filter_silent_message_drop。
 */

/** 内联标记的线格式：`<!--nh:<id>-->`。id 不含 `<`/`>`/空白。 */
export const MESSAGE_MARKER_RE = /<!--nh:([^\s<>]+)-->/g

/** 生成一条消息的隐形标记。 */
export function buildMessageMarker(id: string): string {
	return `<!--nh:${id}-->`
}

/** 扫描内容里已存在的全部标记 id（去重成 Set）。 */
export function scanMessageMarkers(content: string): Set<string> {
	const set = new Set<string>()
	if (!content) return set
	const re = new RegExp(MESSAGE_MARKER_RE.source, 'g')
	let m: RegExpExecArray | null
	while ((m = re.exec(content)) !== null) set.add(m[1])
	return set
}

/** 把标记贴到一个渲染好的消息块尾部（块与标记之间留一个换行）。 */
export function appendMarker(rendered: string, id: string): string {
	return `${rendered}\n${buildMessageMarker(id)}`
}
