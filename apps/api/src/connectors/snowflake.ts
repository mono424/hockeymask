/**
 * Snowflake through the SQL API v2. Results arrive as strings described by
 * `resultSetMetaData.rowType`, split into partitions fetched one by one. Discovery uses the
 * database's INFORMATION_SCHEMA.
 */

import {
  type Column,
  type Connector,
  ConnectorError,
  column,
  type LogicalType,
  type Row,
  type RowSet,
  type Table,
  type TableRef,
  type Value,
} from '@hockeymask/core'
import { type HttpOptions, IDENTIFIER, requestJson } from './http'

const STATEMENTS = '/api/v2/statements'
const DAY_MS = 86_400_000

interface RowType {
  name: string
  type: string
  scale?: number | null
  precision?: number | null
  nullable?: boolean
}

interface StatementResult {
  resultSetMetaData: { numRows: number; rowType: RowType[]; partitionInfo?: unknown[] }
  data: (string | null)[][]
  statementHandle: string
}

export interface SnowflakeOptions extends HttpOptions {
  database: string
  schema: string
  warehouse?: string
}

export class SnowflakeConnector implements Connector {
  readonly system = 'Snowflake'
  readonly dialect = 'snowflake'
  private readonly database: string
  private readonly schema: string

  constructor(private readonly options: SnowflakeOptions) {
    this.database = identifier(options.database).toUpperCase()
    this.schema = identifier(options.schema).toUpperCase()
  }

  async listTables(): Promise<TableRef[]> {
    const rows = await this.all(
      `SELECT TABLE_NAME, ROW_COUNT, COMMENT FROM ${this.database}.INFORMATION_SCHEMA.TABLES ` +
        `WHERE TABLE_SCHEMA = '${this.schema}' ORDER BY TABLE_NAME`,
    )
    return rows.map((r) => ({
      name: `${this.database}.${this.schema}.${r.TABLE_NAME}`,
      label: null,
      description: (r.COMMENT as string | null) ?? null,
      rowCount: (r.ROW_COUNT as number | null) ?? null,
    }))
  }

  async describe(table: string): Promise<Table> {
    const [db, schema, name] = this.qualify(table)
    const [found] = await this.all(
      `SELECT COMMENT, ROW_COUNT FROM ${db}.INFORMATION_SCHEMA.TABLES ` +
        `WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${name}'`,
    )
    if (!found)
      throw new ConnectorError(`Table ${db}.${schema}.${name} does not exist or not authorized.`)
    const columns = await this.all(
      'SELECT COLUMN_NAME, DATA_TYPE, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COMMENT ' +
        `FROM ${db}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${schema}' ` +
        `AND TABLE_NAME = '${name}' ORDER BY ORDINAL_POSITION`,
    )
    return {
      name: `${db}.${schema}.${name}`,
      label: null,
      description: (found.COMMENT as string | null) ?? null,
      rowCount: (found.ROW_COUNT as number | null) ?? null,
      columns: columns.map((r) => {
        const dataType = String(r.DATA_TYPE)
        const scale = r.NUMERIC_SCALE as number | null
        return column({
          name: String(r.COLUMN_NAME),
          logicalType: logical(dataType, scale),
          sourceType: dataType === 'NUMBER' ? `NUMBER(${r.NUMERIC_PRECISION},${scale})` : dataType,
          nullable: r.IS_NULLABLE === 'YES',
          description: (r.COMMENT as string | null) ?? null,
        })
      }),
    }
  }

  async sample(table: string, limit = 20): Promise<RowSet> {
    const described = await this.describe(table)
    const rows = await this.all(`SELECT * FROM ${described.name} LIMIT ${Math.trunc(limit)}`)
    return { columns: described.columns, rows, totalRows: described.rowCount }
  }

  async *read(table: string, options: { batchSize?: number } = {}): AsyncIterable<Row[]> {
    const batchSize = options.batchSize ?? 10_000
    const [db, schema, name] = this.qualify(table)
    const { partitions } = await this.execute(`SELECT * FROM ${db}.${schema}.${name}`)
    let buffer: Row[] = []
    for await (const partition of partitions) {
      buffer.push(...partition)
      while (buffer.length >= batchSize) {
        yield buffer.slice(0, batchSize)
        buffer = buffer.slice(batchSize)
      }
    }
    if (buffer.length > 0) yield buffer
  }

