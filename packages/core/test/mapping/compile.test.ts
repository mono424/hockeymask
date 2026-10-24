import { describe, expect, it } from 'vite-plus/test'
import { compileVersion, structuralIssues } from '../../src/mapping/compile'
import type { MappingVersionInput } from '../../src/mapping/document'
import { issuesOf, planOf, schemaOf, targetsOf, versionOf } from './helpers'
import { type RecordType, show } from '../../src/mapping/types'

const schemas = { s: schemaOf({ a: 'string', n: 'number?' }), s2: schemaOf({ k: 'number' }) }
const targets = targetsOf({ t: { a: 'string', k: 'decimal?', n: 'decimal?' } })

const source = (id = 's') => ({ id, op: 'source', system: 'x', entity: id })
const extract = (key: string, path = key) => ({ key, pipeline: [{ op: 'extract', path }] })
const map = (id: string, input: string, fields: unknown[] = [extract('a')], extra = {}) => ({
  id,
  op: 'map',
  in: input,
  fields,
  ...extra,
})
const sink = (id: string, input: string, key = ['a'], extra = {}) => ({
  id,
  op: 'sink',
  in: input,
  target: 't',
  key,
  ...extra,
})

/** A strict `to_number`: the map can fail a field, so `skip_record` can drop records. */
const fallible = {
  key: 'k',
  pipeline: [
    { op: 'extract', path: 'a' },
    { op: 'to_number', strict: true },
  ],
}

function v(nodes: unknown[], extra: Partial<MappingVersionInput> = {}) {
  return versionOf({
    expectedSchema: schemas,
    nodes: nodes as MappingVersionInput['nodes'],
    ...extra,
  })
}

const codes = (version: ReturnType<typeof v>) =>
  issuesOf(version, { targets }).map((i) => [i.code, i.node])

describe('structuralIssues', () => {
  it('accepts a well-formed graph', () => {
    expect(structuralIssues(v([source(), map('m', 's'), sink('out', 'm')]))).toEqual([])
  })

  it.each([
    [
      'duplicate id',
      [source(), source(), map('m', 's'), sink('out', 'm')],
      [['duplicate_id', 's']],
    ],
    [
      'unknown op',
      [source(), { id: 'x', op: 'nope' }, map('m', 's'), sink('out', 'm')],
      [['unknown_op', 'x']],
    ],
    [
      'missing input',
      [source(), map('m', 's'), sink('out', 'm'), { id: 'loose', op: 'map', fields: [] }],
      [
        ['missing_input', 'loose'],
        ['dead_node', 'loose'],
      ],
    ],
    [
      'dangling ref (leaving the source dead)',
      [source(), map('m', 'ghost'), sink('out', 'm')],
      [
        ['dangling_ref', 'm'],
        ['dead_node', 's'],
      ],
    ],
    [
      'reading a node without output',
      [
        source(),
        { id: 'met', op: 'metrics', in: 's', name: 'm' },
        map('m', 'met'),
        sink('out', 'm'),
      ],
      [['dangling_ref', 'm']],
    ],
    [
      'cycle',
      [source(), map('map1', 'map2'), map('map2', 'map1'), sink('out', 'map2')],
      [
        ['cycle', 'map1'],
        ['dead_node', 's'],
      ],
    ],
    [
      'dead node',
      [source(), map('m', 's'), sink('out', 'm'), { id: 'f', op: 'filter', in: 'm', cond: {} }],
      [['dead_node', 'f']],
    ],
  ])('%s', (_name, nodes, expected) => {
    expect(structuralIssues(v(nodes)).map((i) => [i.code, i.node])).toEqual(expected)
  })

  it('reports expect entries for unknown nodes', () => {
    const version = v([source(), map('m', 's'), sink('out', 'm')], {
      expect: { ghost: { unique: ['a'] } },
    })
    expect(structuralIssues(version)).toEqual([
      { code: 'unknown_reference', message: "expect names unknown node 'ghost'", field: 'ghost' },
    ])
  })

  it('names the cycle path', () => {
    const [issue] = structuralIssues(
      v([source(), map('map1', 'map2'), map('map2', 'map1'), sink('out', 'map2')]),
    )
    expect(issue?.message).toBe('cycle: map1 -> map2 -> map1')
  })
})

