import { describe, expect, it } from 'vite-plus/test'
import { resolveTarget } from '../../../src/mapping/nodes'
import { issuesOf, planOf, runOf, schemaOf, targetsOf, versionOf } from '../helpers'

const targets = targetsOf({
  item: { sku: 'string', name: 'string', weight: 'decimal?', listed: 'date?', seen: 'timestamp?' },
  item_settings: { width: 'decimal?' },
})
const extract = (path: string) => [{ op: 'extract', path }]

function graph(fields: Record<string, unknown[]>, sink: Record<string, unknown>) {
  return versionOf({
    expectedSchema: { s: schemaOf({ a: 'string', b: 'string', n: 'number?', d: 'string?' }) },
    nodes: [
      { id: 's', op: 'source', system: 'x', entity: 'y' },
      {
        id: 'm',
        op: 'map',
        in: 's',
        fields: Object.entries(fields).map(([key, pipeline]) => ({ key, pipeline })),
      },
      { id: 'w', op: 'sink', in: 'm', target: 'item', key: ['sku'], ...sink },
    ],
  })
}
const messages = (version: ReturnType<typeof versionOf>) =>
  issuesOf(version, { targets }).map(({ message, node, field }) => ({ message, node, field }))

describe('resolveTarget', () => {
  it('reads entity.field, or a bare field of the sink target', () => {
    expect(resolveTarget(targets, 'item', 'item_settings.width')).toMatchObject({ ok: true })
    expect(resolveTarget(targets, 'item', 'sku')).toMatchObject({ ok: true })
    expect(resolveTarget(targets, 'item', 'nope.x')).toEqual({
      ok: false,
      error: "target has no entity 'nope'",
    })
    expect(resolveTarget(targets, 'item', 'zip')).toEqual({
      ok: false,
      error: "item has no field 'zip'",
    })
  })
})

describe('sink', () => {
  const base = { sku: extract('a'), name: extract('b') }

  it('writes rows sorted by key, under target paths, with the write policy', () => {
    const version = graph(
      { ...base, width: [...extract('n'), { op: 'divide', by: 1000 }] },
      { columns: { width: 'item_settings.width' }, write: { name: 'fill_if_null' } },
    )
    const plan = planOf(version, { targets })
    const run = runOf(plan, {
      s: [
        { a: 'B', b: 'b', n: 5 },
        { a: 'A', b: 'a' },
      ],
    })
    expect(run.sinks).toEqual([
      {
        sink: 'w',
        status: 'write',
        write: {
          sink: 'w',
          target: 'item',
          key: ['sku'],
          rows: [
            { sku: 'A', name: 'a', 'item_settings.width': null },
            { sku: 'B', name: 'b', 'item_settings.width': 0.005 },
          ],
          write: { name: 'fill_if_null' },
        },
      },
    ])
  })

  it('writes dates as YYYY-MM-DD in the run time zone and timestamps as ISO', () => {
    const date = [...extract('d'), { op: 'to_date', format: 'iso' }]
    const version = graph({ ...base, listed: date, seen: date }, {})
    const run = runOf(
      planOf(version, { targets }),
      {
        s: [
          { a: 'A', b: 'a', d: '2026-01-31T23:30:00Z' },
          { a: 'B', b: 'b' },
        ],
      },
      { tz: 'Europe/Berlin' },
    )
    expect(run.sinks[0]?.write?.rows).toEqual([
      { sku: 'A', name: 'a', listed: '2026-02-01', seen: '2026-01-31T23:30:00.000Z' },
      { sku: 'B', name: 'b', listed: null, seen: null },
    ])
  })

  it('leaves absent (omitted) fields out of the write', () => {
    const version = graph({ ...base, weight: [...extract('n'), { op: 'omit_if_null' }] }, {})
    const run = runOf(planOf(version, { targets }), { s: [{ a: 'A', b: 'a' }] })
    expect(run.sinks[0]?.write?.rows).toEqual([{ sku: 'A', name: 'a' }])
  })

  it('accepts an omittable field for a required target field', () => {
    const version = graph(
      { sku: extract('a'), name: [...extract('d'), { op: 'omit_if_null' }] },
      {},
    )
    expect(messages(version)).toEqual([])
  })

  it('fails on a duplicate key, sorting ties on the first key part', () => {
    const version = graph(base, { key: ['sku', 'name'] })
    const rows = [
      { a: 'A', b: 'y' },
      { a: 'A', b: 'x' },
      { a: 'A', b: 'x' },
    ]
    const run = runOf(planOf(version, { targets }), { s: rows })
    expect(run.sinks).toEqual([{ sink: 'w', status: 'failed' }])
    expect(run.issues).toEqual([
      {
        node: 'w',
        code: 'duplicate_key',
        message: 'sku, name ["A","x"] is written twice',
        samples: [['A', 'x']],
      },
    ])
    expect(
      runOf(planOf(version, { targets }), { s: rows.slice(0, 2) }).sinks[0]?.write?.rows,
    ).toEqual([
      { sku: 'A', name: 'x' },
      { sku: 'A', name: 'y' },
    ])
  })

  it('reports an unknown target entity', () => {
    expect(messages(graph(base, { target: 'nope' }))).toEqual([
      { message: "target has no entity 'nope'", node: 'w', field: undefined },
    ])
  })

  it('reports columns and write naming non-fields, and bad keys', () => {
    expect(
      messages(graph(base, { columns: { zz: 'sku' }, write: { yy: 'never' }, key: ['sku', 'q'] })),
    ).toEqual([
      { message: "'zz' is not a field of m", node: 'w', field: undefined },
      { message: "'yy' is not a field of m", node: 'w', field: undefined },
      { message: "key 'q' is not a field of m", node: 'w', field: undefined },
    ])
    expect(messages(graph({ ...base, sku: extract('d') }, {}))).toEqual([
      { message: 'sku expects string, got string?', node: 'm', field: 'sku' },
      { message: "key 'sku' must be non-null, got string?", node: 'w', field: undefined },
    ])
  })

  it('blames the producing map field for unknown paths and wrong types', () => {
    expect(messages(graph({ ...base, zip: extract('a'), weight: extract('a') }, {}))).toEqual([
      { message: "item has no field 'zip'", node: 'm', field: 'zip' },
      { message: 'weight expects number?, got string', node: 'm', field: 'weight' },
    ])
  })
})

