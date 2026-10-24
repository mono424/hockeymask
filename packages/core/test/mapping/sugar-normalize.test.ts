import { describe, expect, it } from 'vite-plus/test'
import type { MappingVersionInput } from '../../src/mapping/document'
import { entityJsonSchema } from '../../src/mapping/jsonschema'
import { normalizeVersion } from '../../src/mapping/sugar'
import { issuesOf, planOf, runOf, schemaOf, targetsOf, versionOf } from './helpers'

const targets = targetsOf({
  warehouse: { id: 'string', code: 'string' },
  item: { sku: 'string', warehouse_id: 'string?', code: 'string?' },
})
const env = { targets }

const lookup = (extra: Record<string, unknown> = {}) => ({
  op: 'lookup_entity',
  entity: 'warehouse',
  by: 'code',
  ...extra,
})

function version(
  pipeline: unknown[],
  mapExtra: Record<string, unknown> = {},
  extra: Partial<MappingVersionInput> = {},
) {
  return versionOf({
    expectedSchema: { s: schemaOf({ sku: 'string', wh: 'string' }) },
    nodes: [
      { id: 's', op: 'source', system: 'x', entity: 'items' },
      {
        id: 'm',
        op: 'map',
        in: 's',
        fields: [
          { key: 'sku', pipeline: [{ op: 'extract', path: 'sku' }] },
          { key: 'warehouse_id', pipeline },
        ],
        ...mapExtra,
      },
      { id: 'out', op: 'sink', in: 'm', target: 'item', key: ['sku'] },
    ],
    ...extra,
  })
}

const extracted = [{ op: 'extract', path: 'wh' }, lookup()]
const snapshot = {
  s: [
    { sku: 'A', wh: 'w1' },
    { sku: 'B', wh: 'W9' },
  ],
  __internal_warehouse: [{ id: '1', code: 'W1' }],
}

describe('normalizeVersion: if_* sugar', () => {
  it('expands sugar in field pipelines, also inside each', () => {
    const { version: out, issues } = normalizeVersion(
      version([
        { op: 'extract', path: 'wh' },
        { op: 'split', separator: ',' },
        { op: 'each', pipeline: [{ op: 'if_eq', value: 'x', then: null }] },
        { op: 'if_is_null', then: [] },
        7,
      ]),
      env,
    )
    expect(issues).toEqual([])
    expect(out.nodes[1]?.fields).toEqual([
      { key: 'sku', pipeline: [{ op: 'extract', path: 'sku' }] },
      {
        key: 'warehouse_id',
        pipeline: [
          { op: 'extract', path: 'wh' },
          { op: 'split', separator: ',' },
          { op: 'each', pipeline: [{ op: 'when', cases: [{ cond: { eq: 'x' }, then: null }] }] },
          { op: 'when', cases: [{ cond: { is_null: true }, then: [] }] },
          7,
        ],
      },
    ])
  })

  it('reports sugar that does not expand, located at its step', () => {
    const { issues } = normalizeVersion(
      version([
        { op: 'extract', path: 'wh' },
        { op: 'each', pipeline: [{ op: 'if_lte', then: 1 }] },
      ]),
      env,
    )
    expect(issues).toEqual([
      {
        code: 'invalid_params',
        message: 'each: if_lte takes exactly one of value, values, date, pattern',
        node: 'm',
        field: 'warehouse_id',
        step: 1,
      },
    ])
  })

  it('leaves nodes that are not maps, and malformed fields, untouched', () => {
    const v = versionOf({
      nodes: [
        { id: 'a', op: 'map', in: 's' },
        { id: 'b', op: 'map', in: 's', fields: ['oops', { key: 'k' }] },
        { id: 'c', op: 'filter', in: 's', cond: {} },
      ],
    })
    expect(normalizeVersion(v, env)).toEqual({ version: v, issues: [] })
  })
})

