// 调度 + 执行：每周日 00:00 到点跑一次；关机错过则在开机后补跑一次。
//
// 时间算法用 schedule.js（按配置时区算墙钟，不看本机时区）。每次 tick 只做
// 「现在是否过了 nextDue」这一件事，到点后几十秒内动手都是正常的。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scheduleOptionsOf } from './config.js'
import { buildPlan } from './plan.js'
import { applyPlan } from './apply.js'
import { appendJournal } from './journal.js'
import { loadState, saveState } from './state.js'
import { renderRunMarkdown } from './report.js'
import { describeSchedule, formatInZone, nextOccurrence, previousOccurrence } from './schedule.js'

/** 到点后 5 分钟内算「准点」，超过就是补跑（和 02-周报邮件同一标准）。 */
const CATCHUP_GRACE_MS = 5 * 60_000
const RETRY_MS = 15 * 60_000
const MAX_RETRIES = 3

/**
 * @param deps - {
 *   cfgFactory: () => config,
 *   listWorkspaces: (config) => Promise<[{id,title,path}]> | [{...}],
 *   collectProtectPaths: (config) => string[],
 *   pluginRoot, log, now
 * }
 */
export function createRunner({ cfgFactory, listWorkspaces, collectProtectPaths = () => [], askModel, pluginRoot, log = () => {}, now = () => Date.now() }) {
  const stateFile = join(pluginRoot, 'audit', 'state.json')
  const journalFile = join(pluginRoot, 'audit', 'journal.jsonl')
  const runsDir = join(pluginRoot, 'audit', 'runs')

  let state = {}
  let nextDue = 0
  let timer
  let busy = false
  let stopped = false
  let protectedPaths = []

  function resolveProtectedPaths(config) {
    try {
      protectedPaths = collectProtectPaths(config)
    } catch (error) {
      log(`保护名单读取失败，按硬保护继续：${error?.message ?? error}`)
      protectedPaths = []
    }
    return protectedPaths
  }

  function computeDue(at, config) {
    const options = scheduleOptionsOf(config)
    if (config.catchUp) {
      const recent = previousOccurrence(at, options)
      const installedAt = Number(state.installedAt) || 0
      const lastRunAt = Number(state.lastRunAt) || 0
      // 装好之后错过过至少一个 0 点，而且之后没跑过 → 补跑最近那一次。
      if (lastRunAt <= recent && installedAt <= recent) return recent
    }
    return nextOccurrence(at, options)
  }

  /** 只读预览：不写文件、不改状态，给状态路由和命令行 plan 用。 */
  async function preview({ config }) {
    if (typeof askModel !== 'function') throw new Error('没有可用的模型服务（llm）')
    const workspaces = await listWorkspaces(config)
    const guards = resolveProtectedPaths(config)
    return buildPlan({ workspaces, config, protectPaths: guards, now: now(), askModel, log })
  }

  /**
   * 跑一次整理。
   * @param options - { dryRun = false, reason = 'scheduled' }
   */
  async function runTidy({ dryRun = false, reason = 'scheduled' } = {}) {
    const config = cfgFactory()
    if (!config.enabled) {
      log('配置里 enabled=false，跳过本次整理')
      return { ok: false, skipped: 'disabled' }
    }

    const at = now()
    const plan = await preview({ config })
    mkdirSync(runsDir, { recursive: true })

    if (dryRun) {
      writeFileSync(join(runsDir, `${plan.runId}.plan.json`), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
      log(`预览 ${plan.runId}：${plan.totals.projects} 个项目文件夹、${plan.totals.moves} 个文件待整理（未动磁盘）`)
      return { ok: true, dryRun: true, plan }
    }

    const run = applyPlan(plan, { log })
    const nextAfter = nextOccurrence(now(), scheduleOptionsOf(config))
    const markdown = renderRunMarkdown({
      plan,
      run,
      config,
      nextRunLocal: formatInZone(nextAfter, config.timeZone),
      reason,
    })

    writeFileSync(join(runsDir, `${plan.runId}.json`), `${JSON.stringify({ plan, run }, null, 2)}\n`, 'utf8')
    writeFileSync(join(runsDir, `${plan.runId}.md`), markdown, 'utf8')
    appendJournal(journalFile, {
      runId: plan.runId,
      at: new Date(at).toISOString(),
      atLocal: plan.atLocal,
      kind: 'apply',
      reason,
      status: run.status,
      moves: run.moves,
      failures: run.failures,
      createdDirs: run.createdDirs,
      totals: {
        projects: plan.totals.projects,
        moves: run.moves.length,
        failures: run.failures.length,
        bytes: plan.totals.bytes,
      },
    })

    state.lastRunAt = at
    state.lastRunId = plan.runId
    state.lastStatus = run.status
    state.lastProjects = plan.totals.projects
    state.lastMoves = run.moves.length
    state.lastFailures = run.failures.length
    state.lastError = undefined
    state.runs = (Number(state.runs) || 0) + 1
    state.nextRunAt = nextAfter
    state.retry = undefined
    saveState(stateFile, state)
    nextDue = nextAfter

    log(
      `整理完成 ${plan.runId}：新建 ${plan.totals.projects} 个项目文件夹，搬 ${run.moves.length} 个文件，` +
        `失败 ${run.failures.length} 个，跳过 ${plan.totals.skipped} 项；下次 ${formatInZone(nextAfter, config.timeZone)}`,
    )
    return { ok: run.status !== 'failed', runId: plan.runId, plan, run }
  }

  /** 一次到点检查；同时把 nextDue 落进状态，重启后不会重复跑。 */
  async function tick() {
    if (busy || stopped) return false
    const at = now()
    if (nextDue === 0 || at < nextDue) return false
    busy = true
    const config = cfgFactory()
    const catchUp = at - nextDue > CATCHUP_GRACE_MS
    try {
      await runTidy({ dryRun: false, reason: catchUp ? 'catch-up' : 'scheduled' })
      return true
    } catch (error) {
      const attempts = (Number(state.retry?.attempts) || 0) + 1
      state.lastError = `${new Date(at).toISOString()} ${error?.message ?? error}`
      log(`整理失败（第 ${attempts} 次）：${error?.message ?? error}`)
      if (attempts <= MAX_RETRIES) {
        state.retry = { attempts }
        nextDue = at + RETRY_MS
        log(`${Math.round(RETRY_MS / 60_000)} 分钟后重试`)
      } else {
        state.retry = undefined
        nextDue = nextOccurrence(now(), scheduleOptionsOf(config))
        log(`连续失败 ${attempts} 次，放弃这次；下次 ${formatInZone(nextDue, config.timeZone)}`)
      }
      saveState(stateFile, state)
      return false
    } finally {
      busy = false
    }
  }

  async function start() {
    const at = now()
    const loaded = loadState(stateFile)
    if (loaded.error !== undefined) log(loaded.error)
    state = loaded.state
    if (state.installedAt === undefined) state.installedAt = at

    const config = cfgFactory()
    resolveProtectedPaths(config)
    nextDue = computeDue(at, config)
    state.nextRunAt = nextDue
    saveState(stateFile, state)

    const late = nextDue < at - CATCHUP_GRACE_MS
    log(
      `已挂载：${describeSchedule(scheduleOptionsOf(config))}，` +
        `下次 ${formatInZone(nextDue, config.timeZone)}` +
        (late ? '（已经错过，立即补跑）' : '') +
        (config.enabled ? '' : '（enabled=false，不会真的搬东西）'),
    )

    if (late) {
      void tick().catch((error) => log(`补跑失败：${error?.message ?? error}`))
    }

    timer = setInterval(() => {
      void tick().catch((error) => log(`定时检查异常：${error?.message ?? error}`))
    }, config.tickIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    return status()
  }

  function stop() {
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  function status() {
    const config = cfgFactory()
    return {
      plugin: 'weekly-tidy',
      schedule: describeSchedule(scheduleOptionsOf(config)),
      timeZone: config.timeZone,
      enabled: config.enabled,
      nextRunAt: nextDue > 0 ? new Date(nextDue).toISOString() : null,
      nextRunLocal: nextDue > 0 ? formatInZone(nextDue, config.timeZone) : null,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      lastRunLocal: state.lastRunAt ? formatInZone(state.lastRunAt, config.timeZone) : null,
      lastRunId: state.lastRunId ?? null,
      lastStatus: state.lastStatus ?? null,
      lastProjects: state.lastProjects ?? 0,
      lastMoves: state.lastMoves ?? 0,
      lastFailures: state.lastFailures ?? 0,
      lastError: state.lastError ?? null,
      runs: state.runs ?? 0,
      busy,
      minAgeDays: config.minAgeDays,
      minFilesPerProject: config.minFilesPerProject,
      maxFilesPerRun: config.maxFilesPerRun,
      maxFilesPerPrompt: config.maxFilesPerPrompt,
      nameMaxLength: config.nameMaxLength,
      model: config.model || '(当前会话默认模型)',
      workspaces: config.workspaces,
      excludeWorkspaces: config.excludeWorkspaces,
      protectedPaths,
      files: { state: stateFile, journal: journalFile, runs: runsDir },
    }
  }

  /** 手动跑一次（路由用）；正在跑就拒绝，避免两轮互相踩。 */
  async function runNow({ dryRun = false } = {}) {
    if (busy) return { ok: false, error: '已经有一轮在跑了，等它结束' }
    busy = true
    try {
      return await runTidy({ dryRun, reason: 'manual' })
    } finally {
      busy = false
    }
  }

  return {
    start,
    stop,
    tick,
    runTidy,
    runNow,
    preview,
    status,
    get nextDue() {
      return nextDue
    },
    get state() {
      return state
    },
  }
}
