import { describe, expect, it } from 'vite-plus/test'
import type { MappingVersionInput } from '../../../src/mapping/document'
import { findCycle } from '../../../src/mapping/nodes'
import { show } from '../../../src/mapping/types'
import { issuesOf, planOf, runOf, schemaOf, targetsOf, versionOf } from '../helpers'
import { messagesOf, outputAt, single } from './util'

const fields = { a: 'string', n: 'number?' } as const
const rows = [
  { a: 'x', n: 1 },
  { a: 'x', n: 2 },
  { a: 'y', n: null },
]
const check = (node: Record<string, unknown>, input = rows, options = {}) =>
  runOf(planOf(single({ op: 'assert', ...node }, fields)), { s: input }, options)

describe('assert: count, unique, rows', () => {
  it('count passes its input through and alerts by default', () => {
    const run = check({ check: 'count', min: 5, max: 10 })
    expect(run.outputs?.n).toEqual(rows)
    expect(run.issues).toEqual([
      {
        node: 'n',
        code: 'assert',
        clause: 'count',
        action: 'alert',
        message: 'count 3 below 5',
        count: 1,
        samples: [3],
      },
    ])
    expect(check({ check: 'count', max: 1 }).issues[0]?.message).toBe('count 3 above 1')
    expect(check({ check: 'count', min: 1 }).issues).toEqual([])
  })

  it('count is skipped in fixture runs', () => {
    expect(check({ check: 'count', min: 5 }, rows, { fixture: true }).issues).toEqual([])
  })

  it('unique with drop_rows drops every row of a duplicated key', () => {
    const run = check({ check: 'unique', keys: ['a'], on_fail: 'drop_rows' })
    expect(run.outputs?.n).toEqual([{ a: 'y', n: null }])
    expect(run.stats[1]?.changed).toBe(2)
    expect(run.issues[0]).toMatchObject({ clause: 'unique', rowsAffected: 2, samples: [['x']] })
    expect(check({ check: 'unique', keys: ['n'] }).issues).toEqual([])
  })

  it('rows with set_null repairs rows and widens the output type', () => {
    const node = { check: 'rows', cond: { path: 'a', eq: 'x' }, on_fail: { set_null: ['a'] } }
    const plan = planOf(single({ op: 'assert', ...node }, fields))
    expect(show(outputAt(plan).type)).toBe('{ a: string?, n: number? }')
    expect(check(node).outputs?.n).toEqual([...rows.slice(0, 2), { a: null, n: null }])
  })

  it('rows with set_default, and stop', () => {
    const fix = {
      check: 'rows',
      cond: { path: 'n', is_null: false },
      on_fail: { set_default: { n: 0 } },
    }
    expect(check(fix).outputs?.n?.[2]).toEqual({ a: 'y', n: 0 })
    const run = check({ check: 'rows', cond: { path: 'n', is_null: false }, on_fail: 'stop' })
    expect(run.status).toBe('stopped')
  })

  it('skip_downstream holds the sinks below the assert', () => {
    const version = single(
      { op: 'assert', check: 'count', max: 0, on_fail: 'skip_downstream' },
      fields,
      {
        nodes: [{ id: 'w', op: 'sink', in: 'n', target: 't', key: ['a'] }],
      },
    )
    const plan = planOf(version, { targets: targetsOf({ t: { a: 'string', n: 'decimal?' } }) })
    expect(runOf(plan, { s: [{ a: 'x' }] }).sinks).toEqual([{ sink: 'w', status: 'held' }])
  })

  it('rejects actions that do not fit, unknown keys and bad conditions', () => {
    expect(messagesOf({ op: 'assert', check: 'count', on_fail: 'drop_rows' }, fields)).toEqual([
      'on_fail: action drop_rows does not apply to count',
    ])
    expect(messagesOf({ op: 'assert', check: 'unique', keys: ['zz'] }, fields)).toEqual([
      "keys: unknown field 'zz'",
    ])
    expect(messagesOf({ op: 'assert', check: 'rows', cond: { eq: 1 } }, fields)).toEqual([
      'cond: this condition has no piped value to test; give it a "path"',
    ])
    expect(messagesOf({ op: 'assert', check: 'nope' }, fields)[0]).toMatch(/check/)
  })
})

const edges = [
  { from: 'W1', to: 'W2' },
  { from: 'W2', to: 'W1' },
  { from: 'W2', to: 'W3' },
  { from: null, to: 'W3' },
]

