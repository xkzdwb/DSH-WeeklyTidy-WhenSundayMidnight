// 读工作区的 README：里面登记过的项目名，不再重复建文件夹。
//
// 不追求把 README 解析完整 —— 只从标题和列表项里认出「像项目名」的那几行，
// 交给模型当上下文，再在本地按名字去重。

import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { readTextSafe } from './util.js'
import { cleanProjectName } from './naming.js'

/** 太泛的标题，认成项目名只会让模型缩手缩脚。 */
const GENERIC = new Set([
  '目录', '文件说明', '说明', '更新记录', '结构', '用法', '整理', '工作区', '项目', '记录',
  '备注', '注意', '待办', '清单', '数据', '脚本', '截图', '归档', '历史', '如何撤回', '怎么撤回',
  '撤销', '撤回', '概览', '总览', '简介', '关于', 'readme', 'todo', 'notes',
])

/** 找根目录里的 README（大小写都认）。 */
export function findReadme(root) {
  let entries = []
  try {
    entries = readdirSync(root)
  } catch {
    return undefined
  }
  const name = entries.find((entry) => /^readme(\.md|\.markdown|\.txt)?$/i.test(entry))
  return name === undefined ? undefined : join(root, name)
}

function tidyLine(line) {
  return String(line)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown 链接只留文字
    .replace(/[*_`~]/g, '')
    .replace(/^\d{1,3}[.、)]\s*/, '')
    .replace(/^[-–—:：\s]+/, '')
    .replace(/[-–—:：\s]+$/, '')
    .trim()
}

/**
 * 从 README 文本里捞出项目名。
 * @returns { names: string[], excerpt: string }
 */
export function readProjectNames(file, { maxExcerpt = 1200 } = {}) {
  const text = readTextSafe(file)
  if (text === undefined) return { names: [], excerpt: '' }

  const names = []
  const seen = new Set()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const heading = /^#{2,4}\s+(.+)$/.exec(line)
    const bullet = /^[-*+]\s+(.+)$/.exec(line)
    const match = heading ?? bullet
    if (match === null) continue

    const candidate = tidyLine(match[1])
    if (candidate.length < 2 || candidate.length > 40) continue
    if (GENERIC.has(candidate.toLowerCase())) continue
    // 「图片：xxx」这类冒号开头的说明句不是项目名。
    if (/[:：]/.test(candidate)) continue

    const key = cleanProjectName(candidate, { maxLength: 40 }).toLowerCase()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    names.push(candidate)
  }

  const excerpt = text.length > maxExcerpt ? `${text.slice(0, maxExcerpt)}…` : text
  return { names, excerpt }
}
