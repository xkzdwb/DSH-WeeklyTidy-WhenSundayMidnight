// 装配自检：给 apply() 一个假 ctx，确认技能和工具真的注册进去、并且工具能跑通。
//
//   node test/run-assembly.mjs
//
// 不联网、不调真模型：askModel 是假的，工作区用临时目录。
// runner.start() 会写 audit/state.json —— 这是插件自己的账本目录，自检里先读出来、跑完还原。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const stateFile = join(pluginRoot, 'audit', 'state.json')
const stateBackup = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : undefined

let passed = 0
let failed = 0
const failures = []

async function testAsync(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${title}`)
  } catch (error) {
    failed += 1
    failures.push({ title, error })
    console.log(`✗ ${title}\n    ${error?.stack ?? error}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? '断言失败')
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

const roots = []
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tidy-assembly-'))
  roots.push(root)
  return root
}

function touch(file) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'x', 'utf8')
  const stamp = (Date.now() - 5 * 86_400_000) / 1000
  utimesSync(file, stamp, stamp)
}

/** 假模型：把这一批文件全部归到同一个项目。 */
function fakeAsk(prompt) {
  const names = prompt
    .split('\n')
    .map((line) => /^\d+\) (.+?) \| /.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1])
  return JSON.stringify({ groups: [{ folder: '甲项目', reason: '自检', files: names }], unclear: [] })
}

/**
 * 假 ctx：effect() 立刻执行并留住 disposer，其余服务只提供注册表那一层。
 * 这样能验证「apply 之后技能目录里有什么、工具注册表里有什么」，而不需要整个 HOST。
 */
function makeCtx({ workspaces = [], cwd } = {}) {
  const skills = []
  const tools = new Map()
  const disposers = []
  const routes = []

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => dispose?.()
    },
    get: () => undefined,
    workspaceRegistry: {
      list: () => workspaces,
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    llm: {
      async *stream(options) {
        const prompt = options.messages?.[0]?.content?.[0]?.text ?? ''
        yield { type: 'text-delta', text: fakeAsk(prompt) }
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'fake', model: 'fake-model' }),
    },
    skills: {
      register(skill) {
        skills.push(skill)
        return () => {
          const index = skills.indexOf(skill)
          if (index >= 0) skills.splice(index, 1)
        }
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    // 工具从 exec.agent.session.header.cwd 拿「当前工作区」。
    fakeExec: () => ({ agent: { session: { header: { cwd } } } }),
  }
  return { ctx, skills, tools, disposers, routes, exec: ctx.fakeExec }
}

await testAsync('apply 之后注册了 /tidy-workspace 技能和 tidy_workspace 工具', async () => {
  const root = makeRoot()
  touch(join(root, 'a.png'))
  touch(join(root, 'b.png'))
  touch(join(root, 'c.png'))

  const { apply } = await import('../index.js')
  const { ctx, skills, tools, exec } = makeCtx({
    workspaces: [{ id: 'ws-1', path: root, title: '自检工作区' }],
    cwd: root,
  })
  apply(ctx, { enabled: false, minAgeDays: 0 })

  const skill = skills.find((item) => item.name === 'tidy-workspace')
  assert(skill !== undefined, `技能没注册上；实际注册了：${skills.map((item) => item.name).join('、') || '（无）'}`)
  equal(skill.invocation.modelInvocable, true, '技能应对模型可点名')
  equal(skill.invocation.userInvocable, true, '技能应出现在 / 菜单里')
  assert(skill.description.includes('整理当前工作区'), `技能描述不对：${skill.description}`)
  assert(skill.content.includes('先预览'), '技能正文应包含先预览这一步')

  const tool = tools.get('tidy_workspace')
  assert(tool !== undefined, `工具没注册上；实际注册了：${[...tools.keys()].join('、') || '（无）'}`)
  assert(typeof tool.execute === 'function', '工具应可执行')
  equal(tool.isConcurrencySafe(), false, '两轮同时搬同一个目录不安全，应串行')
  assert(tool.description.includes('当前会话所在工作区'), '工具描述应说清整理范围')
})

await testAsync('工具默认直接整理（dryRun 默认 false），不传参数就真搬', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name))

  const { apply } = await import('../index.js')
  const { ctx, tools, exec } = makeCtx({
    workspaces: [{ id: 'ws-1', path: root, title: '自检工作区' }],
    cwd: root,
  })
  apply(ctx, { enabled: false, minAgeDays: 0 })
  const tool = tools.get('tidy_workspace')

  const result = await tool.execute({}, exec())
  equal(result.dryRun, false, '不传 dryRun 时应直接整理')
  equal(result.projects, 1, '应建出 1 个项目文件夹')
  equal(result.moves, 3, '应搬 3 个文件')
  assert(result.undo.includes('undo '), '真搬后应给撤回命令')
  const names = readdirSync(root)
  const folder = names.find((name) => /^01-/.test(name))
  assert(folder !== undefined, `应建出 01- 开头的项目文件夹，实际：${names.join('、')}`)
  equal(readdirSync(join(root, folder)).length, 3, '三个文件应在项目文件夹里')
})

