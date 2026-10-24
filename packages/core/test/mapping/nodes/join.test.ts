import { describe, expect, it } from 'vite-plus/test'
import type { MappingVersionInput } from '../../../src/mapping/document'
import { outputAt } from './util'
import { show } from '../../../src/mapping/types'
import { issuesOf, planOf, runOf, schemaOf, targetsOf, versionOf } from '../helpers'

const left = [
  { k: 'a', v: 1 },
  { k: 'b', v: 2 },
  { k: null, v: 3 },
]
const right = [
  { k: 'a', w: 'A', x: 10 },
  { k: 'c', w: 'C', x: 30 },
]

function graph(join: Record<string, unknown>, extra: Partial<MappingVersionInput> = {}) {
  const { nodes, ...rest } = extra
  return versionOf({
    expectedSchema: {
      l: schemaOf({ k: 'string?', v: 'number' }),
      r: schemaOf({ k: 'string?', w: 'string', x: 'number' }),
    },
    nodes: [
      { id: 'l', op: 'source', system: 'x', entity: 'l' },
      { id: 'r', op: 'source', system: 'x', entity: 'r' },
      { id: 'n', op: 'join', left: 'l', right: 'r', on: [['k', 'k']], cardinality: 'n:1', ...join },
      { id: 'out', op: 'metrics', in: 'n', name: 'm' },
      ...(nodes ?? []),
    ],
    ...rest,
  })
}
type Rows = readonly Record<string, unknown>[]
const run = (
  join: Record<string, unknown>,
  l: Rows = left,
  r: Rows = right,
  extra: Partial<MappingVersionInput> = {},
) => runOf(planOf(graph(join, extra)), { l, r })
const typeOf = (join: Record<string, unknown>) => show(outputAt(planOf(graph(join))).type)
const messages = (join: Record<string, unknown>, extra: Partial<MappingVersionInput> = {}) =>
  issuesOf(graph(join, extra)).map((i) => i.message)

