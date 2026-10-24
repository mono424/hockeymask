import {
  column,
  type MappingVersion,
  parseVersion,
  type Table,
  type TargetSchema,
} from '@hockeymask/core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { getDraft } from '../drafts'
import { queryClient } from '../query'
import { addIntegration, getState, openMapping } from '../store'
import { getBench } from '../testbench'
import { describeIntegrations, describeMapping } from './context'
import { runTool, TOOL_SCHEMAS, toolLabel } from './tools'

const item: Table = {
  name: 'item',
  label: 'Item',
  description: null,
  rowCount: 2,
  columns: [
    column({ name: 'itemid', logicalType: 'string', sourceType: 'text', nullable: false }),
    column({ name: 'displayname', logicalType: 'string', sourceType: 'text' }),
  ],
}

const target: TargetSchema = {
  name: 'target',
  entities: [
    {
      name: 'product',
      description: 'A product.',
      identity: [],
      fields: [
        {
          name: 'sku',
          logicalType: 'string',
          nullable: false,
          description: null,
          unit: null,
          references: null,
        },
        {
          name: 'title',
          logicalType: 'string',
          nullable: true,
          description: null,
          unit: null,
          references: null,
        },
      ],
    },
  ],
}

const nodes = [
  { id: 'items', op: 'source', system: 'netsuite', entity: 'item' },
  {
    id: 'products',
    op: 'map',
    in: 'items',
    fields: [
      { key: 'product.sku', pipeline: [{ op: 'extract', path: 'itemid' }] },
      { key: 'product.title', pipeline: [{ op: 'extract', path: 'displayname' }] },
    ],
  },
  { id: 'write', op: 'sink', in: 'products', target: 'product', key: ['product.sku'] },
]

/** The tool's output, failing the test with the tool's error message otherwise. */
async function call(name: string, input: unknown): Promise<Record<string, unknown>> {
  const answer = await runTool(name, input)
  if ('error' in answer) throw new Error(answer.error)
  return answer.output as Record<string, unknown>
}

/** Answer the API calls the tools make directly; everything else is in the query cache. */
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.startsWith('/api/sources/netsuite/tables/item/sample')) {
    return Response.json({ columns: [], rows: [{ itemid: 'S-1', displayname: 'Sample' }] })
  }
  if (init?.method === 'DELETE') return new Response(null, { status: 204 })
  return Response.json({ detail: 'not here' }, { status: 404 })
})

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock)
  queryClient.setQueryData(['tables', 'netsuite'], [item])
  queryClient.setQueryData(['table', 'netsuite', 'item'], item)
  queryClient.setQueryData(['target'], target)
  addIntegration({
    id: 'ns',
    name: 'Acme NetSuite',
    kind: 'netsuite',
    settings: {},
    graphs: [],
    createdAt: '2026-10-04T00:00:00Z',
  })
})

afterEach(() => fetchMock.mockClear())

