// 小工具：cordis 配置解包 + Windows 路径比较 + 从配置文件里捞绝对路径。
//
// 配置值可能是 live ref（有 .get()），也可能已经解成普通值 —— 现有插件都这么解，
// 这里保持一样，免得改 profile 之后值不更新。

import { readFileSync } from 'node:fs'
import { resolve as resolveAbs } from 'node:path'

const WINDOWS = process.platform === 'win32'

/** @param input - 可能是 ref 的配置值。 @param fallback - 解不出来时的默认值。 */
export function value(input, fallback) {
  const raw =
    input !== null && typeof input === 'object' && typeof input.get === 'function' ? input.get() : input
  return raw === undefined || raw === null ? fallback : raw
}

export function text(input, fallback) {
  const raw = value(input, fallback)
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

export function bool(input, fallback) {
  const raw = value(input, fallback)
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (['true', '1', 'yes', 'on', '是', '开'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', '否', '关'].includes(normalized)) return false
  }
  return fallback
}

export function integer(input, fallback, { min, max } = {}) {
  const raw = Number(value(input, fallback))
  if (!Number.isFinite(raw)) return fallback
  let result = Math.round(raw)
  if (min !== undefined) result = Math.max(min, result)
  if (max !== undefined) result = Math.min(max, result)
  return result
}

/** 字符串数组；单个字符串也接受（写成一行比 YAML 列表省事）。 */
export function list(input, fallback = []) {
  const raw = value(input, fallback)
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
      .filter((item) => item.length > 0)
  }
  if (typeof raw === 'string' && raw.trim().length > 0) return [raw.trim()]
  return fallback
}

/** 绝对路径 → 正斜杠写法；用于显示和落盘。 */
export function displayPath(input) {
  const absolute = resolveAbs(String(input))
  const slashed = absolute.replace(/\\/g, '/')
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
}

/** 比较用的键：Windows 不区分大小写，正斜杠统一。 */
export function pathKey(input) {
  const slashed = displayPath(input)
  return WINDOWS ? slashed.toLowerCase() : slashed
}

export function samePath(a, b) {
  return pathKey(a) === pathKey(b)
}

/** child 是否就是 parent 或位于 parent 之下。 */
export function isUnder(child, parent) {
  const inner = pathKey(child)
  const outer = pathKey(parent)
  return inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
}

/** "P:\x\y"、"P:/x/y"、"/Users/x" 这类绝对路径。 */
export function looksLikeAbsolutePath(input) {
  const candidate = String(input).trim()
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true
  if (/^\\\\[^\\]/.test(candidate)) return true
  return /^\/(?:Users|home|mnt|opt|var|tmp|Volumes|root)\//.test(candidate)
}

/**
 * 从 cordis.patch.yml / package.json 的文本里捞出被引用的绝对路径。
 * 只是字符串扫描：配置文件里的路径都带引号，够用，也不用引 YAML 解析器。
 */
export function extractQuotedPaths(content) {
  const found = []
  const patterns = [/"([^"\n\r]{2,400})"/g, /'([^'\n\r]{2,400})'/g]
  for (const pattern of patterns) {
    for (const match of String(content).matchAll(pattern)) {
      const candidate = match[1].trim()
      if (looksLikeAbsolutePath(candidate)) found.push(candidate)
    }
  }
  return found
}

export function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

export function pad2(number) {
  return String(number).padStart(2, '0')
}

/** 报告里用：相对工作区根目录的写法，看不出来就回退绝对路径。 */
export function withinRoot(absolute, root) {
  const inner = pathKey(absolute)
  const outer = pathKey(root)
  if (inner === outer) return '.'
  if (!inner.startsWith(`${outer}/`)) return displayPath(absolute)
  return displayPath(absolute).slice(displayPath(root).length + 1)
}
