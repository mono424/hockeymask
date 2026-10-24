/** Type conversion: `to_number`, `to_string`, `to_bool`, `to_date`, `assert_type`. */

import { z } from 'zod'
import { err, ok, stepError } from '../result'
import {
  dateFormat,
  formatDate,
  hasFullDate,
  type Instant,
  isTimeZone,
  parseDateValue,
  parseDateFormat,
} from '../time'
import { assignable, parseTypeName, show, t, typeName } from '../types'
import { toJson, type Val } from '../values'
import { defineOp, expectKind, never, params } from './def'

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

const dateFormatParam = z.string().superRefine((s, ctx) => {
  const f = parseDateFormat(s)
  if (!f.ok) ctx.addIssue({ code: 'custom', message: f.error })
})

const timeZone = z.string().refine(isTimeZone, 'unknown time zone')

/** Parses a number from a string (a boolean gives 1 or 0). Strict raises, else null. */
export const toNumber = defineOp({
  name: 'to_number',
  params: params({ strict: z.boolean().optional() }),
  nulls: 'propagate',
  fallible: (p) => p.strict === true,
  signature: (input, p) => {
    const s = expectKind(input, ['string', 'boolean'], 'to_number')
    if (!s.ok) return s
    return ok(input.kind === 'boolean' || p.strict ? t.number : t.nullable(t.number))
  },
  run: (p) => (input) => {
    if (typeof input === 'boolean') return ok(input ? 1 : 0)
    const text = (input as string).trim()
    if (NUMBER.test(text)) return ok(Number(text))
    return p.strict ? stepError('parse_failed', `'${input as string}' is not a number`) : ok(null)
  },
})

/** Canonical string form. `format` applies to dates, in the run time zone. */
export const toString = defineOp({
  name: 'to_string',
  params: params({ format: dateFormatParam.optional() }),
  nulls: 'propagate',
  fallible: never,
  signature: (input, p) => {
    if (input.kind === 'unknown') return err('to_string needs a known input type')
    if (p.format !== undefined && input.kind !== 'date') {
      return err('to_string format applies to dates only')
    }
    return ok(t.string)
  },
  run: (p, _env, input) => {
    if (input.kind === 'date') {
      const format = dateFormat(p.format ?? 'iso')
      return (v, ctx) => ok(formatDate(v as Instant, format, ctx.tz))
    }
    return (v) => ok(stringify(v))
  },
})

function stringify(v: Val): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(toJson(v))
}

const TRUE_VALUES = ['true', '1']
const FALSE_VALUES = ['false', '0']

/** Explicit truthiness: only the listed values convert, anything else is an error. */
export const toBool = defineOp({
  name: 'to_bool',
  params: params({
    true_values: z.array(z.string()).min(1).optional(),
    false_values: z.array(z.string()).min(1).optional(),
  }).refine(
    (p) =>
      !(p.true_values ?? TRUE_VALUES).some((v) => (p.false_values ?? FALSE_VALUES).includes(v)),
    'true_values and false_values overlap',
  ),
  nulls: 'propagate',
  fallible: () => true,
  signature: (input) => {
    const s = expectKind(input, ['string', 'number'], 'to_bool')
    return s.ok ? ok(t.boolean) : s
  },
  run: (p) => {
    const yes = new Set(p.true_values ?? TRUE_VALUES)
    const no = new Set(p.false_values ?? FALSE_VALUES)
    return (input) => {
      const text = typeof input === 'number' ? String(input) : (input as string).trim()
      if (yes.has(text)) return ok(true)
      if (no.has(text)) return ok(false)
      return stepError('parse_failed', `'${text}' is not a listed boolean value`)
    }
  },
})

/**
 * Parses to an instant: `iso`, `epoch_ms`, `epoch_s`, or a `YYYY MM DD HH mm ss` pattern.
 * Wall-clock values are read in `tz`, by default the run's frozen time zone.
 */
export const toDate = defineOp({
  name: 'to_date',
  params: params({ format: dateFormatParam, tz: timeZone.optional() }).refine((p) => {
    const format = parseDateFormat(p.format)
    return !format.ok || hasFullDate(format.value)
  }, 'to_date format needs YYYY, MM and DD'),
  nulls: 'propagate',
  fallible: () => true,
  signature: (input, p) => {
    const epoch = dateFormat(p.format).kind === 'epoch'
    const s = expectKind(input, epoch ? ['string', 'number'] : ['string'], 'to_date')
    return s.ok ? ok(t.date) : s
  },
  run: (p) => {
    const format = dateFormat(p.format)
    return (input, ctx) => {
      const instant = parseDateValue(input as string | number, format, p.tz ?? ctx.tz)
      return instant
        ? ok(instant)
        : stepError(
            'parse_failed',
            `'${String(input as string | number)}' does not match date format ${p.format}`,
          )
    }
  },
})

/** A runtime no-op and a checkpoint for the validator: the input must have this type. */
export const assertType = defineOp({
  name: 'assert_type',
  params: params({
    type: z.string().superRefine((s, ctx) => {
      const parsed = parseTypeName(s)
      if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error })
    }),
  }),
  nulls: 'propagate',
  fallible: never,
  signature: (input, p) => {
    const declared = typeName(p.type)
    return assignable(input, declared)
      ? ok(declared)
      : err(`expected ${p.type}, got ${show(input)}`)
  },
  run: () => (input) => ok(input),
})
