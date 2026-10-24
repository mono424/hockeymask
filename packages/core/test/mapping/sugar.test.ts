import { describe, expect, it } from 'vite-plus/test'
import { expandStep } from '../../src/mapping/sugar'
import { t } from '../../src/mapping/types'
import { evaluate } from './helpers'

describe('expandStep', () => {
  it('passes ordinary steps through unchanged', () => {
    const step = { op: 'divide', by: 1000 }
    expect(expandStep(step)).toEqual({ ok: true, value: step })
  })

  it.each([
    [
      { op: 'if_lte', value: 0, then: null },
      { op: 'when', cases: [{ cond: { lte: 0 }, then: null }] },
    ],
    [
      { op: 'if_after', date: 'today+10y', then: null },
      { op: 'when', cases: [{ cond: { after: 'today+10y' }, then: null }] },
    ],
    [
      { op: 'if_in', values: ['a'], then: 'x', else: 'y' },
      { op: 'when', cases: [{ cond: { in: ['a'] }, then: 'x' }], else: 'y' },
    ],
    [
      { op: 'if_matches', pattern: '^a', path: 's', then: 1 },
      { op: 'when', cases: [{ cond: { path: 's', matches: '^a' }, then: 1 }] },
    ],
    [
      { op: 'if_is_null', then: 0 },
      { op: 'when', cases: [{ cond: { is_null: true }, then: 0 }] },
    ],
    [
      { op: 'if_is_blank', then: null },
      { op: 'when', cases: [{ cond: { is_blank: true }, then: null }] },
    ],
  ])('expands %j', (sugar, expanded) => {
    expect(expandStep(sugar)).toEqual({ ok: true, value: expanded })
  })

  it.each([
    [{ op: 'if_soon', then: 1 }, "unknown op 'if_soon'"],
    [{ op: 'if_all', then: 1 }, "unknown op 'if_all'"],
    [{ op: 'if_lte', value: 0 }, 'if_lte needs "then"'],
    [{ op: 'if_lte', value: 0, then: 1, by: 2 }, 'if_lte does not take by'],
    [{ op: 'if_lte', then: 1 }, 'if_lte takes exactly one of value, values, date, pattern'],
    [{ op: 'if_lte', value: 0, date: 'today', then: 1 }, 'if_lte takes exactly one of value'],
    [{ op: 'if_is_null', value: 0, then: 1 }, 'if_is_null takes no comparison value'],
  ])('rejects %j', (sugar, message) => {
    const r = expandStep(sugar)
    expect(r.ok ? '' : r.error).toContain(message)
  })

  it('runs as the when it expands to', () => {
    const steps = [
      { op: 'extract', path: 'n' },
      { op: 'if_gt', value: 10, then: 10 },
    ]
    expect(evaluate(steps, { n: 12 }, { fields: { n: t.number } })).toBe(10)
    expect(evaluate(steps, { n: 3 }, { fields: { n: t.number } })).toBe(3)
  })
})
