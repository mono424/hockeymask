import { describe, expect, it } from 'vite-plus/test'
import { always, defineOp, expectKind, json, never, params } from '../../../src/mapping/ops/def'
import { ok } from '../../../src/mapping/result'
import { t } from '../../../src/mapping/types'

describe('expectKind', () => {
  it('accepts a listed kind', () => {
    expect(expectKind(t.number, ['number', 'string'], 'op')).toEqual(ok(t.number))
  })

  it.each([
    [t.string, 'op expects number, got string'],
    [t.nullable(t.string), 'op expects number, got string?'],
    [t.unit, 'op expects number, got no input'],
  ])('rejects %j', (input, message) => {
    expect(expectKind(input, ['number'], 'op')).toEqual({ ok: false, error: message })
  })
})

describe('helpers', () => {
  it('never and always', () => {
    expect(never()).toBe(false)
    expect(always()).toBe(true)
  })

  it('json accepts nested JSON and rejects anything else', () => {
    expect(json.safeParse({ a: [1, 'x', null, true, { b: [] }] }).success).toBe(true)
    expect(json.safeParse(undefined).success).toBe(false)
    expect(json.safeParse({ a: () => 1 }).success).toBe(false)
  })

  it('params are strict', () => {
    const schema = params({ a: json })
    expect(schema.safeParse({ a: 1 }).success).toBe(true)
    expect(schema.safeParse({ a: 1, b: 2 }).success).toBe(false)
  })

  it('defineOp is the identity', () => {
    const def = {
      name: 'noop',
      params: params({}),
      nulls: 'consume' as const,
      fallible: never,
      signature: () => ok(t.unknown),
      run: () => () => ok(null),
    }
    expect(defineOp(def)).toBe(def)
  })
})
