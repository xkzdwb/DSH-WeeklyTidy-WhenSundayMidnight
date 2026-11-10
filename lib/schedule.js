// 定时计算：固定「每周某天 HH:MM（某个 IANA 时区）」的下一次/上一次时刻。
//
// 算法与 02-周报邮件/src/schedule.mjs 一致（那边已经在跑，凌晨 0 点准点无误）：
// 不用 Date#getDay，因为 HOST 进程的时区由操作系统决定，而这里要按配置里的时区算。
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** 某个瞬间在该时区的 UTC 偏移（毫秒）：localWall = instant + offset。 */
export function zoneOffsetMs(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = {}
  for (const part of formatter.formatToParts(new Date(instant))) parts[part.type] = part.value
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return wall - Math.floor(instant / 1000) * 1000
}

/** 瞬间 → 该时区的墙上时间字段（month 是 1–12）。 */
export function wallClockOf(instant, timeZone) {
  const offset = zoneOffsetMs(instant, timeZone)
  const wall = new Date(instant + offset)
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    weekday: wall.getUTCDay(),
    offset,
  }
}

/** 墙上时间（年月日时分）→ 瞬间。偏移量迭代两次，足以覆盖夏令时切换。 */
export function instantFromWall({ year, month, day, hour, minute }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0)
  let offset = zoneOffsetMs(wall, timeZone)
  let instant = wall - offset
  const again = zoneOffsetMs(instant, timeZone)
  if (again !== offset) instant = wall - again
  return instant
}

function slotFor(dayWallMs, hour, minute) {
  const date = new Date(dayWallMs)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, 0)
}

/**
 * 严格晚于 now 的下一个「每周 weekday HH:MM」时刻。
 * @param now - 当前时刻（毫秒）。
 * @param options - { weekday: 0–6（0=周日）, hour, minute, timeZone }
 * @returns 下一次触发的毫秒时间戳。
 */
export function nextOccurrence(now, { weekday, hour, minute, timeZone }) {
  const local = wallClockOf(now, timeZone)
  const todayWall = Date.UTC(local.year, local.month - 1, local.day, 0, 0, 0)
  const todayWeekday = new Date(todayWall).getUTCDay()
  const ahead = (weekday - todayWeekday + 7) % 7
  let wall = slotFor(todayWall + ahead * DAY_MS, hour, minute)
  let instant = instantFromWallFields(wall, timeZone)
  if (instant <= now) {
    wall = slotFor(todayWall + (ahead + 7) * DAY_MS, hour, minute)
    instant = instantFromWallFields(wall, timeZone)
  }
  return instant
}

/** 不晚于 now 的最近一个「每周 weekday HH:MM」时刻。 */
export function previousOccurrence(now, { weekday, hour, minute, timeZone }) {
  const local = wallClockOf(now, timeZone)
  const todayWall = Date.UTC(local.year, local.month - 1, local.day, 0, 0, 0)
  const todayWeekday = new Date(todayWall).getUTCDay()
  const behind = (todayWeekday - weekday + 7) % 7
  let wall = slotFor(todayWall - behind * DAY_MS, hour, minute)
  let instant = instantFromWallFields(wall, timeZone)
  if (instant > now) {
    wall = slotFor(todayWall - (behind + 7) * DAY_MS, hour, minute)
    instant = instantFromWallFields(wall, timeZone)
  }
  return instant
}

function instantFromWallFields(wallMs, timeZone) {
  const date = new Date(wallMs)
  return instantFromWall(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    },
    timeZone,
  )
}

/** "2026-11-02 00:00" 这种可读写法（按配置时区）。 */
export function formatInZone(instant, timeZone, { seconds = false } = {}) {
  const local = wallClockOf(instant, timeZone)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${local.year}-${pad(local.month)}-${pad(local.day)} ` +
    `${pad(local.hour)}:${pad(local.minute)}` +
    (seconds ? `:${pad(local.second)}` : '')
  )
}

/** 运行编号用的紧凑写法（按配置时区）：20261116-000000。 */
export function stampOf(instant, timeZone) {
  const local = wallClockOf(instant, timeZone)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${local.year}${pad(local.month)}${pad(local.day)}` +
    `-${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`
  )
}

/** 只给日期："2026-11-02"。 */
export function formatDate(instant, timeZone) {
  return formatInZone(instant, timeZone).slice(0, 10)
}

export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** "00:00" → { hour, minute }；不合法返回 undefined。 */
export function parseTimeOfDay(input) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(input ?? '').trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

/** 配置里的星期/时刻写成一句人话，日志和状态页里用。 */
export function describeSchedule({ weekday, hour, minute, timeZone }) {
  const pad = (n) => String(n).padStart(2, '0')
  return `每${WEEKDAY_NAMES[weekday] ?? weekday} ${pad(hour)}:${pad(minute)}（${timeZone}）`
}

export { MINUTE_MS, DAY_MS }
