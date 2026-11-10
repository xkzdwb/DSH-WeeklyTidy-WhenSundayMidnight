// weekly-tidy — Host 半边：每周日 00:00 整理各工作区根目录的散落文件。
//
// 装配（bundle 的 cordis.patch.yml 里 insert 一行，见同目录 cordis.patch.yml）：
//   - id: weekly-tidy
//     name: '@local/dsh-weekly-tidy'
//     config: { weekday: 0, time: '00:00', timeZone: Asia/Shanghai, ... }
//
// 三条只读/手动路由，方便确认它真的装上了、看它打算做什么、临时手动跑一次：
//   GET  /plugin-weekly-tidy/status   状态：下次什么时候、上次搬了多少
//   GET  /plugin-weekly-tidy/plan     只读预览：这次会怎么搬（不动磁盘）
//   POST /plugin-weekly-tidy/run      手动跑一次；{"dryRun":true} 只出计划，
//                                     真搬要带 {"confirm":"run"}
//
// 只在 node: 内置模块上实现：按绝对路径加载的插件解析不了裸包名。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from './lib/config.js'
import { resolveProfileDir } from './lib/profile.js'
import { collectProtectedPaths } from './lib/protect.js'
import { createRunner } from './lib/runner.js'
import { createLlmClient } from './lib/ai.js'
import { selectWorkspaces } from './lib/workspaces.js'

export const name = 'weekly-tidy'
export const inject = ['workspaceRegistry', 'webServer', 'llm', 'agentDefaultModel']

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = here // index.js 就在包根目录上；再往上一层是工作区，不是插件
const STATUS_PATH = '/plugin-weekly-tidy/status'
const PLAN_PATH = '/plugin-weekly-tidy/plan'
const RUN_PATH = '/plugin-weekly-tidy/run'

function versionOf() {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version ?? '1.1.0'
  } catch {
    return '1.1.0'
  }
}

function sendJson(res, status, payload, { head = false } = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(head ? undefined : body)
}

function readJsonBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish({ error: '请求体过大' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        finish({ value: {} })
        return
      }
      try {
        finish({ value: JSON.parse(raw) })
      } catch {
        finish({ error: '请求体不是 JSON' })
      }
    })
    req.on('error', () => finish({ error: '请求体读取失败' }))
  })
}

function summarizePlan(plan) {
  return {
    runId: plan.runId,
    atLocal: plan.atLocal,
    minAgeDays: plan.minAgeDays,
    minFilesPerProject: plan.minFilesPerProject,
    truncated: plan.truncated,
    totals: plan.totals,
    workspaces: plan.workspaces.map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      root: workspace.root,
      missing: workspace.missing,
      notScanned: workspace.notScanned,
      error: workspace.error ?? null,
      projects: workspace.projects.map((project) => ({
        folder: project.folder,
        reason: project.reason,
        files: project.files,
      })),
      moves: workspace.moves.map((move) => ({ from: move.from, to: move.to, project: move.project })),
      unclear: workspace.unclear.slice(0, 100),
      skippedCount: workspace.skippedCount,
      skipped: workspace.skipped.slice(0, 50),
    })),
  }
}

function apply(ctx, rawConfig) {
  const log = (message) => console.warn(`[${name}] ${message}`)
  const version = versionOf()

  const warned = new Set()
  const cfgFactory = () => {
    const { config, warnings } = normalizeConfig(rawConfig)
    for (const warning of warnings) {
      if (warned.has(warning)) continue
      warned.add(warning)
      log(`配置：${warning}`)
    }
    return config
  }

  const profileDir = resolveProfileDir({ markers: ['weekly-tidy'] })
  if (profileDir === undefined) {
    log('没找到 profile 目录，引用保护降级为「插件自身目录」')
  }

  // 「怎么分组」交给当前会话的默认模型；不在这里写死 provider/model，
  // 用户换了模型插件自动跟着换（也可以在 config.model 里指定 provider/model）。
  const llm = createLlmClient({
    llm: ctx.llm,
    selectionOf: () => ctx.agentDefaultModel.currentSelection(),
    log,
  })

  const runner = createRunner({
    cfgFactory,
    pluginRoot,
    log,
    now: () => Date.now(),
    askModel: (options) => llm.ask(options),
    listWorkspaces: (config) =>
      selectWorkspaces(
        ctx.workspaceRegistry.list().map((workspace) => ({
          id: workspace.id,
          path: workspace.path,
          title: workspace.title,
        })),
        config,
      ),
    collectProtectPaths: (config) =>
      collectProtectedPaths({ profileDir, pluginRoot, extra: config.protectPaths }),
  })

  ctx.effect(() => {
    void runner.start().catch((error) => log(`启动失败：${error?.message ?? error}`))
    return () => runner.stop()
  }, `${name}: scheduler`)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler(req, res) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          sendJson(res, 200, { version, ...runner.status() }, { head: req.method === 'HEAD' })
        },
      }),
    `${name}: status route`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PLAN_PATH,
        handler(req, res) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          void (async () => {
            try {
              const plan = await runner.preview({ config: cfgFactory() })
              sendJson(res, 200, { version, dryRun: true, ...summarizePlan(plan) })
            } catch (error) {
              sendJson(res, 500, { error: String(error?.message ?? error) })
            }
          })()
        },
      }),
    `${name}: plan route`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RUN_PATH,
        handler(req, res) {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          void (async () => {
            const body = await readJsonBody(req)
            if (body.error !== undefined) {
              sendJson(res, 400, { error: body.error })
              return
            }
            const dryRun = body.value?.dryRun === true
            if (!dryRun && body.value?.confirm !== 'run') {
              sendJson(res, 400, { error: '真整理要带 {"confirm":"run"}；只想看计划用 {"dryRun":true} 或 GET /plugin-weekly-tidy/plan' })
              return
            }
            try {
              const result = await runner.runNow({ dryRun })
              if (result.skipped === 'disabled') {
                sendJson(res, 409, { error: '插件在配置里被停用了（enabled: false）' })
                return
              }
              if (dryRun) {
                sendJson(res, 200, { version, dryRun: true, ...summarizePlan(result.plan) })
                return
              }
              sendJson(res, 200, {
                version,
                runId: result.runId,
                ok: result.ok,
                status: result.run.status,
                moves: result.run.moves,
                failures: result.run.failures,
                totals: result.plan.totals,
                nextRunLocal: runner.status().nextRunLocal,
              })
            } catch (error) {
              sendJson(res, 500, { error: String(error?.message ?? error) })
            }
          })()
        },
      }),
    `${name}: run route`,
  )

  log(`已挂载（v${version}）：${runner.status().schedule}，状态 ${STATUS_PATH}`)
}

export { apply }
