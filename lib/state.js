// 状态：上次跑在什么时候、下次什么时候、上次结果如何。
// 状态文件在插件目录里（不在用户工作区里乱放）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function loadState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { state: parsed !== null && typeof parsed === 'object' ? parsed : {} }
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: {} }
    return { state: {}, error: `状态文件读不出来，按空状态继续：${error?.message ?? error}` }
  }
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

export { existsSync }
