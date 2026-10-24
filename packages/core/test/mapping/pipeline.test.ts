import { describe, expect, it } from 'vite-plus/test'
import { compileSteps } from '../../src/mapping/pipeline'
import { Instant } from '../../src/mapping/time'
import { show, t } from '../../src/mapping/types'
import { OMIT } from '../../src/mapping/values'
import { compile, compileError, env, evaluate, run } from './helpers'

const fields = {
  s: t.string,
  n: t.nullable(t.number),
  u: t.unknown,
  width_mm: t.nullable(t.number),
  weight: t.nullable(t.number),
  weightunit: t.string,
  upccode: t.nullable(t.string),
  listed: t.nullable(t.string),
  dims: t.string,
}

describe('compileSteps: structure', () => {
  it('rejects an empty pipeline at step 0', () => {
    const r = compileSteps([], env({ fields }))
    expect(r.ok ? null : r.error).toEqual({
      step: 0,
      message: 'a pipeline needs at least one step',
    })
  })

  it.each([[5], [null], [{}], [{ op: 1 }]])('rejects the step %j', (step) => {
    expect(compileError([step], { fields })).toBe('a step is an object with an "op"')
  })

  it('reports sugar and unknown ops', () => {
    expect(compileError([{ op: 'if_soon', then: 1 }], { fields })).toBe("unknown op 'if_soon'")
    expect(compileError([{ op: 'nope' }], { fields })).toBe("unknown op 'nope'")
    expect(compileError([{ op: 'toString' }], { fields })).toBe("unknown op 'toString'")
  })

  it('locates the failing step', () => {
    const r = compileSteps([{ op: 'extract', path: 's' }, { op: 'nope' }], env({ fields }))
    expect(r.ok ? null : r.error.step).toBe(1)
  })

  it.each([
    [{ op: 'extract', path: '' }, /^extract: path: /],
    [{ op: 'const' }, /^const: value: /],
    [{ op: 'extract', path: 's', x: 1 }, /^extract: Unrecognized key/],
  ])('formats params errors with their path for %j', (step, message) => {
    expect(compileError([step], { fields })).toMatch(message)
  })

  it('formats object-level params errors without a path', () => {
    expect(
      compileError(
        [
          { op: 'extract', path: 's' },
          { op: 'truncate', length: 0, ellipsis: true },
        ],
        { fields },
      ),
    ).toBe('truncate: truncate with ellipsis needs length >= 1')
  })

  it('rejects an entry op after another step', () => {
    expect(
      compileError(
        [
          { op: 'extract', path: 's' },
          { op: 'const', value: 1 },
        ],
        { fields },
      ),
    ).toBe('const starts a pipeline; it cannot follow another step')
  })

  it('rejects a value op as the first step', () => {
    expect(compileError([{ op: 'trim' }], { fields })).toBe(
      'trim needs an input; start the pipeline with extract, const, coalesce or when',
    )
  })

  it('accepts a value op first when given an input type', () => {
    expect(evaluate([{ op: 'trim' }], {}, { input: t.string, value: ' a ' })).toBe('a')
  })

  it('requires omit_if_null to be last', () => {
    expect(
      compileError([{ op: 'extract', path: 'upccode' }, { op: 'omit_if_null' }, { op: 'trim' }], {
        fields,
      }),
    ).toBe('omit_if_null must be the last step')
  })

  it('rejects an op that can only ever see null', () => {
    expect(compileError([{ op: 'const', value: null }, { op: 'trim' }], { fields })).toBe(
      'trim receives only null; nothing to do',
    )
  })

  it('reports signature errors', () => {
    expect(
      compileError(
        [
          { op: 'extract', path: 's' },
          { op: 'divide', by: 2 },
        ],
        { fields },
      ),
    ).toBe('divide expects number, got string')
  })

  it('strips null from an unknown input before the op checks it', () => {
    expect(compileError([{ op: 'extract', path: 'u' }, { op: 'trim' }], { fields })).toBe(
      'trim expects string, got unknown',
    )
  })
})

describe('compileSteps: null lifting', () => {
  const steps = [
    { op: 'extract', path: 'n' },
    { op: 'add', value: 1 },
    { op: 'multiply', by: 2 },
  ]

  it('makes the output nullable and skips propagating ops on null', () => {
    const c = compile(steps, { fields })
    expect(show(c.type)).toBe('number?')
    expect(run(c, { n: 1 })).toEqual({ ok: true, value: 4 })
    expect(run(c, { n: null })).toEqual({ ok: true, value: null })
  })

  it('does not lift a non-null input', () => {
    expect(show(compile([{ op: 'extract', path: 's' }, { op: 'trim' }], { fields }).type)).toBe(
      'string',
    )
  })

  it('lets consuming ops see null', () => {
    expect(
      evaluate(
        [
          { op: 'extract', path: 'n' },
          { op: 'default', value: 0 },
        ],
        { n: null },
        { fields },
      ),
    ).toBe(0)
  })
})

