/**
 * Container types for the generated dataset.
 *
 * Each table is a list of `ColumnSpec` plus a list of plain arrays in the same order. That
 * keeps large tables cheap and lets the demo backends bulk-load a table without knowing
 * anything about its contents.
 *
 * Cell values: strings, numbers (money with 2 decimals), ISO 'YYYY-MM-DD' strings for
 * dates, and `null`.
 */

import { writeFileSync } from 'node:fs'

export type Cell = string | number | null
export type Row = Cell[]

/**
 * How the source system declares a field. 'boolean' is NetSuite's 'T'/'F' checkbox;
 * 'select' is a reference to a list or record, stored as its internal id.
 */
export type ColumnKind = 'integer' | 'number' | 'string' | 'boolean' | 'date' | 'select'

/** How `writeCsv` marks NULL, so that NULL and '' stay distinct. */
export const NULL_TOKEN = '\\N'

export interface ColumnSpec {
  name: string
  /** Storage type in DuckDB DDL: BIGINT, VARCHAR, DECIMAL(12,2), DOUBLE, DATE. */
  sqlType: string
  kind: ColumnKind
  label: string | null
  description: string | null
  nullable: boolean
  custom: boolean
  /** For 'select' columns: the table the internal id points at. */
  references: string | null
}

export function column(
  name: string,
  sqlType: string,
  kind: ColumnKind,
  label: string | null = null,
  options: Partial<Pick<ColumnSpec, 'description' | 'nullable' | 'custom' | 'references'>> = {},
): ColumnSpec {
  return {
    name,
    sqlType,
    kind,
    label,
    description: options.description ?? null,
    nullable: options.nullable ?? true,
    custom: options.custom ?? false,
    references: options.references ?? null,
  }
}

export class TableData {
  constructor(
    readonly name: string,
    readonly columns: ColumnSpec[],
    readonly rows: Row[],
    readonly label: string | null = null,
    readonly description: string | null = null,
  ) {}

  get columnNames(): string[] {
    return this.columns.map((c) => c.name)
  }

  index(name: string): number {
    const i = this.columns.findIndex((c) => c.name === name)
    if (i < 0) throw new Error(`${this.name} has no column ${name}`)
    return i
  }

  column(name: string): ColumnSpec {
    return this.columns[this.index(name)] as ColumnSpec
  }

  toObjects(): Record<string, Cell>[] {
    const names = this.columnNames
    return this.rows.map((row) => {
      const out: Record<string, Cell> = {}
      for (let i = 0; i < names.length; i++) out[names[i] as string] = row[i] ?? null
      return out
    })
  }

  /** Headerless CSV, strings quoted, NULL as an (unambiguous) quoted \N. */
  writeCsv(path: string): void {
    const lines: string[] = []
    for (const row of this.rows) {
      lines.push(row.map(csvCell).join(','))
    }
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  }
}

function csvCell(value: Cell): string {
  if (value === null) return `"${NULL_TOKEN}"`
  if (typeof value === 'number') return String(value)
  return `"${value.replaceAll('"', '""')}"`
}

export interface Dataset {
  seed: number
  scale: number
  /** Reference 'today' the generator used; dates are placed around it. */
  asOf: string
  /** SuiteQL table name -> table. */
  netsuite: Record<string, TableData>
  /** Fully qualified DATABASE.SCHEMA.TABLE -> table. */
  snowflake: Record<string, TableData>
}
