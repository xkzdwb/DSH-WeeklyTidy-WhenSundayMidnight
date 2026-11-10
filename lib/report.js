// 运行报告：一次整理到底建了哪些项目文件夹、搬了什么，写成能直接看的中文 markdown。
//
// 报告落在 audit/runs/<runId>.md；内容只描述「发生了什么」，不参与决策。

const REASONS = {
  scheduled: '到点自动运行',
  'catch-up': '错过了 0 点，开机后补跑',
  manual: '手动触发',
}

const TICK = '`'

/** 行内代码，避免在模板字符串里转义反引号。 */
function code(value) {
  return `${TICK}${value}${TICK}`
}

function reasonLabel(reason) {
  return REASONS[reason] ?? reason ?? '未标注'
}

/** 跳过原因归并：把带数字的原因（最近 N 天内改过）归成一类再计数。 */
function groupSkipped(skipped) {
  const counts = new Map()
  for (const item of skipped) {
    const key = String(item.reason ?? '其他').replace(/\d+/g, 'N')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|')
}

function sizeText(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * @param options - { plan, run, config, nextRunLocal, reason }
 * @returns markdown 文本
 */
export function renderRunMarkdown({ plan, run, config, nextRunLocal, reason }) {
  const lines = []
  lines.push(`# 每周整理 ${plan.runId}`)
  lines.push('')
  lines.push(`- 触发：${reasonLabel(reason)}`)
  lines.push(`- 时间：${plan.atLocal}（${config.timeZone}）`)
  lines.push(`- 范围：${plan.workspaces.length} 个工作区的根目录（只动散落文件）`)
  lines.push(
    `- 结果：建了 **${plan.totals.projects}** 个项目文件夹，搬了 **${run.moves.length}** 个文件，` +
      `失败 ${run.failures.length} 个，跳过 ${plan.totals.skipped} 项，共 ${sizeText(plan.totals.bytes)}`,
  )
  lines.push(`- 下次：${nextRunLocal}`)
  if (plan.truncated) lines.push(`- 注意：到了一次 ${config.maxFilesPerRun} 个文件的上限，剩下的留给下次`)
  lines.push('')

  const withMoves = plan.workspaces.filter((workspace) => workspace.moves.length > 0)
  const withUnclear = plan.workspaces.filter((workspace) => (workspace.unclear ?? []).length > 0)
  const withError = plan.workspaces.filter((workspace) => typeof workspace.error === 'string')
  if (withMoves.length === 0 && withUnclear.length === 0 && withError.length === 0) {
    lines.push('这次没有需要整理的文件。')
    lines.push('')
  }

  for (const workspace of plan.workspaces) {
    if (workspace.missing || workspace.notScanned) continue
    if (workspace.moves.length === 0 && (workspace.unclear ?? []).length === 0 && typeof workspace.error !== 'string') {
      continue
    }

    lines.push(`## ${workspace.title}（${code(workspace.root)}）`)
    lines.push('')
    if (typeof workspace.error === 'string') {
      lines.push(`- 这个工作区没整理：${workspace.error}`)
      lines.push('')
      continue
    }
    if (workspace.projects.length === 0) {
      lines.push('没有建新文件夹。')
      lines.push('')
    }

    for (const project of workspace.projects) {
      const failed = run.failures.some((failure) => String(failure.to).includes(`/${project.folder}/`))
      lines.push(`### ${code(`${project.folder}/`)}${failed ? ' ❌' : ''}（${project.files.length} 个文件，${sizeText(project.bytes)}）`)
      if (project.reason) lines.push(`> ${project.reason}`)
      lines.push('')
      lines.push('| 文件 |')
      lines.push('| --- |')
      for (const name of project.files) lines.push(`| ${code(escapeCell(name))} |`)
      lines.push('')
    }

    if ((workspace.unclear ?? []).length > 0) {
      lines.push(`没分组的（${workspace.unclear.length} 个，留在原处）：`)
      lines.push('')
      for (const item of workspace.unclear) lines.push(`- ${code(escapeCell(item.name))}：${item.reason}`)
      lines.push('')
    }
  }

  if (run.failures.length > 0) {
    lines.push('## 没搬成功的')
    lines.push('')
    for (const failure of run.failures) {
      lines.push(`- ${code(failure.from)} → ${code(failure.to)}：${failure.error}`)
    }
    lines.push('')
  }

  const allSkipped = plan.workspaces.flatMap((workspace) => workspace.skipped)
  const skippedGroups = groupSkipped(allSkipped)
  if (skippedGroups.length > 0) {
    lines.push('## 跳过的（按原因）')
    lines.push('')
    for (const [reasonText, count] of skippedGroups) {
      lines.push(`- ${reasonText}：${count}`)
    }
    lines.push('')
  }

  lines.push('## 怎么撤回')
  lines.push('')
  lines.push(`    node tools/tidy.mjs undo ${plan.runId}`)
  lines.push('')
  return lines.join('\n')
}
