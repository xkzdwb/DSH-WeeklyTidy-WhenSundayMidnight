// 执行：照着 plan 逐个 rename。失败只记一条，继续搬下一个 —— 一个被占用的
// 截图不该让整轮整理停在中途。跨盘（EXDEV）退化成 copy + unlink。

import { copyFileSync, existsSync, mkdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

function ensureDirs(dir, created) {
  if (existsSync(dir)) return
  const missing = []
  let cursor = dir
  for (;;) {
    missing.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor || existsSync(parent)) break
    cursor = parent
  }
  mkdirSync(dir, { recursive: true })
  for (const path of missing.reverse()) created.push(path)
}

function moveFile(from, to) {
  try {
    renameSync(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

/**
 * @param plan - buildPlan 的返回值。
 * @param options - { log }
 * @returns { runId, kind, status, moves（成功的）, failures, createdDirs, missing, durationMs }
 */
export function applyPlan(plan, { log = () => {} } = {}) {
  const startedAt = Date.now()
  const run = {
    runId: plan.runId,
    at: plan.at,
    atLocal: plan.atLocal,
    kind: 'apply',
    status: 'ok',
    moves: [],
    failures: [],
    createdDirs: [],
    missing: [],
    durationMs: 0,
  }

  for (const workspace of plan.workspaces) {
    if (workspace.missing) {
      run.missing.push(workspace.root)
      continue
    }
    for (const move of workspace.moves) {
      try {
        if (existsSync(move.to)) throw new Error('目标位置已经有同名文件')
        ensureDirs(dirname(move.to), run.createdDirs)
        moveFile(move.from, move.to)
        run.moves.push({ ...move, ok: true })
      } catch (error) {
        const detail = error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error)
        run.failures.push({ from: move.from, to: move.to, error: detail })
        log(`搬不动：${move.from} → ${move.to}（${detail}）`)
      }
    }
  }

  if (run.failures.length > 0) run.status = run.moves.length > 0 ? 'partial' : 'failed'
  run.durationMs = Date.now() - startedAt
  return run
}

/** 撤掉某次运行创建的空目录（由深到浅，非空就留着）。 */
export function removeEmptyDirs(dirs, { log = () => {} } = {}) {
  const removed = []
  for (const dir of [...dirs].reverse()) {
    try {
      rmdirSync(dir)
      removed.push(dir)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
        log(`目录没删掉：${dir}（${error?.code ?? error?.message}）`)
      }
    }
  }
  return removed
}
