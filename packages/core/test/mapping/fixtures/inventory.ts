/**
 * A multi-source worked example: per-bin stock snapshots and store counts, resolved against
 * items and locations, summed into inventory levels per product and warehouse, plus the
 * replenishment routes between stocked warehouses, which must not loop.
 */

import { type MappingVersionInput, parseVersion } from '../../../src/mapping/document'
import { TargetSchema } from '../../../src/schema'

const text = (name: string) => ({ name, logicalType: 'string', nullable: false })
const amount = (name: string) => ({ name, logicalType: 'decimal' })

/** Illustrative target model, not the demo API's. */
export const targets = TargetSchema.parse({
  name: 'Target model',
  entities: [
    {
      name: 'inventory_level',
      fields: [
        text('product_sku'),
        text('warehouse'),
        ...['on_hand', 'reserved', 'bins'].map(amount),
      ],
    },
    { name: 'transfer_route', fields: [text('from_warehouse'), text('to_warehouse')] },
  ],
})

const nullable = (type: string) => ({ type: [type, 'null'] })

/** A JSON Schema whose listed fields are all required and non-null. */
const record = (fields: Record<string, string>) => ({
  type: 'object',
  required: Object.keys(fields),
  properties: Object.fromEntries(Object.entries(fields).map(([k, type]) => [k, { type }])),
})

const stockSchema = {
  type: 'object',
  required: ['SNAPSHOT_ID', 'ITEM_ID', 'LOCATION_ID', 'ON_HAND'],
  properties: {
    SNAPSHOT_ID: { type: 'number' },
    ITEM_ID: { type: 'number' },
    LOCATION_ID: { type: 'number' },
    BIN: nullable('string'),
    ON_HAND: { type: 'number' },
    RESERVED: nullable('number'),
  },
}

const storeCountSchema = {
  type: 'object',
  required: ['item_id', 'store_id', 'counted'],
  properties: {
    item_id: { type: 'number' },
    store_id: { type: 'number' },
    counted: { type: 'number' },
    reserved: nullable('number'),
  },
}

const extract = (key: string, path = key) => ({ key, pipeline: [{ op: 'extract', path }] })
const constant = (key: string, value: string) => ({ key, pipeline: [{ op: 'const', value }] })

const tent = 'AO-TENT-2P'
const jacket = 'AO-JKT-RAIN-M'
const route = (sku: string, from_warehouse: string, to_warehouse: string) => ({
  sku,
  from_warehouse,
  to_warehouse,
})

/** Tent stock flows Central -> North -> Downtown, and the last route closes the loop. */
export const routes = [
  route(tent, 'Central', 'North'),
  route(tent, 'North', 'Downtown'),
  route(jacket, 'Central', 'Downtown'),
  // North holds no valid jacket stock (its count is negative), so this route is dropped.
  route(jacket, 'North', 'Central'),
  route(tent, 'Downtown', 'Central'),
]

const snapshot = (
  SNAPSHOT_ID: number,
  ITEM_ID: number,
  LOCATION_ID: number,
  BIN: string | null,
  ON_HAND: number,
  RESERVED: number | null,
) => ({ SNAPSHOT_ID, ITEM_ID, LOCATION_ID, BIN, ON_HAND, RESERVED })

export const sources = {
  stock: [
    snapshot(1, 1, 10, 'A-01-01', 30, 5),
    snapshot(2, 1, 10, 'A-01-02', 12, null),
    snapshot(3, 1, 11, 'B-02-01', 8, 2),
    snapshot(4, 2, 10, 'A-03-01', 40, 0),
    snapshot(5, 2, 11, 'B-01-04', -3, null),
    snapshot(6, 3, 10, 'A-09-09', 5, null),
    snapshot(7, 2, 99, null, 4, null),
  ],
  store_counts: [
    { item_id: 1, store_id: 12, counted: 3, reserved: null },
    { item_id: 2, store_id: 12, counted: 6, reserved: 1 },
  ],
  items: [
    { id: 1, itemid: tent },
    { id: 2, itemid: jacket },
  ],
  locations: [
    { id: 10, name: 'Central' },
    { id: 11, name: 'North' },
    { id: 12, name: 'Downtown' },
  ],
  routes,
}

export const expected = {
  status_counts: [
    { status: 'negative', rows: 1 },
    { status: 'ok', rows: 6 },
    { status: 'unknown_item', rows: 1 },
    { status: 'unknown_location', rows: 1 },
  ],
  levels: [
    { sku: tent, warehouse: 'Central', on_hand: 42, reserved: 5, bins: 2 },
    { sku: tent, warehouse: 'North', on_hand: 8, reserved: 2, bins: 1 },
    { sku: tent, warehouse: 'Downtown', on_hand: 3, reserved: null, bins: 1 },
    { sku: jacket, warehouse: 'Central', on_hand: 40, reserved: 0, bins: 1 },
    { sku: jacket, warehouse: 'Downtown', on_hand: 6, reserved: 1, bins: 1 },
  ],
  route_pairs: [
    { from_warehouse: 'Central', to_warehouse: 'Downtown' },
    { from_warehouse: 'Central', to_warehouse: 'North' },
    { from_warehouse: 'Downtown', to_warehouse: 'Central' },
    { from_warehouse: 'North', to_warehouse: 'Downtown' },
  ],
}