describe('join', () => {
  it('inner: matching records merged; same-name keys merge; null keys never match', () => {
    expect(typeOf({})).toBe('{ k: string?, v: number, w: string, x: number }')
    expect(run({}).outputs?.n).toEqual([{ k: 'a', v: 1, w: 'A', x: 10 }])
    // A null right key is skipped too.
    expect(run({}, left, [{ k: null, w: 'N', x: 0 }]).outputs?.n).toEqual([])
  })

  it('left: every left record, right fields nullable', () => {
    expect(typeOf({ type: 'left', select: { w: 'w' } })).toBe(
      '{ k: string?, v: number, w: string? }',
    )
    expect(run({ type: 'left', select: { w: 'w' } }).outputs?.n).toEqual([
      { k: 'a', v: 1, w: 'A' },
      { k: 'b', v: 2, w: null },
      { k: null, v: 3, w: null },
    ])
    const origins = outputAt(planOf(graph({ type: 'left', select: { w: 'w' } }))).origins
    expect(origins.w).toEqual({ node: 'n', field: 'w', omittable: false })
  })

  it('semi and anti keep left records with or without a match, in the left schema', () => {
    expect(typeOf({ type: 'semi' })).toBe('{ k: string?, v: number }')
    expect(run({ type: 'semi' }).outputs?.n).toEqual([{ k: 'a', v: 1 }])
    expect(run({ type: 'anti' }).outputs?.n).toEqual([
      { k: 'b', v: 2 },
      { k: null, v: 3 },
    ])
  })

  it('where is part of the match, also for left, semi and anti', () => {
    const where = { path: 'x', gt: 10 }
    expect(run({ where }).outputs?.n).toEqual([])
    expect(run({ type: 'left', where, select: { x: 'x' } }).outputs?.n).toEqual([
      { k: 'a', v: 1, x: null },
      { k: 'b', v: 2, x: null },
      { k: null, v: 3, x: null },
    ])
    expect(run({ type: 'semi', where: { path: 'x', eq: 10 } }).outputs?.n).toEqual([
      { k: 'a', v: 1 },
    ])
    expect(run({ type: 'anti', where: { path: 'x', eq: 10 } }).outputs?.n).toHaveLength(2)
  })

  it('select picks and renames right fields', () => {
    expect(typeOf({ select: { w: 'label', k: 'right_k' } })).toBe(
      '{ k: string?, v: number, label: string, right_k: string? }',
    )
    expect(messages({ select: { nope: 'z' } })).toEqual(["select: right has no field 'nope'"])
  })

  it('rejects a name collision, missing or incomparable keys, and a bad where', () => {
    expect(messages({ on: [['v', 'x']] })).toEqual([
      "field 'k' exists on both sides; rename it with select",
    ])
    expect(messages({ on: [['zz', 'yy']], type: 'semi' })).toEqual([
      "left has no field 'zz'",
      "right has no field 'yy'",
    ])
    expect(messages({ on: [['k', 'x']], type: 'semi' })).toEqual([
      'join key k: string? vs x: number',
    ])
    expect(messages({ where: { path: 'nope', eq: 1 } })[0]).toMatch(/^where: unknown field 'nope'/)
    // A where is only compiled once the shape is sound.
    expect(messages({ on: [['zz', 'k']], select: {}, where: { path: 'nope', eq: 1 } })).toEqual([
      "left has no field 'zz'",
    ])
  })

  describe('cardinality', () => {
    const dupRight = [...right, { k: 'a', w: 'A2', x: 11 }]
    const dupLeft = [...left, { k: 'a', v: 9 }]
    it.each([
      ['n:1', left, dupRight, 'right', true],
      ['n:1', dupLeft, right, '', false],
      ['1:n', dupLeft, right, 'left', true],
      ['1:n', left, dupRight, '', false],
      ['1:1', dupLeft, right, 'left', true],
      ['1:1', left, dupRight, 'right', true],
    ] as const)('%s with %#: violation %s', (cardinality, l, r, side, fails) => {
      const result = run({ cardinality, type: 'semi' }, l as never, r as never)
      const stat = result.stats.find((s) => s.node === 'n')
      expect(stat?.status).toBe(fails ? 'failed' : 'ok')
      if (fails) {
        expect(result.issues[0]).toEqual({
          node: 'n',
          code: 'cardinality_violated',
          message: `${cardinality} join: ${side} key ["a"] is not unique`,
          samples: [['a']],
        })
      }
    })

    it('n:m is unchecked but needs a count expectation', () => {
      expect(messages({ cardinality: 'n:m' })).toEqual([
        "an n:m join needs a count expectation in the version's expect block",
      ])
      const result = run({ cardinality: 'n:m', type: 'semi' }, left, [...right, ...right], {
        expect: { n: { count: { max: 10 } } },
      })
      expect(result.outputs?.n).toEqual([{ k: 'a', v: 1 }])
    })

    it('a violation fails only what depends on the join', () => {
      const version = graph(
        {},
        {
          nodes: [{ id: 'w', op: 'sink', in: 'l', target: 't', key: ['v'] }],
        },
      )
      const result = runOf(
        planOf(version, { targets: targetsOf({ t: { k: 'string?', v: 'decimal' } }) }),
        {
          l: left,
          r: dupRight,
        },
      )
      expect(result.status).toBe('partial')
      expect(result.sinks.map((s) => s.status)).toEqual(['write'])
    })
  })

  describe('tolerate_skips', () => {
    const skipping = {
      nodes: [
        {
          id: 'm',
          op: 'map',
          in: 'l',
          fields: [
            { key: 'k', pipeline: [{ op: 'extract', path: 'k' }] },
            {
              key: 'n',
              pipeline: [
                { op: 'extract', path: 'k' },
                { op: 'to_number', strict: true },
              ],
            },
          ],
        },
      ],
    }
    it('a skipping map upstream of a join must be tolerated', () => {
      expect(issuesOf(graph({ left: 'm', type: 'semi' }, skipping))).toEqual([
        expect.objectContaining({ code: 'skip_tolerance', node: 'n' }),
      ])
      expect(issuesOf(graph({ left: 'm', type: 'semi', tolerate_skips: true }, skipping))).toEqual(
        [],
      )
    })
  })
})
