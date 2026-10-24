/**
 * The hockeymask demo API: what the frontend talks to.
 *
 *   GET /api/health
 *   GET /api/sources                              connected sources + reachability
 *   GET /api/sources/:key/tables                  discovery
 *   GET /api/sources/:key/tables/:table           columns, types, labels
 *   GET /api/sources/:key/tables/:table/sample    sample rows
 *   GET /api/target/schema                        the target model, edits applied
 *   GET /api/target/entities, PUT|DELETE /api/target/entities/:name  each entity with whether
 *                                                    it is edited; PUT edits, DELETE resets
 *   GET /api/graphs, GET|PUT|PATCH|DELETE /api/graphs/:id  saved mapping versions, checked
 *                                                    on read; PATCH { name } renames
 *   POST /api/agent/chat, POST /api/agent/tools/:id  the agent chat on the local Claude, and
 *                                                    the page's answers to its tool calls
 */

import {
  checkVersion,
  type CompileIssue,
  ConnectorError,
  emptyVersion,
  MappingVersion,
  parseVersion,
  SourceUnavailable,
  TargetEntity,
  type TargetSchema,
} from '@hockeymask/core'
import { and, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { agentRoutes, type RunAgent } from './agent'
import { type Database, DEMO_COMPANY_ID } from './db/client'
import { mappingGraph, targetEntityEdit } from './db/schema'
import type { Source } from './sources'
import { entityIssues, targetSchema, withEdits } from './target'

/** A source or the database is down: the API itself is fine, a dependency is not. */
const FAILED_DEPENDENCY = 424

export interface AppDeps {
  db: Database
  sources: Record<string, Source>
  /** The local Claude; the Agent SDK's `query` unless a test swaps it. */
  agent?: RunAgent
}

export function createApp({ db, sources, agent }: AppDeps) {
  const base = targetSchema()
  const app = new Hono().basePath('/api')

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ detail: error.message }, error.status)
    if (error instanceof SourceUnavailable)
      return c.json({ detail: error.message }, FAILED_DEPENDENCY)
    if (error instanceof ConnectorError) return c.json({ detail: error.message }, 400)
    console.error(error)
    return c.json({ detail: 'Internal error' }, 500)
  })

  const source = (key: string): Source => {
    const found = sources[key]
    if (!found) throw new HTTPException(404, { message: `No source '${key}'.` })
    return found
  }

  app.get('/health', async (c) => {
    const entries = await Promise.all(
      Object.values(sources).map(async (s) => [s.key, (await s.ping()) ? 'ok' : 'unreachable']),
    )
    const database = await db
      .execute(sql`SELECT 1`)
      .then(() => 'ok')
      .catch(() => 'error')
    return c.json({ status: 'ok', database, sources: Object.fromEntries(entries) })
  })

  app.get('/sources', async (c) =>
    c.json(
      await Promise.all(
        Object.values(sources).map(async (s) => ({
          key: s.key,
          system: s.connector.system,
          dialect: s.connector.dialect,
          baseUrl: s.baseUrl,
          description: s.description,
          status: (await s.ping()) ? 'ok' : 'unreachable',
        })),
      ),
    ),
  )

  app.get('/sources/:key/tables', async (c) =>
    c.json(await source(c.req.param('key')).connector.listTables()),
  )

  app.get('/sources/:key/tables/:table', async (c) =>
    c.json(await source(c.req.param('key')).connector.describe(c.req.param('table'))),
  )

  app.get('/sources/:key/tables/:table/sample', async (c) => {
    const limit = Math.min(5000, Math.max(1, Number(c.req.query('limit') ?? 25)))
    return c.json(await source(c.req.param('key')).connector.sample(c.req.param('table'), limit))
  })

  /** Edited entities; one stored in a shape that no longer parses falls back to the derived one. */
  const edits = async (): Promise<TargetEntity[]> => {
    const rows = await db
      .select()
      .from(targetEntityEdit)
      .where(eq(targetEntityEdit.companyId, DEMO_COMPANY_ID))
    return rows.flatMap((row) => {
      const parsed = TargetEntity.safeParse(row.document)
      return parsed.success ? [parsed.data] : []
    })
  }
  const currentSchema = async () => withEdits(base, await edits())

  const baseEntity = (name: string): TargetEntity => {
    const entity = base.entities.find((e) => e.name === name)
    if (!entity) throw new HTTPException(404, { message: `No entity '${name}'.` })
    return entity
  }

  app.get('/target/schema', async (c) => c.json(await currentSchema()))

  app.get('/target/entities', async (c) => {
    const edited = await edits()
    const names = new Set(edited.map((e) => e.name))
    return c.json(
      withEdits(base, edited).entities.map((entity) => ({
        entity,
        edited: names.has(entity.name),
      })),
    )
  })

  app.put('/target/entities/:name', async (c) => {
    const name = c.req.param('name')
    baseEntity(name)
    const parsed = TargetEntity.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'entity'}: ${i.message}`)
      throw new HTTPException(400, { message: `Not a target entity: ${issues.join('; ')}` })
    }
    const entity = parsed.data
    if (entity.name !== name) {
      throw new HTTPException(400, { message: `An entity keeps its name ('${name}').` })
    }
    const issues = entityIssues(entity, await currentSchema())
    if (issues.length > 0) throw new HTTPException(400, { message: issues.join('; ') })
    const values = {
      companyId: DEMO_COMPANY_ID,
      name,
      document: entity,
      updatedAt: new Date(),
    }
    await db
      .insert(targetEntityEdit)
      .values(values)
      .onConflictDoUpdate({
        target: [targetEntityEdit.companyId, targetEntityEdit.name],
        set: values,
      })
    return c.json({ entity, edited: true })
  })

  /** Drops the edit: the entity is derived from its table again. */
  app.delete('/target/entities/:name', async (c) => {
    const entity = baseEntity(c.req.param('name'))
    await db
      .delete(targetEntityEdit)
      .where(
        and(
          eq(targetEntityEdit.companyId, DEMO_COMPANY_ID),
          eq(targetEntityEdit.name, entity.name),
        ),
      )
    return c.json({ entity, edited: false })
  })

  app.route('/agent', agentRoutes(agent))

  /** The stored version with the draft-save check against the target model. */
  const graphResponse = (row: typeof mappingGraph.$inferSelect, schema: TargetSchema) => {
    const parsed = MappingVersion.safeParse(row.document)
    // Documents saved before the mapping engine have another shape; start those over.
    const graph = parsed.success ? parsed.data : emptyVersion(row.id, row.name)
    const issues: readonly CompileIssue[] = parsed.success
      ? checkVersion(graph, { targets: schema }).issues
      : [{ code: 'invalid_params', message: 'The stored mapping has an outdated format.' }]
    return { id: row.id, graph, issues, updatedAt: row.updatedAt }
  }

  app.get('/graphs', async (c) =>
    c.json(
      await db
        .select({ id: mappingGraph.id, name: mappingGraph.name, updatedAt: mappingGraph.updatedAt })
        .from(mappingGraph)
        .where(eq(mappingGraph.companyId, DEMO_COMPANY_ID))
        .orderBy(desc(mappingGraph.updatedAt)),
    ),
  )

  app.get('/graphs/:id', async (c) => {
    const [row] = await db
      .select()
      .from(mappingGraph)
      .where(
        and(eq(mappingGraph.companyId, DEMO_COMPANY_ID), eq(mappingGraph.id, c.req.param('id'))),
      )
    if (!row) throw new HTTPException(404, { message: `No graph '${c.req.param('id')}'.` })
    return c.json(graphResponse(row, await currentSchema()))
  })

  app.put('/graphs/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    let graph: MappingVersion
    try {
      graph = parseVersion((body as { graph?: unknown } | null)?.graph)
    } catch (error) {
      throw new HTTPException(400, {
        message: `Not a mapping version: ${(error as Error).message}`,
      })
    }
    const values = {
      id: c.req.param('id'),
      companyId: DEMO_COMPANY_ID,
      name: graph.name ?? graph.id,
      document: graph,
      updatedAt: new Date(),
    }
    const [row] = await db
      .insert(mappingGraph)
      .values(values)
      .onConflictDoUpdate({ target: mappingGraph.id, set: values })
      .returning()
    return c.json(graphResponse(row as typeof mappingGraph.$inferSelect, await currentSchema()))
  })

  /** Renames in place: the list's name and the document's `name`, nothing else. */
  app.patch('/graphs/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    const name = (body as { name?: unknown } | null)?.name
    if (typeof name !== 'string' || name.trim() === '') {
      throw new HTTPException(400, { message: 'A mapping needs a non-empty name.' })
    }
    const [row] = await db
      .update(mappingGraph)
      .set({
        name: name.trim(),
        document: sql`jsonb_set(${mappingGraph.document}, '{name}', to_jsonb(${name.trim()}::text))`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(mappingGraph.companyId, DEMO_COMPANY_ID), eq(mappingGraph.id, c.req.param('id'))),
      )
      .returning()
    if (!row) throw new HTTPException(404, { message: `No graph '${c.req.param('id')}'.` })
    return c.json(graphResponse(row, await currentSchema()))
  })

  app.delete('/graphs/:id', async (c) => {
    const [row] = await db
      .delete(mappingGraph)
      .where(
        and(eq(mappingGraph.companyId, DEMO_COMPANY_ID), eq(mappingGraph.id, c.req.param('id'))),
      )
      .returning({ id: mappingGraph.id })
    if (!row) throw new HTTPException(404, { message: `No graph '${c.req.param('id')}'.` })
    return c.body(null, 204)
  })

  return app
}
