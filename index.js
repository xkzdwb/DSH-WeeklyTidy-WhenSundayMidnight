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
// 除了定时，它还往技能目录和一个工具里各注册一条「现在整理当前工作区」：
//   /tidy-workspace          技能（SKILL.md，模型和人两边都能点名）
//   tidy_workspace 工具      模型自己调，只整理**当前会话所在**那一个工作区
// 两者和定时跑的是同一个 runner，只是把工作区名单收窄成会话的 cwd。
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
import { displayPath, isUnder, samePath } from './lib/util.js'
import { frontmatterOf as frontmatter, skillBodyOf } from './lib/skill.js'

export const name = 'weekly-tidy'
export const inject = ['workspaceRegistry', 'webServer', 'llm', 'agentDefaultModel', 'skills', 'tools']

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = here // index.js 就在包根目录上；再往上一层是工作区，不是插件
const STATUS_PATH = '/plugin-weekly-tidy/status'
const PLAN_PATH = '/plugin-weekly-tidy/plan'
const RUN_PATH = '/plugin-weekly-tidy/run'

function versionOf() {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version ?? '1.2.0'
  } catch {
    return '1.2.0'
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

/**
 * SKILL.md 的 frontmatter 读成对象：`name:`、`description:`、`when_to_use:`。
 * 实现在 lib/skill.js（那里有测试覆盖）。
 */
const frontmatterOf = frontmatter

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

  const profileDir = resolveProfileDir({ markers: ['weekly-tidy', '04-自动整理'] })
  if (profileDir === undefined) {
    log('没找到 profile 目录，引用保护降级为「成品插件 + 插件自身目录」')
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

  /**
   * 当前会话所在的工作区（技能/工具只整理这一个）。
   *
   * 会话的 cwd 就是 DSH 认定的「这个对话的工作区」：`session.header.cwd`。
   * 它可能是工作区根本身，也可能在它里面某个子目录 —— 两种都归到工作区根目录，
   * 因为整理规则本来就只动根目录那一层。找不到就回退到注册表里路径最长前缀命中的那个，
   * 再找不到就把 cwd 自己当成一个工作区（总比什么都不做、或者去整理全部工作区好）。
   *
   * @returns {{id,title,path,source}} 或 undefined（拿不到 cwd）
   */
  function currentWorkspace(exec) {
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.trim().length === 0) return undefined
    const root = displayPath(cwd)

    const registered = ctx.workspaceRegistry.list().map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
    }))

    // cwd 本身正好是一个工作区 → 用它。
    const exact = registered.find((workspace) => samePath(workspace.path, root))
    if (exact !== undefined) {
      return { id: exact.id, title: exact.title ?? exact.id, path: exact.path, source: 'session' }
    }

    // cwd 在工作区里面 → 归到那个工作区的根目录（路径最长的那个最具体）。
    let owner
    for (const workspace of registered) {
      if (!isUnder(root, workspace.path)) continue
      if (owner === undefined || displayPath(workspace.path).length > displayPath(owner.path).length) {
        owner = workspace
      }
    }
    if (owner !== undefined) {
      return { id: owner.id, title: owner.title ?? owner.id, path: owner.path, source: 'session' }
    }

    // 没注册过的目录（比如临时打开的文件夹）：就当它自己是一个工作区。
    return {
      id: root,
      title: root.slice(root.lastIndexOf('/') + 1) || root,
      path: root,
      source: 'cwd',
    }
  }

  /** 整理结果压成一句人话，技能/工具回给模型的正文用它。 */
  function describeRun({ plan, run, dryRun }) {
    const lines = []
    lines.push(
      dryRun
        ? `预览 ${plan.runId}（没有动任何文件）`
        : `整理完成 ${plan.runId}`,
    )
    for (const workspace of plan.workspaces) {
      if (workspace.missing) {
        lines.push(`- ${workspace.title}：目录不存在，跳过`)
        continue
      }
      if (workspace.notScanned) {
        lines.push(`- ${workspace.title}：到了一次运行的上限，剩下的留到下次`)
        continue
      }
      lines.push(
        `- ${workspace.title}（${workspace.root}）：` +
          `建 ${workspace.projects.length} 个文件夹，${dryRun ? '打算搬' : '搬了'} ${workspace.moves.length} 个文件，` +
          `未分组 ${workspace.unclear.length} 个，跳过 ${workspace.skippedCount} 项`,
      )
      if (typeof workspace.error === 'string') lines.push(`  ⚠ ${workspace.error}`)
      for (const project of workspace.projects) {
        lines.push(`  ${project.folder}/  ←  ${project.files.join('、')}`)
      }
      if (workspace.unclear.length > 0) {
        const preview = workspace.unclear.slice(0, 8).map((item) => item.name).join('、')
        const more = workspace.unclear.length > 8 ? ` 等 ${workspace.unclear.length} 个` : ''
        lines.push(`  没分组（留在原处）：${preview}${more}`)
      }
    }
    lines.push(
      `合计：${plan.totals.projects} 个文件夹，${dryRun ? '待搬' : '搬了'} ${run === undefined ? plan.totals.moves : run.moves.length} 个文件，` +
        `失败 ${run === undefined ? 0 : run.failures.length} 个`,
    )
    if (run !== undefined && run.failures.length > 0) {
      for (const failure of run.failures.slice(0, 10)) {
        lines.push(`  失败：${failure.from} → ${failure.to}（${failure.error}）`)
      }
    }
    if (!dryRun) {
      lines.push(
        '',
        `要整批撤回：node "${displayPath(join(pluginRoot, 'tools', 'tidy.mjs'))}" undo ${plan.runId}`,
      )
    }
    return lines.join('\n')
  }

  /** 技能 / 工具共用的一次整理。 */
  async function tidyCurrentWorkspace({ exec, dryRun, minAgeDays }) {
    const workspace = currentWorkspace(exec)
    if (workspace === undefined) {
      throw new Error('拿不到当前会话的工作区路径，没法确定整理哪里；请在任意工作区里再试，或用 GET /plugin-weekly-tidy/plan 看全部工作区的计划。')
    }
    const overrides = {}
    if (typeof minAgeDays === 'number' && Number.isFinite(minAgeDays)) overrides.minAgeDays = minAgeDays

    const result = await runner.runNow({
      dryRun,
      workspaces: [workspace],
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      reason: dryRun ? 'preview' : 'manual',
    })
    if (result?.error !== undefined) throw new Error(result.error)
    if (result?.plan === undefined) throw new Error('整理没有返回计划（可能已经有一轮在跑）')
    return { workspace, result }
  }

  // ---------------------------------------------------------------- 技能
  //
  // 输入框里 /tidy-workspace 就是这条：SKILL.md 是正文，模型照它调下面的工具。
  // 注册在全局层，所以任何工作区的任何对话里都能点名。
  ctx.effect(() => {
    const dir = join(pluginRoot, 'skills', 'tidy-workspace')
    const file = join(dir, 'SKILL.md')
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch (error) {
      log(`技能 tidy-workspace 没读到（${displayPath(file)}）：${error?.message ?? error}`)
      return () => {}
    }
    const body = skillBodyOf(source)
    const meta = frontmatterOf(source)
    try {
      const dispose = ctx.skills.register({
        name: meta.name ?? 'tidy-workspace',
        description:
          meta.description ??
          '整理当前工作区：根目录的散落文件按项目收进 NN-中文项目名 文件夹；/tidy-workspace 触发',
        ...(meta.when_to_use !== undefined ? { whenToUse: meta.when_to_use } : {}),
        content: source,
        source: 'custom',
        provider: 'weekly-tidy',
        path: file,
        resourceBase: { kind: 'directory', path: dir },
        metadata: { plugin: '@local/dsh-weekly-tidy', bodyChars: body.length },
        invocation: { modelInvocable: true, userInvocable: true },
      })
      log(`已注册技能 /${meta.name ?? 'tidy-workspace'}（任何工作区的对话里都能用）`)
      return () => {
        try {
          dispose()
        } catch {
          /* 拆卸尽力而为 */
        }
      }
    } catch (error) {
      log(`技能 tidy-workspace 注册失败：${error?.message ?? error}`)
      return () => {}
    }
  }, `${name}: tidy-workspace skill`)

  // ---------------------------------------------------------------- 工具
  //
  // 技能负责「按规则说清楚要做哪几步」，工具负责真的动手；模型也可以不点名技能，
  // 直接说一句「帮我整理这个工作区」就调它。
  ctx.effect(() => {
    const dispose = ctx.tools.register({
      name: 'tidy_workspace',
      description:
        '整理当前会话所在工作区的根目录：把散落的文件按项目收进 NN-中文项目名 文件夹。' +
        '默认直接搬（dryRun=false）；只想看计划不碰磁盘时传 dryRun=true。' +
        '只动根目录第一层、只移动不删除，每次运行都有账本可整批撤回。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: {
            type: 'boolean',
            description:
              '默认 false = 直接整理并搬文件（这次调用会走审批）；true = 只出计划、不动磁盘。',
          },
          minAgeDays: {
            type: 'number',
            description:
              '这次只整理「至少 N 天没动过」的文件，覆盖配置里的 minAgeDays；' +
              '传 0 表示连今天改过的也一起整理（用户说「全都整理」时才这么传）。',
          },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            runId: { type: 'string' },
            dryRun: { type: 'boolean' },
            workspace: { type: 'string' },
            projects: { type: 'number' },
            moves: { type: 'number' },
            failures: { type: 'number' },
            unclear: { type: 'number' },
            skipped: { type: 'number' },
            undo: { type: 'string', description: '真搬后的撤回命令；预览时是空字符串。' },
          },
          required: ['text', 'runId', 'dryRun', 'workspace', 'projects', 'moves', 'failures', 'unclear', 'skipped', 'undo'],
        },
        render(_args, value) {
          return [{ type: 'text', text: String(value?.text ?? '') }]
        },
      },
      timeoutMs: 600_000,
      // 两轮同时搬同一个目录会互相踩，串行执行。
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        // 默认直接整理：/tidy-workspace 或「整理这个工作区」本身就是授权，
        // 审批卡片那一步才是真正的确认点。只有 dryRun:true 才是纯预览。
        const dryRun = args?.dryRun === true
        const rawAge = args?.minAgeDays
        const minAgeDays =
          typeof rawAge === 'number' && Number.isFinite(rawAge) ? Math.max(0, Math.round(rawAge)) : undefined
        const { workspace, result } = await tidyCurrentWorkspace({ exec, dryRun, minAgeDays })
        const plan = result.plan
        const run = result.run
        const unclear = plan.workspaces.reduce((sum, item) => sum + item.unclear.length, 0)
        return {
          text: describeRun({ plan, run, dryRun }),
          runId: plan.runId,
          dryRun,
          workspace: workspace.path,
          projects: plan.totals.projects,
          moves: run === undefined ? plan.totals.moves : run.moves.length,
          failures: run === undefined ? 0 : run.failures.length,
          unclear,
          skipped: plan.totals.skipped,
          undo:
            dryRun || run === undefined
              ? ''
              : `node "${displayPath(join(pluginRoot, 'tools', 'tidy.mjs'))}" undo ${plan.runId}`,
        }
      },
    })
    log('已注册工具 tidy_workspace（只整理当前工作区）')
    return () => {
      try {
        dispose()
      } catch {
        /* 拆卸尽力而为 */
      }
    }
  }, `${name}: tidy_workspace tool`)

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
