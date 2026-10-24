/**
 * Snowflake SQL API v2 semantics over DuckDB.
 *
 * What a client sees, as with a real account:
 * - `resultSetMetaData.rowType` describes columns in Snowflake types (fixed, real, text,
 *   date, timestamp_ntz, boolean) with precision / scale;
 * - every value is a string or null; DATE is days since the epoch, TIMESTAMP is
 *   seconds.nanoseconds since the epoch;
 * - large results are split into partitions; the POST answer carries partition 0, the rest
 *   come from `GET /api/v2/statements/{handle}?partition=N`;
 * - unquoted identifiers come back upper-cased; `INFORMATION_SCHEMA`, `SHOW TABLES` and
 *   `DESCRIBE TABLE` work; the role is read-only.
 */

import { randomUUID } from 'node:crypto'
import type { Json } from '@duckdb/node-api'
import type { Store } from './store'

const DAY_MS = 86_400_000
const INT_TYPES = new Set([
  'BIGINT',
  'INTEGER',
  'SMALLINT',
  'TINYINT',
  'HUGEINT',
  'UBIGINT',
  'UINTEGER',
])
const DECIMAL = /^DECIMAL\((\d+),\s*(\d+)\)$/
const INFORMATION_SCHEMA = /(?:\b(?:"[^"]+"|[A-Za-z_]\w*)\s*\.\s*)?\bINFORMATION_SCHEMA\s*\./gi
const SHOW_TABLES =
  /^SHOW\s+(?:TERSE\s+)?TABLES(?:\s+LIKE\s+'(?<like>[^']*)')?(?:\s+IN\s+(?:(?<dbOnly>DATABASE)\s+(?<db>[\w"]+)|(?:SCHEMA\s+)?(?<scope>[\w."]+)))?$/i
const DESCRIBE = /^DESC(?:RIBE)?\s+TABLE\s+(?<name>[\w."]+)$/i
const WRITE_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'COPY',
  'PUT',
  'REMOVE',
  'CALL',
  'UNDROP',
  'COMMENT',
])

export class SqlApiError extends Error {
  constructor(
    readonly code: string,
    readonly sqlState: string,
    message: string,
    readonly status: 400 | 404 | 422 = 422,
  ) {
    super(message)
  }
}

export interface RowType {
  name: string
  database: string
  schema: string
  table: string
  nullable: boolean
  type: string
  byteLength: number | null
  length: number | null
  scale: number | null
  precision: number | null
  collation: null
}

export interface Statement {
  handle: string
  rowType: RowType[]
  partitions: (string | null)[][][]
  numRows: number
  createdOn: number
}

/** Recent results, so later partitions can be fetched by handle. */
export class StatementCache {
  private readonly items = new Map<string, Statement>()
  constructor(private readonly size = 32) {}

  put(statement: Statement): void {
    this.items.delete(statement.handle)
    this.items.set(statement.handle, statement)
    while (this.items.size > this.size) {
      this.items.delete(this.items.keys().next().value as string)
    }
  }

  get(handle: string): Statement | undefined {
    return this.items.get(handle)
  }
}

const unquote = (identifier: string) =>
  identifier.startsWith('"') ? identifier.slice(1, -1) : identifier.toUpperCase()
const sqlLiteral = (text: string) => `'${text.replaceAll("'", "''")}'`

