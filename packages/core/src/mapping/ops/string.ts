/**
 * String ops: `trim`, `lower`, `upper`, `truncate`, `pad`, `replace`, `regex_extract`,
 * `split`, `join`, `concat`, `slug`. Lengths count code points, not UTF-16 units.
 */

import { z } from 'zod'
import { compileRegex } from '../predicate'
import { err, ok } from '../result'
import { type MType, show, stripNull, t } from '../types'
import type { Val } from '../values'
import { defineOp, expectKind, never, params } from './def'

const stringIn = (op: string) => (input: MType) => {
  const s = expectKind(input, ['string'], op)
  return s.ok ? ok(t.string) : s
}

const regex = z.string().superRefine((s, ctx) => {
  const r = compileRegex(s)
  if (!r.ok) ctx.addIssue({ code: 'custom', message: r.error })
})

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const trim = defineOp({
  name: 'trim',
  params: params({ chars: z.string().min(1).optional() }),
  nulls: 'propagate',
  fallible: never,
  signature: stringIn('trim'),
  run: (p) => {
    if (p.chars === undefined) return (input) => ok((input as string).trim())
    const set = `[${p.chars.replace(/[\\\]^-]/g, '\\$&')}]+`
    const edges = new RegExp(`^${set}|${set}$`, 'gu')
    return (input) => ok((input as string).replace(edges, ''))
  },
})

export const lower = defineOp({
  name: 'lower',
  params: params({}),
  nulls: 'propagate',
  fallible: never,
  signature: stringIn('lower'),
  run: () => (input) => ok((input as string).toLowerCase()),
})

export const upper = defineOp({
  name: 'upper',
  params: params({}),
  nulls: 'propagate',
  fallible: never,
  signature: stringIn('upper'),
  run: () => (input) => ok((input as string).toUpperCase()),
})

/** Lossy, no inverse. With `ellipsis` the result, ellipsis included, fits `length`. */
export const truncate = defineOp({
  name: 'truncate',
  params: params({ length: z.number().int().min(0), ellipsis: z.boolean().optional() }).refine(
    (p) => !p.ellipsis || p.length >= 1,
    'truncate with ellipsis needs length >= 1',
  ),
  nulls: 'propagate',
  fallible: never,
  signature: stringIn('truncate'),
  run: (p) => (input) => {
    const chars = Array.from(input as string)
    if (chars.length <= p.length) return ok(input)
    return ok(
      p.ellipsis ? `${chars.slice(0, p.length - 1).join('')}…` : chars.slice(0, p.length).join(''),
    )
  },
})

/** Fixed-width codes, zero-padded SKUs. Strings already as long are unchanged. */
export const pad = defineOp({
  name: 'pad',
  params: params({
    length: z.number().int().min(1),
    with: z.string().min(1),
    side: z.enum(['left', 'right']),
  }),
  nulls: 'propagate',
  fallible: never,
  signature: stringIn('pad'),
  run: (p) => (input) => {
    const s = input as string
    return ok(p.side === 'left' ? s.padStart(p.length, p.with) : s.padEnd(p.length, p.with))
  },
})

/** Replace every occurrence; `regex: true` treats `pattern` as a regular expression. */
export const replace = defineOp({
  name: 'replace',
  params: params({
    pattern: z.string().min(1),
    with: z.string(),
    regex: z.boolean().optional(),
  }).superRefine((p, ctx) => {
    if (!p.regex || typeof p.pattern !== 'string') return
    const r = compileRegex(p.pattern)
    if (!r.ok) ctx.addIssue({ code: 'custom', path: ['pattern'], message: r.error })
  }),
  nulls: 'propagate',
  fallible: never,
  signature: stringIn('replace'),
  run: (p) => {
    const pattern = new RegExp(p.regex ? p.pattern : escapeRegex(p.pattern), 'gu')
    // Literal replacement: `$` in `with` has no special meaning.
    return (input) => ok((input as string).replace(pattern, () => p.with))
  },
})

function groupCount(pattern: string): number {
  return (new RegExp(`${pattern}|`, 'u').exec('') as RegExpExecArray).length - 1
}

/** The match (or capture `group`) of the first match; no match gives null. */
export const regexExtract = defineOp({
  name: 'regex_extract',
  params: params({ pattern: regex, group: z.number().int().min(0).optional() }).refine(
    (p) => !compileRegex(p.pattern).ok || (p.group ?? 0) <= groupCount(p.pattern),
    'group is larger than the number of capture groups',
  ),
  nulls: 'propagate',
  fallible: never,
  signature: (input) => {
    const s = expectKind(input, ['string'], 'regex_extract')
    return s.ok ? ok(t.nullable(t.string)) : s
  },
  run: (p) => {
    const re = new RegExp(p.pattern, 'u')
    const group = p.group ?? 0
    return (input) => ok(re.exec(input as string)?.[group] ?? null)
  },
})

/** Split on a separator. With `limit`, at most that many parts; the last keeps the rest. */
export const split = defineOp({
  name: 'split',
  params: params({ separator: z.string().min(1), limit: z.number().int().min(1).optional() }),
  nulls: 'propagate',
  fallible: never,
  signature: (input) => {
    const s = expectKind(input, ['string'], 'split')
    return s.ok ? ok(t.list(t.string)) : s
  },
  run: (p) => (input) => {
    const parts = (input as string).split(p.separator)
    if (p.limit === undefined || parts.length <= p.limit) return ok(parts)
    return ok([...parts.slice(0, p.limit - 1), parts.slice(p.limit - 1).join(p.separator)])
  },
})

/** String join of a list; null elements are skipped. Unrelated to the `join` node. */
export const join = defineOp({
  name: 'join',
  params: params({ separator: z.string() }),
  nulls: 'propagate',
  fallible: never,
  signature: (input) => {
    if (input.kind !== 'list' || stripNull(input.of).kind !== 'string') {
      return err(`join expects list<string>, got ${show(input)}`)
    }
    return ok(t.string)
  },
  run: (p) => (input) =>
    ok((input as readonly (string | null)[]).filter((x) => x !== null).join(p.separator)),
})

const SCALAR = new Set(['string', 'number', 'boolean'])

/** Join the parts of a multi-path `extract`; null parts are skipped. */
export const concat = defineOp({
  name: 'concat',
  params: params({ separator: z.string().optional() }),
  nulls: 'propagate',
  fallible: never,
  signature: (input) => {
    if (input.kind !== 'tuple' || !input.of.every((x) => SCALAR.has(stripNull(x).kind))) {
      return err(`concat expects a tuple of strings, numbers or booleans, got ${show(input)}`)
    }
    return ok(t.string)
  },
  run: (p) => (input) =>
    ok(
      (input as readonly Val[])
        .filter((x) => x !== null)
        .map((x) => String(x as string | number | boolean))
        .join(p.separator ?? ''),
    ),
})

/** URL-safe form: ASCII letters and digits, lowercase, runs of anything else to `separator`. */
export const slug = defineOp({
  name: 'slug',
  params: params({ separator: z.string().min(1).optional() }),
  nulls: 'propagate',
  fallible: never,
  signature: stringIn('slug'),
  run: (p) => {
    const sep = p.separator ?? '-'
    return (input) =>
      ok(
        (input as string)
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((x) => x !== '')
          .join(sep),
      )
  },
})
