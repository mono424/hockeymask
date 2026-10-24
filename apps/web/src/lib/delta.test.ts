import { describe, expect, it } from 'vite-plus/test'
import { diffRows } from './delta'

describe('diffRows', () => {
  it('matches rows by key: changed fields, added and removed rows', () => {
    const before = [
      { sku: 'A', title: 'Alpha', price: 1 },
      { sku: 'B', title: 'Beta', price: 2 },
      { sku: 'C', title: 'Gamma', price: 3 },
    ]
    const after = [
      { sku: 'A', title: 'Alpha', price: 1 },
      { sku: 'B', title: 'Beta', price: 5 },
      { sku: 'D', title: 'Delta', price: 4 },
    ]
    const delta = diffRows(before, after, ['sku'])
    expect([delta.added, delta.changed, delta.removed]).toEqual([1, 1, 1])
    expect(delta.rows.map((r) => [r.row.sku, r.change, r.fields])).toEqual([
      ['B', 'changed', ['price']],
      ['D', 'added', undefined],
      ['C', 'removed', undefined],
      ['A', 'same', undefined],
    ])
    expect(delta.rows[0]?.before).toEqual(before[1])
  })

  it('compares nested values by content and counts a dropped field as a change', () => {
    const delta = diffRows(
      [{ id: 1, tags: { a: 1, b: 2 }, note: 'x' }],
      [{ id: 1, tags: { b: 2, a: 1 } }],
      ['id'],
    )
    expect(delta.rows).toEqual([expect.objectContaining({ change: 'changed', fields: ['note'] })])
  })

  it('pairs repeated keys in order, and identifies keyless rows by all their values', () => {
    const twice = diffRows(
      [
        { k: 1, v: 'a' },
        { k: 1, v: 'b' },
      ],
      [
        { k: 1, v: 'a' },
        { k: 1, v: 'c' },
      ],
      ['k'],
    )
    expect(twice.rows.map((r) => r.change)).toEqual(['changed', 'same'])
    const keyless = diffRows([{ v: 'a' }], [{ v: 'b' }], [])
    expect([keyless.added, keyless.changed, keyless.removed]).toEqual([1, 0, 1])
  })
})
