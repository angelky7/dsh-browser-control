/**
 * UTF-16 截断守卫（issue #26）。
 *
 * 页面文本按**码元** `slice(0, n)` 会切出孤立代理项（半个 emoji）。`JSON.stringify`
 * 把它写成裸 `\ud83d`，模型的 JSON 解析器要求代理对成对出现，于是**整个请求体**
 * 被 400 拒收；坏字符进了会话历史就每轮重放，只能换会话。
 *
 * 两条规则：
 *  1. 切点落在高位代理项上时退一格——宁可少一个字，不留半个字符；
 *  2. `toWellFormed()` 兜底页面自己提供的坏字符（孤立代理项 → U+FFFD）。
 */

/** 把任意字符串变成 well-formed UTF-16（孤立代理项 → U+FFFD）。 */
export function toWellFormed(text: string): string {
	const fn = (text as { toWellFormed?: () => string }).toWellFormed
	if (typeof fn === 'function') return fn.call(text)
	// 老运行时兜底：只替换没有配对的代理项。
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

/**
 * 按码元上限截断，但不留下半个代理对。
 * @param text - 原文本。
 * @param maxChars - 码元上限（与既有 offset/limit 语义一致）；≤0 返回空串。
 */
export function sliceWellFormed(text: string, maxChars: number): string {
	if (maxChars <= 0) return ''
	if (text.length <= maxChars) return toWellFormed(text)
	let end = maxChars
	const unit = text.charCodeAt(end - 1)
	// 高位代理项（0xD800–0xDBFF）意味着下一码元才是配对的一半：退一格。
	if (unit >= 0xd800 && unit <= 0xdbff) end -= 1
	return toWellFormed(text.slice(0, Math.max(0, end)))
}
