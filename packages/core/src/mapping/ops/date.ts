/**
 * Date ops: `format_date`, `shift_date`, `truncate_date`, `to_utc`. Calendar math happens in
 * the run's frozen time zone unless a `tz` is given.
 */

import { z } from 'zod'
import { ok } from '../result'
import {
  dateFormat,
  duration,
  formatDate,
  type Instant,
  isTimeZone,
  parseDateFormat,
  parseDuration,
  shift,
  truncate,
} from '../time'
import { type MType, t } from '../types'
import { defineOp, expectKind, never, params } from './def'

const dateIn =
  (op: string, out: MType = t.date) =>
  (input: MType) => {
    const s = expectKind(input, ['date'], op)
    return s.ok ? ok(out) : s
  }

export const formatDateOp = defineOp({
  name: 'format_date',
  params: params({
    format: z.string().superRefine((s, ctx) => {
      const f = parseDateFormat(s)
      if (!f.ok) ctx.addIssue({ code: 'custom', message: f.error })
    }),
    tz: z.string().refine(isTimeZone, 'unknown time zone').optional(),
  }),
  nulls: 'propagate',
  fallible: never,
  signature: dateIn('format_date', t.string),
  run: (p) => {
    const format = dateFormat(p.format)
    return (input, ctx) => ok(formatDate(input as Instant, format, p.tz ?? ctx.tz))
  },
})

/** Shift by a duration such as `+10y` or `-30d`. */
export const shiftDate = defineOp({
  name: 'shift_date',
  params: params({
    by: z.string().superRefine((s, ctx) => {
      const d = parseDuration(s)
      if (!d.ok) ctx.addIssue({ code: 'custom', message: d.error })
    }),
  }),
  nulls: 'propagate',
  fallible: never,
  signature: dateIn('shift_date'),
  run: (p) => {
    const by = duration(p.by)
    return (input, ctx) => ok(shift(input as Instant, by, ctx.tz))
  },
})

export const truncateDate = defineOp({
  name: 'truncate_date',
  params: params({ unit: z.enum(['day', 'month', 'year']) }),
  nulls: 'propagate',
  fallible: never,
  signature: dateIn('truncate_date'),
  run: (p) => (input, ctx) => ok(truncate(input as Instant, p.unit, ctx.tz)),
})

/** Instants carry no zone, so this is the identity; kept as an explicit normalisation step. */
export const toUtc = defineOp({
  name: 'to_utc',
  params: params({}),
  nulls: 'propagate',
  fallible: never,
  signature: dateIn('to_utc'),
  run: () => (input) => ok(input),
})
