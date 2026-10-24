import {
  column,
  compileVersion,
  type LogicalType,
  type Table,
  type TargetEntity,
  type TargetSchema,
  validateStructure,
} from '@hockeymask/core'
import { describe, expect, it } from 'vite-plus/test'
import { sourceSchema } from './schemas'
import { TEMPLATES, templatesFor } from './templates'

type Spec = [name: string, type: LogicalType, opts?: { notNull?: boolean; references?: string }]

const table = (name: string, columns: Spec[]): Table => ({
  name,
  label: null,
  description: null,
  rowCount: null,
  columns: columns.map(([n, logicalType, o]) =>
    column({
      name: n,
      logicalType,
      sourceType: logicalType,
      nullable: !o?.notNull,
      references: o?.references ?? null,
    }),
  ),
})

const req = { notNull: true }

/** The demo sources as their connectors describe them. */
const SOURCES: Record<string, Table> = {
  'netsuite.item': table('item', [
    ['id', 'integer', req],
    ['itemid', 'string', req],
    ['displayname', 'string'],
    ['upccode', 'string'],
    ['baseprice', 'decimal'],
    ['cost', 'decimal'],
    ['weight', 'decimal'],
    ['weightunit', 'string'],
    ['class', 'reference', { references: 'classification' }],
    ['isinactive', 'boolean', req],
    ['custitem_color', 'string'],
    ['custitem_launch_date', 'date'],
    ['custitem_length_mm', 'integer'],
    ['custitem_width_mm', 'integer'],
    ['custitem_height_mm', 'integer'],
    ['custitem_case_qty', 'integer'],
  ]),
  'netsuite.classification': table('classification', [
    ['id', 'integer', req],
    ['name', 'string', req],
    ['fullname', 'string'],
    ['parent', 'reference', { references: 'classification' }],
    ['isinactive', 'boolean'],
  ]),
  'netsuite.location': table('location', [
    ['id', 'integer', req],
    ['name', 'string'],
    ['fullname', 'string'],
    ['isinactive', 'boolean'],
    ['locationtype', 'string'],
    ['country', 'string'],
    ['city', 'string'],
  ]),
  'snowflake.ANALYTICS.INVENTORY.STOCK_SNAPSHOT': table('ANALYTICS.INVENTORY.STOCK_SNAPSHOT', [
    ['SNAPSHOT_ID', 'integer', req],
    ['ITEM_ID', 'integer', req],
    ['LOCATION_ID', 'integer', req],
    ['SNAPSHOT_DATE', 'date', req],
    ['BIN', 'string'],
    ['ON_HAND', 'integer', req],
    ['RESERVED', 'integer'],
  ]),
}

const IDENTITY = ['source_system', 'source_id', 'secondary_source_id']

const entity = (name: string, fields: Spec[], identity = IDENTITY): TargetEntity => ({
  name,
  description: null,
  identity,
  fields: [
    ...(identity === IDENTITY ? IDENTITY.map((n): Spec => [n, 'string', req]) : []),
    ...fields,
  ].map(([n, logicalType, o]) => ({
    name: n,
    logicalType,
    nullable: !o?.notNull,
    description: null,
    unit: null,
    references: o?.references ?? null,
  })),
})

const ref = (references: string, notNull = false) => ({ references, notNull })

/** The target model as the API describes it. */
const TARGET: TargetSchema = {
  name: 'Target model',
  entities: [
    entity('product', [
      ['title', 'string', req],
      ['sku', 'string', req],
      ['ean', 'string'],
      ['price', 'decimal'],
      ['cost', 'decimal'],
      ['category_id', 'reference', ref('category')],
      ['weight', 'decimal'],
      ['length', 'decimal'],
      ['width', 'decimal'],
      ['height', 'decimal'],
      ['active', 'boolean'],
      ['launch_date', 'date'],
    ]),
    entity('category', [
      ['name', 'string', req],
      ['parent_id', 'reference', ref('category')],
    ]),
    entity('warehouse', [
      ['name', 'string', req],
      ['type', 'string'],
      ['country', 'string'],
      ['city', 'string'],
      ['active', 'boolean', req],
    ]),
    entity(
      'inventory_level',
      [
        ['product_id', 'reference', ref('product', true)],
        ['warehouse_id', 'reference', ref('warehouse', true)],
        ['on_hand', 'integer', req],
        ['reserved', 'integer'],
        ['as_of', 'date', req],
      ],
      ['product_id', 'warehouse_id'],
    ),
  ],
}

describe('templates', () => {
  it('are offered per kind', () => {
    expect(templatesFor('netsuite').map((t) => t.key)).toEqual([
      'empty',
      'classes-category',
      'items-product',
      'locations-warehouses',
    ])
    expect(templatesFor('snowflake').map((t) => t.key)).toEqual(['empty', 'stock-inventory'])
  })

  it.each(TEMPLATES.filter((t) => t.key !== 'empty'))(
    '$key compiles against the target model',
    (t) => {
      const version = t.build('test--mapping', t.label)
      expect(version.id).toBe('test--mapping')
      expect(validateStructure(version)).toEqual([])
      const expectedSchema = Object.fromEntries(
        version.nodes
          .filter((n) => n.op === 'source')
          .map((n) => {
            const source = SOURCES[`${String(n.system)}.${String(n.entity)}`]
            if (!source) throw new Error(`no fixture for ${String(n.system)}.${String(n.entity)}`)
            return [n.id, sourceSchema(source, String(n.system))]
          }),
      )
      const compiled = compileVersion({ ...version, expectedSchema }, { targets: TARGET })
      expect(compiled.ok ? [] : compiled.issues).toEqual([])
    },
  )
})