describe('sink: replace mode', () => {
  const base = { sku: extract('a'), name: extract('b') }
  const replace = (expect: Record<string, unknown>) =>
    versionOf({ ...graph(base, { mode: 'replace' }), expect: { m: expect } })
  const guard =
    "mode 'replace' deletes rows this run does not produce; give m a count expectation with a lower bound and onFail stop or skip_downstream"

  it('tells the host the rows are the complete set; upsert says nothing', () => {
    const rows = { s: [{ a: 'A', b: 'a' }] }
    const run = runOf(planOf(replace({ count: { min: 1 }, onFail: 'stop' }), { targets }), rows)
    expect(run.sinks[0]?.write?.mode).toBe('replace')
    for (const mode of [undefined, 'upsert']) {
      const upsert = runOf(planOf(graph(base, mode ? { mode } : {}), { targets }), rows)
      expect(upsert.sinks[0]?.write).not.toHaveProperty('mode')
    }
  })

  it('accepts a lower count bound that stops or holds the write', () => {
    for (const exp of [
      { count: { min: 1 }, onFail: 'stop' },
      { count: { shiftRatio: { min: 0.8 } }, onFail: { count: 'skip_downstream' } },
      { count: { min: 1 }, onFail: { default: 'stop' } },
    ]) {
      expect(messages(replace(exp))).toEqual([])
    }
  })

  it('rejects a replace sink whose input could shrink unnoticed', () => {
    for (const exp of [
      {},
      { count: { min: 1 } },
      { count: { min: 1 }, onFail: 'alert' },
      { count: { max: 10 }, onFail: 'stop' },
      { count: { shiftRatio: { max: 2 } }, onFail: 'stop' },
      { unique: ['sku'], onFail: 'stop' },
    ]) {
      expect(messages(replace(exp))).toEqual([{ message: guard, node: 'w', field: undefined }])
    }
    expect(messages(graph(base, { mode: 'replace' }))).toEqual([
      { message: guard, node: 'w', field: undefined },
    ])
  })
})

