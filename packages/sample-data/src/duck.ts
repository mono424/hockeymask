/**
 * Helpers both demo backends use to bulk-load generated tables into DuckDB.
 *
 * Only SQL text and files: the demo backends own the DuckDB connection, so this package
 * keeps zero runtime dependencies.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NULL_TOKEN, type TableData } from './model'

export const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`
export const literal = (text: string) => `'${text.replaceAll("'", "''")}'`

/** CREATE TABLE for `table` under `target` (already quoted / qualified). */
export function createTableSql(table: TableData, target: string): string {
  const columns = table.columns
    .map((c) => `${quote(c.name)} ${c.sqlType}${c.nullable ? '' : ' NOT NULL'}`)
    .join(', ')
  return `CREATE TABLE ${target} (${columns})`
}

/** INSERT ... SELECT FROM read_csv(...) for a CSV written by `TableData.writeCsv`. */
export function insertFromCsvSql(table: TableData, target: string, csvPath: string): string {
  const columns = table.columns.map((c) => `${literal(c.name)}: ${literal(c.sqlType)}`).join(', ')
  return (
    `INSERT INTO ${target} SELECT * FROM read_csv(${literal(csvPath)}, header = false, ` +
    `columns = {${columns}}, nullstr = ${literal(NULL_TOKEN)}, quote = '"', escape = '"')`
  )
}

/** Write each table to a temporary CSV, hand the paths to `load`, clean up after. */
export async function withCsvFiles<T>(
  tables: TableData[],
  load: (csvPaths: string[]) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sample-data-'))
  try {
    const paths = tables.map((table, i) => {
      const path = join(dir, `${i}.csv`)
      table.writeCsv(path)
      return path
    })
    return await load(paths)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Run `build(tmpPath)` and move the finished database into place, so two processes
 * starting at once never see a half-built file.
 */
export async function buildAtomically(
  path: string,
  build: (tmpPath: string) => Promise<void>,
): Promise<void> {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.building-${process.pid}`
  rmSync(tmp, { force: true })
  rmSync(`${tmp}.wal`, { force: true })
  await build(tmp)
  renameSync(tmp, path)
}