export const expect = {
  stock: {
    count: { shiftRatio: { max: 1.5, min: 0.67 } },
    unique: ['SNAPSHOT_ID'],
    onFail: 'stop',
  },
  status_counts: {
    keyed: {
      by: 'status',
      value: 'rows',
      bounds: {
        unknown_item: { max: 0, onFail: 'alert' },
        unknown_location: { max: 0, onFail: 'alert' },
      },
    },
  },
  levels: {
    count: { min: 1000, max: 50000 },
    unique: ['sku', 'warehouse'],
    onFail: 'skip_downstream',
  },
  route_pairs: { count: { min: 1 }, onFail: 'stop' },
} satisfies MappingVersionInput['expect']

export function inventoryVersion(extra: Partial<MappingVersionInput> = {}) {
  return parseVersion({
    id: 'stock->inventory_level',
    version: 1,
    params: { min_on_hand: 0 },
    expectedSchema: {
      stock: stockSchema,
      store_counts: storeCountSchema,
      items: record({ id: 'number', itemid: 'string' }),
      locations: record({ id: 'number', name: 'string' }),
      routes: record({ sku: 'string', from_warehouse: 'string', to_warehouse: 'string' }),
    },
    nodes: [
      { id: 'stock', op: 'source', system: 'snowflake', entity: 'STOCK_SNAPSHOT' },
      { id: 'store_counts', op: 'source', system: 'pos', entity: 'store_count' },
      { id: 'items', op: 'source', system: 'netsuite', entity: 'item' },
      { id: 'locations', op: 'source', system: 'netsuite', entity: 'location' },
      { id: 'routes', op: 'source', system: 'netsuite', entity: 'replenishment_route' },
      {
        id: 'bin_rows',
        op: 'map',
        in: 'stock',
        fields: [
          extract('item_id', 'ITEM_ID'),
          extract('location_id', 'LOCATION_ID'),
          extract('bin', 'BIN'),
          extract('on_hand', 'ON_HAND'),
          extract('reserved', 'RESERVED'),
        ],
      },
      {
        id: 'store_rows',
        op: 'map',
        in: 'store_counts',
        fields: [
          extract('item_id'),
          extract('location_id', 'store_id'),
          constant('bin', 'shelf'),
          extract('on_hand', 'counted'),
          extract('reserved'),
        ],
      },
      { id: 'counts', op: 'union', inputs: ['bin_rows', 'store_rows'] },
      {
        id: 'with_items',
        op: 'join',
        left: 'counts',
        right: 'items',
        type: 'left',
        on: [['item_id', 'id']],
        cardinality: 'n:1',
        select: { itemid: 'sku' },
      },
      {
        id: 'resolved',
        op: 'join',
        left: 'with_items',
        right: 'locations',
        type: 'left',
        on: [['location_id', 'id']],
        cardinality: 'n:1',
        select: { name: 'warehouse' },
      },
      {
        id: 'rows',
        op: 'map',
        in: 'resolved',
        fields: [
          extract('sku'),
          extract('warehouse'),
          extract('bin'),
          extract('on_hand'),
          extract('reserved'),
          {
            key: 'status',
            pipeline: [
              {
                op: 'when',
                cases: [
                  { cond: { path: 'sku', is_null: true }, then: 'unknown_item' },
                  { cond: { path: 'warehouse', is_null: true }, then: 'unknown_location' },
                  { cond: { path: 'on_hand', lt: { param: 'min_on_hand' } }, then: 'negative' },
                ],
                else: 'ok',
              },
            ],
          },
        ],
      },
      {
        id: 'status_counts',
        op: 'aggregate',
        in: 'rows',
        group_by: ['status'],
        fields: { rows: { agg: 'count' } },
      },
      { id: 'status_counts_out', op: 'metrics', in: 'status_counts', name: 'stock.status_counts' },
      {
        id: 'valid',
        op: 'filter',
        in: 'rows',
        // The is_null clauses narrow sku and warehouse, so the level keys are non-null.
        cond: {
          all: {
            of: [
              { path: 'status', eq: 'ok' },
              { path: 'sku', is_null: false },
              { path: 'warehouse', is_null: false },
            ],
          },
        },
      },
      {
        id: 'levels',
        op: 'aggregate',
        in: 'valid',
        group_by: ['sku', 'warehouse'],
        fields: {
          on_hand: { agg: 'sum', path: 'on_hand' },
          reserved: { agg: 'sum', path: 'reserved' },
          bins: { agg: 'count' },
        },
      },
      {
        id: 'inventory_out',
        op: 'sink',
        in: 'levels',
        target: 'inventory_level',
        key: ['sku', 'warehouse'],
        columns: { sku: 'inventory_level.product_sku' },
        mode: 'replace',
      },
      {
        id: 'stocked_routes',
        op: 'join',
        left: 'routes',
        right: 'levels',
        type: 'semi',
        on: [
          ['sku', 'sku'],
          ['from_warehouse', 'warehouse'],
        ],
        cardinality: 'n:1',
      },
      {
        id: 'route_pairs',
        op: 'distinct',
        in: 'stocked_routes',
        keys: ['from_warehouse', 'to_warehouse'],
      },
      {
        id: 'route_out',
        op: 'sink',
        in: 'route_pairs',
        target: 'transfer_route',
        key: ['from_warehouse', 'to_warehouse'],
        mode: 'replace',
      },
      {
        id: 'no_loops',
        op: 'assert',
        check: 'acyclic',
        in: 'stocked_routes',
        edge: { from: 'from_warehouse', to: 'to_warehouse', key: 'sku' },
        on_fail: 'stop',
      },
    ],
    expect,
    examples: [{ name: 'two products', sources, expect: expected }],
    ...extra,
  })
}
