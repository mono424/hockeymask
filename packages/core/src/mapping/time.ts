/**
 * Dates without a wall clock.
 *
 * The runtime value of the `date` type is an `Instant`: a frozen point in time in epoch
 * milliseconds. Calendar math ("+10y", "start of day") happens in an IANA time zone, using
 * `Intl.DateTimeFormat` to move between instants and wall-clock time. "now" only ever comes
 * from the run context (arch.md, "Time"), never from `Date.now()`.
 */

import { err, ok, type Result } from './result'

export class Instant {
  private constructor(readonly epochMs: number) {
    Object.freeze(this)
  }

  static ofEpochMs(epochMs: number): Instant {
    if (!Number.isFinite(epochMs)) throw new RangeError(`invalid epoch milliseconds ${epochMs}`)
    return new Instant(epochMs)
  }

  /** Strict ISO 8601 with an offset or `Z`, e.g. `2026-10-04T12:00:00Z`. */
  static parse(iso: string): Instant | undefined {
    if (!ISO_INSTANT.test(iso)) return undefined
    const ms = Date.parse(iso)
    return Number.isNaN(ms) ? undefined : new Instant(ms)
  }

  toISOString(): string {
    return new Date(this.epochMs).toISOString()
  }

  toJSON(): string {
    return this.toISOString()
  }

  toString(): string {
    return this.toISOString()
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

// --- time zones ---------------------------------------------------------------------------

/** Wall-clock fields in some time zone. Months are 1-12. */
export interface WallClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly ms: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(tz, f)
  }
  return f
}

