/**
 * NetSuite through its REST web services: the metadata catalog and SuiteQL.
 *
 * `describe` reads a record's JSON Schema (labels, custom-field flags, references). Rows come
 * from SuiteQL, which sends every value as a string, leaves NULL fields out and renders
 * dates in the account's date format; `sample` / `read` decode that against the schema.
 * `query` returns SuiteQL's strings untouched: a free-form statement has no schema.
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
} from '@hockeymask/core'
import { type HttpOptions, IDENTIFIER, requestJson } from './http'

const RECORD = '/services/rest/record/v1'
const SUITEQL = '/services/rest/query/v1/suiteql'
const PAGE_LIMIT = 1000

interface SuiteQLPage {
  items: Record<string, string>[]
  count: number
  hasMore: boolean
  totalResults: number
}

interface JsonSchemaProperty {
  type?: string
  format?: string
  title?: string
  description?: string
  nullable?: boolean
  $ref?: string
  'x-ns-custom-field'?: boolean
  'x-ns-referenced-record'?: string
}

export interface NetSuiteOptions extends HttpOptions {
  /** The account's date preference as strftime tokens; SuiteQL renders dates in it. */
  dateFormat?: string
}

export class NetSuiteConnector implements Connector {
  readonly system = 'NetSuite'
  readonly dialect = 'suiteql'
  private readonly schemas = new Map<string, Table>()

  constructor(private readonly options: NetSuiteOptions) {}

