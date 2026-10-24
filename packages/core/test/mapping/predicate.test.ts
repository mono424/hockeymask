import { describe, expect, it } from 'vite-plus/test'
import {
  compileOperand,
  compilePredicate,
  compileRegex,
  nonNullPaths,
  PREDICATES,
} from '../../src/mapping/predicate'
import { Instant } from '../../src/mapping/time'
import { type MType, show, t } from '../../src/mapping/types'
import type { Rec, Val } from '../../src/mapping/values'
import { env, type PipeOptions, runContext } from './helpers'

const day = (iso: string) => Instant.parse(`${iso}T00:00:00Z`) as Instant

const fields = {
  n: t.nullable(t.number),
  s: t.nullable(t.string),
  b: t.boolean,
  d: t.nullable(t.date),
  tags: t.nullable(t.list(t.string)),
  other: t.nullable(t.number),
  u: t.unknown,
}

type Options = PipeOptions & { piped?: MType }

function compileWith(cond: unknown, options: Options = {}) {
  const e = env({ fields, ...options })
  return { result: compilePredicate(cond, e, options.piped), env: e }
}

/** Compile a condition and return `(piped, record) => boolean`, or throw its error. */
function pred(cond: unknown, options: Options = {}) {
  const { result } = compileWith(cond, options)
  if (!result.ok) throw new Error(result.error)
  const test = result.value
  return (piped: Val, record: Rec = {}, ctx = runContext()) => test(piped, record, ctx)
}

function predError(cond: unknown, options: Options = {}): string {
  const { result } = compileWith(cond, options)
  if (result.ok) throw new Error('expected an error')
  return result.error
}

const piped = (type: MType) => ({ piped: type })

describe('condition shape', () => {
  it.each([
    [null, 'a condition must be an object'],
    [[{ eq: 1 }], 'a condition must be an object'],
    ['eq', 'a condition must be an object'],
    [{}, 'exactly one predicate, got none'],
    [{ path: 'n' }, 'exactly one predicate, got none'],
    [{ eq: 1, lt: 2 }, 'exactly one predicate, got eq, lt'],
    [{ equals: 1 }, "unknown predicate 'equals'"],
  ])('%j is rejected', (cond, message) => {
    expect(predError(cond, piped(t.number))).toContain(message)
  })

  it('lists every predicate name', () => {
    expect(PREDICATES).toEqual([
      'eq',
      'neq',
      'lt',
      'lte',
      'gt',
      'gte',
      'before',
      'after',
      'in',
      'not_in',
      'matches',
      'is_null',
      'is_blank',
      'all',
      'any',
      'not',
    ])
  })
})

describe('subject', () => {
  it('tests the piped value without a path', () => {
    expect(pred({ eq: 1 }, piped(t.number))(1)).toBe(true)
  })

  it('tests a record field with a path, reading a missing field as null', () => {
    const test = pred({ path: 'n', eq: 1 })
    expect(test(null, { n: 1 })).toBe(true)
    expect(test(null, {})).toBe(false)
  })

  it.each([
    [{ eq: 1 }, undefined, 'no piped value to test'],
    [{ eq: 1 }, t.unit, 'no piped value to test'],
    [{ path: 5, eq: 1 }, t.number, 'path must be a field name'],
    [{ path: 'nope', eq: 1 }, t.number, "unknown field 'nope'"],
  ])('%j with piped %j is rejected', (cond, type, message) => {
    expect(predError(cond, { piped: type })).toContain(message)
  })

  it('names the fields of an empty record', () => {
    const e = env({})
    const r = compilePredicate({ path: 'x', eq: 1 }, e)
    expect(r.ok ? '' : r.error).toContain('no fields')
  })
})

