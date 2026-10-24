import { describe, expect, it } from 'vite-plus/test'
import { Instant } from '../../../src/mapping/time'
import { show, t } from '../../../src/mapping/types'
import { compile, compileError, evaluate, run } from '../helpers'

const day = (iso: string) => Instant.parse(`${iso}T00:00:00Z`) as Instant

const fields = {
  strs: t.list(t.string),
  nstrs: t.nullable(t.list(t.string)),
  nums: t.list(t.nullable(t.number)),
  nnums: t.nullable(t.list(t.number)),
  dates: t.list(t.date),
  bools: t.list(t.boolean),
  nested: t.list(t.list(t.string)),
  s: t.string,
  n: t.number,
  ns: t.nullable(t.string),
}

const at = (path: string, step: Record<string, unknown>) => [{ op: 'extract', path }, step]
const typeOf = (path: string, step: Record<string, unknown>) =>
  show(compile(at(path, step), { fields }).type)
const errorOf = (path: string, step: Record<string, unknown>) =>
  compileError(at(path, step), { fields })
const value = (path: string, step: Record<string, unknown>, record: Record<string, unknown>) =>
  evaluate(at(path, step), record as never, { fields })

/** Every list op rejects a non-list input (len also accepts strings) and propagates null. */
describe.each([
  [{ op: 'each', pipeline: [{ op: 'trim' }] }, 'nstrs', 'each expects a list, got number'],
  [{ op: 'filter_list', cond: { eq: 'a' } }, 'nstrs', 'filter_list expects a list, got number'],
  [{ op: 'index', at: 0 }, 'nstrs', 'index expects a list, got number'],
  [{ op: 'first' }, 'nstrs', 'first expects a list, got number'],
  [{ op: 'last' }, 'nstrs', 'last expects a list, got number'],
  [{ op: 'len' }, 'nstrs', 'len expects a list or string, got number'],
  [{ op: 'unique' }, 'nstrs', 'unique expects a list, got number'],
  [{ op: 'sum' }, 'nnums', 'sum expects a list, got number'],
  [{ op: 'min' }, 'nnums', 'min expects a list, got number'],
  [{ op: 'max' }, 'nnums', 'max expects a list, got number'],
  [{ op: 'contains', value: 'a' }, 'nstrs', 'contains expects a list, got number'],
])('%j', (step, nullable, message) => {
  it('rejects a number', () => {
    expect(errorOf('n', step)).toBe(message)
  })

  it('propagates a null list', () => {
    expect(value(nullable, step, { [nullable]: null })).toBe(null)
    expect(typeOf(nullable, step)).toMatch(/\?$/)
  })
})

describe('each', () => {
  it('maps every element through a nested pipeline', () => {
    const step = {
      op: 'each',
      pipeline: [
        { op: 'to_number', strict: true },
        { op: 'multiply', by: 2 },
      ],
    }
    expect(typeOf('strs', step)).toBe('list<number>')
    expect(value('strs', step, { strs: ['1', '2'] })).toEqual([2, 4])
    expect(value('strs', step, { strs: [] })).toEqual([])
  })

  it('lifts null elements inside the nested pipeline', () => {
    const step = { op: 'each', pipeline: [{ op: 'add', value: 1 }] }
    expect(typeOf('nums', step)).toBe('list<number?>')
    expect(value('nums', step, { nums: [1, null] })).toEqual([2, null])
  })

  it('is fallible exactly when the nested pipeline is', () => {
    expect(
      compile(at('strs', { op: 'each', pipeline: [{ op: 'trim' }] }), { fields }).fallible,
    ).toBe(false)
    expect(
      compile(at('strs', { op: 'each', pipeline: [{ op: 'to_number', strict: true }] }), { fields })
        .fallible,
    ).toBe(true)
  })

  it('reports the failing element and op', () => {
    const c = compile(
      at('strs', { op: 'each', pipeline: [{ op: 'trim' }, { op: 'to_number', strict: true }] }),
      {
        fields,
      },
    )
    expect(run(c, { strs: ['1', 'x'] })).toEqual({
      ok: false,
      error: {
        code: 'parse_failed',
        detail: "element 1, to_number: 'x' is not a number",
        step: 1,
        op: 'each',
      },
    })
  })

  it.each([
    [{ op: 'each', pipeline: [] }, /^each: pipeline: /],
    [{ op: 'each' }, /^each: pipeline: /],
    [
      { op: 'each', pipeline: [{ op: 'divide', by: 2 }] },
      'each step 0: divide expects number, got string',
    ],
    [{ op: 'each', pipeline: [{ op: 'omit_if_null' }] }, 'each cannot end in omit_if_null'],
  ])('rejects %j', (step, message) => {
    if (typeof message === 'string') expect(errorOf('strs', step)).toBe(message)
    else expect(errorOf('strs', step)).toMatch(message)
  })

  it('cannot be nested', () => {
    const step = { op: 'each', pipeline: [{ op: 'each', pipeline: [{ op: 'trim' }] }] }
    expect(errorOf('nested', step)).toBe('each step 0: each cannot be nested inside each')
  })
})

describe('filter_list', () => {
  it('keeps elements matching the condition', () => {
    const step = { op: 'filter_list', cond: { gt: 1 } }
    expect(typeOf('nums', step)).toBe('list<number?>')
    expect(value('nums', step, { nums: [1, 2, null, 3] })).toEqual([2, 3])
  })

  it('can compare elements with a record field', () => {
    const step = { op: 'filter_list', cond: { neq: { ref: 's' } } }
    expect(value('strs', step, { strs: ['a', 'b'], s: 'a' })).toEqual(['b'])
  })

  it('rejects an invalid condition', () => {
    expect(errorOf('strs', { op: 'filter_list', cond: { gt: 1 } })).toBe(
      'cannot compare string with number',
    )
  })
})