await testAsync('dryRun:true 只出计划，一个文件都不动', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name))

  const { apply } = await import('../index.js')
  const { ctx, tools, exec } = makeCtx({
    workspaces: [{ id: 'ws-1', path: root, title: '自检工作区' }],
    cwd: root,
  })
  apply(ctx, { enabled: false, minAgeDays: 0 })
  const tool = tools.get('tidy_workspace')

  const result = await tool.execute({ dryRun: true }, exec())
  equal(result.dryRun, true, '传 dryRun:true 时应该是预览')
  equal(result.projects, 1, '应规划出 1 个项目文件夹')
  equal(result.moves, 3, '应规划搬 3 个文件')
  equal(result.undo, '', '预览不该给撤回命令')
  assert(result.text.includes('没有动任何文件'), `回话应说清没动磁盘：${result.text}`)
  // 磁盘上还是那三个文件，没有新建文件夹
  const names = readdirSync(root)
  equal(names.filter((name) => name.endsWith('.png')).length, 3, '预览不该动文件')
  assert(!names.some((name) => /^\d{2}-/.test(name)), '预览不该建项目文件夹')
})

await testAsync('cwd 在工作区子目录时，仍整理工作区根目录', async () => {
  const root = makeRoot()
  const sub = join(root, '某个子目录')
  mkdirSync(sub, { recursive: true })
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name))

  const { apply } = await import('../index.js')
  const { ctx, tools, exec } = makeCtx({
    workspaces: [{ id: 'ws-1', path: root, title: '自检工作区' }],
    cwd: sub,
  })
  apply(ctx, { enabled: false, minAgeDays: 0 })

  const result = await tools.get('tidy_workspace').execute({ dryRun: true }, exec())
  equal(result.dryRun, true)
  equal(result.moves, 3, '应从工作区根目录收了 3 个文件')
  assert(
    result.workspace.replace(/\\/g, '/').endsWith(root.replace(/\\/g, '/').split(/[\\/]/).pop()),
    `整理范围应是工作区根目录而不是子目录：${result.workspace}`,
  )
})

await testAsync('enabled:false 不挡手动整理（那是自动调度的开关）', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name))

  const { apply } = await import('../index.js')
  const { ctx, tools, exec } = makeCtx({
    workspaces: [{ id: 'ws-1', path: root, title: '自检工作区' }],
    cwd: root,
  })
  apply(ctx, { enabled: false, minAgeDays: 0 })

  const result = await tools.get('tidy_workspace').execute({ dryRun: false }, exec())
  equal(result.dryRun, false)
  equal(result.moves, 3, '明确让整理时，enabled:false 不该拦住')
})

await testAsync('minAgeDays 覆盖参数管用：新文件默认挡住，传 0 就整理', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), 'x', 'utf8')
  }

  const { apply } = await import('../index.js')
  const { ctx, tools, exec } = makeCtx({
    workspaces: [{ id: 'ws-1', path: root, title: '自检工作区' }],
    cwd: root,
  })
  apply(ctx, { enabled: false, minAgeDays: 1 })

  const blocked = await tools.get('tidy_workspace').execute({}, exec())
  equal(blocked.moves, 0, '刚写的文件应被默认 minAgeDays=1 挡住')

  const forced = await tools.get('tidy_workspace').execute({ minAgeDays: 0 }, exec())
  equal(forced.moves, 3, 'minAgeDays:0 应把新文件也收进来')
})

await testAsync('拿不到会话 cwd 时给出可操作的报错，而不是整理别的工作区', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name))

  const { apply } = await import('../index.js')
  const { ctx, tools } = makeCtx({
    workspaces: [{ id: 'ws-1', path: root, title: '自检工作区' }],
    cwd: undefined,
  })
  apply(ctx, { enabled: false, minAgeDays: 0 })

  let error
  try {
    await tools.get('tidy_workspace').execute({}, { agent: { session: { header: {} } } })
  } catch (caught) {
    error = caught
  }
  assert(error !== undefined, '应该报错')
  assert(error.message.includes('工作区'), `报错应说清缺什么：${error.message}`)
  equal(readdirSync(root).filter((name) => name.endsWith('.png')).length, 3, '报错时不该动任何文件')
})

// ---------------------------------------------------------------- 收尾

for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不影响结果 */
  }
}
if (stateBackup === undefined) rmSync(stateFile, { force: true })
else writeFileSync(stateFile, stateBackup, 'utf8')

console.log('')
if (failed > 0) {
  console.log(`${passed} 通过，${failed} 失败`)
  for (const item of failures) console.log(`- ${item.title}: ${item.error?.stack ?? item.error}`)
  process.exit(1)
}
console.log(`${passed} 通过，0 失败`)
