// 配置：默认值 + 宽松校验。写错一项只回退那一项并记警告，绝不让 HOST 起不来。
import { bool, integer, list, text, value } from './util.js'
import { parseTimeOfDay } from './schedule.js'

export const DEFAULTS = {
  enabled: true,
  weekday: 0,
  time: '00:00',
  timeZone: 'Asia/Shanghai',
  catchUp: true,
  tickIntervalMs: 30000,
  // 最近 N 天动过的文件先不碰，免得把正在用的截图/脚本搬走；0 = 不限。
  minAgeDays: 1,
  // 一个项目文件夹至少要有几个文件；不够就留在根目录，攒够再建夹。
  minFilesPerProject: 3,
  // 一次运行最多处理多少个文件（熔断），以及一次模型调用喂多少个文件。
  maxFilesPerRun: 200,
  maxFilesPerPrompt: 40,
  // 项目文件夹名（不含编号）最长多少个字符。
  nameMaxLength: 24,
  workspaces: [],
  // 默认不整理 DSH 自带的空工作区（按 id / 标题 / 路径都能匹配）。
  excludeWorkspaces: ['default-workspace'],
  protectPaths: [],
  protectNames: [],
  // 留空 = 用当前会话的默认模型；也可以写 'provider/model' 指定。
  model: '',
}

function ref(raw, key) {
  if (raw === null || typeof raw !== 'object') return undefined
  return raw[key]
}

/**
 * 取一个整数配置：不是数字或超范围时夹取回退，并且真的记一条警告。
 * （integer() 自己会静默夹取，所以这里先留原值再比较。）
 */
function bounded(raw, key, { min, max }, warnings) {
  const asked = value(ref(raw, key))
  const result = integer(asked, DEFAULTS[key], { min, max })
  if (asked === undefined || asked === null) return result
  const numeric = Number(asked)
  if (!Number.isFinite(numeric) || numeric !== result) {
    warnings.push(`${key} 只认 ${min}–${max} 的整数，已改用 ${result}`)
  }
  return result
}

/**
 * 把 profile 里的 config 解成插件自己用的形状。
 * @param raw - cordis config（值可能是 live ref）。
 * @returns { config, warnings }
 */
export function normalizeConfig(raw) {
  const warnings = []
  const config = { ...DEFAULTS }

  config.enabled = bool(ref(raw, 'enabled'), DEFAULTS.enabled)

  // 注意：integer() 会四舍五入并夹取，所以先留一份原值再夹，否则警告永远不触发。
  const rawWeekday = value(ref(raw, 'weekday'))
  const weekday = integer(rawWeekday, DEFAULTS.weekday, { min: 0, max: 6 })
  if (rawWeekday !== undefined && rawWeekday !== null) {
    const asked = Number(rawWeekday)
    if (!Number.isInteger(asked) || asked !== weekday) {
      warnings.push(`weekday 只认 0–6 的整数（0=周日），已改用 ${weekday}`)
    }
  }
  config.weekday = weekday

  const time = text(ref(raw, 'time'), DEFAULTS.time)
  const parsedTime = parseTimeOfDay(time)
  if (parsedTime === undefined) {
    warnings.push(`time "${time}" 不是 HH:MM，已回退到 ${DEFAULTS.time}`)
    config.time = DEFAULTS.time
  } else {
    config.time = `${String(parsedTime.hour).padStart(2, '0')}:${String(parsedTime.minute).padStart(2, '0')}`
  }

  config.timeZone = text(ref(raw, 'timeZone'), DEFAULTS.timeZone)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch {
    warnings.push(`timeZone "${config.timeZone}" 不被 Intl 认识，已回退到 ${DEFAULTS.timeZone}`)
    config.timeZone = DEFAULTS.timeZone
  }

  config.catchUp = bool(ref(raw, 'catchUp'), DEFAULTS.catchUp)
  config.tickIntervalMs = bounded(raw, 'tickIntervalMs', { min: 1000, max: 600000 }, warnings)

  config.minAgeDays = bounded(raw, 'minAgeDays', { min: 0, max: 3650 }, warnings)
  config.minFilesPerProject = bounded(raw, 'minFilesPerProject', { min: 2, max: 20 }, warnings)
  config.maxFilesPerRun = bounded(raw, 'maxFilesPerRun', { min: 1, max: 5000 }, warnings)
  config.maxFilesPerPrompt = bounded(raw, 'maxFilesPerPrompt', { min: 5, max: 120 }, warnings)
  config.nameMaxLength = bounded(raw, 'nameMaxLength', { min: 4, max: 60 }, warnings)

  if (config.maxFilesPerPrompt > config.maxFilesPerRun) {
    warnings.push(`maxFilesPerPrompt (${config.maxFilesPerPrompt}) 超过 maxFilesPerRun，已压到 ${config.maxFilesPerRun}`)
    config.maxFilesPerPrompt = config.maxFilesPerRun
  }

  config.model = text(ref(raw, 'model'), DEFAULTS.model)
  config.workspaces = list(ref(raw, 'workspaces'), DEFAULTS.workspaces)
  config.excludeWorkspaces = list(ref(raw, 'excludeWorkspaces'), DEFAULTS.excludeWorkspaces)
  config.protectPaths = list(ref(raw, 'protectPaths'), DEFAULTS.protectPaths)
  config.protectNames = list(ref(raw, 'protectNames'), DEFAULTS.protectNames)

  return { config, warnings }
}

/** 现在这份 config 对应的调度参数。 */
export function scheduleOptionsOf(config) {
  const parsed = parseTimeOfDay(config.time) ?? parseTimeOfDay(DEFAULTS.time)
  return {
    weekday: config.weekday,
    hour: parsed.hour,
    minute: parsed.minute,
    timeZone: config.timeZone,
  }
}

export { value }
