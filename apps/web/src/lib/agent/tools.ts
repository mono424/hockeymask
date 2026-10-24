/**
 * The agent's tools. They run here in the page, on the state the engineer edits: the
 * integration list, the mapping drafts and the testbench, so the engineer watches the agent
 * work. The API's agent bridge offers them to Claude and relays every call to `runTool`.
 *
 * Mapping edits land as drafts; the engineer reviews and saves them.
 */

import {
  checkVersion,
  compileVersion,
  emptyVersion,
  getNode,
  type MappingVersion,
  MappingVersion as MappingVersionSchema,
  nodeCatalog,
  type NodeJson,
  nodeRegistry,
  opRegistry,
  removeNode,
  type RunResult,
  show,
  type TargetSchema,
  toJson,
} from '@hockeymask/core'
import { freePosition, layoutGraph } from '@hockeymask/react'
import { z } from 'zod'
import { ApiError, api, cached } from '../../api'
import { opInfo } from '../../components/inspector/ops'
import { getDraft, setDraft } from '../drafts'
import {
  type GraphRef,
  graphId,
  type Integration,
  type IntegrationKind,
  KINDS,
} from '../integrations'
import { deleteMapping, renameMapping } from '../mappings'
import { missingSourceSchemas } from '../schemas'
import { addGraph, getState, openMapping } from '../store'
import { type Feeds, rowsJson, runFeeds, setBench, sourcesOf } from '../testbench'

interface Tool<S extends z.ZodObject> {
  description: string
  input: S
  run: (input: z.infer<S>) => Promise<unknown>
  /** What the call does, in a few words for the chat. */
  label: (input: z.infer<S>) => string
}

const define = <S extends z.ZodObject>(tool: Tool<S>) => tool

/** Rows and issues shown per call; the agent can always narrow down. */
const ROW_LIMIT = 10
const ISSUE_LIMIT = 40

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const sources = Object.keys(KINDS) as [IntegrationKind, ...IntegrationKind[]]

const mappingIdParam = z.string().optional().describe('Mapping id. Defaults to the open mapping.')
const sourceParam = z
  .enum(sources)
  .optional()
  .describe("Source system. Defaults to the open integration's.")

/** Leave out what is null or empty, so results stay short. */
const compact = (record: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0),
    ),
  )

/** Drop a node's source schema (removed, or no longer reading that table). */
function withoutSchema(version: MappingVersion, id: string): MappingVersion {
  const { [id]: _dropped, ...expectedSchema } = version.expectedSchema
  return { ...version, expectedSchema }
}

function sourceOf(source: IntegrationKind | undefined): IntegrationKind {
  const resolved = source ?? openMapping(getState()).integration?.kind
  if (!resolved) throw new Error('No integration is open; name the source.')
  return resolved
}

function findMapping(id: string | undefined): { integration: Integration; graph: GraphRef } {
  const state = getState()
  if (id === undefined) {
    const { integration, graph } = openMapping(state)
    if (!integration || !graph) throw new Error('No mapping is open; pass mappingId.')
    return { integration, graph }
  }
  for (const integration of state.integrations) {
    const graph = integration.graphs.find((g) => g.id === id)
    if (graph) return { integration, graph }
  }
  const known = state.integrations.flatMap((i) => i.graphs.map((g) => g.id))
  throw new Error(`No mapping '${id}'. Known mappings: ${known.join(', ') || 'none'}.`)
}

/** The mapping as the engineer sees it: their draft, else the saved version, else empty. */
async function currentVersion(graph: GraphRef): Promise<MappingVersion> {
  const draft = getDraft(graph.id)
  if (draft) return draft
  try {
    return (await cached.graph(graph.id)).graph
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return emptyVersion(graph.id, graph.name)
    throw error
  }
}

/** Fill in the schema of every source that names a table but has none yet. */
async function withSchemas(version: MappingVersion): Promise<MappingVersion> {
  const missing = await missingSourceSchemas(version, cached.table)
  if (Object.keys(missing).length === 0) return version
  return { ...version, expectedSchema: { ...version.expectedSchema, ...missing } }
}

/** Issues, and the fields each step outputs, so the agent can wire the next step. */
function analyse(version: MappingVersion, targets: TargetSchema) {
  const { types } = compileVersion(version, { targets })
  const { issues } = checkVersion(version, { targets })
  return {
    issues: issues.slice(0, ISSUE_LIMIT),
    ...(issues.length > ISSUE_LIMIT && { moreIssues: issues.length - ISSUE_LIMIT }),
    fields: Object.fromEntries(
      Object.entries(types).map(([id, type]) => [
        id,
        Object.fromEntries(Object.entries(type.fields).map(([f, t]) => [f, show(t)])),
      ]),
    ),
  }
}

