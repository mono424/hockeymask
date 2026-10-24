/**
 * The target model described for mapping (`TargetSchema` from @hockeymask/core).
 *
 * Types, nullability, foreign keys and identity come from the Drizzle tables, so they can't
 * drift from the database. Meaning comes from `DOCS`: it is what a person or a model reads
 * to decide where a source field belongs, so a test requires every plain field to have one.
 */

import type { TargetEntity, TargetField, TargetSchema } from '@hockeymask/core'
import { getTableConfig, type PgColumn } from 'drizzle-orm/pg-core'
import { targetTables } from './db/schema'

type FieldDoc = string | { text: string; unit: string }

interface EntityDoc {
  description: string
  fields: Record<string, FieldDoc>
}

const IDENTITY = ['source_system', 'source_id', 'secondary_source_id']
const IDENTITY_DOCS: Record<string, FieldDoc> = {
  source_system: "System the row was imported from, e.g. 'NetSuite'.",
  source_id: "The row's id in that system.",
  secondary_source_id: "Disambiguates when one source row yields several of ours; '' when unused.",
}
const HOST_FILLED = new Set(['id', 'company_id'])

export const DOCS: Record<keyof typeof targetTables, EntityDoc> = {
  product: {
    description: 'An article the company sells or stocks.',
    fields: {
      title: 'Human-readable product name.',
      sku: "The company's own article number (stock keeping unit).",
      ean: 'Barcode of the sales unit (EAN-13 / UPC-A); NULL when it has none.',
      price: 'List price of one sales unit.',
      cost: 'Purchase or production cost of one sales unit.',
      weight: { text: 'Weight of one sales unit.', unit: 'g' },
      length: { text: 'Length of one sales unit.', unit: 'm' },
      width: { text: 'Width of one sales unit.', unit: 'm' },
      height: { text: 'Height of one sales unit.', unit: 'm' },
      active: 'Product is currently sold.',
      launch_date: 'First day the product is sold.',
    },
  },
  category: {
    description: 'A node of the product category tree; top-level categories have no parent.',
    fields: { name: 'Category name, without the names of its parents.' },
  },
  supplier: {
    description: 'A vendor the company buys from.',
    fields: {
      name: 'Supplier company name.',
      currency: 'ISO 4217 currency of purchase orders, e.g. USD.',
      country: 'ISO 3166-1 alpha-2 country code of the supplier, e.g. US.',
      lead_time_days: { text: 'Days from purchase order to goods received.', unit: 'd' },
    },
  },
  supplier_product: {
    description: 'Per (product, supplier) purchasing terms.',
    fields: {
      supplier_sku: "The supplier's own article number for the product.",
      purchase_price: "Price per sales unit from this supplier, in the supplier's currency.",
      preferred: 'This supplier is the default source for the product.',
    },
  },
  warehouse: {
    description: 'A location that holds stock.',
    fields: {
      name: 'Location name.',
      type: 'WAREHOUSE: own warehouse. STORE: retail store. THIRD_PARTY: run by a logistics provider.',
      country: 'ISO 3166-1 alpha-2 country code, e.g. US.',
      city: 'City the location is in.',
      active: 'Location is operating.',
    },
  },
  inventory_level: {
    description: 'Current stock of one product at one warehouse.',
    fields: {
      on_hand: 'Units physically in stock, summed over all bins.',
      reserved: 'Units of on_hand already allocated to orders.',
      as_of: 'Date the stock count refers to.',
    },
  },
}

function logicalType(column: PgColumn): TargetField['logicalType'] {
  if (column.dataType === 'boolean') return 'boolean'
  if (column.columnType === 'PgDate' || column.columnType === 'PgDateString') return 'date'
  if (column.columnType === 'PgTimestamp' || column.columnType === 'PgTimestampString')
    return 'timestamp'
  if (column.columnType === 'PgDoublePrecision') return 'decimal'
  if (column.dataType === 'number') return 'integer'
  return 'string'
}

function entity(name: keyof typeof targetTables): TargetEntity {
  const config = getTableConfig(targetTables[name])
  const doc = DOCS[name]
  const names = config.columns.map((c) => c.name)
  const references = new Map(
    config.foreignKeys.map((fk) => {
      const ref = fk.reference()
      return [ref.columns[0]?.name ?? '', getTableConfig(ref.foreignTable).name]
    }),
  )
  const triple = IDENTITY.every((c) => names.includes(c))
  const constraint = triple ? undefined : config.uniqueConstraints[0]
  const identity = triple
    ? IDENTITY
    : (constraint?.columns ?? config.primaryKeys[0]?.columns ?? [])
        .map((c) => c.name)
        .filter((c) => !HOST_FILLED.has(c))
  const unique = config.columns.find((c) => c.isUnique && !HOST_FILLED.has(c.name))
  return {
    name,
    description: doc.description,
    identity: identity.length > 0 || !unique ? identity : [unique.name],
    // An identity with nullable columns can match NULLs as equal (NULLS NOT DISTINCT).
    ...(constraint?.nullsNotDistinct ? { nullsNotDistinct: true } : {}),
    fields: config.columns
      .filter((c) => !HOST_FILLED.has(c.name))
      .map((c) => {
        const fieldDoc = doc.fields[c.name] ?? IDENTITY_DOCS[c.name]
        const isReference = references.has(c.name)
        return {
          name: c.name,
          logicalType: isReference ? 'reference' : logicalType(c),
          nullable: !c.notNull,
          description: typeof fieldDoc === 'string' ? fieldDoc : (fieldDoc?.text ?? null),
          unit: typeof fieldDoc === 'object' ? fieldDoc.unit : null,
          references: references.get(c.name) ?? null,
        }
      }),
  }
}

export function targetSchema(): TargetSchema {
  return {
    name: 'Target model',
    entities: (Object.keys(targetTables) as (keyof typeof targetTables)[]).map(entity),
  }
}

/** The derived schema with edited entities in place of their derived ones. */
export function withEdits(base: TargetSchema, edits: readonly TargetEntity[]): TargetSchema {
  const byName = new Map(edits.map((e) => [e.name, e]))
  return { ...base, entities: base.entities.map((e) => byName.get(e.name) ?? e) }
}

/** What makes `entity` unusable in `schema`: duplicate fields, unknown identity or references. */
export function entityIssues(entity: TargetEntity, schema: TargetSchema): string[] {
  const names = entity.fields.map((f) => f.name)
  const entities = new Set(schema.entities.map((e) => e.name))
  return [
    ...names.filter((n, i) => names.indexOf(n) !== i).map((n) => `field '${n}' appears twice`),
    ...entity.identity
      .filter((n) => !names.includes(n))
      .map((n) => `identity field '${n}' is not a field`),
    ...entity.fields
      .filter((f) => f.references !== null && !entities.has(f.references))
      .map((f) => `${f.name} references unknown entity '${f.references}'`),
  ]
}
