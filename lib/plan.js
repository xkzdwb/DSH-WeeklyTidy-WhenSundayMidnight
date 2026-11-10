// 规划：扫描每个工作区 → 让模型把散落文件按项目分组、起中文名 → 本地校验并发号。
// 这一步不碰磁盘（只 readdir/stat/读几行预览），所以 plan 可以随便跑，用来先看效果。
//
// 模型输出不可信：文件名必须是候选里的，名字清洗不过就丢，组太小就拆回未分组，
// 编号、撞名、目标目录全部由这里决定。

import { join } from 'node:path'
import { formatInZone, stampOf } from './schedule.js'
import { scanWorkspace } from './scan.js'
import {
  cleanProjectName,
  nextProjectNumber,
  projectFolderName,
  uniqueProjectName,
} from './naming.js'
import { displayPath } from './util.js'
import { buildPrompt, interpretGroups, SYSTEM_PROMPT } from './ai.js'
import { findReadme, readProjectNames } from './readme.js'

const MAX_PROMPT_CHARS = 14000

function chunk(items, size) {
  const safeSize = Math.max(1, Number(size) || 40)
  const batches = []
  for (let index = 0; index < items.length; index += safeSize) {
    batches.push(items.slice(index, index + safeSize))
  }
  return batches
}

function messageOf(error) {
  return String(error?.message ?? error)
}

/**
 * @param options - {
 *   workspaces: [{id,title,path}], config, protectPaths, now,
 *   askModel: ({system, prompt, config, log}) => Promise<string>
 * }
 * @returns 计划对象；形状与 audit/runs/<runId>.plan.json 一致。
 */
