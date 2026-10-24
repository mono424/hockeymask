import { describe, expect, it } from 'vite-plus/test'
import type { FnDef } from '../../../src/mapping/context'
import { fn } from '../../../src/mapping/ops/fn'
import { ok, stepError } from '../../../src/mapping/result'
import { t } from '../../../src/mapping/types'
import { compile, compileError, env, evaluate, evaluateError, typeOf } from '../helpers'

const functions: Record<string, FnDef> = {
  double: { input: t.number, output: t.number, fallible: false, run: (v) => ok((v as number) * 2) },
  tier: {
    output: t.string,
    run: (v) =>
      v === null ? stepError('fn_failed', 'no price') : ok(Number(v) > 10 ? 'high' : 'low'),
  },
  greet: {
    input: t.nullable(t.string),
    output: t.string,
    run: (v, ctx) => ok(`${v === null ? 'null' : (v as string)}@${ctx.tz}`),
  },
}
const fields = { n: t.number, p: t.nullable(t.number), s: t.nullable(t.string) }
const opts = { fields, functions }
const call = (path: string, ref: string) => [
  { op: 'extract', path },
  { op: 'fn', ref },
]

describe('fn', () => {
  it('calls the registered function with the run context', () => {
    expect(evaluate(call('n', 'double'), { n: 21 }, opts)).toBe(42)
    expect(evaluate(call('s', 'greet'), { s: 'hi' }, opts)).toBe('hi@UTC')
  })

  it('consumes null: the function sees it', () => {
    expect(evaluate(call('s', 'greet'), { s: null }, opts)).toBe('null@UTC')
    expect(evaluateError(call('p', 'tier'), { p: null }, opts)).toMatchObject({
      code: 'fn_failed',
      detail: 'no price',
      op: 'fn',
    })
  })

  it('takes the declared output type; any input when none is declared', () => {
    expect(typeOf(call('n', 'double'), opts)).toBe('number')
    expect(typeOf(call('p', 'tier'), opts)).toBe('string')
  })

  it('is fallible unless the function says otherwise', () => {
    expect(compile(call('n', 'double'), opts).fallible).toBe(false)
    expect(compile(call('p', 'tier'), opts).fallible).toBe(true)
    expect(fn.fallible({ ref: 'missing' }, env(), t.number)).toBe(true)
  })

  it.each([
    [call('n', 'missing'), "unknown function 'missing'"],
    [call('n', 'toString'), "unknown function 'toString'"],
    [call('p', 'double'), "function 'double' takes number, got number?"],
    [[{ op: 'extract', path: 'n' }, { op: 'fn' }], 'ref'],
  ])('rejects %j', (steps, message) => {
    expect(compileError(steps, opts)).toContain(message)
  })
})