describe('agent tools', () => {
  it('declare an object JSON Schema per tool', () => {
    for (const tool of Object.values(TOOL_SCHEMAS)) {
      expect(tool.parameters).toMatchObject({ type: 'object' })
      expect(tool.description.length).toBeGreaterThan(10)
    }
  })

  it('create a mapping, open it, and start it as an empty draft', async () => {
    const out = await call('create_mapping', { name: 'Items' })
    expect(out).toEqual({
      mappingId: 'ns--items',
      name: 'Items',
      integration: 'Acme NetSuite',
    })
    expect(openMapping(getState()).graph?.id).toBe('ns--items')
    expect(getDraft('ns--items')?.nodes).toEqual([])
  })

  it('build a whole graph in one edit, deriving the source schema and a layout', async () => {
    const out = await call('edit_mapping', { nodes })
    expect(out.issues).toEqual([])
    expect(out.fields).toMatchObject({
      items: { itemid: 'string', displayname: 'string?' },
      products: { 'product.sku': 'string', 'product.title': 'string?' },
    })
    const draft = getDraft('ns--items') as MappingVersion
    expect(draft.nodes.map((n) => n.id)).toEqual(['items', 'products', 'write'])
    expect(Object.keys(draft.expectedSchema)).toEqual(['items'])
    expect(Object.keys(draft.layout ?? {})).toEqual(['items', 'products', 'write'])
  })

  it('report issues instead of failing on a broken step', async () => {
    const out = await call('edit_mapping', {
      nodes: [{ ...nodes[2], key: ['product.nope'] }],
    })
    expect(out.issues).not.toEqual([])
    await call('edit_mapping', { nodes: [nodes[2]] })
  })

  it('read the mapping back with its fields and unsaved state', async () => {
    const out = await call('get_mapping', {})
    expect(out).toMatchObject({ mappingId: 'ns--items', unsaved: true, issues: [] })
    expect((out.document as { nodes: unknown[] }).nodes).toHaveLength(3)
  })

  it('run the testbench on given rows and share the run with the Testbench view', async () => {
    const out = await call('run_testbench', {
      rows: { items: [{ itemid: 'A-1', displayname: 'Alpha' }] },
    })
    expect(out.sinks).toEqual([
      {
        step: 'write',
        target: 'product',
        status: 'write',
        rowCount: 1,
        rows: [{ 'product.sku': 'A-1', 'product.title': 'Alpha' }],
      },
    ])
    const bench = getBench('ns--items')
    expect(JSON.parse(bench.feeds.items ?? '')).toEqual([{ itemid: 'A-1', displayname: 'Alpha' }])
    expect(bench.run?.result?.status).toBe('ok')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('run the testbench on sample rows by default', async () => {
    const out = await call('run_testbench', { sampleSize: 3 })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sources/netsuite/tables/item/sample?limit=3',
      expect.anything(),
    )
    expect((out.sinks as { rowCount: number }[])[0]?.rowCount).toBe(1)
  })

  it('remove nodes with their references and source schema', async () => {
    const out = await call('edit_mapping', { remove: ['items'] })
    expect(out.nodes).toEqual(['products', 'write'])
    const draft = getDraft('ns--items') as MappingVersion
    expect(draft.nodes[0]).not.toHaveProperty('in')
    expect(draft.expectedSchema).toEqual({})
  })

  it('answer bad calls with an error the agent can read', async () => {
    expect(await runTool('get_mapping', { mappingId: 'nope' })).toEqual({
      error: "No mapping 'nope'. Known mappings: ns--items.",
    })
    expect(await runTool('sample_rows', { limit: 5 })).toMatchObject({
      error: expect.stringContaining('table'),
    })
    expect(await runTool('edit_mapping', { remove: ['ghost'] })).toEqual({
      error: "No node 'ghost' to remove.",
    })
    expect(await runTool('launch', {})).toEqual({ error: "Unknown tool 'launch'." })
  })

  it('look up exact params in the reference', async () => {
    const out = await call('mapping_reference', { names: ['sink', 'extract', 'nope'] })
    expect(out.sink).toMatchObject({ kind: 'step', params: { type: 'object' } })
    expect(out.extract).toMatchObject({ kind: 'record op', summary: expect.any(String) })
    expect(out.nope).toBe('unknown step or op')
  })

  it('rename a mapping in the list and its draft, keeping its id', async () => {
    expect(await call('rename_mapping', { name: ' Item master ' })).toEqual({
      mappingId: 'ns--items',
      from: 'Items',
      name: 'Item master',
    })
    // Never saved: the API answers 404 and only the list and the draft carry the name.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/graphs/ns--items',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Item master' }) }),
    )
    expect(openMapping(getState()).graph).toEqual({ id: 'ns--items', name: 'Item master' })
    expect(getDraft('ns--items')?.name).toBe('Item master')
    expect(await runTool('rename_mapping', { name: '   ' })).toEqual({
      error: 'A mapping needs a name.',
    })
  })

  it('delete a mapping, its draft and its saved document', async () => {
    expect(await call('delete_mapping', { mappingId: 'ns--items' })).toEqual({
      deleted: 'ns--items',
      name: 'Item master',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/graphs/ns--items',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(getState().integrations[0]?.graphs).toEqual([])
    expect(getDraft('ns--items')).toBeNull()
  })

  it('label calls for the chat', () => {
    expect(toolLabel('create_mapping', { name: 'Items' })).toBe('Created mapping Items')
    expect(toolLabel('edit_mapping', { nodes: [{ id: 'a', op: 'map' }], remove: ['b'] })).toBe(
      'Wrote a; removed b',
    )
    expect(toolLabel('mystery', {})).toBe('mystery')
  })
})

describe('page context', () => {
  it('lists integrations and marks what is open', () => {
    const state = getState()
    expect(describeIntegrations(state.integrations, openMapping(state))).toBe(
      'Integrations:\n- “Acme NetSuite” (`ns`, NetSuite, source `netsuite`, open): mappings none',
    )
    expect(describeIntegrations([], { integration: null, graph: null })).toContain(
      'no integrations yet',
    )
  })

  it('describes the open mapping, the selected step, issues and the last run', () => {
    const text = describeMapping({
      graph: { id: 'ctx', name: 'Items' },
      version: parseVersion({ id: 'ctx', nodes }),
      unsaved: true,
      view: 'testbench',
      selectedId: 'products',
      issues: [{ code: 'type_error', node: 'write', field: 'sku', message: 'nullable key' }],
      bench: { feeds: { items: '[{}]' }, run: null, previous: null },
    })
    expect(text).toContain('Open mapping: “Items” (`ctx`), in the testbench view, with unsaved')
    expect(text).toContain('- `products` map <- items: 2 fields')
    expect(text).toContain('- `write` sink <- products: writes product')
    expect(text).toContain('The engineer has step `products` selected')
    expect(text).toContain('- write · sku: nullable key')
    expect(text).toContain('Testbench rows: `items` 1 row.')
  })
})
