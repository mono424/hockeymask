import { describe, expect, it } from 'vite-plus/test'
import { t } from '../../../src/mapping/types'
import { compile, compileError, evaluate, evaluateError, typeOf } from '../helpers'

const tables = {
  status: { '1': 'Draft', '2': 'Active', '3': 'Retired' },
  flags: { true: 1, false: 0 },
  codes: { A: 'alpha', B: 'beta' },
  mixed: { a: 1, b: 'x' },
  empty: {},
}
const fields = { code: t.nullable(t.string), n: t.number, b: t.boolean, l: t.list(t.string) }
const steps = (path: string, params: object) => [
  { op: 'extract', path },
  { op: 'lookup', ...params },
]
const opts = { fields, tables }

describe('lookup', () => {
  it('translates through the table, by the string form of the key', () => {
    expect(evaluate(steps('code', { table: 'status' }), { code: '2' }, opts)).toBe('Active')
    expect(evaluate(steps('n', { table: 'status' }), { n: 3 }, opts)).toBe('Retired')
    expect(evaluate(steps('b', { table: 'flags' }), { b: true }, opts)).toBe(1)
  })

  it('propagates null', () => {
    expect(evaluate(steps('code', { table: 'status' }), { code: null }, opts)).toBeNull()
  })

  it('on_miss null (default) yields null and a nullable type', () => {
    expect(typeOf(steps('code', { table: 'status' }), opts)).toBe('string?')
    expect(evaluate(steps('code', { table: 'status' }), { code: '9' }, opts)).toBeNull()
    expect(
      evaluate(steps('code', { table: 'status', on_miss: 'null' }), { code: '9' }, opts),
    ).toBeNull()
    expect(compile(steps('code', { table: 'status' }), opts).fallible).toBe(false)
  })

  it('on_miss error raises lookup_miss and keeps the type non-null', () => {
    const s = steps('n', { table: 'status', on_miss: 'error' })
    expect(typeOf(s, opts)).toBe('string')
    expect(compile(s, opts).fallible).toBe(true)
    expect(evaluateError(s, { n: 9 }, opts)).toMatchObject({
      code: 'lookup_miss',
      detail: "'9' is not in table 'status'",
    })
  })

  it('on_miss pass forwards the input', () => {
    const s = steps('code', { table: 'codes', on_miss: 'pass' })
    expect(typeOf(s, opts)).toBe('string?')
    expect(evaluate(s, { code: 'A' }, opts)).toBe('alpha')
    expect(evaluate(s, { code: 'Z' }, opts)).toBe('Z')
    expect(compileError(steps('n', { table: 'codes', on_miss: 'pass' }), opts)).toContain(
      'on_miss "pass" forwards number, but the table yields string',
    )
  })

  it('types an empty table as null', () => {
    expect(typeOf(steps('code', { table: 'empty' }), opts)).toBe('null')
  })

  it.each([
    [
      steps('l', { table: 'codes' }),
      'lookup expects a string, number or boolean, got list<string>',
    ],
    [steps('code', { table: 'nope' }), "unknown lookup table 'nope'"],
    [steps('code', { table: 'mixed' }), "lookup table 'mixed' mixes value types"],
    [steps('code', { table: 'codes', on_miss: 'skip' }), 'on_miss'],
    [steps('code', { table: '' }), 'table'],
  ])('rejects %j', (s, message) => {
    expect(compileError(s, opts)).toContain(message)
  })
})
