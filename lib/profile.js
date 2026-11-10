// 找 profile 目录：引用保护要用它里面的 cordis.patch.yml / package.json。
//
// 没有现成的 Host Service 能问「当前 profile 在哪」，所以按顺序试：
//   1. 环境变量 DSH_PROFILE_DIR
//   2. DSH_HOME/profiles/$DSH_PROFILE
//   3. DSH_HOME/profiles/desktop（DSH 默认 profile 名）
//   4. 扫 DSH_HOME/profiles/*，谁的 cordis.patch.yml 里提到本插件就用谁
// 全试不出来就返回 undefined —— 只是少了「引用保护」，不影响整理本身。

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readTextSafe } from './util.js'

function isProfileDir(dir) {
  return existsSync(join(dir, 'cordis.patch.yml'))
}

export function resolveProfileDir({ markers = [] } = {}) {
  const candidates = []
  if (process.env.DSH_PROFILE_DIR) candidates.push(process.env.DSH_PROFILE_DIR)

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profilesRoot = join(dshHome, 'profiles')
  if (process.env.DSH_PROFILE) candidates.push(join(profilesRoot, process.env.DSH_PROFILE))
  candidates.push(join(profilesRoot, 'desktop'))

  for (const candidate of candidates) {
    if (isProfileDir(candidate)) return candidate
  }

  let entries = []
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(profilesRoot, entry.name)
    const haystack = `${readTextSafe(join(dir, 'cordis.patch.yml')) ?? ''}\n${readTextSafe(join(dir, 'package.json')) ?? ''}`
    if (markers.some((marker) => haystack.includes(marker))) return dir
  }
  return undefined
}
