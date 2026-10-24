import { describe, expect, it } from 'vite-plus/test'
import { checkVersion } from '../../src/mapping/check'
import { compileVersion, type Plan } from '../../src/mapping/compile'
import { execute } from '../../src/mapping/execute'
import { sourceRecordType } from '../../src/mapping/jsonschema'
import { show } from '../../src/mapping/types'
import { itemsSchema, productVersion, targets } from './fixtures/product'

const NOW = '2026-10-04T12:00:00Z'

function plan(version = productVersion()): Plan {
  const compiled = compileVersion(version, { targets })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues, null, 2))
  return compiled.plan
}

const item = (over: Record<string, unknown> = {}) => ({
  itemid: 'A-1',
  displayname: 'Widget',
  upccode: '',
  custitem_width_mm: 120,
  custitem_height_mm: 0,
  custitem_length_mm: null,
  weight: 2,
  weightunit: 'kg',
  custitem_launch_date: '9999-01-01',
  ...over,
})

describe('NetSuite item -> product', () => {
  it('derives the source record type from the zod-authored JSON Schema', () => {
    const type = sourceRecordType(itemsSchema)
    expect(type.ok && show(type.value)).toBe(
      '{ itemid: string, displayname: string, upccode: string?, custitem_width_mm: number?, custitem_height_mm: number?, custitem_length_mm: number?, weight: number?, weightunit: string, custitem_launch_date: string? }',
    )
  })

  it('rejects if_after on a string: the date needs to_date first', () => {
    const compiled = compileVersion(
      productVersion([
        { op: 'extract', path: 'custitem_launch_date' },
        { op: 'if_after', date: 'today+10y', then: null },
      ]),
      { targets },
    )
    expect(compiled.ok).toBe(false)
    expect(compiled.issues).toEqual([
      expect.objectContaining({
        code: 'type_error',
        node: 'products',
        field: 'product.launch_date',
        step: 1,
        message: expect.stringContaining("'after' applies to dates, not string"),
      }),
    ])
  })

  it('maps 2 kg to 2000 g, millimetres to metres, placeholder dates and blanks to null', () => {
    const run = execute(plan(), { items: [item()] }, { now: NOW })
    expect(run.status).toBe('ok')
    expect(run.sinks).toEqual([
      {
        sink: 'product_out',
        status: 'write',
        write: {
          sink: 'product_out',
          target: 'product',
          key: ['product.sku'],
          rows: [
            {
              'product.sku': 'A-1',
              'product.title': 'Widget',
              'product.ean': null,
              'product.width': 0.12,
              'product.height': null,
              'product.length': null,
              'product.weight': 2000,
              'product.launch_date': null,
            },
          ],
        },
      },
    ])
  })

  it('keeps genuine launch dates, written as YYYY-MM-DD in the run time zone', () => {
    const run = execute(
      plan(),
      { items: [item({ custitem_launch_date: '2027-03-31' })] },
      {
        now: NOW,
        tz: 'Europe/Berlin',
      },
    )
    expect(run.sinks[0]?.write?.rows[0]?.['product.launch_date']).toBe('2027-03-31')
  })

  it('writes sorted by key and records per-node statistics', () => {
    const items = ['C', 'A', 'B'].map((sku) => item({ itemid: sku }))
    const run = execute(plan(), { items }, { now: NOW }, { clock: () => 0 })
    expect(run.sinks[0]?.write?.rows.map((r) => r['product.sku'])).toEqual(['A', 'B', 'C'])
    expect(run.stats.map((s) => [s.node, s.rowsIn, s.rowsOut])).toEqual([
      ['items', 0, 3],
      ['products', 3, 3],
      ['product_out', 3, 3],
    ])
  })

  it('skips a record whose unit is unknown and counts it on the node', () => {
    const items = [item(), item({ itemid: 'B', weightunit: 'kg' })]
    const bad = { ...item({ itemid: 'C' }), weightunit: 'stone' }
    const run = execute(plan(), { items: [...items, bad] }, { now: NOW })
    // The source schema declares weightunit as an enum, but only its type is enforced at
    // load; the unknown unit surfaces in convert_unit and the record is skipped.
    expect(run.stats.find((s) => s.node === 'products')?.skipped).toBe(1)
    expect(run.issues).toEqual([
      expect.objectContaining({
        node: 'products',
        code: 'unknown_unit',
        field: 'product.weight',
        count: 1,
      }),
    ])
    expect(run.sinks[0]?.write?.rows).toHaveLength(2)
  })

  it('fails the source on a value of the wrong type, and holds the sink', () => {
    const run = execute(plan(), { items: [item({ custitem_width_mm: '120' })] }, { now: NOW })
    expect(run.status).toBe('partial')
    expect(run.sinks).toEqual([{ sink: 'product_out', status: 'upstream_failed' }])
    expect(run.issues).toContainEqual(
      expect.objectContaining({
        node: 'items',
        code: 'schema_violation',
        field: 'custitem_width_mm',
        count: 1,
      }),
    )
  })

  it('runs the version examples on check', () => {
    const version = productVersion(undefined, {
      examples: [
        {
          now: NOW,
          sources: { items: [item()] },
          expect: { products: [{ 'product.sku': 'A-1', 'product.weight': 2000 }] },
        },
      ],
    })
    expect(checkVersion(version, { targets })).toMatchObject({ ok: true, issues: [] })
  })
})
