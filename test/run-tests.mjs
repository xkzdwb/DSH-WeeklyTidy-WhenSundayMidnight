// 离线自测：不联网、不调真模型，用临时目录和假的 askModel 验证规则。
//
//   node test/run-tests.mjs

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyPlan } from '../lib/apply.js'
import { normalizeConfig } from '../lib/config.js'
import { appendJournal, readJournal, undoRun } from '../lib/journal.js'
import {
  cleanProjectName,
  isNumberedName,
  nextProjectNumber,
  projectFolderName,
  projectNumber,
} from '../lib/naming.js'
import { buildPlan } from '../lib/plan.js'
import { scanWorkspace } from '../lib/scan.js'
import { formatInZone, nextOccurrence, parseTimeOfDay, previousOccurrence } from '../lib/schedule.js'

let passed = 0
let failed = 0
const failures = []

function test(title, fn) {
  try {
    const result = fn()
    if (result instanceof Promise) throw new Error('test() 不接受 async 函数，请用 testAsync')
    passed += 1
    console.log(`✓ ${title}`)
  } catch (error) {
    failed += 1
    failures.push({ title, error })
    console.log(`✗ ${title}\n    ${error?.message ?? error}`)
  }
}

async function testAsync(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${title}`)
  } catch (error) {
    failed += 1
    failures.push({ title, error })
    console.log(`✗ ${title}\n    ${error?.message ?? error}`)
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
  const root = mkdtempSync(join(tmpdir(), 'tidy-test-'))
  roots.push(root)
  return root
}

function touch(file, { daysAgo = 0, content = 'x' } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  if (daysAgo > 0) {
    const stamp = (Date.now() - daysAgo * 86_400_000) / 1000
    utimesSync(file, stamp, stamp)
  }
}

function cfg(extra = {}) {
  const { config } = normalizeConfig({ minAgeDays: 0, ...extra })
  return config
}

/** 从提示词里把候选文件名捞回来，模拟「模型看懂了」。 */
function promptNames(prompt) {
  return prompt
    .split('\n')
    .map((line) => /^\d+\) (.+?) \| /.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1])
}

/** 假模型：把这一批文件全部归到同一个项目。 */
function askAll(folder = '项目甲', onCall) {
  return async ({ prompt }) => {
    if (typeof onCall === 'function') onCall(prompt)
    return JSON.stringify({
      groups: [{ folder, reason: '测试用的分组理由', files: promptNames(prompt) }],
      unclear: [],
    })
  }
}

async function planFor(root, { askModel = askAll(), extra = {}, workspaces } = {}) {
  const config = cfg(extra)
  return buildPlan({
    workspaces: workspaces ?? [{ id: 'w', path: root, title: '测试工作区' }],
    config,
    protectPaths: [],
    now: Date.now(),
    askModel,
  })
}

// ---------------------------------------------------------------- 命名

test('cleanProjectName 去掉编号、非法字符和末尾点', () => {
  equal(cleanProjectName('03-示例项目 表头核对'), '示例项目-表头核对')
  equal(cleanProjectName('a/b:c*d'), 'a-b-c-d')
  equal(cleanProjectName('  --尾部--  '), '尾部')
  equal(cleanProjectName('CON'), 'CON-项目')
  equal(cleanProjectName('   '), '')
})

test('编号识别与续号', () => {
  assert(isNumberedName('01-示例项目'), '01- 应识别为编号目录')
  assert(!isNumberedName('Some-Folder'), '没有编号的不算')
  equal(projectNumber('03-示例项目丙'), 3)
  equal(nextProjectNumber(['01-甲', '07-乙', '散目录']), 8)
  equal(nextProjectNumber([]), 1)
  equal(projectFolderName(4, '新项目'), '04-新项目')
})

test('编号里带下划线/中文顿号也认', () => {
  assert(isNumberedName('02_听力原文'), '02_ 应识别')
  assert(isNumberedName('3、做题取证'), '3、应识别')
})

// ---------------------------------------------------------------- 扫描

test('只扫根目录文件：编号目录和普通目录都不进', () => {
  const root = makeRoot()
  touch(join(root, 'a.png'), { daysAgo: 10 })
  touch(join(root, '02-老项目', 'inner.txt'), { daysAgo: 10 })
  touch(join(root, 'Win-Pad Connect', 'x.txt'), { daysAgo: 10 })
  const scan = scanWorkspace({ root, minAgeDays: 1 })
  equal(scan.files.length, 1)
  equal(scan.files[0].name, 'a.png')
  assert(scan.projects.includes('02-老项目'), '编号目录应出现在 projects 里')
  assert(scan.skipped.some((item) => item.reason.includes('已有项目文件夹')), '应有跳过记录')
})

test('README、隐藏文件、太新的文件都跳过', () => {
  const root = makeRoot()
  touch(join(root, 'README.md'), { daysAgo: 10 })
  touch(join(root, '.env'), { daysAgo: 10 })
  touch(join(root, 'fresh.png'), { daysAgo: 0 })
  touch(join(root, 'old.png'), { daysAgo: 10 })
  const scan = scanWorkspace({ root, minAgeDays: 1 })
  equal(scan.files.length, 1)
  equal(scan.files[0].name, 'old.png')
  assert(scan.skipped.some((item) => item.reason === '说明/清单文件'), 'README 应被跳过')
  assert(scan.skipped.some((item) => item.reason === '隐藏项'), '.env 应被跳过')
  assert(scan.skipped.some((item) => item.reason.includes('最近 1 天内改过')), 'fresh.png 应被跳过')
})

test('文本文件带预览，图片不带', () => {
  const root = makeRoot()
  touch(join(root, 'notes.txt'), { daysAgo: 10, content: '第一行\n第二行  ' })
  touch(join(root, 'shot.png'), { daysAgo: 10, content: 'not really png' })
  const scan = scanWorkspace({ root, minAgeDays: 0 })
  const notes = scan.files.find((file) => file.name === 'notes.txt')
  const shot = scan.files.find((file) => file.name === 'shot.png')
  assert(notes.preview.includes('第一行'), '文本应带预览')
  equal(shot.preview, undefined, '图片不应带预览')
})

// ---------------------------------------------------------------- 规划

await testAsync('三个文件归进 01-项目名，文件名保持原样', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name), { daysAgo: 5 })
  const plan = await planFor(root)
  const entry = plan.workspaces[0]
  equal(entry.projects.length, 1)
  equal(entry.projects[0].folder, '01-项目甲')
  equal(entry.moves.length, 3)
  const move = entry.moves.find((item) => item.from.endsWith('/a.png'))
  assert(move !== undefined, 'a.png 应有 move')
  assert(move.to.endsWith('/01-项目甲/a.png'), `目标不对：${move.to}`)
  equal(plan.totals.projects, 1)
})

await testAsync('编号接已有最大编号往后排', async () => {
  const root = makeRoot()
  mkdirSync(join(root, '03-旧项目'), { recursive: true })
  for (const name of ['a.txt', 'b.txt', 'c.txt']) touch(join(root, name), { daysAgo: 5 })
  const plan = await planFor(root)
  equal(plan.workspaces[0].projects[0].folder, '04-项目甲')
})

await testAsync('不足 3 个文件不建夹，留原处', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png']) touch(join(root, name), { daysAgo: 5 })
  const plan = await planFor(root)
  equal(plan.workspaces[0].projects.length, 0)
  equal(plan.workspaces[0].moves.length, 0)
  equal(plan.workspaces[0].unclear.length, 2)
  assert(plan.workspaces[0].unclear[0].reason.includes('不足 3 个'), '应说明原因')
})

await testAsync('与已有文件夹撞名时加 -2', async () => {
  const root = makeRoot()
  mkdirSync(join(root, '01-项目甲'), { recursive: true })
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name), { daysAgo: 5 })
  const plan = await planFor(root)
  equal(plan.workspaces[0].projects[0].folder, '02-项目甲-2')
})

await testAsync('同一项目分两批也合并成一个文件夹', async () => {
  const root = makeRoot()
  const names = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png']
  for (const name of names) touch(join(root, name), { daysAgo: 5 })
  let calls = 0
  // maxFilesPerPrompt 下限是 5，所以 6 个文件正好分两批。
  const plan = await planFor(root, {
    extra: { maxFilesPerPrompt: 5 },
    askModel: askAll('同一批', () => {
      calls += 1
    }),
  })
  equal(calls, 2)
  equal(plan.workspaces[0].projects.length, 1)
  equal(plan.workspaces[0].projects[0].files.length, 6)
})

await testAsync('模型报错时这个工作区不搬，其它工作区继续', async () => {
  const rootA = makeRoot()
  const rootB = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(rootA, name), { daysAgo: 5 })
  for (const name of ['x.png', 'y.png', 'z.png']) touch(join(rootB, name), { daysAgo: 5 })
  const asked = []
  const plan = await planFor(null, {
    workspaces: [
      { id: 'a', path: rootA, title: 'A' },
      { id: 'b', path: rootB, title: 'B' },
    ],
    askModel: async ({ prompt }) => {
      asked.push(prompt)
      if (asked.length === 1) throw new Error('模型超时')
      return JSON.stringify({ groups: [{ folder: '乙项目', files: promptNames(prompt) }], unclear: [] })
    },
  })
  assert(typeof plan.workspaces[0].error === 'string', 'A 应记错误')
  equal(plan.workspaces[0].moves.length, 0)
  equal(plan.workspaces[1].moves.length, 3)
})

await testAsync('模型输出不是 JSON 时整批留着', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name), { daysAgo: 5 })
  const plan = await planFor(root, { askModel: async () => '我觉得可以分三组' })
  equal(plan.workspaces[0].moves.length, 0)
  assert(plan.workspaces[0].error.includes('JSON'), '应说明 JSON 解析失败')
})

await testAsync('模型编造的文件名被忽略', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name), { daysAgo: 5 })
  const plan = await planFor(root, {
    askModel: async () =>
      JSON.stringify({
        groups: [{ folder: '甲', files: ['a.png', 'b.png', 'c.png', '不存在.png', '../../逃出去.txt'] }],
        unclear: [],
      }),
  })
  equal(plan.workspaces[0].moves.length, 3)
  assert(plan.workspaces[0].moves.every((move) => move.to.includes('/01-甲/')), '目标都应在项目文件夹里')
})

await testAsync('没有候选文件时不调用模型', async () => {
  const root = makeRoot()
  let calls = 0
  await planFor(root, { askModel: askAll('甲', () => { calls += 1 }) })
  equal(calls, 0)
})

await testAsync('maxFilesPerRun 到上限后停止并标记 truncated', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']) touch(join(root, name), { daysAgo: 5 })
  const plan = await planFor(root, { extra: { maxFilesPerRun: 2, minFilesPerProject: 2 } })
  equal(plan.truncated, true)
  equal(plan.workspaces[0].moves.length, 2)
})

// ---------------------------------------------------------------- 执行与撤回

await testAsync('apply 建夹搬文件，undo 原样搬回并删空目录', async () => {
  const root = makeRoot()
  for (const name of ['a.png', 'b.png', 'c.png']) touch(join(root, name), { daysAgo: 5 })
  const plan = await planFor(root)
  const run = applyPlan(plan, {})
  equal(run.status, 'ok')
  equal(run.moves.length, 3)

  const folder = join(root, '01-项目甲')
  assert(existsSync(folder), '项目文件夹应已创建')
  equal(readdirSync(folder).length, 3)
  assert(!existsSync(join(root, 'a.png')), '原位置不应还有 a.png')

  const journal = join(root, '..', `${Date.now()}-journal.jsonl`)
  appendJournal(journal, { runId: plan.runId, kind: 'apply', moves: run.moves, createdDirs: run.createdDirs })
  const undo = undoRun(journal, 'last')
  equal(undo.restored, 3)
  equal(undo.failed, 0)
  assert(!existsSync(folder), '空目录应被删掉')
  assert(existsSync(join(root, 'a.png')), 'a.png 应回到根目录')
  rmSync(journal, { force: true })
})

await testAsync('账本里没有那次运行时给出清楚错误', async () => {
  const root = makeRoot()
  const journal = join(root, 'journal.jsonl')
  const result = undoRun(journal, 'no-such-run')
  assert(result.ok === false, '应失败')
  assert(result.error.includes('找不到'), `错误信息不对：${result.error}`)
})

// ---------------------------------------------------------------- 时间与配置

test('parseTimeOfDay 接受 9:5 这种写法，拒绝 24:00', () => {
  const parsed = parseTimeOfDay('9:5')
  assert(parsed !== undefined, '9:5 应被接受')
  equal(parsed.hour, 9)
  equal(parsed.minute, 5)
  equal(parseTimeOfDay('24:00'), undefined)
  equal(parseTimeOfDay('ab'), undefined)
})

test('周日 0 点：周二算出下一个周日，刚过 0 点则算下周', () => {
  const options = { weekday: 0, hour: 0, minute: 0, timeZone: 'Asia/Shanghai' }
  const tuesday = new Date('2026-11-10T12:00:00+08:00').getTime()
  equal(formatInZone(nextOccurrence(tuesday, options), 'Asia/Shanghai'), '2026-11-15 00:00')
  const justAfter = new Date('2026-11-15T00:01:30+08:00').getTime()
  equal(formatInZone(nextOccurrence(justAfter, options), 'Asia/Shanghai'), '2026-11-22 00:00')
  const previous = previousOccurrence(justAfter, options)
  equal(formatInZone(previous, 'Asia/Shanghai'), '2026-11-15 00:00')
})

test('配置回退：坏时间/坏星期/坏整数都有警告', () => {
  const { config, warnings } = normalizeConfig({
    weekday: 9,
    time: '25:99',
    minAgeDays: -5,
    minFilesPerProject: 99,
  })
  equal(config.weekday, 6)
  equal(config.time, '00:00')
  equal(config.minAgeDays, 0)
  equal(config.minFilesPerProject, 20)
  assert(warnings.length >= 4, `警告太少：${warnings.join('；')}`)
})

test('maxFilesPerPrompt 不会超过 maxFilesPerRun', () => {
  const { config } = normalizeConfig({ maxFilesPerRun: 10, maxFilesPerPrompt: 80 })
  equal(config.maxFilesPerPrompt, 10)
})

// ---------------------------------------------------------------- 收尾

for (const root of roots) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响结果
  }
}

console.log('')
if (failed > 0) {
  console.log(`${passed} 通过，${failed} 失败`)
  for (const item of failures) console.log(`- ${item.title}: ${item.error?.stack ?? item.error}`)
  process.exit(1)
}
console.log(`${passed} 通过，0 失败`)
