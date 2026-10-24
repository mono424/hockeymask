/**
 * The target model mappings write to (products, categories, suppliers, warehouses, stock),
 * plus the company and where mapping graphs and target entity edits are stored.
 *
 * Every imported entity carries the external identity triple
 * (source_system, source_id, secondary_source_id), unique per company.
 */

import {
  type AnyPgColumn,
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  type PgColumn,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'

export const company = pgTable('company', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
})

const companyId = () =>
  integer('company_id')
    .notNull()
    .references(() => company.id)

/** source_system / source_id / secondary_source_id; '' rather than NULL keeps it unique. */
const externalIdentity = () => ({
  sourceSystem: text('source_system'),
  sourceId: text('source_id'),
  secondarySourceId: text('secondary_source_id').notNull().default(''),
})

interface IdentityColumns {
  companyId: PgColumn
  sourceSystem: PgColumn
  sourceId: PgColumn
  secondarySourceId: PgColumn
}

const identityUnique = (name: string) => (t: IdentityColumns) => [
  unique(`uq_${name}_external_identity`).on(
    t.companyId,
    t.sourceSystem,
    t.sourceId,
    t.secondarySourceId,
  ),
]

export const product = pgTable(
  'product',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    ...externalIdentity(),
    title: text('title').notNull(),
    sku: text('sku').notNull(),
    ean: text('ean'),
    price: doublePrecision('price'),
    cost: doublePrecision('cost'),
    categoryId: integer('category_id').references((): AnyPgColumn => category.id),
    weight: doublePrecision('weight'),
    length: doublePrecision('length'),
    width: doublePrecision('width'),
    height: doublePrecision('height'),
    active: boolean('active'),
    launchDate: date('launch_date'),
  },
  identityUnique('product'),
)

export const category = pgTable(
  'category',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    ...externalIdentity(),
    name: text('name').notNull(),
    parentId: integer('parent_id').references((): AnyPgColumn => category.id),
  },
  identityUnique('category'),
)

export const supplier = pgTable(
  'supplier',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    ...externalIdentity(),
    name: text('name').notNull(),
    currency: text('currency'),
    country: text('country'),
    leadTimeDays: integer('lead_time_days'),
  },
  identityUnique('supplier'),
)

export const supplierProduct = pgTable(
  'supplier_product',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    productId: integer('product_id')
      .notNull()
      .references(() => product.id),
    supplierId: integer('supplier_id')
      .notNull()
      .references(() => supplier.id),
    supplierSku: text('supplier_sku'),
    purchasePrice: doublePrecision('purchase_price'),
    preferred: boolean('preferred'),
  },
  (t) => [unique('uq_supplier_product').on(t.productId, t.supplierId)],
)

export const warehouseType = pgEnum('warehouse_type', ['WAREHOUSE', 'STORE', 'THIRD_PARTY'])

export const warehouse = pgTable(
  'warehouse',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    ...externalIdentity(),
    name: text('name').notNull(),
    type: warehouseType('type'),
    country: text('country'),
    city: text('city'),
    active: boolean('active').notNull().default(true),
  },
  identityUnique('warehouse'),
)

export const inventoryLevel = pgTable(
  'inventory_level',
  {
    id: serial('id').primaryKey(),
    companyId: companyId(),
    productId: integer('product_id')
      .notNull()
      .references(() => product.id),
    warehouseId: integer('warehouse_id')
      .notNull()
      .references(() => warehouse.id),
    onHand: integer('on_hand').notNull(),
    reserved: integer('reserved'),
    asOf: date('as_of').notNull(),
  },
  (t) => [unique('uq_inventory_level').on(t.productId, t.warehouseId)],
)

/** The tables a mapping can write to, in the order the target schema lists them. */
export const targetTables = {
  product,
  category,
  supplier,
  supplier_product: supplierProduct,
  warehouse,
  inventory_level: inventoryLevel,
}

/** Saved mapping versions (the document is @hockeymask/core's MappingVersion). */
export const mappingGraph = pgTable('mapping_graph', {
  id: text('id').primaryKey(),
  companyId: companyId(),
  name: text('name').notNull(),
  document: jsonb('document').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Target entities edited on the schema page (a TargetEntity document); replace the derived one. */
export const targetEntityEdit = pgTable(
  'target_entity_edit',
  {
    companyId: companyId(),
    name: text('name').notNull(),
    document: jsonb('document').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.name] })],
)