export function isTimeZone(tz: string): boolean {
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

/** The wall clock in `tz` at `instant`. */
export function toWallClock(instant: Instant, tz: string): WallClock {
  const parts: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(new Date(instant.epochMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return {
    year: parts.year as number,
    month: parts.month as number,
    day: parts.day as number,
    hour: parts.hour as number,
    minute: parts.minute as number,
    second: parts.second as number,
    ms: ((instant.epochMs % 1000) + 1000) % 1000,
  }
}

function wallAsUtc(w: WallClock): number {
  // Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear does not.
  const d = new Date(Date.UTC(2000, w.month - 1, w.day, w.hour, w.minute, w.second, w.ms))
  d.setUTCFullYear(w.year)
  return d.getTime()
}

/** Offset of `tz` from UTC at `epochMs`, in milliseconds. */
function offsetAt(epochMs: number, tz: string): number {
  return wallAsUtc(toWallClock(Instant.ofEpochMs(epochMs), tz)) - epochMs
}

/**
 * The instant at which the wall clock in `tz` shows `w`. A wall time skipped by a DST
 * transition resolves after the gap; an ambiguous one resolves to the earlier instant.
 */
export function fromWallClock(w: WallClock, tz: string): Instant {
  const local = wallAsUtc(w)
  // The offsets in force a day before and a day after cover both sides of any transition.
  const before = offsetAt(local - 86_400_000, tz)
  const after = offsetAt(local + 86_400_000, tz)
  const shows = (c: number) => wallAsUtc(toWallClock(Instant.ofEpochMs(c), tz)) === local
  const candidates = [local - before, local - after].filter(shows)
  // Inside a gap neither matches: keep the earlier offset, which lands after the gap.
  return Instant.ofEpochMs(candidates.length > 0 ? Math.min(...candidates) : local - before)
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

// --- calendar math --------------------------------------------------------------------------

export type DurationUnit = 'y' | 'mo' | 'w' | 'd' | 'h'

export interface Duration {
  readonly amount: number
  readonly unit: DurationUnit
}

const DURATION_PART = /([+-])(\d+)(y|mo|w|d|h)/gy

/** `+10y`, `-30d`, `+1y-2mo`: one or more signed amounts. */
export function parseDuration(text: string): Result<readonly Duration[], string> {
  const parts: Duration[] = []
  DURATION_PART.lastIndex = 0
  let at = 0
  while (at < text.length) {
    DURATION_PART.lastIndex = at
    const m = DURATION_PART.exec(text)
    if (!m) return err(`invalid duration '${text}', expected e.g. '+10y' or '-30d'`)
    const [, sign, digits, unit] = m
    parts.push({ amount: Number(digits) * (sign === '-' ? -1 : 1), unit: unit as DurationUnit })
    at = DURATION_PART.lastIndex
  }
  if (parts.length === 0) return err(`invalid duration '${text}', expected e.g. '+10y' or '-30d'`)
  return ok(parts)
}

/** A duration already validated by `parseDuration` (e.g. by a params schema). */
export function duration(text: string): readonly Duration[] {
  const parsed = parseDuration(text)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

/** Shift by calendar units in `tz`. Month ends clamp: Feb 29 + 1y is Feb 28. */
export function shift(instant: Instant, by: readonly Duration[], tz: string): Instant {
  let current = instant
  for (const { amount, unit } of by) {
    if (unit === 'h') {
      current = Instant.ofEpochMs(current.epochMs + amount * 3_600_000)
      continue
    }
    const w = toWallClock(current, tz)
    if (unit === 'y' || unit === 'mo') {
      const months = w.year * 12 + (w.month - 1) + (unit === 'y' ? amount * 12 : amount)
      const year = Math.floor(months / 12)
      const month = (months % 12) + 1
      current = fromWallClock(
        { ...w, year, month, day: Math.min(w.day, daysInMonth(year, month)) },
        tz,
      )
    } else {
      const days = unit === 'w' ? amount * 7 : amount
      const d = new Date(wallAsUtc({ ...w, hour: 0, minute: 0, second: 0, ms: 0 }))
      d.setUTCDate(d.getUTCDate() + days)
      current = fromWallClock(
        { ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
        tz,
      )
    }
  }
  return current
}

export type TruncateUnit = 'day' | 'month' | 'year'

/** Start of the day, month or year containing `instant`, in `tz`. */
export function truncate(instant: Instant, unit: TruncateUnit, tz: string): Instant {
  const w = toWallClock(instant, tz)
  return fromWallClock(
    {
      year: w.year,
      month: unit === 'year' ? 1 : w.month,
      day: unit === 'day' ? w.day : 1,
      hour: 0,
      minute: 0,
      second: 0,
      ms: 0,
    },
    tz,
  )
}

// --- date expressions -------------------------------------------------------------------------

/**
 * A comparison date in a predicate: `today` or `now` plus durations (resolved against the
 * run's frozen clock), or a literal ISO date or instant.
 */
export type DateExpr =
  | {
      readonly kind: 'relative'
      readonly anchor: 'today' | 'now'
      readonly by: readonly Duration[]
    }
  | { readonly kind: 'date'; readonly wall: WallClock }
  | { readonly kind: 'instant'; readonly instant: Instant }

const RELATIVE = /^(today|now)(.*)$/

export function parseDateExpr(text: string): Result<DateExpr, string> {
  const rel = RELATIVE.exec(text)
  if (rel) {
    const anchor = rel[1] as 'today' | 'now'
    if (rel[2] === '') return ok({ kind: 'relative', anchor, by: [] })
    const by = parseDuration(rel[2] as string)
    return by.ok ? ok({ kind: 'relative', anchor, by: by.value }) : by
  }
  const wall = parseWithFormat(text, DATE_ONLY)
  if (wall) return ok({ kind: 'date', wall })
  const instant = Instant.parse(text)
  if (instant) return ok({ kind: 'instant', instant })
  return err(
    `invalid date '${text}', expected 'today+10y', 'now-1d', 'YYYY-MM-DD' or an ISO instant`,
  )
}

/** Whether the expression reads the run clock (fixtures must then pin `now`). */
export function usesClock(expr: DateExpr): boolean {
  return expr.kind === 'relative'
}

export function resolveDateExpr(expr: DateExpr, clock: { now: Instant; tz: string }): Instant {
  switch (expr.kind) {
    case 'instant':
      return expr.instant
    case 'date':
      return fromWallClock(expr.wall, clock.tz)
    case 'relative': {
      const anchor = expr.anchor === 'today' ? truncate(clock.now, 'day', clock.tz) : clock.now
      return shift(anchor, expr.by, clock.tz)
    }
  }
}

// --- formats ------------------------------------------------------------------------------------

/**
 * A date format: `iso`, `epoch_ms`, `epoch_s`, or a pattern of the tokens `YYYY MM DD HH mm ss`
 * with any other characters taken literally.
 */
export type DateFormat =
  | { readonly kind: 'iso' }
  | { readonly kind: 'epoch'; readonly unit: 'ms' | 's' }
  | { readonly kind: 'pattern'; readonly tokens: readonly string[]; readonly regex: RegExp }

const TOKENS = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'] as const
const TOKEN_SPLIT = /(YYYY|MM|DD|HH|mm|ss)/

export function parseDateFormat(text: string): Result<DateFormat, string> {
  if (text === 'iso') return ok({ kind: 'iso' })
  if (text === 'epoch_ms') return ok({ kind: 'epoch', unit: 'ms' })
  if (text === 'epoch_s') return ok({ kind: 'epoch', unit: 's' })
  const tokens = text.split(TOKEN_SPLIT).filter((p) => p !== '')
  const used = tokens.filter((p) => (TOKENS as readonly string[]).includes(p))
  if (used.length === 0) return err(`date format '${text}' has none of ${TOKENS.join(' ')}`)
  if (new Set(used).size !== used.length) return err(`date format '${text}' repeats a token`)
  const source = tokens
    .map((p) => {
      if (p === 'YYYY') return '(\\d{4})'
      if ((TOKENS as readonly string[]).includes(p)) return '(\\d{2})'
      return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return ok({ kind: 'pattern', tokens, regex: new RegExp(`^${source}$`) })
}

/** A format already validated by `parseDateFormat` (e.g. by a params schema). */
export function dateFormat(text: string): DateFormat {
  const format = parseDateFormat(text)
  if (!format.ok) throw new Error(format.error)
  return format.value
}

const DATE_ONLY = parseDateFormat('YYYY-MM-DD')
const DATE_TIME = parseDateFormat('YYYY-MM-DDTHH:mm:ss')

/** Whether a pattern format names a full calendar date (needed to parse, not to format). */
export function hasFullDate(format: DateFormat): boolean {
  return format.kind !== 'pattern' || ['YYYY', 'MM', 'DD'].every((x) => format.tokens.includes(x))
}

function parseWithFormat(text: string, format: Result<DateFormat, string>): WallClock | undefined {
  if (!format.ok || format.value.kind !== 'pattern') return undefined
  const m = format.value.regex.exec(text)
  if (!m) return undefined
  const fields: Record<string, number> = { YYYY: 1970, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0 }
  let group = 1
  for (const token of format.value.tokens) {
    if ((TOKENS as readonly string[]).includes(token)) fields[token] = Number(m[group++])
  }
  const w: WallClock = {
    year: fields.YYYY as number,
    month: fields.MM as number,
    day: fields.DD as number,
    hour: fields.HH as number,
    minute: fields.mm as number,
    second: fields.ss as number,
    ms: 0,
  }
  const valid =
    w.month >= 1 &&
    w.month <= 12 &&
    w.day >= 1 &&
    w.day <= daysInMonth(w.year, w.month) &&
    w.hour <= 23 &&
    w.minute <= 59 &&
    w.second <= 59
  return valid ? w : undefined
}

/**
 * Parse a source value. Pattern and ISO strings without an offset are wall-clock times in
 * `tz`; epoch formats take a number or a numeric string. Undefined when it does not parse.
 */
export function parseDateValue(
  input: string | number,
  format: DateFormat,
  tz: string,
): Instant | undefined {
  if (format.kind === 'epoch') {
    const n = typeof input === 'number' ? input : /^-?\d+$/.test(input) ? Number(input) : Number.NaN
    return Number.isFinite(n) ? Instant.ofEpochMs(format.unit === 's' ? n * 1000 : n) : undefined
  }
  if (typeof input !== 'string') return undefined
  if (format.kind === 'pattern') {
    const w = parseWithFormat(input, ok(format))
    return w && fromWallClock(w, tz)
  }
  const wall = parseWithFormat(input, DATE_ONLY) ?? parseWithFormat(input, DATE_TIME)
  return wall ? fromWallClock(wall, tz) : Instant.parse(input)
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** Format an instant. `iso` is UTC (`...Z`); patterns and epoch formats as named. */
export function formatDate(instant: Instant, format: DateFormat, tz: string): string {
  if (format.kind === 'iso') return instant.toISOString()
  if (format.kind === 'epoch') {
    return String(format.unit === 's' ? Math.floor(instant.epochMs / 1000) : instant.epochMs)
  }
  const w = toWallClock(instant, tz)
  const values: Record<string, string> = {
    YYYY: pad(w.year, 4),
    MM: pad(w.month),
    DD: pad(w.day),
    HH: pad(w.hour),
    mm: pad(w.minute),
    ss: pad(w.second),
  }
  return format.tokens.map((p) => values[p] ?? p).join('')
}

/** `YYYY-MM-DD` of the instant in `tz`, how `date` target fields are written. */
export function toDateString(instant: Instant, tz: string): string {
  const w = toWallClock(instant, tz)
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`
}