function acyclic(node: Record<string, unknown>, extra: Partial<MappingVersionInput> = {}) {
  return versionOf({
    expectedSchema: {
      e: schemaOf({ from: 'string?', to: 'string', w: 'number?' }),
      g: schemaOf({ k: 'string?', n: 'number' }),
      r: schemaOf({ k: 'string?', from: 'string', to: 'string', kind: 'string', n: 'number' }),
    },
    nodes: [
      { id: 'e', op: 'source', system: 'x', entity: 'e' },
      ...(node.per ? [{ id: 'g', op: 'source', system: 'x', entity: 'g' }] : []),
      ...(node.remove ? [{ id: 'r', op: 'source', system: 'x', entity: 'r' }] : []),
      {
        id: 'n',
        op: 'assert',
        check: 'acyclic',
        in: 'e',
        edge: { from: 'from', to: 'to' },
        ...node,
      },
    ],
    ...extra,
  })
}
const per = { in: 'g', key: 'k' }
const remove = {
  in: 'r',
  key: 'k',
  from: 'from',
  to: 'to',
  where: { path: 'kind', eq: 'transfer' },
}

describe('assert: acyclic', () => {
  it('checks the whole edge relation without per', () => {
    const run = runOf(planOf(acyclic({})), { e: edges })
    expect(run.issues).toEqual([
      expect.objectContaining({
        clause: 'acyclic',
        action: 'alert',
        count: 1,
        message: '1 graph has a cycle, e.g. W1 -> W2 -> W1',
        samples: [{ group: null, cycle: ['W1', 'W2', 'W1'] }],
      }),
    ])
    expect(runOf(planOf(acyclic({})), { e: edges.slice(1) }).issues).toEqual([])
    expect(runOf(planOf(acyclic({})), { e: [] }).issues).toEqual([])
  })

  it('checks once per group, after removing that group’s rows', () => {
    const groups = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((k) => ({ k, n: 1 }))
    const removals = [
      { k: 'A', from: 'W2', to: 'W1', kind: 'transfer', n: 1 },
      { k: 'B', from: 'W2', to: 'W1', kind: 'purchase', n: 1 },
    ]
    const run = runOf(planOf(acyclic({ per, remove, on_fail: 'stop' })), {
      e: edges,
      g: [...groups, { k: null, n: 0 }],
      r: removals,
    })
    expect(run.status).toBe('stopped')
    const issue = run.issues[0]
    expect(issue?.count).toBe(6)
    expect(issue?.message).toBe('6 groups have a cycle, e.g. B: W1 -> W2 -> W1')
    expect(issue?.samples).toHaveLength(5)
  })

  it('skips edges and removals with absent ends', () => {
    const omit = (path: string) => ({
      key: path,
      pipeline: [{ op: 'extract', path }, { op: 'omit_if_null' }],
    })
    const version = versionOf({
      expectedSchema: {
        e: schemaOf({ from: 'string?', to: 'string?' }),
        g: schemaOf({ k: 'string' }),
        r: schemaOf({ k: 'string?', from: 'string?', to: 'string?' }),
      },
      nodes: [
        { id: 'e', op: 'source', system: 'x', entity: 'e' },
        { id: 'g', op: 'source', system: 'x', entity: 'g' },
        { id: 'r', op: 'source', system: 'x', entity: 'r' },
        { id: 'em', op: 'map', in: 'e', fields: [omit('from'), omit('to')] },
        { id: 'rm', op: 'map', in: 'r', fields: [omit('k'), omit('from'), omit('to')] },
        {
          id: 'n',
          op: 'assert',
          check: 'acyclic',
          in: 'em',
          edge: { from: 'from', to: 'to' },
          per,
          remove: { in: 'rm', key: 'k', from: 'from', to: 'to' },
        },
      ],
    })
    const run = runOf(planOf(version), {
      e: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a' }],
      g: [{ k: 'A' }],
      r: [{}, { k: 'A', from: 'b', to: 'a' }],
    })
    expect(run.issues).toEqual([])
  })

  it('works on non-string edges and group keys', () => {
    const version = versionOf({
      expectedSchema: {
        e: schemaOf({ from: 'number', to: 'number' }),
        g: schemaOf({ k: 'number' }),
      },
      nodes: [
        { id: 'e', op: 'source', system: 'x', entity: 'e' },
        { id: 'g', op: 'source', system: 'x', entity: 'g' },
        { id: 'n', op: 'assert', check: 'acyclic', in: 'e', edge: { from: 'from', to: 'to' }, per },
      ],
    })
    const run = runOf(planOf(version), {
      e: [
        { from: 1, to: 2 },
        { from: 2, to: 1 },
      ],
      g: [{ k: 7 }],
    })
    expect(run.issues[0]?.message).toBe('1 groups have a cycle, e.g. 7: d1 -> d2 -> d1')
  })

  it('rejects unknown fields, incomparable types, a bad where and remove without per', () => {
    const messages = (node: Record<string, unknown>) =>
      issuesOf(acyclic(node)).map((i) => i.message)
    expect(messages({ edge: { from: 'zz', to: 'w' }, per: { in: 'g', key: 'q' } })).toEqual([
      "edge: unknown field 'zz'",
      "per: unknown field 'q'",
    ])
    expect(messages({ edge: { from: 'from', to: 'w' } })).toEqual(['edge: string? vs number?'])
    expect(
      messages({ per, remove: { in: 'r', key: 'n', from: 'n', to: 'to', where: { eq: 1 } } }),
    ).toEqual([
      'remove.from: number vs string?',
      'remove.key: number vs string?',
      'remove.where: this condition has no piped value to test; give it a "path"',
    ])
    expect(messages({ remove: { in: 'r', key: 'zz', from: 'from', to: 'to' } })).toEqual([
      'remove needs per or edge.key',
      "remove: unknown field 'zz'",
    ])
    expect(messages({ on_fail: { set_null: ['to'] } })).toEqual([
      'on_fail: action set_null does not apply to acyclic',
    ])
  })
})