describe('compileVersion', () => {
  it('stops after structural problems that make the graph ambiguous', () => {
    const cyclic = compileVersion(
      v([source(), map('map1', 'map2'), map('map2', 'map1'), sink('out', 'map2')]),
      { targets },
    )
    expect(cyclic.ok).toBe(false)
    expect(cyclic.issues.map((i) => i.code)).toEqual(['cycle', 'dead_node'])
    const duplicate = compileVersion(v([source(), source(), map('m', 's'), sink('out', 'm')]), {
      targets,
    })
    expect(duplicate.issues.map((i) => i.code)).toEqual(['duplicate_id'])
  })

  it('collects every problem in one pass, located by node, field and step', () => {
    const version = v([
      source(),
      map('m', 's', [
        extract('a'),
        extract('ghost'),
        {
          key: 'k',
          pipeline: [
            { op: 'extract', path: 'a' },
            { op: 'divide', by: 2 },
          ],
        },
      ]),
      sink('out', 'm'),
      map('map2', 's', [extract('a'), { key: 'zz', pipeline: [{ op: 'const', value: 1 }] }]),
      sink('out2', 'map2'),
    ])
    expect(issuesOf(version, { targets })).toEqual([
      expect.objectContaining({ code: 'type_error', node: 'm', field: 'ghost', step: 0 }),
      expect.objectContaining({ code: 'type_error', node: 'm', field: 'k', step: 1 }),
      expect.objectContaining({
        code: 'type_error',
        node: 'map2',
        field: 'zz',
        message: "t has no field 'zz'",
      }),
    ])
  })

  it('skips nodes of unknown ops after reporting them', () => {
    const version = v([source(), map('m', 's'), sink('out', 'm'), { id: 'z', op: 'nope', in: 'm' }])
    expect(codes(version)).toEqual([['unknown_op', 'z']])
  })

  it('does not cascade from a node that failed to compile', () => {
    const version = v([
      source(),
      map('m', 's', [extract('ghost')]),
      map('map3', 'm'),
      sink('out', 'map3'),
    ])
    expect(codes(version)).toEqual([['type_error', 'm']])
  })

  it('reports invalid params with their path, or without one', () => {
    const version = v([
      { ...source(), bogus: 1 },
      map('m', 's', [{ pipeline: [] }]),
      sink('out', 'm'),
    ])
    const messages = issuesOf(version, { targets }).map((i) => [i.code, i.node, i.message])
    expect(messages).toEqual([['invalid_params', 's', 'Unrecognized key: "bogus"']])
    const bad = v([source(), map('m', 's', [{ pipeline: [] }]), sink('out', 'm')])
    expect(issuesOf(bad, { targets }).map((i) => i.message)).toEqual([
      'fields.0.key: Invalid input: expected string, received undefined',
      'fields.0.pipeline: Too small: expected array to have >=1 items',
    ])
  })

  it('blames the map field that produced a value the sink rejects', () => {
    const version = v([
      source(),
      map('m', 's', [extract('a'), { key: 'k', pipeline: [{ op: 'const', value: 'x' }] }]),
      sink('out', 'm'),
    ])
    expect(issuesOf(version, { targets })).toEqual([
      { code: 'type_error', message: 'k expects number?, got string', node: 'm', field: 'k' },
    ])
  })

  it('reports sugar problems found while normalizing', () => {
    const version = v([
      source(),
      map('m', 's', [
        {
          key: 'a',
          pipeline: [
            { op: 'extract', path: 'a' },
            { op: 'if_lte', then: null },
          ],
        },
      ]),
      sink('out', 'm'),
    ])
    expect(issuesOf(version, { targets })).toEqual([
      expect.objectContaining({ code: 'invalid_params', node: 'm', field: 'a', step: 1 }),
    ])
  })

  it('allows one sink per target entity, counting entities written through dotted paths', () => {
    const product = targetsOf({
      product: { sku: 'string' },
      product_dimensions: { width: 'decimal?' },
    })
    const version = versionOf({
      expectedSchema: { s: schemaOf({ sku: 'string', w: 'number' }) },
      nodes: [
        source(),
        map('m', 's', [extract('product.sku', 'sku'), extract('product_dimensions.width', 'w')]),
        { id: 'a', op: 'sink', in: 'm', target: 'product', key: ['product.sku'] },
        map('map2', 's', [extract('width', 'w')]),
        { id: 'b', op: 'sink', in: 'map2', target: 'product_dimensions', key: ['width'] },
      ],
    })
    expect(issuesOf(version, { targets: product })).toEqual([
      {
        code: 'duplicate_sink',
        message: 'a and b both write product_dimensions; union their inputs into one sink',
        node: 'b',
      },
    ])
  })

  it('rejects an expectation on a node without output, and invalid expectations', () => {
    const onSink = v([source(), map('m', 's'), sink('out', 'm')], {
      expect: { out: { unique: ['a'] } },
    })
    expect(issuesOf(onSink, { targets })).toEqual([
      { code: 'invalid_expectation', message: 'sink has no output to expect on', node: 'out' },
    ])
    const unknown = v([source(), map('m', 's'), sink('out', 'm')], {
      expect: { m: { unique: ['zz'] } },
    })
    expect(issuesOf(unknown, { targets })).toEqual([
      { code: 'invalid_expectation', message: 'unknown fields: zz', node: 'm', field: 'unique' },
    ])
  })
})

