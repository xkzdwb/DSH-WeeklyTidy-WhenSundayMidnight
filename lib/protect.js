// 保护名单：工作区外面/里面的东西哪些绝对不能碰。
//
// 两层：
//   1. 硬保护：插件自己的目录（由 index.js / CLI 传进来），外加配置里 protectPaths 指定的路径。
//   2. 引用保护：profile 的 cordis.patch.yml 和 package.json 里用引号写着的绝对路径。
//      那些路径是正在运行的插件、配置、secrets —— 把文件搬走等于把 DSH 弄坏。
import { join } from 'node:path'
import { displayPath, extractQuotedPaths, isUnder, pathKey, readTextSafe } from './util.js'

/** 默认额外保护：留空，由使用者在配置里按需加（插件自身目录总会自动保护）。 */
export const DEFAULT_PROTECT_PATHS = []

/**
 * @param options - { profileDir, pluginRoot, extra: string[] }
 * @returns 规范化后的保护路径数组（正斜杠，去重）。
 */
export function collectProtectedPaths({ profileDir, pluginRoot, extra = [] } = {}) {
  const found = new Map()

  const add = (input) => {
    if (typeof input !== 'string' || input.trim().length === 0) return
    try {
      const normalized = displayPath(input)
      found.set(pathKey(normalized), normalized)
    } catch {
      // 非法路径直接忽略：保护名单多一条坏路径不该让插件挂掉。
    }
  }

  for (const candidate of DEFAULT_PROTECT_PATHS) add(candidate)
  for (const candidate of extra) add(candidate)
  if (pluginRoot) add(pluginRoot)

  if (profileDir) {
    for (const fileName of ['cordis.patch.yml', 'package.json']) {
      const content = readTextSafe(join(profileDir, fileName))
      if (content === undefined) continue
      for (const candidate of extractQuotedPaths(content)) add(candidate)
    }
  }

  return [...found.values()]
}

/** path 是否被保护名单里的某一条覆盖（等于或在其下面）。 */
export function isProtectedPath(path, protectedPaths) {
  if (!Array.isArray(protectedPaths) || protectedPaths.length === 0) return false
  return protectedPaths.some((guard) => isUnder(path, guard))
}

/** 命中的那条保护规则，报告里用来说明「为什么没动它」。 */
export function matchingGuard(path, protectedPaths) {
  if (!Array.isArray(protectedPaths)) return undefined
  return protectedPaths.find((guard) => isUnder(path, guard))
}