  async listTables(): Promise<TableRef[]> {
    const catalog = (await this.get(`${RECORD}/metadata-catalog`)) as { items: { name: string }[] }
    const tables = await Promise.all(catalog.items.map((item) => this.describe(item.name)))
    return tables.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      rowCount: t.rowCount,
    }))
  }

  async describe(table: string): Promise<Table> {
    const schema = await this.schema(table)
    const page = await this.suiteql(`SELECT COUNT(*) AS n FROM ${schema.name}`, 1, 0)
    return { ...schema, rowCount: Number(page.items[0]?.n ?? 0) }
  }

  /** The first `limit` rows, over as many SuiteQL pages as that takes. */
  async sample(table: string, limit = 20): Promise<RowSet> {
    const schema = await this.schema(table)
    const rows: Row[] = []
    let total = 0
    for await (const page of this.pages(
      `SELECT * FROM ${schema.name}`,
      Math.min(limit, PAGE_LIMIT),
    )) {
      total = page.totalResults
      rows.push(...page.items.map((item) => this.decode(item, schema.columns)))
      if (rows.length >= limit) break
    }
    return { columns: schema.columns, rows: rows.slice(0, limit), totalRows: total }
  }

  async *read(table: string, options: { batchSize?: number } = {}): AsyncIterable<Row[]> {
    const schema = await this.schema(table)
    const order = schema.columns.some((c) => c.name === 'id') ? ' ORDER BY id' : ''
    for await (const page of this.pages(
      `SELECT * FROM ${schema.name}${order}`,
      options.batchSize,
    )) {
      yield page.items.map((item) => this.decode(item, schema.columns))
    }
  }

  async query(sql: string, options: { limit?: number } = {}): Promise<RowSet> {
    const rows: Row[] = []
    const names = new Set<string>()
    let total: number | null = null
    for await (const page of this.pages(sql, Math.min(options.limit ?? PAGE_LIMIT, PAGE_LIMIT))) {
      total = page.totalResults
      for (const item of page.items) {
        const row: Row = {}
        for (const [name, value] of Object.entries(item)) {
          if (name === 'links') continue
          names.add(name)
          row[name] = value
        }
        rows.push(row)
      }
      if (options.limit !== undefined && rows.length >= options.limit) break
    }
    const columns = [...names].map((name) =>
      column({ name, logicalType: 'string', sourceType: 'suiteql' }),
    )
    return {
      columns,
      rows: rows
        .slice(0, options.limit)
        .map((row) => Object.fromEntries([...names].map((n) => [n, row[n] ?? null]))),
      totalRows: total,
    }
  }

  // --- transport ------------------------------------------------------------------------

  private async schema(table: string): Promise<Table> {
    if (!IDENTIFIER.test(table))
      throw new ConnectorError(`'${table}' is not a NetSuite record type`)
    const cached = this.schemas.get(table)
    if (cached) return cached
    const schema = (await this.get(`${RECORD}/metadata-catalog/${table}`, {
      Accept: 'application/schema+json',
    })) as {
      title?: string
      description?: string
      required?: string[]
      properties?: Record<string, JsonSchemaProperty>
    }
    const required = new Set(schema.required ?? [])
    const result: Table = {
      name: table,
      label: schema.title ?? null,
      description: schema.description ?? null,
      rowCount: null,
      columns: Object.entries(schema.properties ?? {}).map(([name, prop]) =>
        toColumn(name, prop, required.has(name)),
      ),
    }
    this.schemas.set(table, result)
    return result
  }

  private async get(path: string, headers: Record<string, string> = {}): Promise<unknown> {
    const { body } = await requestJson(
      this.system,
      this.options,
      path,
      { method: 'GET', headers },
      errorMessage,
    )
    return body
  }

  private async suiteql(sql: string, limit: number, offset: number): Promise<SuiteQLPage> {
    const { body } = await requestJson(
      this.system,
      this.options,
      `${SUITEQL}?limit=${limit}&offset=${offset}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'transient' },
        body: JSON.stringify({ q: sql }),
      },
      errorMessage,
    )
    return body as SuiteQLPage
  }

  private async *pages(sql: string, limit = PAGE_LIMIT): AsyncIterable<SuiteQLPage> {
    let offset = 0
    while (true) {
      const page = await this.suiteql(sql, limit, offset)
      yield page
      if (!page.hasMore) return
      offset += page.count
    }
  }

  private decode(item: Record<string, string>, columns: Column[]): Row {
    const row: Row = {}
    for (const c of columns) {
      const raw = item[c.name]
      row[c.name] = raw === undefined ? null : this.decodeValue(raw, c.logicalType)
    }
    return row
  }

  private decodeValue(raw: string, type: LogicalType): string | number {
    switch (type) {
      case 'integer':
      case 'reference':
      case 'decimal':
        return Number(raw)
      case 'date':
        return parseDate(raw, this.options.dateFormat ?? '%d.%m.%Y') ?? raw
      default:
        return raw // strings and 'T' / 'F' checkboxes stay as NetSuite says them
    }
  }
}

function toColumn(name: string, prop: JsonSchemaProperty, required: boolean): Column {
  let logicalType: LogicalType = 'unknown'
  let sourceType = String(prop.type)
  let references: string | null = null
  if (prop.$ref || prop.type === 'object') {
    references = prop['x-ns-referenced-record'] ?? prop.$ref?.split('/').pop() ?? null
    logicalType = 'reference'
    sourceType = `select:${references}`
  } else if (prop.type === 'integer') logicalType = 'integer'
  else if (prop.type === 'number') logicalType = 'decimal'
  else if (prop.type === 'boolean') logicalType = 'boolean'
  else if (prop.type === 'string' && prop.format === 'date')
    [logicalType, sourceType] = ['date', 'date']
  else if (prop.type === 'string' && prop.format === 'date-time')
    [logicalType, sourceType] = ['timestamp', 'date-time']
  else if (prop.type === 'string') logicalType = 'string'
  return column({
    name,
    logicalType,
    sourceType,
    nullable: prop.nullable ?? !required,
    label: prop.title ?? null,
    description: prop.description ?? null,
    isCustom: Boolean(prop['x-ns-custom-field']),
    references,
  })
}

/** Parse a date rendered with strftime tokens (%d %m %Y) into 'YYYY-MM-DD'. */
export function parseDate(text: string, format: string): string | null {
  const order: string[] = []
  const pattern = format.replace(/%[dmY]|[.*+?^${}()|[\]\\/]/g, (token) => {
    if (token === '%d' || token === '%m') {
      order.push(token)
      return '(\\d{1,2})'
    }
    if (token === '%Y') {
      order.push(token)
      return '(\\d{4})'
    }
    return `\\${token}`
  })
  const match = new RegExp(`^${pattern}$`).exec(text)
  if (!match) return null
  const part = (token: string) => match[order.indexOf(token) + 1] ?? ''
  return `${part('%Y')}-${part('%m').padStart(2, '0')}-${part('%d').padStart(2, '0')}`
}

function errorMessage(status: number, body: unknown): string {
  const details = (body as { 'o:errorDetails'?: { detail?: string }[] } | null)?.['o:errorDetails']
  if (details?.[0]?.detail) return details[0].detail
  return `NetSuite answered ${status}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)}`
}
