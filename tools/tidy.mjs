#!/usr/bin/env node
// 命令行：先看计划，再决定动不动手；搬错了可以整批撤回。
//
//   node tools/tidy.mjs status
//   node tools/tidy.mjs plan   [--json]
//   node tools/tidy.mjs apply  [--yes]
//   node tools/tidy.mjs undo   [runId|last]
//
// plan / apply 走插件自己的 HTTP 路由（分组要用模型，模型只在 Host 进程里），
// 所以 DSH 得在运行；undo 直接读本地账本，不需要插件在线。
//
//   --base http://127.0.0.1:9683   换端口/地址

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { undoRun } from '../lib/journal.js'
import { displayPath } from '../lib/util.js'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const journalFile = join(pluginRoot, 'audit', 'journal.jsonl')
const stateFile = join(pluginRoot, 'audit', 'state.json')
const DEFAULT_BASE = 'http://127.0.0.1:9683'

function parseArgs(argv) {
  const options = { command: argv[0] ?? 'status', base: DEFAULT_BASE, json: false, yes: false, runId: undefined }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base') {
      options.base = argv[index + 1] ?? DEFAULT_BASE
      index += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--yes') {
      options.yes = true
    } else if (!arg.startsWith('--') && options.command === 'undo' && options.runId === undefined) {
      options.runId = arg
    } else {
      console.error(`没看懂的参数：${arg}`)
      process.exit(2)
    }
  }
  return options
}

async function api(base, path, init) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { raw: text }
  }
  if (!response.ok) {
    const error = new Error(payload?.error ?? `HTTP ${response.status}`)
    error.payload = payload
    throw error
  }
  return payload
}

function printPlan(plan) {
  console.log(`计划 ${plan.runId}（${plan.atLocal}）`)
  for (const workspace of plan.workspaces) {
    if (workspace.missing) {
      console.log(`- ${workspace.title}：目录不存在，跳过`)
      continue
    }
    if (workspace.notScanned) {
      console.log(`- ${workspace.title}：到上限，留到下次`)
      continue
    }
    console.log(
      `- ${workspace.title}：新建 ${workspace.projects.length} 个项目文件夹，` +
        `搬 ${workspace.moves.length} 个，未分组 ${workspace.unclear.length} 个，跳过 ${workspace.skippedCount} 项`,
    )
    if (typeof workspace.error === 'string') console.log(`    ⚠ ${workspace.error}`)
    for (const project of workspace.projects) {
      console.log(`    ${project.folder}/  ←  ${project.files.join('、')}`)
    }
  }
  console.log(
    `合计：新建 ${plan.totals.projects} 个项目文件夹，搬 ${plan.totals.moves} 个文件，` +
      `未分组 ${plan.workspaces.reduce((sum, workspace) => sum + workspace.unclear.length, 0)} 个` +
      (plan.truncated ? '（到上限，其余留到下次）' : ''),
  )
}

function localStatus() {
  let state = {}
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    state = {}
  }
  console.log(`插件目录：${displayPath(pluginRoot)}`)
  console.log(`上次：${state.lastRunLocal ?? '还没跑过'}${state.lastRunId ? `（${state.lastRunId}）` : ''}`)
  if (state.lastError) console.log(`上次错误：${state.lastError}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const base = options.base.replace(/\/+$/, '')

  if (options.command === 'undo') {
    const result = undoRun(journalFile, options.runId ?? 'last')
    if (!result.ok && result.error !== undefined) {
      console.error(result.error)
      process.exit(1)
    }
    console.log(
      `撤回 ${result.targetRunId}：搬回 ${result.restored} 个，没搬回 ${result.failed} 个，` +
        `清掉空目录 ${result.removedDirs.length} 个`,
    )
    for (const failure of result.failures) console.error(`- ${failure.from}：${failure.error}`)
    if (result.failed > 0) process.exit(1)
    return
  }

  if (options.command === 'status') {
    try {
      const status = await api(base, '/plugin-weekly-tidy/status')
      console.log(`插件：${status.plugin} v${status.version ?? '?'}`)
      console.log(`计划：${status.schedule}`)
      console.log(`下次：${status.nextRunLocal ?? '未知'}`)
      console.log(`上次：${status.lastRunLocal ?? '还没跑过'}`)
      if (status.lastRunId) {
        console.log(
          `      ${status.lastRunId}：新建 ${status.lastProjects ?? 0} 个项目文件夹，` +
            `搬 ${status.lastMoves ?? 0} 个，失败 ${status.lastFailures ?? 0} 个`,
        )
      }
      if (status.lastError) console.log(`上次错误：${status.lastError}`)
      console.log(`模型：${status.model}`)
      console.log(`阈值：最近 ${status.minAgeDays} 天动过的不动；每组至少 ${status.minFilesPerProject} 个文件；单次上限 ${status.maxFilesPerRun}`)
      console.log(`保护：${(status.protectedPaths ?? []).join('、') || '（无）'}`)
      return
    } catch (error) {
      console.error(`连接插件失败（DSH 没在运行？）：${error.message}`)
      localStatus()
      process.exit(1)
    }
  }

  if (options.command === 'plan') {
    const plan = await api(base, '/plugin-weekly-tidy/plan')
    if (options.json) console.log(JSON.stringify(plan, null, 2))
    else printPlan(plan)
    return
  }

  if (options.command === 'apply') {
    if (!options.yes) {
      const plan = await api(base, '/plugin-weekly-tidy/plan')
      printPlan(plan)
      console.log('')
      console.log('上面只是计划，什么都没动。确认没问题再加 --yes 真搬：')
      console.log(`  node "${displayPath(join(pluginRoot, 'tools', 'tidy.mjs'))}" apply --yes`)
      return
    }
    const result = await api(base, '/plugin-weekly-tidy/run', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'run' }),
    })
    console.log(`搬完 ${result.runId}：${result.moves.length} 个文件，失败 ${result.failures.length} 个`)
    for (const failure of result.failures) console.error(`- ${failure.from}：${failure.error}`)
    console.log(`撤回：node "${displayPath(join(pluginRoot, 'tools', 'tidy.mjs'))}" undo ${result.runId}`)
    if (result.status === 'failed') process.exit(1)
    return
  }

  console.error('用法：tidy.mjs <status|plan|apply|undo> [--json] [--yes] [--base URL]')
  process.exit(2)
}

main().catch((error) => {
  console.error(`出错：${error?.message ?? error}`)
  process.exit(1)
})