describe('eq / neq', () => {
  const eq = pred({ eq: 2 }, piped(t.nullable(t.number)))
  const neq = pred({ neq: 2 }, piped(t.nullable(t.number)))

  it.each([
    [2, true, false],
    [3, false, true],
    [null, false, true],
  ])('%j: eq %j, neq %j', (value, isEq, isNeq) => {
    expect(eq(value)).toBe(isEq)
    expect(neq(value)).toBe(isNeq)
  })

  it('compares booleans and lists', () => {
    expect(pred({ eq: true }, piped(t.boolean))(true)).toBe(true)
    expect(pred({ path: 'tags', eq: ['a'] })(null, { tags: ['a'] })).toBe(true)
  })

  it('compares a date with a date literal', () => {
    expect(pred({ eq: '2026-01-01' }, piped(t.date))(day('2026-01-01'))).toBe(true)
  })

  it.each([
    [{ eq: null }, "'eq' cannot compare with null; use is_null"],
    [{ eq: 'x' }, 'cannot compare number? with string'],
    [{ neq: { ref: 'b' } }, 'cannot compare number? with boolean'],
  ])('%j is rejected', (cond, message) => {
    expect(predError(cond, piped(t.nullable(t.number)))).toContain(message)
  })
})

describe('lt / lte / gt / gte', () => {
  it.each([
    ['lt', 1, true],
    ['lt', 2, false],
    ['lte', 2, true],
    ['lte', 3, false],
    ['gt', 3, true],
    ['gt', 2, false],
    ['gte', 2, true],
    ['gte', 1, false],
  ])('%s 2 on %j is %j', (name, value, expected) => {
    expect(pred({ [name]: 2 }, piped(t.number))(value)).toBe(expected)
  })

  it('is false for null on either side', () => {
    expect(pred({ lt: 2 }, piped(t.nullable(t.number)))(null)).toBe(false)
    expect(pred({ lt: { ref: 'other' } }, piped(t.number))(1, { other: null })).toBe(false)
  })

  it('orders strings by code unit and dates by instant', () => {
    expect(pred({ lt: 'b' }, piped(t.string))('B')).toBe(true)
    expect(pred({ lt: '2026-01-01' }, piped(t.date))(day('2025-12-31'))).toBe(true)
  })

  it('accepts an unknown subject', () => {
    expect(pred({ path: 'u', gt: 1 })(null, { u: 2 })).toBe(true)
  })

  it('rejects unorderable subjects', () => {
    expect(predError({ lt: true }, piped(t.boolean))).toBe(
      "'lt' applies to numbers, strings and dates, not boolean",
    )
  })
})

describe('before / after', () => {
  const after = pred({ after: 'today+10y' }, piped(t.nullable(t.date)))

  it('resolves relative dates against the run clock (now 2026-10-04)', () => {
    expect(after(day('2036-10-05'))).toBe(true)
    expect(after(day('2036-10-04'))).toBe(false)
    expect(after(null)).toBe(false)
  })

  it('re-resolves when the clock or time zone changes, and caches otherwise', () => {
    const now = Instant.parse('2030-01-01T00:00:00Z') as Instant
    expect(after(day('2036-10-05'), {}, runContext({ now }))).toBe(false)
    expect(after(day('2040-01-02'), {}, runContext({ now }))).toBe(true)
    expect(after(day('2040-01-01'), {}, runContext({ now }))).toBe(false)
  })

  it.each([
    [{ before: '2026-01-01' }, day('2025-12-31'), true],
    [{ before: '2026-01-01T00:00:00Z' }, day('2026-01-01'), false],
    [{ after: 'now' }, Instant.parse('2026-10-04T12:00:01Z'), true],
    [{ after: 'now-1d' }, day('2026-10-04'), true],
  ])('%j on %s is %j', (cond, value, expected) => {
    expect(pred(cond, piped(t.date))(value as Instant)).toBe(expected)
  })

  it('compares with a date field or a date param', () => {
    expect(
      pred({ before: { ref: 'd' } }, piped(t.date))(day('2020-01-01'), { d: day('2021-01-01') }),
    ).toBe(true)
    const cutoff = pred(
      { after: { param: 'cutoff' } },
      { ...piped(t.date), params: { cutoff: '2026-01-01' } },
    )
    expect(cutoff(day('2026-06-01'))).toBe(true)
  })

  it('flags the clock only for relative dates', () => {
    expect(compileWith({ after: 'today' }, piped(t.date)).env.clock.used).toBe(true)
    expect(compileWith({ after: '2026-01-01' }, piped(t.date)).env.clock.used).toBe(false)
  })

  it('accepts an unknown subject', () => {
    expect(pred({ path: 'u', before: '2026-01-01' })(null, { u: day('2025-01-01') })).toBe(true)
  })

  it.each([
    [{ before: '2026-01-01' }, t.string, "'before' applies to dates, not string"],
    [{ after: 'yesterday' }, t.date, "invalid date 'yesterday'"],
    [{ after: 'today+1x' }, t.date, "invalid duration '+1x'"],
    [{ after: 5 }, t.date, 'cannot compare date with number'],
  ])('%j on %s is rejected', (cond, type, message) => {
    expect(predError(cond, piped(type))).toContain(message)
  })
})