describe('assert: acyclic with edges grouped by edge.key', () => {
  // Each product has its own supply graph; warehouse ids are numbers, products strings.
  function grouped(
    node: Record<string, unknown> = {},
    extra: { id: string; op: string; [key: string]: unknown }[] = [],
  ) {
    return versionOf({
      expectedSchema: {
        e: schemaOf({ k: 'string?', from: 'number?', to: 'number' }),
        g: schemaOf({ k: 'string' }),
        r: schemaOf({ k: 'string', from: 'number', to: 'number' }),
      },
      nodes: [
        { id: 'e', op: 'source', system: 'x', entity: 'e' },
        { id: 'g', op: 'source', system: 'x', entity: 'g' },
        { id: 'r', op: 'source', system: 'x', entity: 'r' },
        {
          id: 'n',
          op: 'assert',
          check: 'acyclic',
          in: 'e',
          edge: { from: 'from', to: 'to', key: 'k' },
          ...node,
        },
        ...extra,
      ],
    })
  }
  const routes = [
    // A1 and A2 each use one direction between warehouses 1 and 2: no cycle per product.
    { k: 'A1', from: 1, to: 2 },
    { k: 'A1', from: 2, to: 3 },
    { k: 'A2', from: 2, to: 1 },
    // A3 has both directions.
    { k: 'A3', from: 1, to: 2 },
    { k: 'A3', from: 2, to: 1 },
    // Rows without a key, or without an end, are no edges.
    { k: null, from: 3, to: 1 },
    { k: 'A1', from: null, to: 1 },
  ]
  const sinks = [
    { id: 'gm', op: 'metrics', in: 'g', name: 'g' },
    { id: 'rm', op: 'metrics', in: 'r', name: 'r' },
  ]

  it('checks each group on its own edges only', () => {
    const run = runOf(planOf(grouped({}, sinks)), { e: routes, g: [], r: [] })
    expect(run.issues).toEqual([
      expect.objectContaining({
        clause: 'acyclic',
        count: 1,
        message: '1 groups have a cycle, e.g. A3: d1 -> d2 -> d1',
        samples: [{ group: 'A3', cycle: ['d1', 'd2', 'd1'] }],
      }),
    ])
    // Shared edges would join A1's and A2's routes into a cycle.
    const shared = grouped({ edge: { from: 'from', to: 'to' } }, sinks)
    expect(runOf(planOf(shared), { e: routes.slice(0, 3), g: [], r: [] }).issues).toHaveLength(1)
  })

  it('removes a group’s own rows first', () => {
    const run = runOf(
      planOf(grouped({ remove: { in: 'r', key: 'k', from: 'from', to: 'to' } }, sinks.slice(0, 1))),
      {
        e: routes,
        g: [],
        r: [
          { k: 'A3', from: 2, to: 1 },
          { k: 'A1', from: 1, to: 2 },
        ],
      },
    )
    expect(run.issues).toEqual([])
  })

  it('rejects per next to edge.key, unknown and incomparable fields', () => {
    const messages = (node: Record<string, unknown>, extra = sinks) =>
      issuesOf(grouped(node, extra)).map((i) => i.message)
    expect(messages({ per: { in: 'g', key: 'k' } }, sinks.slice(1))).toEqual([
      'edge.key groups the edges itself; drop per',
    ])
    expect(messages({ edge: { from: 'from', to: 'to', key: 'zz' } })).toEqual([
      "edge: unknown field 'zz'",
    ])
    expect(
      messages({ remove: { in: 'r', key: 'from', from: 'from', to: 'to' } }, sinks.slice(0, 1)),
    ).toEqual(['remove.key: number vs string?'])
  })
})

describe('findCycle', () => {
  it.each([
    [[], undefined],
    [
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
      undefined,
    ],
    [
      [
        ['a', 'b'],
        ['a', 'c'],
        ['c', 'b'],
      ],
      undefined,
    ],
    [
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'b'],
      ],
      ['b', 'c', 'b'],
    ],
    [[['z', 'z']], ['z', 'z']],
  ] as const)('%j', (graph, cycle) => {
    expect(findCycle(graph as never)).toEqual(cycle)
  })
})
