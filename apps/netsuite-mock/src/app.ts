/**
 * The sample NetSuite account (Acme Outdoor), as far as an integration can see it.
 *
 * Endpoints (paths as in NetSuite's REST web services):
 *
 *     POST /services/rest/query/v1/suiteql?limit=&offset=       body {"q": "SELECT ..."}
 *     GET  /services/rest/record/v1/metadata-catalog
 *     GET  /services/rest/record/v1/metadata-catalog/{record}    JSON Schema of a record type
 *
 * Authentication is accepted but not checked. Simplification versus a real account: record
 * types and fields use their SuiteQL names (`item`, `itemid`) in the metadata catalog too,
 * where NetSuite would use REST names (`inventoryItem`, `itemId`).
 */

import { Hono } from 'hono'
import type { ColumnSpec } from 'sample-data'
import { defaultSettings, type Settings } from './settings'
import { openStore, type RecordType } from './store'
import { items, MAX_LIMIT, run, SuiteQLError } from './suiteql'

const RECORD = '/services/rest/record/v1'
const QUERY = '/services/rest/query/v1'

function nsError(status: 400 | 404, detail: string, code = 'INVALID_PARAMETER') {
  const titles = { 400: 'Bad Request', 404: 'Not Found' }
  return Response.json(
    {
      type: `https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.${status - 399}`,
      title: titles[status],
      status,
      'o:errorDetails': [{ detail, 'o:errorCode': code }],
    },
    { status },
  )
}

export function fieldSchema(column: ColumnSpec): Record<string, unknown> {
  const kinds: Record<ColumnSpec['kind'], Record<string, unknown>> = {
    integer: { type: 'integer', format: 'int64' },
    number: { type: 'number', format: 'double' },
    string: { type: 'string' },
    boolean: { type: 'boolean' },
    date: { type: 'string', format: 'date' },
    select: {
      type: 'object',
      $ref: `${RECORD}/metadata-catalog/${column.references}`,
      'x-ns-referenced-record': column.references,
    },
  }
  const schema: Record<string, unknown> = {
    title: column.label ?? column.name,
    ...kinds[column.kind],
  }
  schema.nullable = column.nullable
  if (column.description) schema.description = column.description
  if (column.custom) schema['x-ns-custom-field'] = true
  return schema
}

export function recordSchema(record: RecordType): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: 'object',
    title: record.label ?? record.name,
    properties: Object.fromEntries(record.columns.map((c) => [c.name, fieldSchema(c)])),
    required: record.columns.filter((c) => !c.nullable).map((c) => c.name),
  }
  if (record.description) schema.description = record.description
  return schema
}

function pageLinks(url: string, limit: number, offset: number, total: number) {
  const href = (at: number) => {
    const u = new URL(url)
    u.searchParams.set('limit', String(limit))
    u.searchParams.set('offset', String(at))
    return u.toString()
  }
  const links: { rel: string; href: string }[] = []
  if (offset > 0) links.push({ rel: 'previous', href: href(Math.max(0, offset - limit)) })
  if (offset + limit < total) links.push({ rel: 'next', href: href(offset + limit) })
  links.push({ rel: 'first', href: href(0) })
  links.push({ rel: 'last', href: href(Math.max(0, Math.floor((total - 1) / limit) * limit)) })
  links.push({ rel: 'self', href: url })
  return links
}

function intParam(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback
  return /^\d+$/.test(raw) ? Number(raw) : null
}

export async function createApp(overrides: Partial<Settings> = {}): Promise<Hono> {
  const settings: Settings = { ...defaultSettings, ...overrides }
  const store = await openStore(settings)
  const app = new Hono()

  app.get('/', (c) =>
    c.json({
      service: 'netsuite-mock',
      account: 'ACME',
      records: [...store.records.keys()],
      dateFormat: settings.dateFormat,
      dataset: { scale: settings.scale, seed: settings.seed },
    }),
  )

  app.post(`${QUERY}/suiteql`, async (c) => {
    if (!(c.req.header('content-type') ?? '').includes('application/json')) {
      return nsError(400, "Invalid content type. The request body must be 'application/json'.")
    }
    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return nsError(400, 'The request body is not valid JSON.')
    }
    const q = (payload as { q?: unknown } | null)?.q
    if (typeof q !== 'string' || !q.trim()) {
      return nsError(400, "The request body must contain a non-empty 'q' property.")
    }
    const limit = intParam(c.req.query('limit'), MAX_LIMIT)
    const offset = intParam(c.req.query('offset'), 0)
    if (limit === null || limit < 1 || limit > MAX_LIMIT) {
      return nsError(400, `The value of 'limit' must be between 1 and ${MAX_LIMIT}.`)
    }
    if (offset === null)
      return nsError(400, "The value of 'offset' must be a non-negative integer.")
    try {
      const page = await run(store, q, { limit, offset })
      return c.json({
        links: pageLinks(c.req.url, limit, offset, page.total),
        count: page.rows.length,
        hasMore: offset + page.rows.length < page.total,
        items: items(page, settings.dateFormat),
        offset,
        totalResults: page.total,
      })
    } catch (error) {
      if (!(error instanceof SuiteQLError)) throw error
      return nsError(
        400,
        `Invalid search query. Detailed unprocessed description follows. Search error occurred: ${error.message}`,
      )
    }
  })

  app.get(`${RECORD}/metadata-catalog`, (c) => {
    const base = c.req.url.replace(/\/$/, '')
    return c.json({
      items: [...store.records.keys()].map((name) => ({
        name,
        links: [
          { rel: 'canonical', href: `${base}/${name}`, mediaType: 'application/json' },
          { rel: 'alternate', href: `${base}/${name}`, mediaType: 'application/schema+json' },
        ],
      })),
    })
  })

  app.get(`${RECORD}/metadata-catalog/:record`, (c) => {
    const record = store.records.get(c.req.param('record'))
    if (!record) {
      return nsError(404, `Record type '${c.req.param('record')}' was not found.`, 'NONEXISTENT_ID')
    }
    return c.body(JSON.stringify(recordSchema(record)), 200, {
      'Content-Type': 'application/schema+json',
    })
  })

  return app
}
