import { describe, expect, it } from 'vite-plus/test'
import { show } from '../../../src/mapping/types'
import { issuesOf, planOf } from '../helpers'
import { messagesOf, outputAt, outputOf, single } from './util'

const fields = { g: 'string?', n: 'number?', s: 'string', b: 'boolean' } as const
const rows = [
  { g: 'x', n: 3, s: 'c', b: true },
  { g: 'x', n: 1, s: 'a', b: false },
  { g: 'x', n: null, s: 'a', b: true },
  { g: null, n: 5, s: 'z', b: true },
]
const agg = (f: Record<string, unknown>, group_by: string[] = ['g'], extra = {}) => ({
  op: 'aggregate',
  group_by,
  fields: f,
  ...extra,
})
const out = (f: Record<string, unknown>, group_by?: string[], input = rows) =>
  outputOf(agg(f, group_by), fields, input)

describe('aggregate', () => {
  it('one record per group, sorted by key, null a group of its own', () => {
    expect(out({ c: { agg: 'count' } })).toEqual([
      { g: null, c: 1 },
      { g: 'x', c: 3 },
    ])
  })

  it('group_by [] gives one record, also for empty input', () => {
    expect(out({ c: { agg: 'count' } }, [])).toEqual([{ c: 4 }])
    expect(out({ c: { agg: 'count' }, t: { agg: 'sum', path: 'n' } }, [], [])).toEqual([
      { c: 0, t: null },
    ])
  })

  it.each([
    ['count_distinct', { agg: 'count_distinct', path: 's' }, 2, 'number'],
    ['sum skips nulls', { agg: 'sum', path: 'n' }, 4, 'number?'],
    ['min', { agg: 'min', path: 'n' }, 1, 'number?'],
    ['max of strings', { agg: 'max', path: 's' }, 'c', 'string?'],
    ['collect_set', { agg: 'collect_set', path: 'n' }, [1, 3], 'list<number>'],
    [
      'collect_list',
      { agg: 'collect_list', path: 'n', order_by: ['s', { path: 'b', desc: true }] },
      [null, 1, 3],
      'list<number?>',
    ],
    ['first', { agg: 'first', path: 's', order_by: [{ path: 'n', desc: true }] }, 'c', 'string?'],
    ['last', { agg: 'last', path: 's', order_by: ['n'] }, 'c', 'string?'],
    ['any', { agg: 'any', cond: { path: 'b', eq: false } }, true, 'boolean'],
    ['all', { agg: 'all', cond: { path: 'b', eq: true } }, false, 'boolean'],
    ['filtered count', { agg: 'count', where: { path: 'b', eq: true } }, 2, 'number'],
  ])('%s', (_name, spec, value, type) => {
    expect(out({ v: spec })?.[1]).toEqual({ g: 'x', v: value })
    const plan = planOf(single(agg({ v: spec }), fields))
    expect(show(outputAt(plan).type.fields.v as never)).toBe(type)
  })

  it('ties in order_by fall back to canonical record order', () => {
    const tied = [
      { g: 'x', n: 1, s: 'b', b: true },
      { g: 'x', n: 1, s: 'a', b: true },
    ]
    expect(out({ v: { agg: 'collect_list', path: 's', order_by: ['n'] } }, [], tied)).toEqual([
      { v: ['a', 'b'] },
    ])
  })

  it('empty after where gives null for value aggregates', () => {
    const none = { path: 's', eq: 'nothing' }
    expect(
      out(
        {
          lo: { agg: 'min', path: 'n', where: none },
          f: { agg: 'first', path: 's', order_by: ['s'], where: none },
          all: { agg: 'all', cond: { path: 'b', eq: true }, where: none },
        },
        [],
      ),
    ).toEqual([{ lo: null, f: null, all: true }])
  })

  it('keeps the origin of group fields', () => {
    const plan = planOf(single(agg({ c: { agg: 'count' } }), fields))
    expect(outputAt(plan).origins).toEqual({
      g: { node: 's', field: 'g', omittable: false },
      c: { node: 'n', field: 'c', omittable: false },
    })
  })

  it('an absent group field groups as null', () => {
    const upstream = {
      id: 'u',
      op: 'map',
      in: 's',
      fields: [{ key: 'g', pipeline: [{ op: 'extract', path: 'g' }, { op: 'omit_if_null' }] }],
    }
    const node = { ...agg({ c: { agg: 'count' } }), in: 'u' }
    expect(outputOf(node, fields, rows, { nodes: [upstream] })).toEqual([
      { g: null, c: 1 },
      { g: 'x', c: 3 },
    ])
    const ordered = {
      ...agg({ l: { agg: 'collect_list', path: 'g', order_by: ['g'] } }, []),
      in: 'u',
    }
    const twoAbsent = [...rows, { g: null, n: 0, s: 'q', b: false }]
    expect(outputOf(ordered, fields, twoAbsent, { nodes: [upstream] })).toEqual([
      { l: [null, null, 'x', 'x', 'x'] },
    ])
  })

  it.each([
    [{ agg: 'sum' }, 'sum needs a path'],
    [{ agg: 'count', path: 'n' }, 'count takes no path'],
    [{ agg: 'first', path: 'n' }, 'first needs order_by'],
    [{ agg: 'count', order_by: ['n'] }, 'count takes no order_by'],
    [{ agg: 'any' }, 'any needs a cond'],
    [{ agg: 'count', cond: { path: 'b', eq: true } }, 'count takes no cond'],
    [{ agg: 'sum', path: 'zz' }, "unknown field 'zz'"],
    [{ agg: 'last', path: 'n', order_by: ['zz'] }, "order_by: unknown field 'zz'"],
    [{ agg: 'sum', path: 's' }, 'sum needs a number field, s is string'],
    [{ agg: 'max', path: 'b' }, 'max needs a number, string or date field, b is boolean'],
    [
      { agg: 'count', where: { eq: 1 } },
      'where: this condition has no piped value to test; give it a "path"',
    ],
    [
      { agg: 'all', cond: { path: 'zz', eq: 1 } },
      expect.stringMatching(/^cond: unknown field 'zz'/),
    ],
  ])('rejects %j', (spec, message) => {
    expect(issuesOf(single(agg({ v: spec }), fields))).toEqual([
      { code: 'type_error', message, node: 'n', field: 'v' },
    ])
  })

  it('rejects unknown group fields, clashing names and no fields', () => {
    expect(messagesOf(agg({ g: { agg: 'count' } }, ['g', 'q']), fields)).toEqual([
      "group_by: unknown field 'q'",
      "'g' is both a group key and an aggregate",
    ])
    expect(messagesOf(agg({}), fields)).toEqual(['fields: needs at least one field'])
  })

  it('a skipping map upstream must be tolerated', () => {
    const upstream = {
      id: 'u',
      op: 'map',
      in: 's',
      fields: [
        {
          key: 'g',
          pipeline: [
            { op: 'extract', path: 's' },
            { op: 'to_number', strict: true },
          ],
        },
      ],
    }
    const node = { ...agg({ c: { agg: 'count' } }), in: 'u' }
    expect(messagesOf(node, fields, { nodes: [upstream] })[0]).toMatch(/^u can drop records/)
    expect(messagesOf({ ...node, tolerate_skips: true }, fields, { nodes: [upstream] })).toEqual([])
  })
})
