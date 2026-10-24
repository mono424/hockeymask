/**
 * `expectedSchema` as JSON Schema (arch.md, "expectedSchema is the type environment").
 *
 * The stored schema of a source is its type environment: `sourceRecordType` derives the
 * record type a `source` node emits. `format` stays a validation constraint, never a type: a
 * `{ "type": "string", "format": "date" }` field is a `string`, and `to_date` makes a date.
 *
 * Until per-record contract validation (Ajv) exists, `conformRows` is the runtime guard: it
 * projects rows onto the declared fields and checks every value against its declared type.
 */

import type { Column, LogicalType, Table, TargetEntity } from '../schema'
import type { JsonSchema } from './document'
import { err, ok, type Result } from './result'
import { Instant } from './time'
import { type MType, type NonNull, type RecordType, show, t } from './types'
import { isRecordVal, type Json, type Rec, type Val } from './values'

type Node = Readonly<Record<string, unknown>>

const DIALECT = 'https://json-schema.org/draft/2020-12/schema'

/** The record type of a source's schema. Optional fields read as null, so are nullable. */
export function sourceRecordType(schema: JsonSchema): Result<RecordType, string> {
  const properties = schema.properties as Readonly<Record<string, Node>> | undefined
  if (schema.type !== 'object' || typeof properties !== 'object' || properties === null) {
    return err(
      'a source schema must describe one object record ("type": "object" with "properties")',
    )
  }
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const fields: Record<string, MType> = {}
  for (const [name, node] of Object.entries(properties)) {
    const type = toMType(node)
    fields[name] = required.has(name) ? type : t.nullable(type)
  }
  return ok(t.record(fields))
}

function toMType(node: Node): MType {
  const union = (node.anyOf ?? node.oneOf) as readonly Node[] | undefined
  if (Array.isArray(union)) {
    const nonNull = union.filter((m) => m.type !== 'null')
    const inner = nonNull.length === 1 ? toMType(nonNull[0] as Node) : t.unknown
    return union.length > nonNull.length ? t.nullable(inner) : inner
  }
  if (Array.isArray(node.type)) {
    const types = node.type as readonly string[]
    const nonNull = types.filter((x) => x !== 'null')
    const inner = nonNull.length === 1 ? toMType({ ...node, type: nonNull[0] }) : t.unknown
    return nonNull.length < types.length ? t.nullable(inner) : inner
  }
  if (Array.isArray(node.enum)) {
    const kinds = new Set(
      (node.enum as readonly unknown[]).map((v) => (v === null ? 'null' : typeof v)),
    )
    const hasNull = kinds.delete('null')
    const inner: MType = kinds.size === 1 ? scalar([...kinds][0] as string) : t.unknown
    return hasNull ? t.nullable(inner) : inner
  }
  switch (node.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return scalar(node.type)
    case 'integer':
      return t.number
    case 'array':
      return t.list(
        typeof node.items === 'object' && node.items ? toMType(node.items as Node) : t.unknown,
      )
    case 'object': {
      const props = (node.properties ?? {}) as Readonly<Record<string, Node>>
      return t.record(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toMType(v)])))
    }
    default:
      return t.unknown
  }
}

function scalar(kind: string): NonNull {
  switch (kind) {
    case 'string':
      return t.string
    case 'number':
      return t.number
    case 'boolean':
      return t.boolean
    default:
      return t.unknown
  }
}

function logicalSchema(logical: LogicalType): Record<string, Json> {
  switch (logical) {
    case 'string':
      return { type: 'string' }
    case 'integer':
      return { type: 'integer' }
    case 'decimal':
      return { type: 'number' }
    case 'boolean':
      return { type: 'boolean' }
    case 'date':
      return { type: 'string', format: 'date' }
    case 'timestamp':
      return { type: 'string', format: 'date-time' }
    default:
      return {}
  }
}

function fieldSchema(logical: LogicalType, nullable: boolean, description?: string | null) {
  const base = logicalSchema(logical)
  const typed =
    nullable && typeof base.type === 'string' ? { ...base, type: [base.type, 'null'] } : base
  return description ? { ...typed, description } : typed
}

function objectSchema(
  id: string,
  fields: readonly {
    name: string
    logical: LogicalType
    nullable: boolean
    description?: string | null
  }[],
): JsonSchema {
  return {
    $schema: DIALECT,
    $id: id,
    type: 'object',
    required: fields.filter((f) => !f.nullable).map((f) => f.name),
    properties: Object.fromEntries(
      fields.map((f) => [f.name, fieldSchema(f.logical, f.nullable, f.description)]),
    ),
    additionalProperties: true,
  }
}

/** A starting `expectedSchema` for a source table, from what its connector describes. */
export function tableJsonSchema(table: Table, system?: string): JsonSchema {
  return objectSchema(
    system ? `${system}.${table.name}` : table.name,
    table.columns.map((c: Column) => ({
      name: c.name,
      logical: c.logicalType,
      nullable: c.nullable,
      description: c.description,
    })),
  )
}

/** The pinned schema of an internal entity read as a source. */
export function entityJsonSchema(entity: TargetEntity): JsonSchema {
  return objectSchema(
    `internal.${entity.name}`,
    entity.fields.map((f) => ({
      name: f.name,
      logical: f.logicalType,
      nullable: f.nullable,
      description: f.description,
    })),
  )
}

/** Does a runtime value inhabit this type? */
export function conforms(value: Val, type: MType): boolean {
  if (value === null) return type.kind === 'nullable' || type.kind === 'unknown'
  switch (type.kind) {
    case 'nullable':
      return conforms(value, type.of)
    case 'unknown':
      return true
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'date':
      return value instanceof Instant
    case 'list':
      return Array.isArray(value) && (value as readonly Val[]).every((v) => conforms(v, type.of))
    case 'tuple':
      return (
        Array.isArray(value) &&
        value.length === type.of.length &&
        type.of.every((x, i) => conforms((value as readonly Val[])[i] as Val, x))
      )
    case 'record':
      return (
        isRecordVal(value) &&
        Object.entries(type.fields).every(([k, v]) => conforms(value[k] ?? null, v))
      )
    default:
      return false
  }
}

export interface FieldViolation {
  readonly field: string
  readonly expected: string
  readonly count: number
  /** Row positions of the first violations. */
  readonly samples: readonly number[]
}

/** Project rows onto the declared fields and check each value; one violation per field. */
export function conformRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  type: RecordType,
): { rows: Rec[]; violations: FieldViolation[] } {
  const fields = Object.entries(type.fields)
  const counts = new Map<string, { count: number; samples: number[] }>()
  const out: Rec[] = []
  for (const [i, row] of rows.entries()) {
    const rec: Record<string, Val> = {}
    for (const [name, fieldType] of fields) {
      const value = (row[name] ?? null) as Val
      if (!conforms(value, fieldType)) {
        const v = counts.get(name) ?? { count: 0, samples: [] }
        v.count += 1
        if (v.samples.length < 5) v.samples.push(i)
        counts.set(name, v)
      }
      rec[name] = value
    }
    out.push(rec)
  }
  return {
    rows: out,
    violations: [...counts].map(([field, v]) => ({
      field,
      expected: show(type.fields[field] as MType),
      ...v,
    })),
  }
}