export async function buildPlan({
  workspaces,
  config,
  protectPaths = [],
  now = Date.now(),
  askModel,
  log = () => {},
} = {}) {
  const plan = {
    runId: stampOf(now, config.timeZone),
    at: new Date(now).toISOString(),
    atLocal: formatInZone(now, config.timeZone),
    minAgeDays: config.minAgeDays,
    minFilesPerProject: config.minFilesPerProject,
    maxFilesPerRun: config.maxFilesPerRun,
    maxFilesPerPrompt: config.maxFilesPerPrompt,
    nameMaxLength: config.nameMaxLength,
    truncated: false,
    protectedPaths: protectPaths,
    workspaces: [],
    totals: {
      workspaces: 0,
      workspacesWithMoves: 0,
      scanned: 0,
      files: 0,
      moves: 0,
      projects: 0,
      skipped: 0,
      bytes: 0,
    },
  }

  let budget = Math.max(0, config.maxFilesPerRun)

  for (const workspace of workspaces) {
    const entry = {
      id: workspace.id,
      title: workspace.title ?? workspace.id,
      root: displayPath(workspace.path),
      missing: false,
      notScanned: false,
      error: null,
      files: [],
      projects: [],
      moves: [],
      unclear: [],
      skipped: [],
      skippedCount: 0,
    }

    if (budget <= 0) {
      entry.notScanned = true
      entry.skipped.push({ path: entry.root, reason: '本次已到 maxFilesPerRun 上限，留到下次' })
      plan.truncated = true
      plan.workspaces.push(entry)
      continue
    }

    const scan = scanWorkspace({
      root: workspace.path,
      minAgeDays: config.minAgeDays,
      protectPaths,
      skipNames: config.protectNames,
      now,
    })

    entry.missing = scan.missing
    entry.skipped = scan.skipped.slice(0, 300)
    entry.skippedCount = scan.skipped.length
    plan.totals.skipped += scan.skipped.length

    if (entry.missing) {
      plan.workspaces.push(entry)
      continue
    }

    const candidates = scan.files.slice(0, budget)
    if (scan.files.length > candidates.length) {
      plan.truncated = true
      entry.skipped.push({
        path: entry.root,
        reason: `本次已到 ${config.maxFilesPerRun} 个文件上限，其余留到下次`,
      })
      entry.skippedCount += scan.files.length - candidates.length
      plan.totals.skipped += scan.files.length - candidates.length
    }

    entry.files = candidates.map((file) => file.name)
    plan.totals.files += candidates.length
    plan.totals.scanned += candidates.length

    if (candidates.length === 0) {
      plan.workspaces.push(entry)
      continue
    }

    const readmeFile = findReadme(workspace.path)
    const readme = readmeFile === undefined ? { names: [], excerpt: '' } : readProjectNames(readmeFile)

    // folderName（小写）→ { folder, reason, names: Set }
    const groups = new Map()
    const byName = new Map(candidates.map((file) => [file.name, file]))
    let failure

    for (const batch of chunk(candidates, config.maxFilesPerPrompt)) {
      const prompt = buildPrompt(
        {
          workspaceTitle: entry.title,
          root: entry.root,
          files: batch,
          existingProjects: [...scan.projects, ...[...groups.values()].map((group) => group.folder)],
          readmeNames: readme.names,
          readmeExcerpt: readme.excerpt,
        },
        { maxChars: MAX_PROMPT_CHARS },
      )

      let raw
      try {
        raw = await askModel({ system: SYSTEM_PROMPT, prompt, config, log })
      } catch (error) {
        failure = `模型调用失败：${messageOf(error)}`
        log(`${entry.title}：${failure}`)
        break
      }

      const parsed = interpretGroups(raw, batch.map((file) => file.name), {
        maxLength: config.nameMaxLength,
      })
      if (parsed.error !== undefined) {
        failure = parsed.error
        log(`${entry.title}：${failure}`)
        break
      }

      for (const group of parsed.groups) {
        const key = group.folder.toLowerCase()
        const known = groups.get(key)
        if (known === undefined) {
          groups.set(key, { folder: group.folder, reason: group.reason, names: new Set(group.files) })
        } else {
          for (const name of group.files) known.names.add(name)
          if (known.reason.length === 0 && group.reason.length > 0) known.reason = group.reason
        }
      }
    }

    // 只统计还没被任何组占用的文件（模型漏掉的都在这里）。
    const assigned = new Set()
    for (const group of groups.values()) for (const name of group.names) assigned.add(name)

    if (failure !== undefined) {
      entry.error = failure
      entry.unclear = candidates.map((file) => ({ name: file.name, reason: '模型调用失败，原样留着' }))
      plan.workspaces.push(entry)
      continue
    }

    // 组太小就拆掉，文件放回未分组 —— 一两个文件单开一个文件夹比散着更乱。
    for (const [key, group] of [...groups.entries()]) {
      if (group.names.size >= config.minFilesPerProject) continue
      for (const name of group.names) {
        entry.unclear.push({ name, reason: `不足 ${config.minFilesPerProject} 个文件，够一组再建夹` })
        assigned.delete(name)
      }
      groups.delete(key)
    }

    // 已有目录名（连同去掉编号后的名字）都算占用，免得新建 01-项目 撞上 01-项目。
    const taken = new Set()
    for (const name of scan.dirs) {
      taken.add(name.toLowerCase())
      const cleaned = cleanProjectName(name, { maxLength: config.nameMaxLength })
      if (cleaned.length > 0) taken.add(cleaned.toLowerCase())
    }
    let number = nextProjectNumber(scan.dirs)
    for (const group of groups.values()) {
      const cleaned = cleanProjectName(group.folder, { maxLength: config.nameMaxLength })
      if (cleaned.length === 0) {
        for (const name of group.names) entry.unclear.push({ name, reason: '项目名清洗后为空，没敢建夹' })
        continue
      }
      const unique = uniqueProjectName(cleaned, taken, { maxLength: config.nameMaxLength })
      const folder = projectFolderName(number, unique)
      number += 1
      const destDir = displayPath(join(workspace.path, folder))

      let bytes = 0
      const files = []
      for (const name of group.names) {
        const file = byName.get(name)
        if (file === undefined) continue
        files.push(name)
        bytes += file.size
        entry.moves.push({
          from: file.path,
          to: displayPath(join(destDir, name)),
          project: folder,
          bytes: file.size,
          mtimeMs: file.mtimeMs,
        })
      }
      entry.projects.push({ folder, name: unique, reason: group.reason, files, bytes })
    }

    for (const file of candidates) {
      if (assigned.has(file.name)) continue
      if (entry.unclear.some((item) => item.name === file.name)) continue
      entry.unclear.push({ name: file.name, reason: '模型没有分组（拿不准的留在原处）' })
    }

    plan.totals.moves += entry.moves.length
    plan.totals.projects += entry.projects.length
    plan.totals.bytes += entry.moves.reduce((sum, move) => sum + (Number(move.bytes) || 0), 0)
    plan.totals.skipped += entry.unclear.length
    if (entry.moves.length > 0) plan.totals.workspacesWithMoves += 1
    budget -= entry.moves.length

    plan.workspaces.push(entry)
  }

  // workspaces 是「看了几个工作区」，workspacesWithMoves 才是「几个工作区真有东西可搬」
  plan.totals.workspaces = plan.workspaces.length

  return plan
}
