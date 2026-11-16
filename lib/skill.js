// 技能定义：SKILL.md 的 frontmatter 读成对象。
//
// 只认三个字段（name / description / when_to_use），够注册一条技能用；支持引号值、
// `>` / `|` 块标量和缩进续行。不引 YAML 依赖 —— 按绝对路径加载的插件解析不了裸包名。

/** @param source - SKILL.md 全文。 @returns 字段对象（没有 frontmatter 时为空对象）。 */
export function frontmatterOf(source) {
  const result = {}
  const text = String(source ?? '')
  if (!text.startsWith('---')) return result
  const end = text.indexOf('\n---', 3)
  if (end < 0) return result
  let key = null
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (pair !== null) {
      key = pair[1]
      const raw = pair[2].trim()
      // `>` 和 `|` 开块标量，正文是后面缩进的行。
      const block = raw === '>' || raw === '|' || raw === '>-' || raw === '|-'
      result[key] = block ? '' : raw.replace(/^['"]|['"]$/g, '')
      continue
    }
    if (key !== null && /^\s+\S/.test(line)) {
      const more = line.trim()
      result[key] = result[key] ? `${result[key]} ${more}` : more
      continue
    }
    key = null
  }
  return result
}

/** 去掉 frontmatter，只留正文（技能正文里保留 frontmatter 也没问题，这里给统计字数用）。 */
export function skillBodyOf(source) {
  return String(source ?? '').replace(/^---[\s\S]*?\n---\r?\n?/, '')
}
