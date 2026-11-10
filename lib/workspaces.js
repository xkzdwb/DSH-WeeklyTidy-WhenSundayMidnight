// 工作区名单：HOST 里用 workspaceRegistry.list()；命令行里读 workspace.json。
// 两条路都归成 [{ id, title, path }]，plan 不关心来源。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { samePath } from './util.js'

/** 默认注册表位置；测试/命令行可以覆盖。 */
export function defaultRegistryFile() {
  if (process.env.DSH_WORKSPACE_REGISTRY) return process.env.DSH_WORKSPACE_REGISTRY
  return join(homedir(), '.dsh', 'storages', 'workspace.json')
}

/** 读 DSH 的工作区注册表（只读）。读不出来返回 []，由调用方报告。 */
export function readRegistryWorkspaces(file = defaultRegistryFile()) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  // 注册表是 { unit, global, tables: { workspaces: { <id>: {...} } } }；
  // 老一点的版本直接放在顶层 workspaces 上，两种都认。
  const table = parsed?.tables?.workspaces ?? parsed?.workspaces
  if (table === null || typeof table !== 'object') return []
  const list = []
  const declared = Array.isArray(parsed?.global?.workspaceIds) ? parsed.global.workspaceIds : []
  const ids = [
    ...declared.filter((id) => Object.hasOwn(table, id)),
    ...Object.keys(table).filter((id) => !declared.includes(id)),
  ]
  for (const id of ids) {
    const value = table[id]
    if (value === null || typeof value !== 'object') continue
    const path = typeof value.path === 'string' ? value.path : ''
    if (path.length === 0) continue
    list.push({ id, path, title: typeof value.title === 'string' && value.title.length > 0 ? value.title : id })
  }
  return list
}

function matches(workspace, pattern) {
  if (pattern === workspace.id) return true
  if (workspace.title !== undefined && pattern.toLowerCase() === workspace.title.toLowerCase()) return true
  return samePath(pattern, workspace.path)
}

/** workspaces 留空 = 全部；excludeWorkspaces 优先。 */
export function selectWorkspaces(registered, config) {
  const include = Array.isArray(config.workspaces) ? config.workspaces : []
  const exclude = Array.isArray(config.excludeWorkspaces) ? config.excludeWorkspaces : []
  const picked = include.length === 0 ? registered : registered.filter((ws) => include.some((p) => matches(ws, p)))
  return picked.filter((ws) => !exclude.some((p) => matches(ws, p)))
}