function splitName(name: string, database: string, schema: string): [string, string, string] {
  const parts = (name.match(/"[^"]+"|[^.]+/g) ?? []).map(unquote)
  if (parts.length === 1) return [database, schema, parts[0] as string]
  if (parts.length === 2) return [database, parts[0] as string, parts[1] as string]
  if (parts.length === 3) return parts as [string, string, string]
  throw new SqlApiError('001003', '42000', `SQL compilation error:\ninvalid name '${name}'`)
}

/** Return [DuckDB SQL, whether result names keep their case]. */
export function translate(statement: string, database: string, schema: string): [string, boolean] {
  const sql = statement.trim().replace(/;+$/, '').trim()
  if (sql.replace(/'[^']*'/g, '').includes(';')) {
    throw new SqlApiError(
      '000008',
      '0A000',
      'Actual statement count 2 did not match the desired statement count 1.',
    )
  }
  const keyword = sql.split(/\s+/, 1)[0]?.toUpperCase() ?? ''

  const show = SHOW_TABLES.exec(sql)
  if (show?.groups) {
    const g = show.groups
    const where: string[] = []
    if (g.dbOnly) where.push(`TABLE_CATALOG = ${sqlLiteral(unquote(g.db as string))}`)
    else if (g.scope) {
      const parts = g.scope.split('.').map(unquote)
      const [db, sch] = parts.length === 1 ? [database, parts[0]] : [parts[0], parts[1]]
      where.push(
        `TABLE_CATALOG = ${sqlLiteral(db as string)}`,
        `TABLE_SCHEMA = ${sqlLiteral(sch as string)}`,
      )
    } else {
      where.push(`TABLE_CATALOG = ${sqlLiteral(database)}`, `TABLE_SCHEMA = ${sqlLiteral(schema)}`)
    }
    if (g.like !== undefined) where.push(`TABLE_NAME ILIKE ${sqlLiteral(g.like)}`)
    return [
      'SELECT CREATED AS created_on, TABLE_NAME AS name, TABLE_CATALOG AS database_name, ' +
        "TABLE_SCHEMA AS schema_name, 'TABLE' AS kind, COALESCE(COMMENT, '') AS comment, " +
        "'' AS cluster_by, ROW_COUNT AS rows, TABLE_OWNER AS owner " +
        `FROM memory.sf_information_schema."TABLES" WHERE ${where.join(' AND ')} ORDER BY name`,
      true,
    ]
  }
  const describe = DESCRIBE.exec(sql)
  if (describe?.groups) {
    const [db, sch, table] = splitName(describe.groups.name as string, database, schema)
    return [
      'SELECT COLUMN_NAME AS name, ' +
        "CASE DATA_TYPE WHEN 'NUMBER' THEN 'NUMBER(' || NUMERIC_PRECISION || ',' " +
        "|| NUMERIC_SCALE || ')' WHEN 'TEXT' THEN 'VARCHAR(16777216)' ELSE DATA_TYPE END " +
        "AS type, 'COLUMN' AS kind, CASE IS_NULLABLE WHEN 'YES' THEN 'Y' ELSE 'N' END " +
        `AS "null?", NULL AS "default", 'N' AS "primary key", 'N' AS "unique key", ` +
        'COMMENT AS comment ' +
        `FROM memory.sf_information_schema."COLUMNS" WHERE TABLE_CATALOG = ${sqlLiteral(db)} ` +
        `AND TABLE_SCHEMA = ${sqlLiteral(sch)} AND TABLE_NAME = ${sqlLiteral(table)} ` +
        'ORDER BY ORDINAL_POSITION',
      true,
    ]
  }
  if (keyword === 'SELECT' || keyword === 'WITH') {
    return [sql.replace(INFORMATION_SCHEMA, 'memory.sf_information_schema.'), false]
  }
  if (WRITE_KEYWORDS.has(keyword)) {
    throw new SqlApiError(
      '003001',
      '42501',
      `SQL access control error:\nInsufficient privileges to operate on schema '${schema}'`,
    )
  }
  throw new SqlApiError(
    '001003',
    '42000',
    `SQL compilation error:\nsyntax error line 1 at position 0 unexpected '${keyword || sql}'.`,
  )
}

export function rowTypeOf(name: string, duckType: string): RowType {
  const entry: RowType = {
    name,
    database: '',
    schema: '',
    table: '',
    nullable: true,
    type: 'text',
    byteLength: null,
    length: null,
    scale: null,
    precision: null,
    collation: null,
  }
  const decimal = DECIMAL.exec(duckType)
  if (INT_TYPES.has(duckType)) Object.assign(entry, { type: 'fixed', precision: 38, scale: 0 })
  else if (decimal) {
    Object.assign(entry, {
      type: 'fixed',
      precision: Number(decimal[1]),
      scale: Number(decimal[2]),
    })
  } else if (['DOUBLE', 'FLOAT', 'REAL'].includes(duckType)) entry.type = 'real'
  else if (duckType === 'DATE') entry.type = 'date'
  else if (duckType.startsWith('TIMESTAMP')) {
    Object.assign(entry, { type: 'timestamp_ntz', precision: 0, scale: 9 })
  } else if (duckType === 'BOOLEAN') entry.type = 'boolean'
  else Object.assign(entry, { byteLength: 16777216, length: 16777216 })
  return entry
}

/** `value` as @duckdb/node-api's JSON conversion gives it, on Snowflake's wire. */
export function wireValue(value: Json, kind: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return JSON.stringify(value)
  const text = String(value)
  switch (kind) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'date': {
      const [y, m, d] = text.split('-').map(Number) as [number, number, number]
      return String(Math.round(Date.UTC(y, m - 1, d) / DAY_MS))
    }
    case 'timestamp_ntz': {
      const [date, time = '00:00:00'] = text.split(' ')
      const [hms, fraction = ''] = time.split('.')
      const seconds = Math.floor(Date.parse(`${date}T${hms}Z`) / 1000)
      return `${seconds}.${fraction.padEnd(9, '0').slice(0, 9)}`
    }
    default:
      return text
  }
}