  async query(sql: string, options: { limit?: number } = {}): Promise<RowSet> {
    const { meta, partitions } = await this.execute(sql)
    let rows: Row[] = []
    for await (const partition of partitions) {
      rows.push(...partition)
      if (options.limit !== undefined && rows.length >= options.limit) {
        rows = rows.slice(0, options.limit)
        break
      }
    }
    return { columns: meta.rowType.map(columnFromRowType), rows, totalRows: meta.numRows }
  }

  // --- transport ------------------------------------------------------------------------

  private qualify(table: string): [string, string, string] {
    const parts = table.split('.').map((p) => identifier(p).toUpperCase())
    if (parts.length === 1) return [this.database, this.schema, parts[0] as string]
    if (parts.length === 3) return parts as [string, string, string]
    throw new ConnectorError(`'${table}' is not a table name (TABLE or DB.SCHEMA.TABLE)`)
  }

  private async all(sql: string): Promise<Row[]> {
    const rows: Row[] = []
    for await (const partition of (await this.execute(sql)).partitions) rows.push(...partition)
    return rows
  }

  private async post(path: string, body?: unknown): Promise<StatementResult> {
    const result = await requestJson(
      this.system,
      this.options,
      path,
      body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
      (status, payload) =>
        (payload as { message?: string } | null)?.message ?? `Snowflake answered ${status}`,
    )
    return result.body as StatementResult
  }

  private async execute(sql: string) {
    const result = await this.post(STATEMENTS, {
      statement: sql,
      database: this.database,
      schema: this.schema,
      warehouse: this.options.warehouse ?? 'COMPUTE_WH',
    })
    const meta = result.resultSetMetaData
    const decoders = meta.rowType.map(decoder)
    const decode = (data: (string | null)[][]): Row[] =>
      data.map((values) =>
        Object.fromEntries(
          meta.rowType.map((rt, i) => {
            const raw = values[i]
            return [
              rt.name,
              raw === null || raw === undefined ? null : (decoders[i] as (v: string) => Value)(raw),
            ]
          }),
        ),
      )
    const fetchPartition = (index: number) =>
      this.post(`${STATEMENTS}/${result.statementHandle}?partition=${index}`).then((p) =>
        decode(p.data),
      )
    async function* partitions(): AsyncIterable<Row[]> {
      yield decode(result.data)
      for (let index = 1; index < (meta.partitionInfo?.length ?? 1); index += 1) {
        yield await fetchPartition(index)
      }
    }
    return { meta, partitions: partitions() }
  }
}

function identifier(name: string): string {
  if (!IDENTIFIER.test(name))
    throw new ConnectorError(`'${name}' is not a plain Snowflake identifier`)
  return name
}

function decoder(rt: RowType): (raw: string) => Value {
  switch (rt.type) {
    case 'fixed':
    case 'real':
      return Number
    case 'date':
      return (raw) => new Date(Number(raw) * DAY_MS).toISOString().slice(0, 10)
    case 'boolean':
      return (raw) => raw.toLowerCase() === 'true'
    default:
      if (rt.type.startsWith('timestamp')) {
        return (raw) => new Date(Number(raw.split(' ')[0]) * 1000).toISOString().slice(0, 23)
      }
      return (raw) => raw
  }
}

function logical(kind: string, scale: number | null | undefined): LogicalType {
  const k = kind.toUpperCase()
  if (k === 'FIXED' || k === 'NUMBER') return scale ? 'decimal' : 'integer'
  if (k === 'REAL' || k === 'FLOAT') return 'decimal'
  if (k === 'TEXT' || k === 'VARCHAR') return 'string'
  if (k === 'DATE') return 'date'
  if (k.startsWith('TIMESTAMP')) return 'timestamp'
  if (k === 'BOOLEAN') return 'boolean'
  return 'unknown'
}

function columnFromRowType(rt: RowType): Column {
  const sourceType =
    rt.type === 'fixed'
      ? `NUMBER(${rt.precision},${rt.scale})`
      : rt.type === 'real'
        ? 'FLOAT'
        : rt.type.toUpperCase()
  return column({
    name: rt.name,
    logicalType: logical(rt.type, rt.scale),
    sourceType,
    nullable: rt.nullable ?? true,
  })
}
