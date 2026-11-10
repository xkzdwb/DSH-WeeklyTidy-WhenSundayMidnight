// 让模型判断「这几个文件是不是同一件事」，并给出一个中文项目名。
//
// 模型只负责「分组 + 起名」，编号、撞名、目录创建、搬文件都在本地做 ——
// 模型说要搬到哪里的路径一律不信。

import { cleanProjectName } from './naming.js'

export const SYSTEM_PROMPT = [
  '你在帮一位中文用户整理 Windows 上的工作区目录。',
  '用户习惯是：一个项目一个文件夹，文件夹名叫「编号-中文短名」，已经整理好的项目不再动。',
  '你的任务只有一件：把根目录里散落的文件按「同一件事/同一个项目」分组，并给每组起一个中文短名。',
  '只输出一个 JSON 对象，不要解释，不要用 Markdown 代码块，不要编造文件名。',
].join('\n')

function sizeText(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function dateText(mtimeMs) {
  const date = new Date(Number(mtimeMs) || Date.now())
  if (Number.isNaN(date.getTime())) return '日期不明'
  return date.toISOString().slice(0, 10)
}

function listOrNone(items, none = '（没有）') {
  if (!Array.isArray(items) || items.length === 0) return none
  return items.map((item) => `- ${item}`).join('\n')
}

/**
 * 拼一次判断用的提示词。
 * @param options - { workspaceTitle, root, files, existingProjects, readmeNames, readmeExcerpt }
 * @param settings - { maxChars = 14000 }
 * @returns 提示词字符串
 */
export function buildPrompt(
  { workspaceTitle, root, files, existingProjects = [], readmeNames = [], readmeExcerpt = '' },
  { maxChars = 14000 } = {},
) {
  const header = [
    `工作区：${workspaceTitle}`,
    `根目录：${root}`,
    '',
    '已经整理好的项目文件夹（不要重复创建，也不要建议改名）：',
    listOrNone(existingProjects),
    '',
    'README 里登记过的项目名（同样不要重复创建）：',
    listOrNone(readmeNames),
  ]
  if (readmeExcerpt.trim().length > 0) {
    header.push('', 'README 摘录（只供理解上下文）：', '"""', readmeExcerpt.trim(), '"""')
  }

  const footer = [
    '',
    '请把上面这些「待判断的散落文件」按项目分组，并给每组起名：',
    '- folder：不超过 16 个汉字，不带编号（编号由程序统一发），不带书名号和标点，词之间用短横线，例如「示例项目-第二阶段」。',
    `- 每组至少 3 个文件；不足 3 个的、拿不准的，放进 unclear，不要硬凑。`,
    '- 一个文件只能出现在一组里；文件名要原样抄写，不要改写、不要加路径。',
    '- 宁可少分，也不要把不相干的文件塞进同一个项目。',
    '',
    '只输出这样的 JSON：',
    '{"groups":[{"folder":"示例项目-第二阶段","reason":"一句话说明为什么算一组","files":["a.png","b.png"]}],"unclear":["notes.tsv"]}',
  ].join('\n')

  const render = (withPreview, limit) => {
    const lines = []
    files.slice(0, limit).forEach((file, index) => {
      lines.push(`${index + 1}) ${file.name} | ${sizeText(file.size)} | ${dateText(file.mtimeMs)}`)
      if (withPreview && typeof file.preview === 'string' && file.preview.length > 0) {
        lines.push(`   预览：${file.preview}`)
      }
    })
    if (limit < files.length) lines.push(`（还有 ${files.length - limit} 个文件没列出来）`)
    return lines.join('\n')
  }

  const assemble = (withPreview, limit) =>
    [
      ...header,
      '',
      `待判断的散落文件（共 ${files.length} 个，都在根目录）：`,
      render(withPreview, limit),
      footer,
    ].join('\n')

  let prompt = assemble(true, files.length)
  if (prompt.length <= maxChars) return prompt
  prompt = assemble(false, files.length)
  if (prompt.length <= maxChars) return prompt

  // 还是太长就少列一些文件，剩下的留给下一批（plan.js 会分批）。
  let low = 1
  let high = files.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (assemble(false, middle).length <= maxChars) low = middle
    else high = middle - 1
  }
  return assemble(false, low)
}

function extractJson(raw) {
  let text = String(raw ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence !== null) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * 校验模型输出：只认候选文件里的名字，名字清洗不过的整组丢掉。
 * @returns { groups: [{folder, files, reason}], unclear: [没被分组的文件名], error? }
 */
export function interpretGroups(raw, candidateNames, { maxLength = 24 } = {}) {
  const byLower = new Map(candidateNames.map((name) => [String(name).toLowerCase(), name]))
  const parsed = typeof raw === 'string' ? extractJson(raw) : raw
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return { groups: [], unclear: [...candidateNames], error: '模型没有返回可解析的 JSON' }
  }

  const groups = []
  const used = new Set()
  for (const item of Array.isArray(parsed.groups) ? parsed.groups : []) {
    const folder = cleanProjectName(item?.folder, { maxLength })
    if (folder.length === 0) continue
    const files = []
    for (const name of Array.isArray(item?.files) ? item.files : []) {
      const actual = byLower.get(String(name ?? '').trim().toLowerCase())
      if (actual === undefined || used.has(actual)) continue
      used.add(actual)
      files.push(actual)
    }
    if (files.length === 0) continue
    const reason = typeof item?.reason === 'string' ? item.reason.trim().slice(0, 80) : ''
    groups.push({ folder, files, reason })
  }

  return { groups, unclear: candidateNames.filter((name) => !used.has(name)) }
}

/**
 * Host 侧 llm 服务的薄封装：一次调用拿到完整文本。
 * @param deps - { llm, selectionOf: () => {provider, model}, log, timeoutMs }
 */
export function createLlmClient({ llm, selectionOf, log = () => {}, timeoutMs = 180_000 }) {
  async function ask({ prompt, system = SYSTEM_PROMPT, maxTokens = 2048, model, temperature = 0.2, signal } = {}) {
    const selection = typeof selectionOf === 'function' ? selectionOf() ?? {} : {}
    let provider = selection.provider
    let modelName = selection.model
    if (typeof model === 'string' && model.trim().length > 0) {
      const trimmed = model.trim()
      const slash = trimmed.indexOf('/')
      if (slash > 0) {
        provider = trimmed.slice(0, slash)
        modelName = trimmed.slice(slash + 1)
      } else {
        modelName = trimmed
      }
    }
    if (typeof provider !== 'string' || provider.length === 0 || typeof modelName !== 'string' || modelName.length === 0) {
      throw new Error('拿不到当前模型（provider/model），请在配置里填 model')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('模型调用超时')), timeoutMs)
    const onAbort = () => controller.abort(signal?.reason)
    if (signal !== undefined && signal !== null) signal.addEventListener('abort', onAbort, { once: true })

    let text = ''
    let failure
    try {
      for await (const chunk of llm.stream({
        provider,
        model: modelName,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens,
        temperature,
        signal: controller.signal,
      })) {
        if (chunk?.type === 'text-delta') text += chunk.text ?? ''
        else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
      }
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw new Error(`模型调用失败：${controller.signal.reason.message}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
    }

    if (failure !== undefined) {
      throw new Error(`模型调用失败：${failure?.message ?? failure?.code ?? '未知错误'}`)
    }
    if (text.trim().length === 0) {
      log('模型返回了空内容')
      throw new Error('模型返回了空内容')
    }
    return text
  }

  return { ask }
}