describe('sink: references and nullable keys', () => {
  const base = targetsOf({
    product: { sku: 'string', name: 'string?' },
    warehouse: { code: 'string' },
    transfer: { from_id: 'reference?', to_id: 'reference', days: 'integer?' },
    product_transfer: { product_id: 'reference', transfer_id: 'reference', ghost_id: 'reference?' },
  })
  const REFS: Record<string, string> = {
    'transfer.from_id': 'warehouse',
    'transfer.to_id': 'warehouse',
    'product_transfer.product_id': 'product',
    'product_transfer.transfer_id': 'transfer',
    'product_transfer.ghost_id': 'nope',
  }
  // Transfers are identified by (from, to), where a NULL from (an inbound receipt) is a value.
  const refTargets = {
    ...base,
    entities: base.entities.map((e) => ({
      ...e,
      ...(e.name === 'transfer' ? { identity: ['from_id', 'to_id'], nullsNotDistinct: true } : {}),
      fields: e.fields.map((f) => ({ ...f, references: REFS[`${e.name}.${f.name}`] ?? null })),
    })),
  }
  const transferPair = [{ op: 'extract', path: ['d', 'b'] }]
  const productTransfer = (fields: Record<string, unknown[]>, sink: Record<string, unknown> = {}) =>
    graph(fields, {
      target: 'product_transfer',
      key: ['product_id', 'transfer_id'],
      refs: { product_id: { by: ['sku'] }, transfer_id: { by: ['from_id', 'to_id'] } },
      ...sink,
    })
  const messagesFor = (version: ReturnType<typeof versionOf>) =>
    issuesOf(version, { targets: refTargets }).map((i) => i.message)

  it('writes natural keys typed by the referenced fields, and tells the host how to resolve them', () => {
    const version = productTransfer({ product_id: extract('a'), transfer_id: transferPair })
    const run = runOf(planOf(version, { targets: refTargets }), {
      s: [
        { a: 'P1', b: 'W3', d: 'W1' },
        { a: 'P1', b: 'W2' },
      ],
    })
    expect(run.sinks[0]?.write).toEqual({
      sink: 'w',
      target: 'product_transfer',
      key: ['product_id', 'transfer_id'],
      rows: [
        { product_id: 'P1', transfer_id: [null, 'W2'] },
        { product_id: 'P1', transfer_id: ['W1', 'W3'] },
      ],
      refs: {
        product_id: { entity: 'product', by: ['sku'] },
        transfer_id: { entity: 'transfer', by: ['from_id', 'to_id'] },
      },
    })
  })

  it('rejects natural keys of the wrong shape and refs that resolve to nothing', () => {
    expect(
      messagesFor(
        productTransfer(
          { product_id: extract('d'), transfer_id: extract('a'), ghost_id: extract('a') },
          {
            key: ['transfer_id'],
            refs: {
              product_id: { by: ['sku'] },
              transfer_id: { by: ['from_id', 'to_id'] },
              ghost_id: { by: ['x'] },
              q: { by: ['sku'] },
            },
          },
        ),
      ),
    ).toEqual([
      "'q' is not a field of m",
      'product_id expects string, got string?',
      'transfer_id expects (unknown?, unknown), got string',
      "refs.ghost_id: target has no entity 'nope'",
    ])
    expect(
      messagesFor(
        productTransfer(
          { product_id: extract('a'), transfer_id: transferPair },
          { refs: { product_id: { by: ['zz'] } } },
        ),
      ),
    ).toEqual(["refs.product_id: product has no field 'zz'"])
    expect(
      messagesFor(
        graph({ sku: extract('a') }, { target: 'product', refs: { sku: { by: ['x'] } } }),
      ),
    ).toEqual(['refs.sku: sku is not a reference'])
  })

  it('allows a nullable key field where the identity matches NULLs as equal', () => {
    const transfer = (
      from: unknown[],
      fields: Record<string, unknown[]> = {},
      key = ['from_id', 'to_id'],
    ) => graph({ from_id: from, to_id: extract('b'), ...fields }, { target: 'transfer', key })
    const plan = planOf(transfer(extract('d')), { targets: refTargets })
    expect(
      runOf(plan, {
        s: [
          { a: 'x', b: 'W1', d: 'W9' },
          { a: 'x', b: 'W2' },
        ],
      }).sinks[0]?.write?.rows,
    ).toEqual([
      { from_id: null, to_id: 'W2' },
      { from_id: 'W9', to_id: 'W1' },
    ])
    // NULLs are equal, so two inbound receipts into one warehouse are the same transfer.
    const twice = runOf(plan, {
      s: [
        { a: 'x', b: 'W2' },
        { a: 'y', b: 'W2' },
      ],
    })
    expect(twice.issues[0]?.message).toBe('from_id, to_id [null,"W2"] is written twice')

    const nonNull = (message: string) => [message]
    // An omitted field is absent, not NULL.
    expect(messagesFor(transfer([...extract('d'), { op: 'omit_if_null' }]))).toEqual(
      nonNull("key 'from_id' must be non-null, got string?"),
    )
    // Outside the identity, or on an entity whose NULLs are distinct.
    expect(messagesFor(transfer(extract('a'), { days: extract('n') }, ['to_id', 'days']))).toEqual(
      nonNull("key 'days' must be non-null, got number?"),
    )
    expect(
      messagesFor(
        graph({ sku: extract('a'), name: extract('d') }, { target: 'product', key: ['name'] }),
      ),
    ).toEqual(nonNull("key 'name' must be non-null, got string?"))
    expect(messagesFor(graph({ zip: extract('d') }, { target: 'transfer', key: ['zip'] }))).toEqual(
      ["transfer has no field 'zip'", "key 'zip' must be non-null, got string?"],
    )
  })
})