describe('compileSteps: flags and runtime', () => {
  it('tracks fallibility across steps', () => {
    expect(compile([{ op: 'extract', path: 's' }, { op: 'trim' }], { fields }).fallible).toBe(false)
    expect(
      compile([{ op: 'extract', path: 's' }, { op: 'to_number', strict: true }, { op: 'abs' }], {
        fields,
      }).fallible,
    ).toBe(true)
  })

  it('marks a pipeline ending in omit_if_null as omittable', () => {
    const c = compile([{ op: 'extract', path: 'upccode' }, { op: 'omit_if_null' }], { fields })
    expect(c.omittable).toBe(true)
    expect(show(c.type)).toBe('string?')
    expect(run(c, { upccode: null })).toEqual({ ok: true, value: OMIT })
    expect(compile([{ op: 'extract', path: 's' }], { fields }).omittable).toBe(false)
  })

  it('locates a runtime error by step and op', () => {
    const c = compile(
      [{ op: 'extract', path: 's' }, { op: 'trim' }, { op: 'to_number', strict: true }],
      {
        fields,
      },
    )
    expect(run(c, { s: ' x ' })).toEqual({
      ok: false,
      error: { code: 'parse_failed', detail: "'x' is not a number", step: 2, op: 'to_number' },
    })
  })
})

describe('worked example: NetSuite product pipelines', () => {
  it('width: if_lte 0 then null, divide 1000', () => {
    const steps = [
      { op: 'extract', path: 'width_mm' },
      { op: 'if_lte', value: 0, then: null },
      { op: 'divide', by: 1000 },
    ]
    expect(show(compile(steps, { fields }).type)).toBe('number?')
    expect(evaluate(steps, { width_mm: 120 }, { fields })).toBe(0.12)
    expect(evaluate(steps, { width_mm: -3 }, { fields })).toBe(null)
    expect(evaluate(steps, { width_mm: 0 }, { fields })).toBe(null)
    expect(evaluate(steps, { width_mm: null }, { fields })).toBe(null)
  })

  it('weight: convert a (value, unit) tuple to grams', () => {
    const steps = [
      { op: 'extract', path: ['weight', 'weightunit'] },
      { op: 'convert_unit', to: 'g' },
    ]
    const c = compile(steps, { fields })
    expect(c.fallible).toBe(true)
    expect(show(c.type)).toBe('number?')
    expect(evaluate(steps, { weight: 2, weightunit: 'kg' }, { fields })).toBe(2000)
  })

  it('ean: blank to null', () => {
    const steps = [{ op: 'extract', path: 'upccode' }, { op: 'blank_to_null' }]
    expect(show(compile(steps, { fields }).type)).toBe('string?')
    expect(evaluate(steps, { upccode: '  ' }, { fields })).toBe(null)
    expect(evaluate(steps, { upccode: '12345678' }, { fields })).toBe('12345678')
  })

  it('launch date: placeholder dates beyond today+10y become null', () => {
    const steps = [
      { op: 'extract', path: 'listed' },
      { op: 'to_date', format: 'YYYY-MM-DD' },
      { op: 'if_after', date: 'today+10y', then: null },
    ]
    expect(show(compile(steps, { fields }).type)).toBe('date?')
    expect(evaluate(steps, { listed: '2030-01-01' }, { fields })).toEqual(
      Instant.parse('2030-01-01T00:00:00Z'),
    )
    expect(evaluate(steps, { listed: '9999-01-01' }, { fields })).toBe(null)
  })

  it('launch date without to_date does not type-check', () => {
    expect(
      compileError(
        [
          { op: 'extract', path: 'listed' },
          { op: 'if_after', date: 'today+10y', then: null },
        ],
        { fields },
      ),
    ).toBe("case 0: 'after' applies to dates, not string?")
  })

  it('dims: parse once, index into the list', () => {
    const steps = [
      { op: 'extract', path: 'dims' },
      { op: 'split', separator: 'x' },
      { op: 'each', pipeline: [{ op: 'to_number', strict: true }] },
      { op: 'index', at: 1 },
    ]
    expect(show(compile(steps, { fields }).type)).toBe('number?')
    expect(evaluate(steps, { dims: '120x80x40' }, { fields })).toBe(80)
  })
})