function errorFromDuckDb(error: Error): SqlApiError {
  const first = (error.message.split('\n\nLINE')[0] ?? error.message).trim()
  const kind = /^(\w+) Error: /.exec(first)?.[1]
  const text = first.replace(/^\w+ Error: /, '')
  if (kind === 'Catalog') {
    return new SqlApiError(
      '002003',
      '42S02',
      `SQL compilation error:\n${text} (or not authorized).`,
    )
  }
  if (kind === 'Parser') {
    return new SqlApiError('001003', '42000', `SQL compilation error:\nsyntax error: ${text}`)
  }
  if (kind === 'Binder') {
    return new SqlApiError('000904', '42000', `SQL compilation error:\ninvalid identifier: ${text}`)
  }
  return new SqlApiError('100038', '22018', `Execution error: ${text}`)
}

export async function execute(
  store: Store,
  statement: string,
  { database, schema, partitionRows }: { database: string; schema: string; partitionRows: number },
): Promise<Statement> {
  const [sql, keepCase] = translate(statement, database, schema)
  let con: Awaited<ReturnType<Store['connect']>>
  try {
    con = await store.connect(database, schema)
  } catch (error) {
    throw new SqlApiError('002043', '02000', (error as Error).message)
  }
  let names: string[]
  let types: string[]
  let rows: Json[][]
  try {
    const result = await con.runAndReadAll(sql)
    names = result.columnNames()
    types = result.columnTypes().map(String)
    rows = result.getRowsJson()
  } catch (error) {
    throw errorFromDuckDb(error as Error)
  } finally {
    con.closeSync()
  }

  const rowType = names.map((name, i) => {
    let shown = name
    if (!keepCase && !statement.includes(`"${name}"`)) {
      shown = name === 'count_star()' ? 'COUNT(*)' : name.toUpperCase()
    }
    return rowTypeOf(shown, types[i] as string)
  })
  const kinds = rowType.map((rt) => rt.type)
  const data = rows.map((row) => row.map((v, i) => wireValue(v, kinds[i] as string)))
  const partitions: (string | null)[][][] = []
  for (let i = 0; i < data.length; i += partitionRows)
    partitions.push(data.slice(i, i + partitionRows))
  if (partitions.length === 0) partitions.push([])
  return { handle: randomUUID(), rowType, partitions, numRows: data.length, createdOn: Date.now() }
}

export function resultBody(statement: Statement, requestId: string): Record<string, unknown> {
  return {
    resultSetMetaData: {
      numRows: statement.numRows,
      format: 'jsonv2',
      partitionInfo: statement.partitions.map((p) => ({
        rowCount: p.length,
        uncompressedSize: JSON.stringify(p).length,
      })),
      rowType: statement.rowType,
    },
    data: statement.partitions[0],
    code: '090001',
    statementStatusUrl: `/api/v2/statements/${statement.handle}?requestId=${requestId}`,
    requestId,
    sqlState: '00000',
    statementHandle: statement.handle,
    message: 'Statement executed successfully.',
    createdOn: statement.createdOn,
  }
}
