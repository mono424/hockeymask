import {
  type CompileIssue,
  compileVersion,
  execute,
  parseVersion,
  type Table,
  type TableRef,
  tableJsonSchema,
  type TargetSchema,
} from '@hockeymask/core'
import { beforeAll, describe, expect, it } from 'vite-plus/test'
import { STOCK_SNAPSHOT } from 'sample-data'
import { readAll, startStack } from './stack'

let stack: Awaited<ReturnType<typeof startStack>>
beforeAll(async () => {
  stack = await startStack()
}, 60_000)

const get = async <T>(path: string): Promise<T> =>
  (await (await stack.api.request(path)).json()) as T

describe('discovery through the API', () => {
  it('lists both sources and their tables', async () => {
    const netsuite = await get<TableRef[]>('/api/sources/netsuite/tables')
    const item = netsuite.find((t) => t.name === 'item')
    expect(item?.rowCount).toBe(stack.dataset.netsuite.item?.rows.length)
    const snowflake = await get<TableRef[]>('/api/sources/snowflake/tables')
    expect(snowflake.map((t) => t.name)).toContain(STOCK_SNAPSHOT)
  })

  it('shows NetSuite custom fields with their references', async () => {
    const item = await get<Table>('/api/sources/netsuite/tables/item')
    const vendor = await get<Table>('/api/sources/netsuite/tables/itemvendor')
    expect(vendor.columns.find((c) => c.name === 'vendor')).toMatchObject({ references: 'vendor' })
    const color = item.columns.find((c) => c.name === 'custitem_color')
    expect(color).toMatchObject({ isCustom: true })
  })
})

describe('the wire is lossless', () => {
  it('NetSuite items arrive as generated (DD.MM.YYYY decoded to ISO)', async () => {
    const wire = await readAll(stack.netsuite.read('item'))
    const generated = stack.dataset.netsuite.item?.toObjects() ?? []
    expect(wire).toEqual(generated)
  })

  it('STOCK_SNAPSHOT survives the SQL API partitions', async () => {
    const wire = await readAll(stack.snowflake.read('STOCK_SNAPSHOT'))
    const generated = stack.dataset.snowflake[STOCK_SNAPSHOT]?.toObjects() ?? []
    expect(wire.length).toBeGreaterThan(1000) // more than one partition
    expect(wire).toEqual(generated)
  })
})

it('saves a mapping over real tables, checks it, and runs it on the wire rows', async () => {
  // The version's source contract starts from what the connector describes, then the author
  // corrects it: NetSuite declares checkboxes boolean but SuiteQL delivers 'T' / 'F'.
  const item = await get<Table>('/api/sources/netsuite/tables/item')
  const described = tableJsonSchema(item, 'netsuite')
  const checkbox = { type: ['string', 'null'], enum: ['T', 'F', null] }
  const items = {
    ...described,
    properties: {
      ...(described.properties as object),
      isinactive: checkbox,
    },
  }
  const required = (path: string) => [
    { op: 'extract', path },
    { op: 'require', message: `${path} is empty` },
  ]
  const version = parseVersion({
    id: 'items',
    name: 'Acme items',
    expectedSchema: { items },
    nodes: [
      { id: 'items', op: 'source', system: 'netsuite', entity: 'item' },
      {
        id: 'products',
        op: 'map',
        in: 'items',
        fields: [
          { key: 'sku', pipeline: required('itemid') },
          // ~1% of items have no display name: fall back to the SKU.
          { key: 'title', pipeline: [{ op: 'coalesce', paths: ['displayname', 'itemid'] }] },
        ],
      },
      { id: 'product_out', op: 'sink', in: 'products', target: 'product', key: ['sku'] },
    ],
  })

  const saved = await stack.api.request('/api/graphs/items', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph: version }),
  })
  const body = (await saved.json()) as { issues: CompileIssue[] }
  expect(saved.status).toBe(200)
  expect(body.issues).toEqual([])

  const compiled = compileVersion(version, {
    targets: await get<TargetSchema>('/api/target/schema'),
  })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues))
  const rows = await readAll(stack.netsuite.read('item'))
  const run = execute(compiled.plan, { items: rows }, { now: '2026-10-04T00:00:00Z' })
  expect(run.issues).toEqual([])
  expect(run.status).toBe('ok')
  expect(run.sinks[0]?.write?.rows).toHaveLength(rows.length)
})
