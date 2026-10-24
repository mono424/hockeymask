import { describe, expect, it } from 'vite-plus/test'
import {
  conformRows,
  conforms,
  entityJsonSchema,
  sourceRecordType,
  tableJsonSchema,
} from '../../src/mapping/jsonschema'
import { Instant } from '../../src/mapping/time'
import { type MType, show, t } from '../../src/mapping/types'
import { column, TargetEntity } from '../../src/schema'

const fieldOf = (node: Record<string, unknown>, required = true) => {
  const type = sourceRecordType({
    type: 'object',
    required: required ? ['f'] : [],
    properties: { f: node },
  })
  if (!type.ok) throw new Error(type.error)
  return show(type.value.fields.f as MType)
}

describe('sourceRecordType', () => {
  it.each([
    [{ type: 'string' }, 'string'],
    [{ type: 'string', format: 'date' }, 'string'],
    [{ type: 'number' }, 'number'],
    [{ type: 'integer' }, 'number'],
    [{ type: 'boolean' }, 'boolean'],
    [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, 'string?'],
    [{ oneOf: [{ type: 'number' }] }, 'number'],
    [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, 'unknown'],
    [{ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] }, 'unknown?'],
    [{ type: ['string', 'null'] }, 'string?'],
    [{ type: ['integer'] }, 'number'],
    [{ type: ['string', 'number'] }, 'unknown'],
    [{ enum: ['kg', 'g'] }, 'string'],
    [{ type: 'string', enum: ['kg', null] }, 'string?'],
    [{ enum: [0, 1] }, 'number'],
    [{ enum: [true] }, 'boolean'],
    [{ enum: [1, 'a'] }, 'unknown'],
    [{ enum: [{ a: 1 }] }, 'unknown'],
    [{ type: 'array', items: { type: 'string' } }, 'list<string>'],
    [{ type: 'array' }, 'list<unknown>'],
    [{ type: 'object', properties: { a: { type: 'number' } } }, '{ a: number }'],
    [{ type: 'object' }, '{  }'],
    [{}, 'unknown'],
    [{ type: 'null' }, 'unknown'],
  ])('%j is %s', (node, expected) => {
    expect(fieldOf(node)).toBe(expected)
  })

  it('makes optional fields nullable, since a missing field reads as null', () => {
    expect(fieldOf({ type: 'string' }, false)).toBe('string?')
    expect(fieldOf({ type: ['string', 'null'] }, false)).toBe('string?')
  })

  it.each([
    [{ type: 'array', items: {} }],
    [{ type: 'object' }],
    [{ type: 'object', properties: null }],
  ])('rejects a schema that is not one object record: %j', (schema) => {
    expect(sourceRecordType(schema)).toEqual({
      ok: false,
      error: 'a source schema must describe one object record ("type": "object" with "properties")',
    })
  })

  it('ignores a malformed required list', () => {
    const type = sourceRecordType({
      type: 'object',
      required: 'a',
      properties: { a: { type: 'string' } },
    })
    expect(type.ok && show(type.value)).toBe('{ a: string? }')
  })
})

describe('generated schemas', () => {
  const table = {
    name: 'item',
    label: null,
    description: null,
    rowCount: null,
    columns: [
      column({
        name: 's',
        logicalType: 'string',
        sourceType: 'varchar',
        nullable: false,
        description: 'SKU',
      }),
      column({ name: 'i', logicalType: 'integer', sourceType: 'int' }),
      column({ name: 'd', logicalType: 'decimal', sourceType: 'num', nullable: false }),
      column({ name: 'b', logicalType: 'boolean', sourceType: 'bool', nullable: false }),
      column({ name: 'day', logicalType: 'date', sourceType: 'date' }),
      column({ name: 'at', logicalType: 'timestamp', sourceType: 'ts', nullable: false }),
      column({ name: 'r', logicalType: 'reference', sourceType: 'ref' }),
    ],
  }

  it('describes a connector table as one record', () => {
    const schema = tableJsonSchema(table, 'netsuite')
    expect(schema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'netsuite.item',
      type: 'object',
      required: ['s', 'd', 'b', 'at'],
      properties: {
        s: { type: 'string', description: 'SKU' },
        i: { type: ['integer', 'null'] },
        d: { type: 'number' },
        b: { type: 'boolean' },
        day: { type: ['string', 'null'], format: 'date' },
        at: { type: 'string', format: 'date-time' },
        r: {},
      },
      additionalProperties: true,
    })
    expect(tableJsonSchema(table).$id).toBe('item')
    const type = sourceRecordType(schema)
    expect(type.ok && show(type.value)).toBe(
      '{ s: string, i: number?, d: number, b: boolean, day: string?, at: string, r: unknown? }',
    )
  })

  it('pins an internal entity', () => {
    const entity = TargetEntity.parse({
      name: 'warehouse',
      fields: [
        { name: 'code', logicalType: 'string', nullable: false },
        { name: 'active', logicalType: 'boolean' },
      ],
    })
    expect(entityJsonSchema(entity)).toMatchObject({
      $id: 'internal.warehouse',
      required: ['code'],
      properties: { code: { type: 'string' }, active: { type: ['boolean', 'null'] } },
    })
  })
})

describe('conforms', () => {
  const date = Instant.ofEpochMs(0)
  it.each([
    [null, t.nullable(t.string), true],
    [null, t.unknown, true],
    [null, t.string, false],
    ['a', t.nullable(t.string), true],
    [{ x: 1 }, t.unknown, true],
    ['a', t.string, true],
    [1, t.string, false],
    [1.5, t.number, true],
    [Number.NaN, t.number, false],
    [Number.POSITIVE_INFINITY, t.number, false],
    [true, t.boolean, true],
    ['true', t.boolean, false],
    [date, t.date, true],
    ['1970-01-01', t.date, false],
    [['a', null], t.list(t.nullable(t.string)), true],
    [['a', 1], t.list(t.string), false],
    ['a', t.list(t.string), false],
    [[1, 'a'], t.tuple([t.number, t.string]), true],
    [[1], t.tuple([t.number, t.string]), false],
    [['a', 'a'], t.tuple([t.number, t.string]), false],
    ['a', t.tuple([t.number]), false],
    [{ a: 1 }, t.record({ a: t.number, b: t.nullable(t.string) }), true],
    [{ b: 'x' }, t.record({ a: t.number }), false],
    [[1], t.record({}), false],
    [date, t.record({}), false],
    ['a', t.never, false],
    ['a', t.unit, false],
  ])('%j in %o is %s', (value, type, expected) => {
    expect(conforms(value as never, type)).toBe(expected)
  })
})

describe('conformRows', () => {
  const type = t.record({ a: t.string, n: t.nullable(t.number) })

  it('projects onto the declared fields; missing fields read as null', () => {
    expect(conformRows([{ a: 'x', n: 1, extra: true }, { a: 'y' }], type)).toEqual({
      rows: [
        { a: 'x', n: 1 },
        { a: 'y', n: null },
      ],
      violations: [],
    })
  })

  it('counts violations per field, sampling the first five rows', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ a: i, n: i === 3 ? 'x' : i }))
    const result = conformRows(rows, type)
    expect(result.violations).toEqual([
      { field: 'a', expected: 'string', count: 7, samples: [0, 1, 2, 3, 4] },
      { field: 'n', expected: 'number?', count: 1, samples: [3] },
    ])
    expect(result.rows).toHaveLength(7)
  })
})
