import { describe, expect, it } from 'vite-plus/test'
import { catalog, datasetKey, FULL_ITEMS, generate, MIN_ITEMS, STOCK_SNAPSHOT } from '../src'

const ds = generate()
const rows = (table: string) => ds.netsuite[table]?.toObjects() ?? []
const items = rows('item')
const stock = ds.snowflake[STOCK_SNAPSHOT]?.toObjects() ?? []
const ids = (table: string) => new Set(rows(table).map((r) => r.id))
const share = (n: number) => n / items.length

function groupBy<T>(values: T[], key: (value: T) => unknown): Map<unknown, T[]> {
  const out = new Map<unknown, T[]>()
  for (const v of values) out.set(key(v), [...(out.get(key(v)) ?? []), v])
  return out
}

describe('generate', () => {
  it('is deterministic per seed', () => {
    const again = generate()
    expect(again.netsuite.item?.rows).toEqual(ds.netsuite.item?.rows)
    expect(again.snowflake[STOCK_SNAPSHOT]?.rows).toEqual(ds.snowflake[STOCK_SNAPSHOT]?.rows)
    expect(generate({ seed: 7 }).netsuite.item?.rows).not.toEqual(ds.netsuite.item?.rows)
    expect(datasetKey(42, 1)).toBe('v3-seed42-scale1')
  })

  it('follows the scale, with a floor for small scales', () => {
    expect(Object.keys(ds.netsuite).sort()).toEqual(
      ['classification', 'currency', 'item', 'itemvendor', 'location', 'vendor'].sort(),
    )
    expect(Object.keys(ds.snowflake)).toEqual(['ANALYTICS.INVENTORY.STOCK_SNAPSHOT'])
    expect(items).toHaveLength(FULL_ITEMS)
    expect(stock.length).toBeGreaterThan(20_000)
    expect(stock.length).toBeLessThan(35_000)
    const small = generate({ scale: 0.02 })
    expect(small.netsuite.item?.rows).toHaveLength(MIN_ITEMS)
    expect(small.snowflake[STOCK_SNAPSHOT]?.rows.length).toBeGreaterThan(1000)
    expect(generate({ scale: 1.5 }).netsuite.item?.rows).toHaveLength(3000)
    expect(() => generate({ scale: 0 })).toThrow(RangeError)
  })

  it('has unique, readable SKUs starting with AO-TENT-2P-GRN', () => {
    expect(items[0]).toMatchObject({
      itemid: 'AO-TENT-2P-GRN',
      displayname: 'Acme Trail Tent 2P Green',
    })
    expect(new Set(items.map((r) => r.itemid)).size).toBe(items.length)
    expect(items.every((r) => /^AO-[A-Z0-9-]+$/.test(r.itemid as string))).toBe(true)
    const large = generate({ scale: 1.5 }).netsuite.item?.toObjects() ?? []
    expect(new Set(large.map((r) => r.itemid)).size).toBe(large.length)
  })

  it('keeps every reference resolvable', () => {
    const subset = (values: unknown[], of: Set<unknown>) => values.every((v) => of.has(v))
    expect(
      subset(
        items.map((r) => r.class),
        ids('classification'),
      ),
    ).toBe(true)
    const parents = rows('classification').map((r) => r.parent)
    expect(
      subset(
        parents.filter((p) => p !== null),
        ids('classification'),
      ),
    ).toBe(true)
    expect(
      subset(
        rows('vendor').map((r) => r.currency),
        ids('currency'),
      ),
    ).toBe(true)
    expect(
      subset(
        rows('itemvendor').map((r) => r.item),
        ids('item'),
      ),
    ).toBe(true)
    expect(
      subset(
        rows('itemvendor').map((r) => r.vendor),
        ids('vendor'),
      ),
    ).toBe(true)
    expect(
      subset(
        stock.map((r) => r.ITEM_ID),
        ids('item'),
      ),
    ).toBe(true)
    expect(new Set(stock.map((r) => r.LOCATION_ID))).toEqual(new Set(catalog.STOCK_LOCATIONS))
  })

  it('gives every item one preferred vendor and at most two', () => {
    const byItem = groupBy(rows('itemvendor'), (r) => r.item)
    expect(byItem.size).toBe(items.length)
    for (const links of byItem.values()) {
      expect(links.length).toBeLessThanOrEqual(2)
      expect(links.filter((r) => r.preferredvendor === 'T')).toHaveLength(1)
    }
  })

  it('stocks active items at 2-4 locations, over 1-3 bins, for the last 3 days', () => {
    expect(new Set(stock.map((r) => r.SNAPSHOT_ID)).size).toBe(stock.length)
    expect(new Set(stock.map((r) => r.SNAPSHOT_DATE))).toEqual(
      new Set(['2026-10-02', '2026-10-03', '2026-10-04']),
    )
    const inactive = new Set(items.filter((r) => r.isinactive === 'T').map((r) => r.id))
    expect(stock.some((r) => inactive.has(r.ITEM_ID))).toBe(false)
    const locations = groupBy(
      stock.filter((r) => r.SNAPSHOT_DATE === ds.asOf),
      (r) => r.ITEM_ID,
    )
    expect(locations.size).toBe(items.length - inactive.size)
    for (const snapshot of locations.values()) {
      const perLocation = groupBy(snapshot, (r) => r.LOCATION_ID)
      expect(perLocation.size).toBeGreaterThanOrEqual(2)
      expect(perLocation.size).toBeLessThanOrEqual(4)
      for (const bins of perLocation.values()) expect(bins.length).toBeLessThanOrEqual(3)
    }
    const groups = new Set(stock.map((r) => `${r.ITEM_ID}|${r.LOCATION_ID}|${r.SNAPSHOT_DATE}`))
    expect(groups.size).toBeLessThan(stock.length) // loading needs an aggregate over bins
  })

  it('carries the documented dirt', () => {
    expect(share(items.filter((r) => r.upccode === '').length)).toBeCloseTo(0.08, 1)
    expect(items.some((r) => r.upccode === null)).toBe(false)
    expect(
      items.filter((r) => r.upccode !== '').every((r) => /^\d{12,13}$/.test(r.upccode as string)),
    ).toBe(true)
    expect(new Set(items.map((r) => r.weightunit))).toEqual(new Set(['g', 'kg', 'lb', 'oz']))
    expect(share(items.filter((r) => r.isinactive === 'T').length)).toBeCloseTo(0.05, 1)
    const dims = ['length', 'width', 'height']
    const bad = items.filter((r) => dims.some((d) => (r[`custitem_${d}_mm`] as number) <= 0))
    expect(share(bad.length)).toBeCloseTo(0.03, 1)
    const values = bad.flatMap((r) => dims.map((d) => r[`custitem_${d}_mm`]))
    expect(values).toContain(0)
    expect(values.some((v) => (v as number) < 0)).toBe(true)
    for (const field of ['custitem_launch_date', 'custitem_case_qty', 'cost', 'displayname']) {
      expect(items.some((r) => r[field] === null)).toBe(true)
    }
    expect(rows('location').filter((r) => r.isinactive === 'T')).toHaveLength(1)
    expect(rows('vendor').some((r) => r.isinactive === 'T')).toBe(true)
    expect(rows('classification').some((r) => r.isinactive === 'T')).toBe(true)
    expect(stock.some((r) => (r.ON_HAND as number) < 0)).toBe(true)
    expect(stock.some((r) => r.BIN === null)).toBe(true)
    expect(stock.some((r) => r.RESERVED === null)).toBe(true)
  })
})
