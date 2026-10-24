import {
  ConnectorError,
  column,
  emptyVersion,
  type RowSet,
  SourceUnavailable,
  type TableRef,
  type TargetSchema,
} from '@hockeymask/core'
import { beforeAll, describe, expect, it } from 'vite-plus/test'
import { createApp, type Database, openDatabase, type Source } from '../src'

const fakeSource = (overrides: Partial<Source['connector']> = {}): Source => ({
  key: 'netsuite',
  description: 'Demo ERP',
  baseUrl: 'http://netsuite.test',
  ping: async () => true,
  connector: {
    system: 'NetSuite',
    dialect: 'suiteql',
    listTables: async () => [{ name: 'item', label: 'Item', description: null, rowCount: 2 }],
    describe: async (table) => {
      if (table !== 'item') throw new ConnectorError(`Record type '${table}' was not found.`)
      return {
        name: 'item',
        label: 'Item',
        description: null,
        rowCount: 2,
        columns: [column({ name: 'id', logicalType: 'integer', sourceType: 'integer' })],
      }
    },
    sample: async () => ({
      columns: [],
      rows: [{ id: 1, itemid: 'AO-TENT-2P-GRN' }],
      totalRows: 2,
    }),
    read: async function* () {},
    query: async () => ({ columns: [], rows: [], totalRows: 0 }),
    ...overrides,
  },
})

let db: Database
beforeAll(async () => {
  db = await openDatabase()
})

const api = (source = fakeSource()) => createApp({ db, sources: { netsuite: source } })

/** Body of a response, typed by the caller. */
const body = async <T>(response: Response | Promise<Response>): Promise<T> =>
  (await (await response).json()) as T

interface GraphBody {
  id: string
  graph: { name: string }
  issues: { code: string; node?: string; field?: string; message: string }[]
}

const put = (app: ReturnType<typeof api>, id: string, graph: unknown) =>
  app.request(`/api/graphs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph }),
  })

/** NetSuite item -> product, checked against the demo target model. */
const itemToProduct = (titleField: string) => ({
  id: 'items',
  expectedSchema: {
    items: {
      type: 'object',
      required: ['itemid', 'displayname'],
      properties: { itemid: { type: 'string' }, displayname: { type: 'string' } },
    },
  },
  nodes: [
    { id: 'items', op: 'source', system: 'netsuite', entity: 'item' },
    {
      id: 'products',
      op: 'map',
      in: 'items',
      fields: [
        { key: 'sku', pipeline: [{ op: 'extract', path: 'itemid' }] },
        { key: titleField, pipeline: [{ op: 'extract', path: 'displayname' }] },
      ],
    },
    { id: 'product_out', op: 'sink', in: 'products', target: 'product', key: ['sku'] },
  ],
})

describe('discovery', () => {
  it('reports health and sources', async () => {
    expect(await body(api().request('/api/health'))).toEqual({
      status: 'ok',
      database: 'ok',
      sources: { netsuite: 'ok' },
    })
    const [listed] = await body<{ key: string }[]>(api().request('/api/sources'))
    expect(listed).toMatchObject({ key: 'netsuite', system: 'NetSuite', status: 'ok' })
  })

  it('passes tables and samples through', async () => {
    expect(await body<TableRef[]>(api().request('/api/sources/netsuite/tables'))).toHaveLength(1)
    const sample = await body<RowSet>(api().request('/api/sources/netsuite/tables/item/sample'))
    expect(sample.rows[0]).toEqual({ id: 1, itemid: 'AO-TENT-2P-GRN' })
  })

  it('maps failures to user-facing statuses', async () => {
    expect((await api().request('/api/sources/sap/tables')).status).toBe(404)
    expect((await api().request('/api/sources/netsuite/tables/salesorder')).status).toBe(400)
    const down = fakeSource({
      listTables: () => Promise.reject(new SourceUnavailable('NetSuite is unreachable')),
    })
    const response = await api(down).request('/api/sources/netsuite/tables')
    expect(response.status).toBe(424)
    expect((await body<{ detail: string }>(response)).detail).toContain('unreachable')
  })
})

describe('target schema', () => {
  it('describes the target model with units and identity', async () => {
    const schema = await body<TargetSchema>(api().request('/api/target/schema'))
    expect(schema.name).toBe('Target model')
    expect(schema.entities.map((e) => e.name)).toEqual([
      'product',
      'category',
      'supplier',
      'supplier_product',
      'warehouse',
      'inventory_level',
    ])
    const product = schema.entities.find((e) => e.name === 'product')
    expect(product?.identity).toEqual(['source_system', 'source_id', 'secondary_source_id'])
    expect(product?.fields.find((f) => f.name === 'weight')?.unit).toBe('g')
    expect(product?.fields.find((f) => f.name === 'length')?.unit).toBe('m')
    expect(product?.nullsNotDistinct).toBeUndefined()
  })

  it('identifies link entities by their two references', async () => {
    const schema = await body<TargetSchema>(api().request('/api/target/schema'))
    const stock = schema.entities.find((e) => e.name === 'inventory_level')
    expect(stock?.identity).toEqual(['product_id', 'warehouse_id'])
    expect(stock?.fields.find((f) => f.name === 'warehouse_id')).toMatchObject({
      logicalType: 'reference',
      nullable: false,
      references: 'warehouse',
    })
    const offer = schema.entities.find((e) => e.name === 'supplier_product')
    expect(offer?.identity).toEqual(['product_id', 'supplier_id'])
  })

  it('documents every plain field (docs are what auto-fill reads)', async () => {
    const schema = await body<TargetSchema>(api().request('/api/target/schema'))
    const undocumented = schema.entities.flatMap((e) =>
      e.fields
        .filter((f) => f.logicalType !== 'reference' && !f.description)
        .map((f) => `${e.name}.${f.name}`),
    )
    expect(undocumented).toEqual([])
  })
})

describe('target entity edits', () => {
  interface EntityBody {
    entity: TargetSchema['entities'][number]
    edited: boolean
  }
  const edit = (app: ReturnType<typeof createApp>, name: string, entity: unknown) =>
    app.request(`/api/target/entities/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entity),
    })
  // Its own database: an edit changes the schema every other test checks against.
  const fresh = async () => createApp({ db: await openDatabase(), sources: {} })
  const product = async (app: ReturnType<typeof createApp>) => {
    const listed = await body<EntityBody[]>(app.request('/api/target/entities'))
    return listed.find((e) => e.entity.name === 'product') as EntityBody
  }

  it('replaces an entity in the schema until it is reset', async () => {
    const app = await fresh()
    const before = await product(app)
    expect(before.edited).toBe(false)
    const changed = { ...before.entity, description: 'A sellable article.' }
    expect(await body<EntityBody>(edit(app, 'product', changed))).toEqual({
      entity: changed,
      edited: true,
    })
    expect(await product(app)).toEqual({ entity: changed, edited: true })
    const schema = await body<TargetSchema>(app.request('/api/target/schema'))
    expect(schema.entities.find((e) => e.name === 'product')?.description).toBe(
      'A sellable article.',
    )
    const reset = await body<EntityBody>(
      app.request('/api/target/entities/product', { method: 'DELETE' }),
    )
    expect(reset).toEqual(before)
    expect(await product(app)).toEqual(before)
  })

  it('checks saved mappings against the edited schema', async () => {
    const app = await fresh()
    const { entity } = await product(app)
    await edit(app, 'product', {
      ...entity,
      fields: entity.fields.filter((f) => f.name !== 'title'),
    })
    const saved = await body<GraphBody>(put(app, 'items', itemToProduct('title')))
    expect(saved.issues).toEqual([expect.objectContaining({ node: 'products', field: 'title' })])
  })

  it('rejects entities that do not fit the schema', async () => {
    const app = await fresh()
    const { entity } = await product(app)
    const [first] = entity.fields
    const rejects = async (name: string, value: unknown, status = 400) => {
      const response = await edit(app, name, value)
      expect(response.status).toBe(status)
      return (await body<{ detail: string }>(response)).detail
    }
    expect(await rejects('nope', entity, 404)).toBe("No entity 'nope'.")
    expect(await rejects('product', { ...entity, fields: 'none' })).toContain('fields')
    expect(await rejects('product', { ...entity, name: 'item' })).toContain('keeps its name')
    expect(await rejects('product', { ...entity, identity: ['nope'] })).toBe(
      "identity field 'nope' is not a field",
    )
    expect(
      await rejects('product', {
        ...entity,
        fields: [...entity.fields, { ...first, references: 'x' }],
      }),
    ).toBe(`field '${first?.name}' appears twice; ${first?.name} references unknown entity 'x'`)
    expect((await product(app)).edited).toBe(false)
  })
})

