import { describe, expect, it } from 'vite-plus/test'
import { show, t } from '../../../src/mapping/types'
import { compile, compileError, evaluate } from '../helpers'

const fields = {
  n: t.nullable(t.number),
  mode: t.nullable(t.string),
  src: t.nullable(t.string),
  orderable: t.number,
}

const after = (step: Record<string, unknown>, path = 'n') => [{ op: 'extract', path }, step]

describe('when after a step', () => {
  const clampLow = { op: 'when', cases: [{ cond: { lte: 0 }, then: null }] }

  it('replaces matching values and passes the rest through by default', () => {
    expect(show(compile(after(clampLow), { fields }).type)).toBe('number?')
    expect(evaluate(after(clampLow), { n: -1 }, { fields })).toBe(null)
    expect(evaluate(after(clampLow), { n: 5 }, { fields })).toBe(5)
  })

  it('sees null, because it consumes it', () => {
    const step = { op: 'when', cases: [{ cond: { is_null: true }, then: 0 }] }
    expect(evaluate(after(step), { n: null }, { fields })).toBe(0)
  })

  it('takes the first matching case', () => {
    const step = {
      op: 'when',
      cases: [
        { cond: { gt: 10 }, then: 'big' },
        { cond: { gt: 0 }, then: 'small' },
      ],
      else: 'none',
    }
    expect(show(compile(after(step), { fields }).type)).toBe('string')
    expect([20, 5, -1].map((n) => evaluate(after(step), { n }, { fields }))).toEqual([
      'big',
      'small',
      'none',
    ])
  })

  it('forwards the input with { pass: true }', () => {
    const step = { op: 'when', cases: [{ cond: { gt: 0 }, then: { pass: true } }], else: 0 }
    expect(show(compile(after(step), { fields }).type)).toBe('number?')
    expect(evaluate(after(step), { n: 3 }, { fields })).toBe(3)
    expect(evaluate(after(step), { n: -3 }, { fields })).toBe(0)
  })

  it('tests record fields with a path', () => {
    const step = {
      op: 'when',
      cases: [{ cond: { path: 'mode', eq: 'pickup' }, then: true }],
      else: false,
    }
    expect(evaluate(after(step), { n: 1, mode: 'pickup' }, { fields })).toBe(true)
  })

  it('returns list literals', () => {
    const step = { op: 'when', cases: [{ cond: { gt: 0 }, then: ['a'] }], else: [] }
    expect(show(compile(after(step), { fields }).type)).toBe('list<string>')
    expect(evaluate(after(step), { n: 1 }, { fields })).toEqual(['a'])
  })

  it.each([
    [
      { op: 'when', cases: [{ cond: { gt: 0 }, then: 'x' }] },
      'when branches disagree: string, number?',
    ],
    [
      { op: 'when', cases: [{ cond: { eq: 'a' }, then: 1 }] },
      'case 0: cannot compare number? with string',
    ],
    [{ op: 'when', cases: [] }, /^when: cases: /],
    [{ op: 'when', cases: [{ cond: { gt: 0 } }] }, /^when: cases\.0\.then: /],
    [
      { op: 'when', cases: [{ cond: { gt: 0 }, then: 1, x: 1 }] },
      /^when: cases\.0: Unrecognized key/,
    ],
    [{ op: 'when', cases: [{ cond: { gt: 0 }, then: { a: 1 } }] }, /^when: cases\.0\.then: /],
    [
      { op: 'when', cases: [{ cond: { gt: 0 }, then: { pass: false } }] },
      /^when: cases\.0\.then: /,
    ],
  ])('rejects %j', (step, message) => {
    if (typeof message === 'string') expect(compileError(after(step), { fields })).toBe(message)
    else expect(compileError(after(step), { fields })).toMatch(message)
  })
})

describe('when as the first step', () => {
  const kind = {
    op: 'when',
    cases: [
      { cond: { path: 'mode', eq: 'pickup' }, then: 'pickup_explicit' },
      { cond: { path: 'src', is_null: true }, then: 'no_source' },
    ],
    else: 'ship',
  }

  it('classifies a record by its fields', () => {
    expect(show(compile([kind], { fields }).type)).toBe('string')
    expect(evaluate([kind], { mode: 'pickup', src: 'W1' }, { fields })).toBe('pickup_explicit')
    expect(evaluate([kind], { mode: 'ship', src: null }, { fields })).toBe('no_source')
    expect(evaluate([kind], { mode: 'ship', src: 'W1' }, { fields })).toBe('ship')
  })

  it.each([
    [
      { op: 'when', cases: [{ cond: { path: 'mode', eq: 'a' }, then: 1 }] },
      'when as the first step needs an "else"',
    ],
    [
      { op: 'when', cases: [{ cond: { path: 'mode', eq: 'a' }, then: { pass: true } }], else: 1 },
      'when as the first step has no input to pass',
    ],
    [
      { op: 'when', cases: [{ cond: { path: 'mode', eq: 'a' }, then: 1 }], else: { pass: true } },
      'when as the first step has no input to pass',
    ],
    [
      { op: 'when', cases: [{ cond: { eq: 'a' }, then: 1 }], else: 0 },
      'case 0: this condition has no piped value to test; give it a "path"',
    ],
  ])('rejects %j', (step, message) => {
    expect(compileError([step], { fields })).toBe(message)
  })

  it('is not fallible', () => {
    expect(compile([kind], { fields }).fallible).toBe(false)
  })
})
