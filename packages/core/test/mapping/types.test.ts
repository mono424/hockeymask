import { describe, expect, it } from 'vite-plus/test'
import {
  assignable,
  comparable,
  equalTypes,
  fromLogicalType,
  isNullable,
  mayBeNull,
  nullableIf,
  orderable,
  parseTypeName,
  show,
  stripNull,
  t,
  typeName,
  typeOfJson,
  unify,
  unifyAll,
} from '../../src/mapping/types'

describe('constructors and helpers', () => {
  it('nullable flattens', () => {
    expect(t.nullable(t.nullable(t.string))).toEqual(t.nullable(t.string))
    expect(isNullable(t.nullable(t.string))).toBe(true)
    expect(stripNull(t.nullable(t.number))).toEqual(t.number)
    expect(stripNull(t.number)).toEqual(t.number)
    expect(nullableIf(t.number, false)).toEqual(t.number)
    expect(nullableIf(t.number, true)).toEqual(t.nullable(t.number))
  })

  it('mayBeNull covers nullable and unknown', () => {
    expect(mayBeNull(t.nullable(t.string))).toBe(true)
    expect(mayBeNull(t.unknown)).toBe(true)
    expect(mayBeNull(t.string)).toBe(false)
  })

  it.each([
    [t.null, 'null'],
    [t.nullable(t.number), 'number?'],
    [t.list(t.nullable(t.string)), 'list<string?>'],
    [t.tuple([t.number, t.string]), '(number, string)'],
    [t.record({ a: t.number, b: t.date }), '{ a: number, b: date }'],
    [t.unit, '()'],
    [t.unknown, 'unknown'],
    [t.never, 'never'],
  ])('show %j = %s', (type, text) => {
    expect(show(type)).toBe(text)
  })

  it('equalTypes compares structure', () => {
    expect(equalTypes(t.list(t.number), t.list(t.number))).toBe(true)
    expect(equalTypes(t.list(t.number), t.list(t.string))).toBe(false)
  })
})

describe('assignable', () => {
  it.each([
    [t.string, t.string, true],
    [t.string, t.number, false],
    [t.string, t.unknown, true],
    [t.never, t.number, true],
    [t.null, t.nullable(t.number), true],
    [t.string, t.nullable(t.string), true],
    [t.nullable(t.string), t.string, false],
    [t.list(t.number), t.list(t.nullable(t.number)), true],
    [t.list(t.number), t.string, false],
    [t.tuple([t.number, t.string]), t.tuple([t.number, t.string]), true],
    [t.tuple([t.number]), t.tuple([t.number, t.string]), false],
    [t.tuple([t.number]), t.list(t.number), false],
    [t.record({ a: t.number, b: t.string }), t.record({ a: t.number }), true],
    [t.record({ a: t.number }), t.record({ a: t.number, b: t.string }), false],
    [t.record({ a: t.string }), t.record({ a: t.number }), false],
    [t.record({ a: t.string }), t.string, false],
  ])('%j -> %j: %s', (from, to, expected) => {
    expect(assignable(from, to)).toBe(expected)
  })
})

describe('comparable and orderable', () => {
  it.each([
    [t.string, t.nullable(t.string), true],
    [t.string, t.number, false],
    [t.unknown, t.number, true],
    [t.number, t.never, true],
    [t.list(t.string), t.list(t.string), true],
    [t.list(t.string), t.list(t.number), false],
    [t.record({}), t.record({}), false],
  ])('comparable %j %j: %s', (a, b, expected) => {
    expect(comparable(a, b)).toBe(expected)
  })

  it('orders numbers, strings and dates only', () => {
    expect(
      [t.number, t.nullable(t.date), t.string, t.boolean, t.list(t.number)].map(orderable),
    ).toEqual([true, true, true, false, false])
  })
})

describe('unify', () => {
  it.each([
    [t.number, t.nullable(t.number), 'number?'],
    [t.never, t.string, 'string'],
    [t.null, t.string, 'string?'],
    [t.string, t.never, 'string'],
    [t.unknown, t.string, 'unknown'],
    [t.list(t.never), t.list(t.string), 'list<string>'],
    [t.tuple([t.number, t.null]), t.tuple([t.nullable(t.number), t.string]), '(number?, string?)'],
    [t.record({ a: t.number }), t.record({ a: t.null }), '{ a: number? }'],
  ])('%j with %j = %s', (a, b, expected) => {
    const u = unify(a, b)
    expect(u.ok && show(u.value)).toBe(expected)
  })

  it.each([
    [t.number, t.string],
    [t.list(t.number), t.list(t.string)],
    [t.tuple([t.number]), t.tuple([t.number, t.number])],
    [t.tuple([t.number]), t.tuple([t.string])],
    [t.record({ a: t.number }), t.record({ a: t.number, b: t.number })],
    [t.record({ a: t.number }), t.record({ b: t.number })],
    [t.record({ a: t.number }), t.record({ a: t.string })],
  ])('%j and %j do not unify', (a, b) => {
    const u = unify(a, b)
    expect(u.ok ? '' : u.error).toContain('have no common type')
  })

  it('unifyAll folds left to right', () => {
    const all = unifyAll([t.number, t.null, t.number])
    expect(all.ok && show(all.value)).toBe('number?')
    expect(unifyAll([]).ok && show((unifyAll([]) as { value: typeof t.never }).value)).toBe('never')
    expect(unifyAll([t.number, t.string]).ok).toBe(false)
  })
})

describe('typeOfJson and fromLogicalType', () => {
  it.each([
    [null, 'null'],
    ['x', 'string'],
    [1, 'number'],
    [false, 'boolean'],
    [[], 'list<never>'],
    [[1, null], 'list<number?>'],
    [[1, 'x'], 'list<unknown>'],
    [{ a: [true] }, '{ a: list<boolean> }'],
    [undefined, 'unknown'],
  ])('%j is %s', (value, expected) => {
    expect(show(typeOfJson(value))).toBe(expected)
  })

  it.each([
    ['string', 'string'],
    ['integer', 'number'],
    ['decimal', 'number'],
    ['boolean', 'boolean'],
    ['date', 'date'],
    ['timestamp', 'date'],
    ['reference', 'unknown'],
    ['unknown', 'unknown'],
  ] as const)('logical %s is %s', (logical, expected) => {
    expect(show(fromLogicalType(logical))).toBe(expected)
  })
})

describe('parseTypeName', () => {
  it.each([
    ['string', 'string'],
    ['number?', 'number?'],
    ['boolean', 'boolean'],
    ['date', 'date'],
    ['list<number?>', 'list<number?>'],
    [' list< string > ?', 'list<string>?'],
  ])('%s', (text, expected) => {
    expect(show(typeName(text))).toBe(expected)
  })

  it.each(['text', 'string??', 'list<>', 'list<text>', 'list<number'])('rejects %s', (text) => {
    expect(parseTypeName(text)).toEqual({ ok: false, error: `unknown type '${text}'` })
  })

  it('typeName throws on an invalid name', () => {
    expect(() => typeName('text')).toThrow("unknown type 'text'")
  })
})
