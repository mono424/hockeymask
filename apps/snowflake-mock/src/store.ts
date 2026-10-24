/** The sample inventory mart (ANALYTICS.INVENTORY.*) in a cached DuckDB file. */

import { join } from 'node:path'
import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'
import {
  buildAtomically,
  createTableSql,
  datasetKey,
  generate,
  insertFromCsvSql,
  literal,
  quote,
  SNOWFLAKE_DATABASE,
  withCsvFiles,
} from 'sample-data'
import type { Settings } from './settings'

export const DATABASE = SNOWFLAKE_DATABASE
export const IDENTIFIER = /^(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")$/

const INT_TYPES = "('BIGINT', 'INTEGER', 'SMALLINT', 'TINYINT', 'HUGEINT', 'UBIGINT', 'UINTEGER')"

/** Snowflake-shaped INFORMATION_SCHEMA views; queries are rewritten to read these. */
const INFORMATION_SCHEMA = `
CREATE SCHEMA memory.sf_information_schema;
CREATE TABLE memory.sf_information_schema.table_stats (
  table_schema VARCHAR, table_name VARCHAR, row_count BIGINT
);
CREATE VIEW memory.sf_information_schema."TABLES" AS
SELECT t.database_name AS TABLE_CATALOG, t.schema_name AS TABLE_SCHEMA,
       t.table_name AS TABLE_NAME, 'BASE TABLE' AS TABLE_TYPE, s.row_count AS ROW_COUNT,
       t.comment AS COMMENT, TIMESTAMP '2024-03-01 08:00:00' AS CREATED,
       'INVENTORY_ANALYST' AS TABLE_OWNER
FROM duckdb_tables() t
LEFT JOIN memory.sf_information_schema.table_stats s
  ON s.table_schema = t.schema_name AND s.table_name = t.table_name
WHERE t.database_name = '${DATABASE}' AND t.schema_name <> 'main';
CREATE VIEW memory.sf_information_schema."COLUMNS" AS
SELECT c.database_name AS TABLE_CATALOG, c.schema_name AS TABLE_SCHEMA,
       c.table_name AS TABLE_NAME, c.column_name AS COLUMN_NAME,
       c.column_index AS ORDINAL_POSITION,
       CASE WHEN c.is_nullable THEN 'YES' ELSE 'NO' END AS IS_NULLABLE,
       CASE WHEN c.data_type IN ${INT_TYPES} OR c.data_type LIKE 'DECIMAL%' THEN 'NUMBER'
            WHEN c.data_type = 'VARCHAR' THEN 'TEXT'
            WHEN c.data_type IN ('DOUBLE', 'FLOAT', 'REAL') THEN 'FLOAT'
            WHEN c.data_type LIKE 'TIMESTAMP%' THEN 'TIMESTAMP_NTZ'
            ELSE c.data_type END AS DATA_TYPE,
       CASE WHEN c.data_type = 'VARCHAR' THEN 16777216 END AS CHARACTER_MAXIMUM_LENGTH,
       CASE WHEN c.data_type IN ${INT_TYPES} THEN 38
            WHEN c.data_type LIKE 'DECIMAL%' THEN c.numeric_precision END AS NUMERIC_PRECISION,
       CASE WHEN c.data_type IN ${INT_TYPES} THEN 0
            WHEN c.data_type LIKE 'DECIMAL%' THEN c.numeric_scale END AS NUMERIC_SCALE,
       c.comment AS COMMENT
FROM duckdb_columns() c
WHERE c.database_name = '${DATABASE}' AND c.schema_name <> 'main';
`

const MACROS = `
CREATE MACRO memory.main.nvl(a, b) AS coalesce(a, b);
CREATE MACRO memory.main.iff(c, a, b) AS CASE WHEN c THEN a ELSE b END;
`

export interface Store {
  instance: DuckDBInstance
  /** A fresh connection whose unqualified names resolve in `database.schema`. */
  connect(database: string, schema: string): Promise<DuckDBConnection>
}

async function build(path: string, settings: Settings): Promise<void> {
  const ds = generate({ scale: settings.scale, seed: settings.seed })
  const tables = Object.values(ds.snowflake)
  const instance = await DuckDBInstance.create(':memory:')
  const con = await instance.connect()
  try {
    await con.run(`ATTACH ${literal(path)} AS ${quote(DATABASE)}`)
    const schemas = new Set(tables.map((t) => t.name.split('.').slice(0, 2).join('.')))
    for (const fq of [...schemas].sort()) {
      await con.run(`CREATE SCHEMA ${fq.split('.').map(quote).join('.')}`)
    }
    await withCsvFiles(tables, async (paths) => {
      for (const [i, table] of tables.entries()) {
        const target = table.name.split('.').map(quote).join('.')
        await con.run(createTableSql(table, target))
        await con.run(insertFromCsvSql(table, target, paths[i] as string))
        if (table.description) {
          await con.run(`COMMENT ON TABLE ${target} IS ${literal(table.description)}`)
        }
        for (const column of table.columns) {
          if (!column.description) continue
          await con.run(
            `COMMENT ON COLUMN ${target}.${quote(column.name)} IS ${literal(column.description)}`,
          )
        }
      }
    })
    await con.run(`DETACH ${quote(DATABASE)}`)
  } finally {
    con.closeSync()
    instance.closeSync()
  }
}

export async function openStore(settings: Settings): Promise<Store> {
  const path = join(
    settings.dataDir,
    `snowflake-${datasetKey(settings.seed, settings.scale)}.duckdb`,
  )
  await buildAtomically(path, (tmp) => build(tmp, settings))

  const instance = await DuckDBInstance.create(':memory:')
  const con = await instance.connect()
  await con.run(`ATTACH ${literal(path)} AS ${quote(DATABASE)} (READ_ONLY)`)
  await con.run(MACROS)
  await con.run(INFORMATION_SCHEMA)
  const tables = await con.runAndReadAll(
    `SELECT schema_name, table_name FROM duckdb_tables()
     WHERE database_name = ${literal(DATABASE)} AND schema_name <> 'main'`,
  )
  for (const [schema, table] of tables.getRowsJson() as [string, string][]) {
    const count = await con.runAndReadAll(
      `SELECT COUNT(*) FROM ${quote(DATABASE)}.${quote(schema)}.${quote(table)}`,
    )
    const rows = Number(count.getRowsJson()[0]?.[0])
    await con.run(
      `INSERT INTO memory.sf_information_schema.table_stats VALUES (${literal(schema)}, ${literal(table)}, ${rows})`,
    )
  }
  con.closeSync()

  return {
    instance,
    async connect(database, schema) {
      for (const part of [database, schema]) {
        if (!IDENTIFIER.test(part)) throw new Error(`invalid identifier ${JSON.stringify(part)}`)
      }
      const connection = await instance.connect()
      await connection.run(`SET search_path = '${database}.${schema},memory.main'`)
      return connection
    },
  }
}