const documentOf = ({ nodes, expect, params, tables, onError, unknownFields }: MappingVersion) =>
  compact({ nodes, expect, params, tables, onError, unknownFields })

/** JSON Schema of a step's or an op's params, for the reference. */
function paramsSchema(schema: z.ZodType) {
  try {
    const { $schema: _drop, ...rest } = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    })
    return rest
  } catch {
    return 'not expressible as JSON Schema'
  }
}

/** Upsert nodes by id; a source whose table changed gets its schema derived again. */
function upsert(version: MappingVersion, nodes: readonly NodeJson[]): MappingVersion {
  let next = version
  for (const node of nodes) {
    const existing = getNode(next, node.id)
    if (existing) {
      const sameTable =
        node.op === 'source' &&
        existing.op === 'source' &&
        existing.system === node.system &&
        existing.entity === node.entity
      next = { ...next, nodes: next.nodes.map((n) => (n.id === node.id ? node : n)) }
      if (!sameTable) next = withoutSchema(next, node.id)
    } else {
      next = {
        ...next,
        nodes: [...next.nodes, node],
        layout: { ...next.layout, [node.id]: freePosition(next, node.op) },
      }
    }
  }
  return next
}

/** Merge a record; a null value removes the key. */
function merge<T>(base: Record<string, T>, patch: Record<string, unknown> | undefined) {
  if (!patch) return base
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

function summarizeRun(result: RunResult) {
  return {
    status: result.status,
    sinks: result.sinks.map((sink) => {
      const rows =
        sink.write?.rows ??
        (result.outputs?.[sink.sink] ?? []).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toJson(v)])),
        )
      return compact({
        step: sink.sink,
        target: sink.write?.target,
        status: sink.status,
        rowCount: rows.length,
        rows: rows.slice(0, ROW_LIMIT),
      })
    }),
    steps: result.stats.map((s) =>
      compact({
        step: s.node,
        op: s.op,
        status: s.status,
        in: s.rowsIn,
        out: s.rowsOut,
        skipped: s.skipped || null,
        changed: s.changed || null,
      }),
    ),
    issues: result.issues.slice(0, ISSUE_LIMIT),
  }
}

