/**
 * The demo account's data: the sample NetSuite tables in a cached DuckDB file.
 *
 * The file is built once per (generator version, seed, scale) and then attached
 * read-only. SuiteQL runs against it through `suiteql.ts`.
 */

import { join } from 'node:path'
import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import {
  buildAtomically,
  type ColumnKind,
  type ColumnSpec,
  createTableSql,
  datasetKey,
  generate,
  insertFromCsvSql,
  literal,
  quote,
  withCsvFiles,
} from 'sample-data'
import type { Settings } from './settings'

export const CATALOG = 'ns'
const TABLES = '__ns_tables'
const COLUMNS = '__ns_columns'
const DISPLAY = '__ns_display'

/** What BUILTIN.DF(<reference>) shows for a record of each type. */
const DISPLAY_COLUMN: Record<string, string> = {
  classification: 'fullname',
  currency: 'name',
  item: 'itemid',
  location: 'name',
  vendor: 'companyname',
}

export interface RecordType {
  name: string
  label: string | null
  description: string | null
  columns: ColumnSpec[]
}

export interface Store {
  instance: DuckDBInstance
  records: Map<string, RecordType>
  /** Field name -> record type it references (drives BUILTIN.DF). */
  references: Map<string, string>
  /** A fresh connection with the account's tables and SuiteQL helpers on the search path. */
  connect(): Promise<DuckDBConnection>
}

const sqlValue = (v: string | number | boolean | null) =>
  v === null ? 'NULL' : typeof v === 'string' ? literal(v) : String(v)

async function build(path: string, settings: Settings): Promise<void> {
  const ds = generate({ scale: settings.scale, seed: settings.seed })
  const tables = Object.values(ds.netsuite)
  const instance = await DuckDBInstance.create(path)
  const con = await instance.connect()
  try {
    await con.run(
      `CREATE TABLE ${TABLES} (ord INT, name VARCHAR, label VARCHAR, description VARCHAR);
       CREATE TABLE ${COLUMNS} (tbl VARCHAR, ord INT, name VARCHAR, sql_type VARCHAR, kind VARCHAR,
         label VARCHAR, description VARCHAR, nullable BOOLEAN, custom BOOLEAN, refs VARCHAR);
       CREATE TABLE ${DISPLAY} (tbl VARCHAR, id VARCHAR, display VARCHAR)`,
    )
    await withCsvFiles(tables, async (paths) => {
      for (const [i, table] of tables.entries()) {
        const target = quote(table.name)
        await con.run(createTableSql(table, target))
        await con.run(insertFromCsvSql(table, target, paths[i] as string))
        await con.run(
          `INSERT INTO ${TABLES} VALUES (${i}, ${literal(table.name)}, ${sqlValue(table.label)}, ${sqlValue(table.description)})`,
        )
        const columns = table.columns.map(
          (c, ord) =>
            `(${[table.name, ord, c.name, c.sqlType, c.kind, c.label, c.description, c.nullable, c.custom, c.references].map(sqlValue).join(', ')})`,
        )
        await con.run(`INSERT INTO ${COLUMNS} VALUES ${columns.join(', ')}`)
      }
    })
    for (const [name, column] of Object.entries(DISPLAY_COLUMN)) {
      await con.run(
        `INSERT INTO ${DISPLAY} SELECT ${literal(name)}, CAST(id AS VARCHAR), CAST(${quote(column)} AS VARCHAR) FROM ${quote(name)}`,
      )
    }
  } finally {
    con.closeSync()
    instance.closeSync()
  }
}

async function loadRecords(con: DuckDBConnection): Promise<Map<string, RecordType>> {
  const columns = new Map<string, ColumnSpec[]>()
  const columnRows = await con.runAndReadAll(
    `SELECT tbl, name, sql_type, kind, label, description, nullable, custom, refs
     FROM ${CATALOG}.main.${COLUMNS} ORDER BY tbl, ord`,
  )
  for (const r of columnRows.getRowObjectsJson()) {
    const list = columns.get(r.tbl as string) ?? []
    list.push({
      name: r.name as string,
      sqlType: r.sql_type as string,
      kind: r.kind as ColumnKind,
      label: r.label as string | null,
      description: r.description as string | null,
      nullable: r.nullable as boolean,
      custom: r.custom as boolean,
      references: r.refs as string | null,
    })
    columns.set(r.tbl as string, list)
  }
  const tableRows = await con.runAndReadAll(
    `SELECT name, label, description FROM ${CATALOG}.main.${TABLES} ORDER BY ord`,
  )
  const records = new Map<string, RecordType>()
  for (const r of tableRows.getRowObjectsJson()) {
    const name = r.name as string
    records.set(name, {
      name,
      label: r.label as string | null,
      description: r.description as string | null,
      columns: columns.get(name) ?? [],
    })
  }
  return records
}

export async function openStore(settings: Settings): Promise<Store> {
  const path = join(
    settings.dataDir,
    `netsuite-${datasetKey(settings.seed, settings.scale)}.duckdb`,
  )
  await buildAtomically(path, (tmp) => build(tmp, settings))

  const instance = await DuckDBInstance.create(':memory:')
  const con = await instance.connect()
  await con.run(`ATTACH ${literal(path)} AS ${CATALOG} (READ_ONLY)`)
  // SuiteQL has NVL and BUILTIN.DF; give DuckDB both (DF as a lookup in the display table).
  await con.run(`CREATE MACRO memory.main.nvl(a, b) AS coalesce(a, b);
    CREATE MACRO memory.main.ns_df(t, v) AS
      (SELECT display FROM ${CATALOG}.main.${DISPLAY} WHERE tbl = t AND id = CAST(v AS VARCHAR))`)
  const records = await loadRecords(con)
  con.closeSync()

  const references = new Map<string, string>()
  for (const record of records.values()) {
    for (const c of record.columns)
      if (c.references) references.set(c.name.toLowerCase(), c.references)
  }
  return {
    instance,
    records,
    references,
    async connect() {
      const connection = await instance.connect()
      await connection.run(`SET search_path = '${CATALOG}.main,memory.main'`)
      return connection
    },
  }
}
