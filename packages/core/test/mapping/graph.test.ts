import { describe, expect, it } from 'vite-plus/test'
import type { NodeJson } from '../../src/mapping/document'
import {
  consumers,
  downstream,
  findGraphCycle,
  inputIds,
  nodeRefs,
  topologicalOrder,
  upstream,
} from '../../src/mapping/graph'

const n = (id: string, op: string, params: Record<string, unknown> = {}): NodeJson => ({
  id,
  op,
  ...params,
})

describe('nodeRefs', () => {
  it.each([
    ['single slot', n('m', 'map', { in: 's' }), [{ slot: 'in', source: 's' }]],
    [
      'two slots',
      n('j', 'join', { left: 'a', right: 'b' }),
      [
        { slot: 'left', source: 'a' },
        { slot: 'right', source: 'b' },
      ],
    ],
    [
      'a multiple slot, skipping blanks and non-strings',
      n('u', 'union', { inputs: ['a', '', 3, 'b'] }),
      [
        { slot: 'inputs', source: 'a', index: 0 },
        { slot: 'inputs', source: 'b', index: 3 },
      ],
    ],
    [
      'nested assert refs',
      n('x', 'assert', { in: 'l', per: { in: 'r' }, remove: { in: 'e' } }),
      [
        { slot: 'in', source: 'l' },
        { slot: 'per', source: 'r' },
        { slot: 'remove', source: 'e' },
      ],
    ],
    [
      'a nested slot under a non-object',
      n('x', 'assert', { in: 'l', per: 'r' }),
      [{ slot: 'in', source: 'l' }],
    ],
    ['an empty or missing reference', n('m', 'map', { in: '' }), []],
    ['a list in a single slot', n('m', 'map', { in: ['s'] }), []],
    ['an unknown op', n('z', 'nope', { in: 's' }), []],
    ['a source', n('s', 'source'), []],
  ])('%s', (_name, node, refs) => {
    expect(nodeRefs(node)).toEqual(refs)
  })

  it('inputIds lists each upstream node once', () => {
    expect(inputIds(n('j', 'join', { left: 'a', right: 'a' }))).toEqual(['a'])
  })
})

describe('walking the graph', () => {
  const nodes = [
    n('s', 'source'),
    n('m', 'map', { in: 's' }),
    n('f', 'filter', { in: 'm' }),
    n('g', 'aggregate', { in: 's' }),
    n('j', 'join', { left: 'f', right: 'g' }),
    n('x', 'map', { in: 'ghost' }),
  ]

  it('consumers ignore references to missing nodes', () => {
    expect(Object.fromEntries(consumers(nodes))).toEqual({
      s: ['m', 'g'],
      m: ['f'],
      f: ['j'],
      g: ['j'],
      j: [],
      x: [],
    })
  })

  it('downstream and upstream are transitive and exclude the start', () => {
    expect([...downstream(nodes, 's')].sort()).toEqual(['f', 'g', 'j', 'm'])
    expect([...downstream(nodes, 'j')]).toEqual([])
    expect([...upstream(nodes, 'j')].sort()).toEqual(['f', 'g', 'm', 's'])
    expect([...upstream(nodes, 'x')]).toEqual([])
    expect([...downstream(nodes, 'ghost')]).toEqual([])
  })

  it('orders nodes topologically, ties in document order', () => {
    // Of the nodes that are ready, the one earliest in the document runs first.
    expect(topologicalOrder(nodes)).toEqual(['s', 'm', 'f', 'g', 'j', 'x'])
    expect(
      topologicalOrder([n('b', 'map', { in: 'a' }), n('a', 'source'), n('c', 'source')]),
    ).toEqual(['a', 'b', 'c'])
  })

  it('finds no cycle in a DAG', () => {
    expect(findGraphCycle(nodes)).toBeNull()
  })

  it('finds a cycle, and leaves its nodes out of the order', () => {
    const cyclic = [
      n('s', 'source'),
      n('a', 'map', { in: 'b' }),
      n('b', 'map', { in: 'a' }),
      n('c', 'map', { in: 'b' }),
    ]
    expect(findGraphCycle(cyclic)).toEqual(['a', 'b', 'a'])
    expect(topologicalOrder(cyclic)).toEqual(['s'])
  })

  it('finds a cycle reached from a later root', () => {
    const cyclic = [
      n('s', 'source'),
      n('t', 'map', { in: 's' }),
      n('a', 'union', { inputs: ['t', 'b'] }),
      n('b', 'map', { in: 'a' }),
    ]
    expect(findGraphCycle(cyclic)).toEqual(['a', 'b', 'a'])
  })
})