export const TOOLS = {
  list_tables: define({
    description: 'List the tables of a source system, with row counts.',
    input: z.object({ source: sourceParam }),
    label: ({ source }) => `Listed ${source ?? 'source'} tables`,
    run: async ({ source }) =>
      (await cached.tables(sourceOf(source))).map((t) =>
        compact({ name: t.name, label: t.label, rows: t.rowCount, description: t.description }),
      ),
  }),

  describe_table: define({
    description: 'Columns of a source table: name, logical and source type, label, description.',
    input: z.object({ source: sourceParam, table: z.string().min(1) }),
    label: ({ table }) => `Described ${table}`,
    run: async ({ source, table }) => {
      const described = await cached.table(sourceOf(source), table)
      return {
        ...compact({ name: described.name, label: described.label, rows: described.rowCount }),
        columns: described.columns.map((c) =>
          compact({
            name: c.name,
            type: c.logicalType,
            sourceType: c.sourceType,
            label: c.label,
            description: c.description,
            custom: c.isCustom || null,
            references: c.references,
          }),
        ),
      }
    },
  }),

  sample_rows: define({
    description: 'Sample rows of a source table, exactly as its connector delivers them.',
    input: z.object({
      source: sourceParam,
      table: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional().describe('Rows; 10 by default.'),
    }),
    label: ({ table }) => `Sampled ${table}`,
    run: async ({ source, table, limit }) =>
      (await api.sample(sourceOf(source), table, limit ?? ROW_LIMIT)).rows,
  }),

  get_target_model: define({
    description:
      'The target data model, what mappings write to. Without an entity: every entity with its field names. With one: its fields with type, nullability, unit and references.',
    input: z.object({ entity: z.string().optional() }),
    label: ({ entity }) => (entity ? `Read target ${entity}` : 'Read the target model'),
    run: async ({ entity }) => {
      const schema = await cached.targetSchema()
      if (!entity) {
        return schema.entities.map((e) =>
          compact({
            name: e.name,
            description: e.description,
            identity: e.identity,
            fields: e.fields.map((f) => f.name),
          }),
        )
      }
      const found = schema.entities.find((e) => e.name === entity)
      if (!found) throw new Error(`No target entity '${entity}'.`)
      return {
        ...compact({ name: found.name, description: found.description, identity: found.identity }),
        fields: found.fields.map((f) =>
          compact({
            name: f.name,
            type: f.logicalType,
            nullable: f.nullable,
            description: f.description,
            unit: f.unit,
            references: f.references,
          }),
        ),
      }
    },
  }),

  mapping_reference: define({
    description:
      'Reference for the mapping language. Without names: every step (node op) with its inputs and every record op for map field pipelines. With names: the exact params, as JSON Schema, of those steps or ops.',
    input: z.object({ names: z.array(z.string()).optional() }),
    label: ({ names }) => (names?.length ? `Looked up ${names.join(', ')}` : 'Read the reference'),
    run: async ({ names }) => {
      if (!names?.length) {
        return {
          steps: nodeCatalog.map((n) => ({
            op: n.op,
            description: n.description,
            inputs: n.slots.map((s) => s.path.join('.') + (s.multiple ? '[]' : '')),
          })),
          recordOps: Object.keys(opRegistry).map((op) =>
            compact({ op, summary: opInfo(op)?.summary, startsPipeline: opInfo(op)?.entry }),
          ),
          sugar:
            'if_<predicate> { <operand: value|values|date|pattern>, then, else? } expands to a one-case when, e.g. { "op": "if_lte", "value": 0, "then": null }.',
        }
      }
      return Object.fromEntries(
        names.map((name) => {
          const step = Object.hasOwn(nodeRegistry, name) ? nodeRegistry[name] : undefined
          const op = Object.hasOwn(opRegistry, name) ? opRegistry[name] : undefined
          if (step) return [name, { kind: 'step', params: paramsSchema(step.params) }]
          if (op) {
            return [
              name,
              compact({
                kind: 'record op',
                summary: opInfo(name)?.summary,
                params: paramsSchema(op.params),
              }),
            ]
          }
          return [name, 'unknown step or op']
        }),
      )
    },
  }),

  create_mapping: define({
    description:
      'Create an empty mapping in an integration and open it in the builder. Returns its id.',
    input: z.object({
      name: z.string().min(1),
      integrationId: z.string().optional().describe('Defaults to the open integration.'),
    }),
    label: ({ name }) => `Created mapping ${name}`,
    run: async ({ name, integrationId }) => {
      const { integrations } = getState()
      const integration = integrationId
        ? integrations.find((i) => i.id === integrationId)
        : openMapping(getState()).integration
      if (!integration) {
        throw new Error(
          integrationId ? `No integration '${integrationId}'.` : 'No integration is open.',
        )
      }
      const id = graphId(integration.id, name, integration.graphs)
      // A draft from the start: nothing is saved until the engineer saves it.
      setDraft(id, emptyVersion(id, name.trim()))
      addGraph(integration.id, { id, name: name.trim() })
      return { mappingId: id, name: name.trim(), integration: integration.name }
    },
  }),

  rename_mapping: define({
    description: 'Rename a mapping. Its id stays the same; a saved document is renamed at once.',
    input: z.object({ name: z.string().min(1), mappingId: mappingIdParam }),
    label: ({ name }) => `Renamed mapping to ${name}`,
    run: async ({ name, mappingId }) => {
      const { graph } = findMapping(mappingId)
      return { mappingId: graph.id, from: graph.name, name: await renameMapping(graph.id, name) }
    },
  }),

  delete_mapping: define({
    description: 'Delete a mapping and its saved document. Only when the engineer asks for it.',
    input: z.object({ mappingId: z.string().min(1) }),
    label: ({ mappingId }) => `Deleted mapping ${mappingId}`,
    run: async ({ mappingId }) => {
      const { graph } = findMapping(mappingId)
      await deleteMapping(graph.id)
      return { deleted: graph.id, name: graph.name }
    },
  }),

  get_mapping: define({
    description:
      "A mapping's document (nodes, expect, params, tables), whether it has unsaved changes, its issues, and the fields each step outputs (with their types).",
    input: z.object({ mappingId: mappingIdParam }),
    label: () => 'Read the mapping',
    run: async ({ mappingId }) => {
      const { integration, graph } = findMapping(mappingId)
      const version = await withSchemas(await currentVersion(graph))
      return {
        mappingId: graph.id,
        name: graph.name,
        integration: integration.name,
        source: integration.kind,
        unsaved: getDraft(graph.id) !== null,
        document: documentOf(version),
        ...analyse(version, await cached.targetSchema()),
      }
    },
  }),

  edit_mapping: define({
    description:
      "Edit a mapping's draft. `nodes` are added, or replace the node with the same id whole; `remove` deletes nodes and every reference to them. `expect`, `params` and `tables` merge per key (null removes a key). Source schemas are derived from their tables. Returns the issues and the fields each step outputs.",
    input: z.object({
      mappingId: mappingIdParam,
      nodes: z
        .array(z.looseObject({ id: z.string().min(1), op: z.string().min(1) }))
        .optional()
        .describe('Whole nodes: { id, op, label?, ...params }.'),
      remove: z.array(z.string()).optional().describe('Ids of nodes to delete.'),
      expect: z.record(z.string(), z.unknown()).optional().describe('Expectations by node id.'),
      params: z.record(z.string(), z.unknown()).optional().describe('Named constants.'),
      tables: z.record(z.string(), z.unknown()).optional().describe('Lookup tables by name.'),
    }),
    label: ({ nodes, remove }) =>
      [
        nodes?.length && `wrote ${nodes.map((n) => n.id).join(', ')}`,
        remove?.length && `removed ${remove.join(', ')}`,
      ]
        .filter(Boolean)
        .join('; ')
        .replace(/^./, (c) => c.toUpperCase()) || 'Edited the mapping',
    run: async ({ mappingId, nodes, remove, expect, params, tables }) => {
      const { graph } = findMapping(mappingId)
      const before = await currentVersion(graph)
      let version = before
      for (const id of remove ?? []) {
        if (!getNode(version, id)) throw new Error(`No node '${id}' to remove.`)
        version = withoutSchema(removeNode(version, id), id)
      }
      version = upsert(version, (nodes ?? []) as NodeJson[])
      const parsed = MappingVersionSchema.safeParse({
        ...version,
        expect: merge(version.expect, expect),
        params: merge(version.params, params),
        tables: merge(version.tables, tables),
      })
      if (!parsed.success) throw new Error(z.prettifyError(parsed.error))
      version = await withSchemas(parsed.data)
      // A graph built from nothing gets laid out whole; added nodes take a free spot.
      if (before.nodes.length === 0) version = layoutGraph(version)
      setDraft(graph.id, version)
      return {
        mappingId: graph.id,
        nodes: version.nodes.map((n) => n.id),
        ...analyse(version, await cached.targetSchema()),
      }
    },
  }),

  run_testbench: define({
    description: `Run a mapping in the testbench and report what would reach the target: rows per sink (first ${ROW_LIMIT}), per-step row counts, and run issues. Each source is fed \`rows\` you give for its node id, else sample rows of its table. Replaces the testbench rows, so the engineer sees this run in the Testbench view.`,
    input: z.object({
      mappingId: mappingIdParam,
      rows: z
        .record(z.string(), z.array(z.record(z.string(), z.unknown())))
        .optional()
        .describe('Rows by source node id, as the source delivers them.'),
      sampleSize: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Sample rows per source without given rows; 10 by default.'),
    }),
    label: () => 'Ran the testbench',
    run: async ({ mappingId, rows, sampleSize }) => {
      const { graph } = findMapping(mappingId)
      const version = await withSchemas(await currentVersion(graph))
      const feeds = sourcesOf(version)
      if (feeds.length === 0) throw new Error('The mapping has no source step yet.')
      for (const id of Object.keys(rows ?? {})) {
        if (!feeds.some((n) => n.id === id)) throw new Error(`'${id}' is not a source step.`)
      }
      const fed: Feeds = Object.fromEntries(
        await Promise.all(
          feeds.map(async (node) => {
            const given = rows?.[node.id]
            if (given) return [node.id, rowsJson(given)]
            const system = text(node.system)
            const entity = text(node.entity)
            if (!system || !entity) throw new Error(`Source '${node.id}' has no table.`)
            const sample = await api.sample(system, entity, sampleSize ?? ROW_LIMIT)
            return [node.id, rowsJson(sample.rows)]
          }),
        ),
      )
      const run = runFeeds(version, fed, await cached.targetSchema())
      setBench(graph.id, { feeds: fed, run })
      return compact({
        mappingId: graph.id,
        errors: run.errors,
        ...(run.result && summarizeRun(run.result)),
      })
    },
  }),
}

export type ToolName = keyof typeof TOOLS

/** The tools as the bridge expects them: name -> description and JSON Schema of the input. */
export const TOOL_SCHEMAS = Object.fromEntries(
  Object.entries(TOOLS).map(([name, tool]) => [
    name,
    { description: tool.description, parameters: z.toJSONSchema(tool.input, { io: 'input' }) },
  ]),
)

const isTool = (name: string): name is ToolName => Object.hasOwn(TOOLS, name)

export function toolLabel(name: string, input: unknown): string {
  if (!isTool(name)) return name
  const parsed = TOOLS[name].input.safeParse(input)
  return parsed.success ? (TOOLS[name].label as (i: unknown) => string)(parsed.data) : name
}

/** Run one tool call; a failure is the answer the agent reads, never a thrown error. */
export async function runTool(
  name: string,
  input: unknown,
): Promise<{ output: unknown } | { error: string }> {
  if (!isTool(name)) return { error: `Unknown tool '${name}'.` }
  const tool = TOOLS[name]
  const parsed = tool.input.safeParse(input)
  if (!parsed.success) return { error: z.prettifyError(parsed.error) }
  try {
    return { output: await (tool.run as (i: unknown) => Promise<unknown>)(parsed.data) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
