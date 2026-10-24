/**
 * The sample Snowflake inventory mart (Acme Outdoor), behind the SQL API v2.
 *
 *     POST /api/v2/statements                 body {"statement": "...", "database", "schema",
 *                                                   "warehouse", "role"}
 *     GET  /api/v2/statements/{handle}?partition=N
 *
 * Authentication headers are accepted but not checked. Without `database` / `schema` in the
 * body the session defaults to ANALYTICS.INVENTORY.
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { defaultSettings, type Settings } from './settings'
import { execute, resultBody, SqlApiError, StatementCache } from './sqlapi'
import { openStore } from './store'

function sfError(error: SqlApiError, handle: string = randomUUID()) {
  return Response.json(
    {
      code: error.code,
      message: error.message,
      sqlState: error.sqlState,
      statementHandle: handle,
      statementStatusUrl: `/api/v2/statements/${handle}`,
    },
    { status: error.status },
  )
}

const nonEmpty = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

export async function createApp(overrides: Partial<Settings> = {}): Promise<Hono> {
  const settings: Settings = { ...defaultSettings, ...overrides }
  const store = await openStore(settings)
  const cache = new StatementCache()
  const app = new Hono()

  app.get('/', (c) =>
    c.json({
      service: 'snowflake-mock',
      account: 'ACME-ANALYTICS',
      defaultNamespace: `${settings.defaultDatabase}.${settings.defaultSchema}`,
      partitionRows: settings.partitionRows,
      dataset: { scale: settings.scale, seed: settings.seed },
    }),
  )

  app.post('/api/v2/statements', async (c) => {
    let payload: Record<string, unknown> | null = null
    if ((c.req.header('content-type') ?? '').includes('application/json')) {
      try {
        payload = (await c.req.json()) as Record<string, unknown>
      } catch {
        payload = null
      }
    }
    if (payload === null) {
      return sfError(
        new SqlApiError(
          '391901',
          '42601',
          'Request body must be a JSON object (Content-Type: application/json).',
          400,
        ),
      )
    }
    const statement = payload.statement
    if (typeof statement !== 'string' || !statement.trim()) {
      return sfError(
        new SqlApiError('391903', '42601', "Request body is missing 'statement'.", 400),
      )
    }
    const requestId = c.req.query('requestId') ?? randomUUID()
    try {
      const result = await execute(store, statement, {
        database: nonEmpty(payload.database) ?? settings.defaultDatabase,
        schema: nonEmpty(payload.schema) ?? settings.defaultSchema,
        partitionRows: settings.partitionRows,
      })
      cache.put(result)
      return c.json(resultBody(result, requestId))
    } catch (error) {
      if (error instanceof SqlApiError) return sfError(error)
      throw error
    }
  })

  app.get('/api/v2/statements/:handle', (c) => {
    const handle = c.req.param('handle')
    const result = cache.get(handle)
    if (!result) {
      return sfError(
        new SqlApiError('000709', '02000', `Statement ${handle} not found`, 404),
        handle,
      )
    }
    const raw = c.req.query('partition')
    const partition = raw === undefined ? 0 : Number(raw)
    if (!Number.isInteger(partition) || partition < 0 || partition >= result.partitions.length) {
      return sfError(
        new SqlApiError('000709', '02000', `Partition ${raw} out of range`, 404),
        handle,
      )
    }
    if (partition === 0) return c.json(resultBody(result, randomUUID()))
    return c.json({ data: result.partitions[partition] })
  })

  return app
}
