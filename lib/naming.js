// 命名规则：一个项目一个文件夹，叫 `NN-中文项目名`。
//
// 照工作区里已有的手写习惯来（01-示例项目-第二阶段、02-课堂录音-转写、
// 00-环境装配 … 11-示例插件）：
//   - 文件夹名是中文短名，不带编号、不带标点，词之间用短横线；
//   - 编号接工作区根目录已有的最大编号往后排；
//   - 文件名保持原样搬进去 —— 脚本里常写死文件名，改名容易把引用打断。

import { pad2 } from './util.js'

/** Windows 文件名里不允许的字符。 */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g
/** 这些名字在 Windows 上是设备名，不能当文件夹名。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
/** 以 1~3 位数字加分隔符开头的名字，算「已经整理过的项目」。 */
const NUMBERED = /^(\d{1,3})[-_．.、 ]/

/** "a.tar.gz" → { stem: "a.tar", ext: ".gz" }；".gitignore" → { stem: ".gitignore", ext: "" }。 */
export function splitFileName(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot).toLowerCase() }
}

/** 名字是不是「编号-项目」这一种。 */
export function isNumberedName(name) {
  return NUMBERED.test(String(name ?? '').trim())
}

/** "03-示例项目-第三阶段" → 3；不是编号名 → undefined。 */
export function projectNumber(name) {
  const match = NUMBERED.exec(String(name ?? '').trim())
  if (match === null) return undefined
  const number = Number(match[1])
  return Number.isFinite(number) ? number : undefined
}

/**
 * 把模型给的项目名收拾成能当文件夹名的样子。
 * 返回空字符串表示这个名字不能用（调用方直接丢掉这一组）。
 */
export function cleanProjectName(input, { maxLength = 24 } = {}) {
  let name = String(input ?? '')
    // 模型偶尔会自作主张带上编号，去掉 —— 编号由这里统一发。
    .replace(/^\s*\d{1,3}\s*[-_．.、]\s*/, '')
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.、，,;；:：'"“”‘’《》\s]+/, '')
    .replace(/[-_.、，,;；:：'"“”‘’《》\s]+$/, '')
  if (name.length > maxLength) name = name.slice(0, maxLength).replace(/[-_.、，,;；:：\s]+$/, '')
  // 末尾的点/空格在 Windows 上会被悄悄吃掉，提前去掉。
  name = name.replace(/[. ]+$/, '')
  if (RESERVED.test(name)) name = `${name}-项目`
  return name
}

/** 根目录里已有编号的最大值 +1；一个都没有就从 01 开始。 */
export function nextProjectNumber(names) {
  let max = 0
  for (const name of names) {
    const number = projectNumber(name)
    if (number !== undefined && number > max) max = number
  }
  return max + 1
}

/** 编号 → 两位前缀（超过 99 就原样）。 */
export function formatNumber(number) {
  return number >= 100 ? String(number) : pad2(number)
}

/** `01-示例项目` 这种完整文件夹名。 */
export function projectFolderName(number, name) {
  return `${formatNumber(number)}-${name}`
}

/**
 * 在已占用的名字里挑一个不冲突的：撞了加 -2、-3，同时保证不超过长度上限。
 * @param taken - 小写名字的 Set（会被就地更新）。
 */
export function uniqueProjectName(name, taken, { maxLength = 24 } = {}) {
  const base = name.slice(0, maxLength)
  let candidate = base
  let attempt = 1
  while (taken.has(candidate.toLowerCase())) {
    attempt += 1
    const suffix = `-${attempt}`
    candidate = `${base.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

export { ILLEGAL }