describe('normalizeVersion: lookup_entity', () => {
  it('rewrites an extracted key into a shared source and an n:1 left join', () => {
    const { version: out, issues } = normalizeVersion(version(extracted), env)
    expect(issues).toEqual([])
    expect(out.nodes.map((n) => n.id)).toEqual([
      's',
      '__internal_warehouse',
      'm__lookup1',
      'm',
      'out',
    ])
    expect(out.nodes[1]).toEqual({
      id: '__internal_warehouse',
      op: 'source',
      system: 'internal',
      entity: 'warehouse',
    })
    expect(out.nodes[2]).toEqual({
      id: 'm__lookup1',
      op: 'join',
      left: 's',
      right: '__internal_warehouse',
      on: [['wh', 'code']],
      type: 'left',
      cardinality: 'n:1',
      select: { id: '__warehouse_id__lookup' },
      tolerate_skips: true,
    })
    expect(out.nodes[3]).toMatchObject({
      in: 'm__lookup1',
      fields: [
        { key: 'sku' },
        { key: 'warehouse_id', pipeline: [{ op: 'extract', path: '__warehouse_id__lookup' }] },
      ],
    })
    expect(out.nodes[3]).not.toHaveProperty('drop')
    expect(out.expectedSchema.__internal_warehouse).toEqual(
      entityJsonSchema(targets.entities[0] as never),
    )
  })

  it('resolves keys to ids end to end; a miss is null by default', () => {
    const run = runOf(
      planOf(version([{ op: 'extract', path: 'wh' }, { op: 'upper' }, lookup()]), env),
      snapshot,
    )
    expect(run.outputs?.out).toEqual([
      { sku: 'A', warehouse_id: '1' },
      { sku: 'B', warehouse_id: null },
    ])
  })

  it('materialises a computed key in a helper map that inherits on_error', () => {
    const { version: out } = normalizeVersion(
      version([{ op: 'extract', path: 'wh' }, { op: 'upper' }, lookup({ field: 'code' })], {
        on_error: 'null',
      }),
      env,
    )
    expect(out.nodes.map((n) => n.id)).toEqual([
      's',
      'm__key1',
      '__internal_warehouse',
      'm__lookup1',
      'm',
      'out',
    ])
    expect(out.nodes[1]).toEqual({
      id: 'm__key1',
      op: 'map',
      in: 's',
      keep: 'all',
      fields: [
        { key: '__warehouse_id__key', pipeline: [{ op: 'extract', path: 'wh' }, { op: 'upper' }] },
      ],
      on_error: 'null',
    })
    expect(out.nodes[3]).toMatchObject({
      left: 'm__key1',
      on: [['__warehouse_id__key', 'code']],
      select: { code: '__warehouse_id__lookup' },
    })
  })

  it('with keep: "all", drops its helper fields from the map output', () => {
    const v = version([{ op: 'extract', path: 'wh' }, { op: 'upper' }, lookup()], {
      keep: 'all',
      drop: [],
    })
    expect(normalizeVersion(v, env).version.nodes[4]).toMatchObject({
      keep: 'all',
      drop: ['__warehouse_id__key', '__warehouse_id__lookup'],
    })
    const withMetrics = versionOf({
      expectedSchema: { s: schemaOf({ sku: 'string', wh: 'string' }) },
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'items' },
        {
          id: 'm',
          op: 'map',
          in: 's',
          keep: 'all',
          fields: [
            { key: 'id', pipeline: [{ op: 'extract', path: 'wh' }, { op: 'upper' }, lookup()] },
          ],
        },
        { id: 'met', op: 'metrics', in: 'm', name: 'resolved' },
      ],
    })
    const run = runOf(planOf(withMetrics, env), snapshot)
    expect(run.outputs?.m).toEqual([
      { sku: 'A', wh: 'w1', id: '1' },
      { sku: 'B', wh: 'W9', id: null },
    ])
  })

  it.each([
    [
      'pass',
      [
        { sku: 'A', warehouse_id: '1' },
        { sku: 'B', warehouse_id: 'W9' },
      ],
      0,
    ],
    ['error', [{ sku: 'A', warehouse_id: '1' }], 1],
  ])('on_miss %s', (onMiss, rows, skipped) => {
    const plan = planOf(
      version([{ op: 'extract', path: 'wh' }, { op: 'upper' }, lookup({ on_miss: onMiss })]),
      env,
    )
    const run = runOf(plan, snapshot)
    expect(run.outputs?.out).toEqual(rows)
    expect(run.stats.find((s) => s.node === 'm')?.skipped).toBe(skipped)
  })

  it('shares one source per entity across fields and maps', () => {
    const v = versionOf({
      expectedSchema: { s: schemaOf({ sku: 'string', wh: 'string' }) },
      nodes: [
        { id: 's', op: 'source', system: 'x', entity: 'items' },
        {
          id: 'm',
          op: 'map',
          in: 's',
          fields: [
            { key: 'sku', pipeline: [{ op: 'extract', path: 'sku' }] },
            { key: 'warehouse_id', pipeline: extracted },
            { key: 'code', pipeline: [{ op: 'extract', path: 'wh' }, lookup({ field: 'code' })] },
          ],
        },
        { id: 'out', op: 'sink', in: 'm', target: 'item', key: ['sku'] },
      ],
    })
    const { version: out } = normalizeVersion(v, env)
    expect(out.nodes.map((n) => n.id)).toEqual([
      's',
      '__internal_warehouse',
      'm__lookup1',
      'm__lookup2',
      'm',
      'out',
    ])
    expect(out.nodes[3]).toMatchObject({ left: 'm__lookup1' })
    const run = runOf(planOf(v, env), { ...snapshot, s: [{ sku: 'A', wh: 'W1' }] })
    expect(run.outputs?.out).toEqual([{ sku: 'A', warehouse_id: '1', code: 'W1' }])
  })

  it.each([
    [
      'an unknown entity',
      [{ op: 'extract', path: 'wh' }, lookup({ entity: 'nope' })],
      "lookup_entity: unknown entity 'nope'",
      1,
    ],
    ['no key before it', [lookup()], 'lookup_entity needs a key; extract it first', 0],
    [
      'two lookups in one field',
      [{ op: 'extract', path: 'wh' }, lookup(), lookup()],
      'use one lookup_entity per field; resolve the others in an upstream map',
      1,
    ],
    [
      'a lookup inside each',
      [
        { op: 'extract', path: 'wh' },
        { op: 'split', separator: ',' },
        { op: 'each', pipeline: [lookup()] },
      ],
      'each: lookup_entity cannot be used inside each',
      2,
    ],
    [
      'bad params',
      [
        { op: 'extract', path: 'wh' },
        { op: 'lookup_entity', entity: 'warehouse', extra: 1 },
      ],
      'lookup_entity: by: Invalid input: expected string, received undefined; : Unrecognized key: "extra"',
      1,
    ],
  ])('reports %s', (_name, pipeline, message, step) => {
    const { issues } = normalizeVersion(version(pipeline), env)
    expect(issues).toEqual([
      { code: 'invalid_params', message, node: 'm', field: 'warehouse_id', step },
    ])
  })

  it('surfaces lookup problems from compileVersion too', () => {
    expect(issuesOf(version([lookup()]), env)).toEqual([
      expect.objectContaining({ code: 'invalid_params', field: 'warehouse_id' }),
      expect.objectContaining({ code: 'type_error', field: 'warehouse_id' }),
    ])
  })
})

describe('normalizeVersion: internal sources', () => {
  it('pins schemas of internal sources from the target model, keeping authored ones', () => {
    const authored = schemaOf({ id: 'string' })
    const v = versionOf({
      expectedSchema: { kept: authored },
      nodes: [
        { id: 'w', op: 'source', system: 'internal', entity: 'warehouse' },
        { id: 'kept', op: 'source', system: 'internal', entity: 'warehouse' },
        { id: 'ghost', op: 'source', system: 'internal', entity: 'nope' },
        { id: 'ext', op: 'source', system: 'erp', entity: 'warehouse' },
      ],
    })
    const { expectedSchema } = normalizeVersion(v, env).version
    expect(expectedSchema).toEqual({
      kept: authored,
      w: entityJsonSchema(targets.entities[0] as never),
    })
  })

  it('is idempotent', () => {
    const once = normalizeVersion(
      version(
        [
          { op: 'extract', path: 'wh' },
          { op: 'upper' },
          lookup(),
          { op: 'if_eq', value: '1', then: null },
        ],
        { keep: 'all' },
      ),
      env,
    )
    const twice = normalizeVersion(once.version, env)
    expect(twice).toEqual({ version: once.version, issues: [] })
  })
})
