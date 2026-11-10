// 扫描：每个工作区根目录这一层的「散落文件」。
//
// 只收文件，目录一律不进、不改名、不移动：以 1~3 位数字开头的目录是已经整理
// 好的项目（01-示例项目-第二阶段 这种），原样保留；其它目录也原样保留。
//
// 会跳过的：隐藏项、符号链接/重解析点、开发目录（.git/node_modules/dist…）、
// 说明与清单文件（README.md/package.json/cordis.patch.yml/锁文件）、保护名单
// 里的路径、最近 minAgeDays 天动过的文件。
//
// 文本类文件顺手读前几百字，给模型判断「这几个文件是不是同一件事」用。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { displayPath } from './util.js'
import { matchingGuard } from './protect.js'
import { isNumberedName } from './naming.js'

export const SKIP_DIR_NAMES = new Set([
  '.git', '.github', '.gitlab', '.svn', '.hg',
  'node_modules', '__pycache__', '.venv', 'venv', '.tox', '.pytest_cache', '.mypy_cache',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.turbo', '.parcel-cache',
  '.cache', '.idea', '.vscode', '.toolchain', '.archify', '.acl-recovery', '.plugin-manager',
  '.dsh', '.DS_Store', 'desktop.ini',
])

export const SKIP_FILE_NAMES = new Set([
  'readme.md', 'readme', 'readme.txt', 'readme.markdown',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock',
  'cordis.patch.yml', 'cordis.yml', 'cordis.yaml', 'tsconfig.json', 'jsconfig.json',
  'license', 'license.txt', 'license.md', '.gitignore', '.gitattributes', '.npmrc', 'icon.svg',
])

/** 能读一点内容给模型看的扩展名。二进制/图片不读。 */
const PREVIEW_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'py', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'ps1', 'sh', 'bat', 'cmd', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'log', 'html', 'htm', 'xml', 'sql', 'srt', 'vtt', 'tex', 'r', 'lua', 'go', 'rs', 'java',
])

const DAY_MS = 86_400_000
const PREVIEW_BYTES = 900
const PREVIEW_CHARS = 240

function previewOf(path, extension) {
  if (!PREVIEW_EXTENSIONS.has(extension)) return undefined
  try {
    const text = readFileSync(path, 'utf8').slice(0, PREVIEW_BYTES)
    const flat = text
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (flat.length === 0) return undefined
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat
  } catch {
    return undefined
  }
}

/**
 * 扫一个工作区根目录。
 * @param options - {
 *   root, minAgeDays = 0, protectPaths = [], skipNames = [], now = Date.now(),
 *   previews = true, previewBytesLimit = 512 * 1024
 * }
 * @returns {
 *   root, missing,
 *   files: [{ path, name, size, mtimeMs, preview? }],
 *   projects: [已有编号目录名],
 *   dirs: [根目录里所有目录名],
 *   skipped: [{ path, reason }]
 * }
 */
export function scanWorkspace({
  root,
  minAgeDays = 0,
  protectPaths = [],
  skipNames = [],
  now = Date.now(),
  previews = true,
  previewBytesLimit = 512 * 1024,
}) {
  const result = { root, missing: false, files: [], projects: [], dirs: [], skipped: [] }
  const skipNameSet = new Set(skipNames.map((name) => name.toLowerCase()))
  // minAgeDays=0 表示「连刚改过的也整理」，此时不要算出无穷大的 cutoff，
  // 否则 mtime > -Infinity 恒真，会把所有文件都判成「太新」。
  const cutoff = minAgeDays > 0 ? now - minAgeDays * DAY_MS : undefined

  let rootStats
  try {
    rootStats = statSync(root)
  } catch {
    result.missing = true
    return result
  }
  if (!rootStats.isDirectory()) {
    result.missing = true
    return result
  }

  const skip = (path, reason) => {
    result.skipped.push({ path: displayPath(path), reason })
  }

  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    skip(root, `读不了目录：${error?.code ?? error?.message ?? error}`)
    return result
  }

  for (const entry of entries) {
    const absolute = join(root, entry.name)
    const lowerName = entry.name.toLowerCase()

    if (entry.name.startsWith('.')) {
      skip(absolute, '隐藏项')
      continue
    }
    if (entry.isSymbolicLink()) {
      skip(absolute, '符号链接/重解析点')
      continue
    }
    const guard = matchingGuard(absolute, protectPaths)
    if (guard !== undefined) {
      skip(absolute, `受保护路径（${guard}）`)
      continue
    }

    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(lowerName) || skipNameSet.has(lowerName)) {
        skip(absolute, '开发/系统目录')
        continue
      }
      result.dirs.push(entry.name)
      if (isNumberedName(entry.name)) {
        result.projects.push(entry.name)
        skip(absolute, '已有项目文件夹（保留原样）')
      } else {
        skip(absolute, '目录（不是散落文件，不动）')
      }
      continue
    }

    if (!entry.isFile()) {
      skip(absolute, '非普通文件')
      continue
    }
    if (SKIP_FILE_NAMES.has(lowerName) || skipNameSet.has(lowerName)) {
      skip(absolute, '说明/清单文件')
      continue
    }

    let stats
    try {
      stats = statSync(absolute)
    } catch (error) {
      skip(absolute, `读不了文件信息：${error?.code ?? error?.message ?? error}`)
      continue
    }
    if (cutoff !== undefined && stats.mtimeMs > cutoff) {
      skip(absolute, `最近 ${minAgeDays} 天内改过`)
      continue
    }

    const dot = lowerName.lastIndexOf('.')
    const extension = dot > 0 ? lowerName.slice(dot + 1) : ''
    const file = {
      path: displayPath(absolute),
      name: entry.name,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    }
    if (previews && stats.size <= previewBytesLimit) {
      const preview = previewOf(absolute, extension)
      if (preview !== undefined) file.preview = preview
    }
    result.files.push(file)
  }

  return result
}