describe('graphs', () => {
  it('saves, checks and lists mapping versions', async () => {
    const app = api()
    const saved = await put(app, 'main', emptyVersion('main', 'Acme'))
    expect(saved.status).toBe(200)
    expect((await body<GraphBody>(saved)).issues).toEqual([])
    const listed = await body<{ id: string }[]>(app.request('/api/graphs'))
    expect(listed.map((g) => g.id)).toContain('main')
    expect((await body<GraphBody>(app.request('/api/graphs/main'))).graph.name).toBe('Acme')
  })

  it('checks a mapping against the target model', async () => {
    const app = api()
    const clean = await body<GraphBody>(put(app, 'items', itemToProduct('title')))
    expect(clean.issues).toEqual([])
    const wrong = await body<GraphBody>(put(app, 'items', itemToProduct('name')))
    expect(wrong.issues).toEqual([
      expect.objectContaining({ code: 'type_error', node: 'products', field: 'name' }),
    ])
  })

  it('renames a mapping version in the list and the document', async () => {
    const app = api()
    await put(app, 'renamed', itemToProduct('title'))
    const rename = (name: unknown, id = 'renamed') =>
      app.request(`/api/graphs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
    const renamed = await body<GraphBody & { graph: { nodes: unknown[] } }>(
      rename('  Items to products '),
    )
    expect(renamed.graph.name).toBe('Items to products')
    expect(renamed.graph.nodes).toHaveLength(3)
    const listed = await body<{ id: string; name: string }[]>(app.request('/api/graphs'))
    expect(listed.find((g) => g.id === 'renamed')?.name).toBe('Items to products')
    expect((await rename('  ')).status).toBe(400)
    expect((await rename(7)).status).toBe(400)
    expect((await rename('Any', 'nope')).status).toBe(404)
  })

  it('deletes a mapping version', async () => {
    const app = api()
    await put(app, 'gone', emptyVersion('gone'))
    expect((await app.request('/api/graphs/gone', { method: 'DELETE' })).status).toBe(204)
    expect((await app.request('/api/graphs/gone')).status).toBe(404)
    expect((await app.request('/api/graphs/gone', { method: 'DELETE' })).status).toBe(404)
  })

  it('rejects documents that are not mapping versions, and 404s unknown ids', async () => {
    const bad = await put(api(), 'x', { nodes: 'no' })
    expect(bad.status).toBe(400)
    expect((await api().request('/api/graphs/nope')).status).toBe(404)
  })
})