describe('in / not_in', () => {
  const isIn = pred({ in: ['a', 'b'] }, piped(t.nullable(t.string)))
  const notIn = pred({ not_in: ['a', 'b'] }, piped(t.nullable(t.string)))

  it.each([
    ['a', true, false],
    ['c', false, true],
    [null, false, true],
  ])('%j: in %j, not_in %j', (value, a, b) => {
    expect(isIn(value)).toBe(a)
    expect(notIn(value)).toBe(b)
  })

  it('never matches a null element', () => {
    expect(pred({ in: ['a', null] }, piped(t.string))('a')).toBe(true)
    expect(pred({ path: 'tags', in: [null] })(null, { tags: null })).toBe(false)
  })

  it('reads the list from a field or a param', () => {
    const inField = pred({ in: { ref: 'tags' } }, piped(t.string))
    expect(inField('x', { tags: ['x'] })).toBe(true)
    expect(inField('x', { tags: null })).toBe(false)
    const known = pred(
      { not_in: { param: 'modes' } },
      { ...piped(t.string), params: { modes: ['pickup'] } },
    )
    expect(known('ship')).toBe(true)
  })

  it('takes date expressions for a date subject', () => {
    const e = compileWith({ in: ['2026-01-01', 'today'] }, piped(t.date))
    expect(e.env.clock.used).toBe(true)
    expect(pred({ in: ['2026-01-01', 'today'] }, piped(t.date))(day('2026-10-04'))).toBe(true)
    expect(pred({ in: ['2026-01-01'] }, piped(t.date))(day('2026-10-04'))).toBe(false)
  })

  it.each([
    [{ in: 'a' }, t.string, "'in' takes a list, got string"],
    [{ in: [1] }, t.string, 'cannot test string for membership in list<number>'],
    [{ in: [1] }, t.date, 'cannot test date for membership in list<number>'],
    [{ in: ['soon'] }, t.date, "invalid date 'soon'"],
    [{ not_in: { param: 'nope' } }, t.string, "unknown param 'nope'"],
  ])('%j on %s is rejected', (cond, type, message) => {
    expect(predError(cond, piped(type))).toContain(message)
  })
})

describe('matches', () => {
  const test = pred({ matches: '^\\d{8}$' }, piped(t.nullable(t.string)))

  it.each([
    ['12345678', true],
    ['1234', false],
    [null, false],
  ])('%j is %j', (value, expected) => {
    expect(test(value)).toBe(expected)
  })

  it('is false for a non-string unknown value', () => {
    expect(pred({ path: 'u', matches: '1' })(null, { u: 1 })).toBe(false)
  })

  it.each([
    [{ matches: 5 }, t.string, 'matches takes a regular expression string'],
    [{ matches: 'a' }, t.number, 'matches applies to strings, not number'],
    [{ matches: '(' }, t.string, 'invalid regular expression'],
  ])('%j on %s is rejected', (cond, type, message) => {
    expect(predError(cond, piped(type))).toContain(message)
  })
})

describe('is_null / is_blank', () => {
  it.each([
    [{ is_null: true }, null, true],
    [{ is_null: true }, '', false],
    [{ is_null: false }, 'x', true],
    [{ is_blank: true }, null, true],
    [{ is_blank: true }, '  ', true],
    [{ is_blank: true }, 'x', false],
    [{ is_blank: false }, 'x', true],
  ])('%j on %j is %j', (cond, value, expected) => {
    expect(pred(cond, piped(t.nullable(t.string)))(value)).toBe(expected)
  })

  it('is_blank accepts an unknown subject and is false for non-strings', () => {
    expect(pred({ path: 'u', is_blank: true })(null, { u: 0 })).toBe(false)
  })

  it.each([
    [{ is_null: 'yes' }, t.string, "'is_null' takes true or false"],
    [{ is_blank: true }, t.number, 'is_blank applies to strings, not number'],
  ])('%j on %s is rejected', (cond, type, message) => {
    expect(predError(cond, piped(type))).toBe(message)
  })
})