describe('records a map drops must not silently flip a join or aggregate', () => {
  const graph = (mapExtra = {}, joinExtra = {}, through = false) =>
    v([
      source(),
      source('s2'),
      map('m', 's', [fallible], mapExtra),
      ...(through ? [{ id: 'f', op: 'filter', in: 'm', cond: { path: 'k', gt: 0 } }] : []),
      {
        id: 'j',
        op: 'join',
        left: through ? 'f' : 'm',
        right: 's2',
        on: [['k', 'k']],
        cardinality: 'n:1',
        ...joinExtra,
      },
      { id: 'out', op: 'sink', in: 'j', target: 't', key: ['k'] },
    ])

  it.each([
    ['directly', graph()],
    ['through a filter', graph({}, {}, true)],
  ])('rejects a skip-capable map upstream of a join %s', (_name, version) => {
    expect(issuesOf(version, { targets })).toEqual([
      expect.objectContaining({
        code: 'skip_tolerance',
        node: 'j',
        message: expect.stringContaining('m can drop records'),
      }),
    ])
  })

  it.each([
    ['tolerate_skips', graph({}, { tolerate_skips: true })],
    ['on_error null', graph({ on_error: 'null' })],
    ['on_error skip_field', graph({ on_error: 'skip_field' })],
  ])('accepts %s', (_name, version) => {
    expect(issuesOf(version, { targets }).filter((i) => i.code === 'skip_tolerance')).toEqual([])
  })

  it('accepts a map built only from infallible ops', () => {
    const version = v([
      source(),
      map('m', 's', [extract('a')]),
      { id: 'g', op: 'aggregate', in: 'm', group_by: ['a'], fields: { n: { agg: 'count' } } },
      { id: 'out', op: 'sink', in: 'g', target: 't', key: ['a'] },
    ])
    expect(issuesOf(version, { targets: targetsOf({ t: { a: 'string', n: 'integer' } }) })).toEqual(
      [],
    )
  })

  it('checks only the first join or aggregate on each path, once per pair', () => {
    const version = v([
      source(),
      map('m', 's', [extract('a'), fallible]),
      { id: 'g', op: 'aggregate', in: 'm', group_by: ['a'], fields: { n: { agg: 'count' } } },
      { id: 'g2', op: 'aggregate', in: 'g', group_by: ['a'], fields: { c: { agg: 'count' } } },
      { id: 'f1', op: 'filter', in: 'm', cond: { path: 'a', eq: 'x' } },
      { id: 'f2', op: 'filter', in: 'm', cond: { path: 'a', eq: 'y' } },
      { id: 'u', op: 'union', inputs: ['f1', 'f2'] },
      { id: 'g3', op: 'aggregate', in: 'u', group_by: ['a'], fields: { c: { agg: 'count' } } },
      { id: 'met', op: 'metrics', in: 'g2', name: 'x' },
      { id: 'met3', op: 'metrics', in: 'g3', name: 'y' },
    ])
    const nodes = issuesOf(version, { targets }).map((i) => `${i.code} ${i.node}`)
    expect(nodes.sort((x, y) => x.localeCompare(y))).toEqual([
      'skip_tolerance g',
      'skip_tolerance g3',
    ])
  })
})

describe('plan', () => {
  it('orders nodes, frees edges after their last use, and traces lineage', () => {
    const plan = planOf(
      v([
        source(),
        map('m', 's'),
        sink('out', 'm'),
        { id: 'g', op: 'aggregate', in: 's', group_by: [], fields: { n: { agg: 'count' } } },
        { id: 'met', op: 'metrics', in: 'g', name: 'count' },
      ]),
      { targets },
    )
    expect(plan.nodes.map((n) => [n.id, n.inputs, n.sinks, n.feedsMetrics, n.effect])).toEqual([
      ['s', [], ['out'], true, undefined],
      ['m', ['s'], ['out'], false, undefined],
      ['out', ['m'], ['out'], false, 'sink'],
      ['g', ['s'], [], true, undefined],
      ['met', ['g'], [], true, 'metrics'],
    ])
    expect([...plan.lastUse]).toEqual([
      ['s', 3],
      ['m', 2],
      ['g', 4],
    ])
    expect(plan.nodes[0]?.params).toEqual({ system: 'x', entity: 's' })
    expect(plan.usesClock).toBe(false)
  })

  it('notes when a predicate reads the run clock', () => {
    const plan = planOf(
      v([
        source(),
        map('m', 's', [
          extract('a'),
          {
            key: 'k',
            pipeline: [
              { op: 'extract', path: 'a' },
              { op: 'to_date', format: 'iso' },
              { op: 'if_after', date: 'today', then: null },
              { op: 'to_string' },
            ],
          },
        ]),
        sink('out', 'm', ['a'], { columns: { k: 'a2' } }),
      ]),
      { targets: targetsOf({ t: { a: 'string', a2: 'string?' } }) },
    )
    expect(plan.usesClock).toBe(true)
  })
})

describe('types', () => {
  it('reports the record types of the nodes that compiled, also when others fail', () => {
    const version = versionOf({
      expectedSchema: { s: schemaOf({ a: 'string', n: 'number?' }) },
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'y' },
        {
          id: 'm',
          op: 'map',
          in: 's',
          fields: [{ key: 'b', pipeline: [{ op: 'extract', path: 'nope' }] }],
        },
        { id: 'out', op: 'sink', in: 'm', target: 't', key: ['b'] },
      ],
    })
    const result = compileVersion(version, { targets: targetsOf({ t: { b: 'string' } }) })
    expect(result.ok).toBe(false)
    expect(Object.keys(result.types)).toEqual(['s'])
    expect(show(result.types.s as RecordType)).toBe('{ a: string, n: number? }')
  })
})