describe('index / first / last', () => {
  it.each([
    [{ op: 'index', at: 0 }, 'a'],
    [{ op: 'index', at: 2 }, 'c'],
    [{ op: 'index', at: -1 }, 'c'],
    [{ op: 'index', at: 3 }, null],
    [{ op: 'index', at: -4 }, null],
    [{ op: 'first' }, 'a'],
    [{ op: 'last' }, 'c'],
  ])('%j of [a, b, c] is %j', (step, expected) => {
    expect(value('strs', step, { strs: ['a', 'b', 'c'] })).toBe(expected)
    expect(typeOf('strs', step)).toBe('string?')
  })

  it.each([{ op: 'first' }, { op: 'last' }, { op: 'index', at: 0 }])('%j of [] is null', (step) => {
    expect(value('strs', step, { strs: [] })).toBe(null)
  })

  it('rejects a non-integer index', () => {
    expect(errorOf('strs', { op: 'index', at: 0.5 })).toMatch(/^index: at: /)
  })
})

describe('len', () => {
  it('counts list elements and string code points', () => {
    expect(value('strs', { op: 'len' }, { strs: ['a', 'b'] })).toBe(2)
    expect(value('s', { op: 'len' }, { s: 'a😀' })).toBe(2)
    expect(typeOf('s', { op: 'len' })).toBe('number')
    expect(typeOf('strs', { op: 'len' })).toBe('number')
  })
})

describe('unique', () => {
  it('drops repeats, keeping the first occurrence', () => {
    expect(value('strs', { op: 'unique' }, { strs: ['b', 'a', 'b', 'c', 'a'] })).toEqual([
      'b',
      'a',
      'c',
    ])
    expect(
      value('dates', { op: 'unique' }, { dates: [day('2026-01-01'), day('2026-01-01')] }),
    ).toEqual([day('2026-01-01')])
    expect(typeOf('strs', { op: 'unique' })).toBe('list<string>')
  })
})

describe('sum', () => {
  it.each([
    [[1, 2, null, 3], 6],
    [[null], null],
    [[], null],
    [[0.1, 0.2, 0.3], 0.6000000000000001],
    [[0.3, 0.2, 0.1], 0.6000000000000001],
  ])('sum of %j is %j', (nums, expected) => {
    expect(value('nums', { op: 'sum' }, { nums })).toBe(expected)
  })

  it('types list<number> to number? and rejects other lists', () => {
    expect(typeOf('nums', { op: 'sum' })).toBe('number?')
    expect(errorOf('strs', { op: 'sum' })).toBe('sum expects list<number>, got list<string>')
  })
})

describe('min / max', () => {
  it.each([
    ['nums', { nums: [3, null, 1, 2] }, 1, 3],
    ['nums', { nums: [null] }, null, null],
    ['strs', { strs: ['b', 'a', 'c'] }, 'a', 'c'],
    [
      'dates',
      { dates: [day('2026-02-01'), day('2026-01-01')] },
      day('2026-01-01'),
      day('2026-02-01'),
    ],
  ])('%s %j: min %j, max %j', (path, record, lo, hi) => {
    expect(value(path, { op: 'min' }, record)).toEqual(lo)
    expect(value(path, { op: 'max' }, record)).toEqual(hi)
  })

  it('types to a nullable element and rejects unorderable lists', () => {
    expect(typeOf('nums', { op: 'min' })).toBe('number?')
    expect(typeOf('dates', { op: 'max' })).toBe('date?')
    expect(errorOf('bools', { op: 'max' })).toBe(
      'max expects a list of numbers, strings or dates, got list<boolean>',
    )
  })
})

describe('contains', () => {
  it.each([
    [{ op: 'contains', value: 'b' }, { strs: ['a', 'b'] }, true],
    [{ op: 'contains', value: 'z' }, { strs: ['a', 'b'] }, false],
    [{ op: 'contains', value: { ref: 's' } }, { strs: ['a'], s: 'a' }, true],
    [{ op: 'contains', value: { ref: 'ns' } }, { strs: ['a'], ns: null }, false],
    [{ op: 'contains', value: { param: 'p' } }, { strs: ['a', 'p'] }, true],
  ])('%j on %j is %j', (step, record, expected) => {
    expect(evaluate(at('strs', step), record as never, { fields, params: { p: 'p' } })).toBe(
      expected,
    )
    expect(show(compile(at('strs', step), { fields, params: { p: 'p' } }).type)).toBe('boolean')
  })

  it('skips null elements', () => {
    expect(value('nums', { op: 'contains', value: 1 }, { nums: [null, 1] })).toBe(true)
    expect(value('nums', { op: 'contains', value: 2 }, { nums: [null, 1] })).toBe(false)
  })

  it('reads string values as dates in a date list', () => {
    expect(
      value('dates', { op: 'contains', value: '2026-01-01' }, { dates: [day('2026-01-01')] }),
    ).toBe(true)
  })

  it.each([
    [{ op: 'contains' }, /^contains: value: /],
    [{ op: 'contains', value: 1 }, 'cannot look for number in list<string>'],
    [{ op: 'contains', value: { ref: 'nope' } }, /^unknown field 'nope'/],
  ])('rejects %j', (step, message) => {
    if (typeof message === 'string') expect(errorOf('strs', step)).toBe(message)
    else expect(errorOf('strs', step)).toMatch(message)
  })
})
