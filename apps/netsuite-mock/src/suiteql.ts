/**
 * SuiteQL over DuckDB, with NetSuite's wire habits.
 *
 * What a SuiteQL client sees, as with a real account:
 * - every value is a JSON string; dates are rendered in the account's date format;
 * - NULL fields are left out of the item entirely;
 * - `BUILTIN.DF(field)` returns the display value of a list/record reference;
 * - results are paged with `limit` (max 1000) and `offset` query parameters.
 */

import type { Json } from '@duckdb/node-api'
import type { Store } from './store'

export const MAX_LIMIT = 1000

const DF = /BUILTIN\s*\.\s*DF\s*\(\s*((?:[A-Za-z_]\w*\s*\.\s*)?([A-Za-z_]\w*))\s*\)/gi
const LEADING_COMMENTS = /^\s*(?:--[^\n]*(?:\n|$)\s*|\/\*[\s\S]*?\*\/\s*)*/
const HAS_PAGING = /\b(LIMIT|OFFSET|FETCH\s+FIRST|FETCH\s+NEXT)\b/i

/** Rendered as NetSuite's 400 'Invalid search query' error. */
export class SuiteQLError extends Error {}

export function translate(sql: string, references: ReadonlyMap<string, string>): string {
  const rewritten = sql.replace(DF, (_, expr: string, field: string) => {
    const target = references.get(field.toLowerCase())
    // DF on a plain field is the field itself, as in NetSuite.
    return target ? `ns_df('${target}', ${expr})` : expr
  })
  return rewritten.trim().replace(/;+$/, '').trim()
}

export interface Page {
  names: string[]
  types: string[]
  rows: Json[][]
  total: number
}

export async function run(
  store: Store,
  sql: string,
  { limit, offset }: { limit: number; offset: number },
): Promise<Page> {
  const body = sql.replace(LEADING_COMMENTS, '')
  const keyword = body.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? ''
  if (keyword !== 'SELECT' && keyword !== 'WITH') {
    throw new SuiteQLError('Only SELECT statements are supported.')
  }
  const query = translate(body, store.references)
  const con = await store.connect()
  try {
    const count = await con.runAndReadAll(`SELECT COUNT(*) FROM (${query}) AS q`)
    const total = Number(count.getRowsJson()[0]?.[0])
    // Appending keeps the statement's own ORDER BY authoritative.
    const page = HAS_PAGING.test(query)
      ? `SELECT * FROM (${query}) AS q LIMIT ${limit} OFFSET ${offset}`
      : `${query}\nLIMIT ${limit} OFFSET ${offset}`
    const result = await con.runAndReadAll(page)
    return {
      names: result.columnNames().map((n) => n.toLowerCase()),
      types: result.columnTypes().map(String),
      rows: result.getRowsJson(),
      total,
    }
  } catch (error) {
    if (error instanceof SuiteQLError) throw error
    throw new SuiteQLError(clean((error as Error).message))
  } finally {
    con.closeSync()
  }
}

/** Keep DuckDB's useful first lines; drop its error-class prefix and LINE/caret context. */
function clean(message: string): string {
  return (message.split('\n\nLINE')[0] ?? message).trim().replace(/^\w+ Error: /, '')
}

/** A small strftime: %d %m %Y %y %H %M %S %%. */
export function strftime(iso: string, format: string): string {
  const [date = '', time = ''] = iso.split(/[ T]/)
  const [Y = '', m = '', d = ''] = date.split('-')
  const [H = '00', M = '00', S = '00'] = time.split(':')
  const parts: Record<string, string> = {
    d,
    m,
    Y,
    y: Y.slice(-2),
    H,
    M,
    S: S.slice(0, 2),
    '%': '%',
  }
  return format.replace(/%([dmYyHMS%])/g, (_, k: string) => parts[k] ?? '')
}

export function wireValue(value: Json, type: string, dateFormat: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return JSON.stringify(value)
  if (type === 'BOOLEAN') return value ? 'T' : 'F'
  const text = String(value)
  if (type === 'DATE') return strftime(text, dateFormat)
  if (type.startsWith('TIMESTAMP')) return strftime(text, `${dateFormat} %H:%M`)
  if (type.startsWith('DECIMAL') && text.includes('.')) {
    return text.replace(/0+$/, '').replace(/\.$/, '') // NetSuite shows 14.99, 12.5 and 3, not 3.00
  }
  return text
}

export function items(page: Page, dateFormat: string): Record<string, unknown>[] {
  return page.rows.map((row) => {
    const item: Record<string, unknown> = { links: [] }
    page.names.forEach((name, i) => {
      const wired = wireValue(row[i] ?? null, page.types[i] as string, dateFormat)
      if (wired !== null) item[name] = wired // NetSuite omits NULL fields
    })
    return item
  })
}