describe('all / any / not', () => {
  const all = pred({ all: { of: [{ gt: 0 }, { lt: 10 }] } }, piped(t.number))
  const any = pred({ any: { of: [{ lt: 0 }, { gt: 10 }] } }, piped(t.number))
  const not = pred({ not: { eq: 1 } }, piped(t.number))

  it.each([
    [5, true, false, true],
    [-1, false, true, true],
    [1, true, false, false],
  ])('%j: all %j, any %j, not %j', (value, a, b, c) => {
    expect(all(value)).toBe(a)
    expect(any(value)).toBe(b)
    expect(not(value)).toBe(c)
  })

  it('treats empty lists as vacuous', () => {
    expect(pred({ all: { of: [] } }, piped(t.number))(1)).toBe(true)
    expect(pred({ any: { of: [] } }, piped(t.number))(1)).toBe(false)
  })

  it.each([
    [{ path: 'n', all: { of: [] } }, "'all' does not take a path; put paths on its conditions"],
    [{ all: [{ eq: 1 }] }, `'all' takes { "of": [conditions] }`],
    [{ any: null }, `'any' takes { "of": [conditions] }`],
    [{ any: 5 }, `'any' takes { "of": [conditions] }`],
    [{ all: { of: [], extra: 1 } }, `'all' takes { "of": [conditions] }`],
    [{ all: { of: 'x' } }, `'all' takes { "of": [conditions] }`],
    [{ all: { of: [{ eq: 1 }, { eq: 'x' }] } }, 'all.of[1]: cannot compare number with string'],
    [{ not: { eq: 'x' } }, 'cannot compare number with string'],
  ])('%j is rejected', (cond, message) => {
    expect(predError(cond, piped(t.number))).toBe(message)
  })
})

describe('operands', () => {
  const operand = (value: unknown, options: Options = {}, asDate = false) =>
    compileOperand(value, env({ fields, ...options }), asDate)

  it('types a literal, a ref and a param', () => {
    const types = [
      operand(1),
      operand({ ref: 's' }),
      operand({ param: 'p' }, { params: { p: ['a'] } }),
      operand('2026-01-01', {}, true),
    ].map((r) => (r.ok ? show(r.value.type) : r.error))
    expect(types).toEqual(['number', 'string?', 'list<string>', 'date'])
  })

  it('reads a ref from the record', () => {
    const r = operand({ ref: 's' })
    expect(r.ok && r.value.get(null, { s: 'x' }, runContext())).toBe('x')
    expect(r.ok && r.value.get(null, {}, runContext())).toBe(null)
  })

  it.each([
    [{ ref: 'nope' }, "unknown field 'nope'"],
    [{ ref: 1 }, 'a comparison value is a literal'],
    [{ param: 'p', ref: 's' }, 'a comparison value is a literal'],
    [{ other: 1 }, 'a comparison value is a literal'],
  ])('%j is rejected', (value, message) => {
    const r = operand(value)
    expect(r.ok ? '' : r.error).toContain(message)
  })

  it('treats a non-string array as an ordinary literal for dates', () => {
    const r = operand([1, 2], {}, true)
    expect(r.ok && show(r.value.type)).toBe('list<number>')
  })
})

describe('compileRegex', () => {
  it('compiles in unicode mode or reports the error', () => {
    expect(compileRegex('^a$').ok).toBe(true)
    const bad = compileRegex('[')
    expect(bad.ok ? '' : bad.error).toContain('invalid regular expression')
  })
})

describe('nonNullPaths', () => {
  it.each([
    [null, []],
    ['x', []],
    [{ path: 'a', is_null: false }, ['a']],
    [{ path: 'a', is_null: true }, []],
    [{ is_null: false }, []],
    [{ path: 'a', eq: 1 }, []],
    [
      { all: { of: [{ path: 'a', is_null: false }, { path: 'b', is_null: false }, { eq: 1 }] } },
      ['a', 'b'],
    ],
    [{ all: { of: 'x' } }, []],
    [{ any: { of: [{ path: 'a', is_null: false }] } }, []],
  ])('%j narrows %j', (cond, paths) => {
    expect(nonNullPaths(cond)).toEqual(paths)
  })
})
