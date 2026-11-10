// 账本：每次真正搬了东西就追加一行 JSON，撤回时按这一行原路返回。
//
// audit/journal.jsonl 是只追加的，出问题可以直接看；audit/runs/<runId>.json 是
// 当次的完整计划 + 结果，方便对照。

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { removeEmptyDirs } from './apply.js'

export function appendJournal(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/** 读全部账本行；坏行跳过（账本不该因为一行截断就整份读不出来）。 */
export function readJournal(file) {
  try {
    const content = readFileSync(file, 'utf8')
    const rows = []
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        rows.push(JSON.parse(trimmed))
      } catch {
        // 跳过坏行
      }
    }
    return rows
  } catch {
    return []
  }
}

/** 找一条 apply 记录；runId 传 "last" 取最近一条。 */
export function findRun(file, runId) {
  const rows = readJournal(file)
  const applies = rows.filter((row) => row?.kind === 'apply')
  if (runId === undefined || runId === 'last' || runId === '') return applies[applies.length - 1]
  return applies.find((row) => row.runId === runId)
}

function moveBack(from, to) {
  try {
    renameSync(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

/**
 * 撤回一次运行：把 move.to 搬回 move.from，删掉当次新建的空目录。
 * 已是「目标不在了」「原位置被占了」的条目记失败，不覆盖任何现有文件。
 */
export function undoRun(file, runId, { log = () => {} } = {}) {
  const record = findRun(file, runId)
  if (record === undefined) return { ok: false, error: `账本里找不到运行 ${runId ?? 'last'}` }

  const restored = []
  const failures = []
  for (const move of [...(record.moves ?? [])].reverse()) {
    try {
      if (!existsSync(move.to)) throw new Error('整理后的文件已经不在（可能被手动移走了）')
      if (existsSync(move.from)) throw new Error('原位置已经有同名文件，没敢覆盖')
      mkdirSync(dirname(move.from), { recursive: true })
      moveBack(move.to, move.from)
      restored.push({ from: move.to, to: move.from })
    } catch (error) {
      const detail = error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error)
      failures.push({ from: move.to, to: move.from, error: detail })
      log(`撤不回来：${move.to} → ${move.from}（${detail}）`)
    }
  }

  const removedDirs = removeEmptyDirs(record.createdDirs ?? [], { log })
  const undoRecord = {
    runId: `${record.runId}-undo`,
    targetRunId: record.runId,
    at: new Date().toISOString(),
    kind: 'undo',
    restored: restored.length,
    failed: failures.length,
    moves: restored,
    failures,
    removedDirs,
  }
  appendJournal(file, undoRecord)
  return {
    ok: failures.length === 0,
    targetRunId: record.runId,
    restored: restored.length,
    failed: failures.length,
    failures,
    removedDirs,
  }
}
