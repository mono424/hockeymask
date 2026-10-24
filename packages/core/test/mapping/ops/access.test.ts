import { describe, expect, it } from 'vite-plus/test'
import { coalesce, constant, extract } from '../../../src/mapping/ops/access'
import { t } from '../../../src/mapping/types'
import { compile, compileError, env, evaluate, typeOf } from '../helpers'

const fields = {
  a: t.string,
  b: t.nullable(t.number),
  c: t.nullable(t.string),
  d: t.nullable(t.string),
}

describe('extract', () => {
  it('reads one field with its declared type', () => {
    expect(typeOf([{ op: 'extract', path: 'a' }], { fields })).toBe('string')
    expect(evaluate([{ op: 'extract', path: 'a' }], { a: 'x' }, { fields })).toBe('x')
  })

  it('reads a missing key as null', () => {
    expect(evaluate([{ op: 'extract', path: 'b' }], {}, { fields })).toBeNull()
  })

  it('reads a tuple of fields', () => {
    const steps = [{ op: 'extract', path: ['a', 'b'] }]
    expect(typeOf(steps, { fields })).toBe('(string, number?)')
    expect(evaluate(steps, { a: 'x' }, { fields })).toEqual(['x', null])
  })

  it.each([
    [{ path: 'zzz' }, "unknown field 'zzz'"],
    [{ path: ['a', 'zzz'] }, "unknown field 'zzz'"],
    [{ path: '' }, 'path'],
    [{ path: [] }, 'path'],
    [{ path: 'a', extra: 1 }, 'extra'],
  ])('rejects %j', (params, message) => {
    expect(compileError([{ op: 'extract', ...params }], { fields })).toContain(message)
  })

  it('starts a pipeline and cannot follow a step', () => {
    expect(
      compileError(
        [
          { op: 'const', value: 1 },
          { op: 'extract', path: 'a' },
        ],
        { fields },
      ),
    ).toContain('starts a pipeline')
  })

  it('is infallible and consumes null', () => {
    expect(extract.fallible({ path: 'a' }, env(), t.unit)).toBe(false)
    expect(extract.nulls).toBe('consume')
  })
})

describe('const', () => {
  it.each([
    ['x', 'string'],
    [2, 'number'],
    [true, 'boolean'],
    [null, 'null'],
    [[1, 2], 'list<number>'],
    [{ k: 'v' }, '{ k: string }'],
  ])('%j has type %s', (value, type) => {
    expect(typeOf([{ op: 'const', value }])).toBe(type)
    expect(evaluate([{ op: 'const', value }])).toEqual(value)
  })

  it('needs a value', () => {
    expect(compileError([{ op: 'const' }])).toContain('const')
  })

  it('is infallible', () => {
    expect(constant.fallible({ value: 1 }, env(), t.unit)).toBe(false)
  })
})

describe('coalesce', () => {
  it('is nullable only when every field is', () => {
    expect(typeOf([{ op: 'coalesce', paths: ['c', 'd'] }], { fields })).toBe('string?')
    expect(typeOf([{ op: 'coalesce', paths: ['c', 'a'] }], { fields })).toBe('string')
  })

  it('returns the first non-null field', () => {
    const steps = [{ op: 'coalesce', paths: ['c', 'd'] }]
    expect(evaluate(steps, { c: null, d: 'y' }, { fields })).toBe('y')
    expect(evaluate(steps, { c: 'x', d: 'y' }, { fields })).toBe('x')
    expect(evaluate(steps, {}, { fields })).toBeNull()
  })

  it.each([
    [{ paths: ['a', 'zzz'] }, "unknown field 'zzz'"],
    [{ paths: ['a', 'b'] }, 'no common type'],
    [{ paths: ['a'] }, 'paths'],
  ])('rejects %j', (params, message) => {
    expect(compileError([{ op: 'coalesce', ...params }], { fields })).toContain(message)
  })

  it('is infallible', () => {
    expect(coalesce.fallible({ paths: ['a', 'b'] }, env(), t.unit)).toBe(false)
    expect(compile([{ op: 'coalesce', paths: ['c', 'd'] }], { fields }).fallible).toBe(false)
  })
})
