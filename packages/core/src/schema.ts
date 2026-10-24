/**
 * Descriptions of source and target schemas.
 *
 * These are the nouns every other part of hockeymask speaks: connectors describe what a
 * source contains as `Table`s of `Column`s, the host application describes what it wants
 * to receive as a `TargetSchema`, and mapping graphs work between the two.
 *
 * Every type is a zod schema plus its inferred TypeScript type, so the same definition
 * validates data on the wire and types it in code.
 */

import { z } from 'zod'

/** A single decoded value. Dates are ISO strings ('2026-10-04'), decimals are numbers. */
export const Value = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type Value = z.infer<typeof Value>

/** One record as a source returns it: column name -> decoded value. */
export const Row = z.record(z.string(), Value)
export type Row = z.infer<typeof Row>

/**
 * Source-independent type of a column or field.
 *
 * Connectors translate each system's declared types into one of these. The declared type
 * is kept alongside (`Column.sourceType`), because it often carries meaning the logical
 * type loses, e.g. NetSuite declares checkboxes `boolean` but SuiteQL returns 'T' / 'F'.
 */
export const LogicalType = z.enum([
  'string',
  'integer',
  'decimal',
  'boolean',
  'date',
  'timestamp',
  'reference',
  'unknown',
])
export type LogicalType = z.infer<typeof LogicalType>

export const Column = z.object({
  name: z.string(),
  logicalType: LogicalType,
  sourceType: z.string().describe('Type exactly as the source declares it.'),
  nullable: z.boolean().default(true),
  label: z.string().nullable().default(null).describe('Human label shown in the source UI.'),
  description: z.string().nullable().default(null),
  isCustom: z.boolean().default(false).describe('Customer-added field, e.g. custitem_*.'),
  references: z
    .string()
    .nullable()
    .default(null)
    .describe('Table this column points at, when the source declares it.'),
})
export type Column = z.infer<typeof Column>

export const TableRef = z.object({
  name: z.string().describe("Name in the source's own notation, e.g. ANALYTICS.PLANNING.X."),
  label: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  rowCount: z.number().int().nullable().default(null),
})
export type TableRef = z.infer<typeof TableRef>

export const Table = TableRef.extend({ columns: z.array(Column) })
export type Table = z.infer<typeof Table>

/** A batch of rows together with the columns that describe them. */
export const RowSet = z.object({
  columns: z.array(Column),
  rows: z.array(Row),
  totalRows: z
    .number()
    .int()
    .nullable()
    .default(null)
    .describe('Rows the query would return without a limit, if known.'),
})
export type RowSet = z.infer<typeof RowSet>

export const TargetField = z.object({
  name: z.string(),
  logicalType: LogicalType,
  nullable: z.boolean().default(true),
  description: z.string().nullable().default(null),
  unit: z.string().nullable().default(null).describe("Unit the target stores, e.g. 'g' or 'm'."),
  references: z.string().nullable().default(null).describe('Target entity of a foreign key.'),
})
export type TargetField = z.infer<typeof TargetField>

export const TargetEntity = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
  identity: z
    .array(z.string())
    .default([])
    .describe('Fields a re-import uses to find the row it wrote last time.'),
  nullsNotDistinct: z
    .boolean()
    .optional()
    .describe(
      'The identity matches NULLs as equal (NULLS NOT DISTINCT), so a nullable identity field may be part of an upsert key.',
    ),
  fields: z.array(TargetField),
})
export type TargetEntity = z.infer<typeof TargetEntity>

export const TargetSchema = z.object({
  name: z.string(),
  entities: z.array(TargetEntity),
})
export type TargetSchema = z.infer<typeof TargetSchema>

/** Column of `table` named `name`, ignoring case (source systems differ on case). */
export function findColumn(table: Table, name: string): Column {
  const wanted = name.toLowerCase()
  const column = table.columns.find((c) => c.name.toLowerCase() === wanted)
  if (!column) throw new Error(`${table.name} has no column '${name}'`)
  return column
}

export function findEntity(schema: TargetSchema, name: string): TargetEntity {
  const entity = schema.entities.find((e) => e.name === name)
  if (!entity) throw new Error(`${schema.name} has no entity '${name}'`)
  return entity
}

export function findField(entity: TargetEntity, name: string): TargetField {
  const field = entity.fields.find((f) => f.name === name)
  if (!field) throw new Error(`${entity.name} has no field '${name}'`)
  return field
}

/** Build a Column with the defaults filled in. */
export function column(
  input: Pick<Column, 'name' | 'logicalType' | 'sourceType'> & Partial<Column>,
): Column {
  return Column.parse(input)
}
