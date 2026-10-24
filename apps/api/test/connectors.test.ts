import { describe, expect, it } from 'vite-plus/test'
import { ConnectorError, SourceUnavailable } from '@hockeymask/core'
import { type FetchLike, NetSuiteConnector, parseDate, SnowflakeConnector } from '../src/connectors'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ITEM_SCHEMA = {
  title: 'Item',
  required: ['id'],
  properties: {
    id: { type: 'integer', title: 'Internal ID', nullable: false },
    itemid: { type: 'string', title: 'Item Name/Number' },
    baseprice: { type: 'number' },
    isinactive: { type: 'boolean' },
    custitem_launch_date: { type: 'string', format: 'date', 'x-ns-custom-field': true },
    class: { type: 'object', $ref: '/metadata-catalog/classification' },
  },
}

const netsuiteFetch: FetchLike = async (input, init) => {
  const url = new URL(input)
  if (url.pathname.endsWith('/metadata-catalog/item')) return json(ITEM_SCHEMA)
  const q = JSON.parse(init?.body as string).q as string
  if (q.includes('COUNT'))
    return json({ items: [{ n: '2' }], count: 1, hasMore: false, totalResults: 1 })
  if (q.includes('nope'))
    return json({ 'o:errorDetails': [{ detail: 'Invalid search query.' }] }, 400)
  const items = [
    // values are strings, NULL fields are absent, dates use the account format
    {
      links: [],
      id: '1003',
      itemid: 'AO-TENT-2P-GRN',
      baseprice: '249.99',
      isinactive: 'F',
      custitem_launch_date: '15.03.2024',
      class: '2',
    },
    { links: [], id: '1005', itemid: 'AO-JKT-RAIN-M-BLU', isinactive: 'T' },
  ]
  const offset = Number(url.searchParams.get('offset'))
  return json({
    items: items.slice(offset, offset + 1),
    count: 1,
    hasMore: offset === 0,
    totalResults: 2,
  })
}

describe('NetSuiteConnector', () => {
  const netsuite = new NetSuiteConnector({ baseUrl: 'http://ns', fetch: netsuiteFetch })

  it('describes records from the metadata catalog', async () => {
    const table = await netsuite.describe('item')
    expect(table.rowCount).toBe(2)
    const cls = table.columns.find((c) => c.name === 'class')
    expect(cls).toMatchObject({ logicalType: 'reference', references: 'classification' })
    expect(table.columns.find((c) => c.name === 'custitem_launch_date')?.isCustom).toBe(true)
  })

  it('decodes the wire format but does not interpret values', async () => {
    const rows = []
    for await (const batch of netsuite.read('item')) rows.push(...batch)
    expect(rows[0]).toEqual({
      id: 1003,
      itemid: 'AO-TENT-2P-GRN',
      baseprice: 249.99,
      isinactive: 'F', // checkbox stays 'T' / 'F'
      custitem_launch_date: '2024-03-15', // account format, only re-encoded
      class: 2,
    })
    expect(rows[1]?.baseprice).toBeNull() // absent field = NULL
  })

  it('samples across SuiteQL pages, up to the limit', async () => {
    expect((await netsuite.sample('item', 2)).rows.map((r) => r.id)).toEqual([1003, 1005])
    const one = await netsuite.sample('item', 1)
    expect(one.rows.map((r) => r.id)).toEqual([1003])
    expect(one.totalRows).toBe(2)
  })

  it('surfaces NetSuite errors', async () => {
    await expect(netsuite.query('SELECT nope FROM item')).rejects.toThrow('Invalid search query.')
    await expect(netsuite.describe('item; DROP')).rejects.toThrow(ConnectorError)
  })
})

describe('SnowflakeConnector', () => {
  const rowType = [
    { name: 'SNAPSHOT_ID', type: 'fixed', scale: 0, precision: 38 },
    { name: 'BIN', type: 'text' },
    { name: 'UNIT_COST', type: 'fixed', scale: 2, precision: 12 },
    { name: 'SNAPSHOT_DATE', type: 'date' },
  ]
  const snowflakeFetch: FetchLike = async (input) => {
    if (new URL(input).searchParams.get('partition') === '1')
      return json({ data: [['3', '', '1.00', '0']] })
    return json({
      resultSetMetaData: { numRows: 3, rowType, partitionInfo: [{}, {}] },
      data: [
        ['1', 'A-01-03', '4.97', '19000'],
        ['2', null, null, null],
      ],
      statementHandle: 'h1',
    })
  }
  const snowflake = new SnowflakeConnector({
    baseUrl: 'http://sf',
    database: 'ANALYTICS',
    schema: 'INVENTORY',
    fetch: snowflakeFetch,
  })

  it('decodes rowType values and fetches every partition', async () => {
    const result = await snowflake.query('SELECT * FROM STOCK_SNAPSHOT')
    expect(result.totalRows).toBe(3)
    expect(result.rows).toEqual([
      { SNAPSHOT_ID: 1, BIN: 'A-01-03', UNIT_COST: 4.97, SNAPSHOT_DATE: '2022-01-08' },
      { SNAPSHOT_ID: 2, BIN: null, UNIT_COST: null, SNAPSHOT_DATE: null },
      { SNAPSHOT_ID: 3, BIN: '', UNIT_COST: 1, SNAPSHOT_DATE: '1970-01-01' }, // '' is not NULL
    ])
    expect(result.columns.map((c) => c.logicalType)).toEqual([
      'integer',
      'string',
      'decimal',
      'date',
    ])
  })

  it('rejects identifiers that are not plain', () => {
    expect(
      () => new SnowflakeConnector({ baseUrl: 'http://sf', database: 'A; DROP', schema: 'P' }),
    ).toThrow(ConnectorError)
  })
})

it('reports an unreachable source as SourceUnavailable', async () => {
  const down: FetchLike = () => Promise.reject(new TypeError('fetch failed'))
  await expect(
    new NetSuiteConnector({ baseUrl: 'http://ns', fetch: down }).listTables(),
  ).rejects.toThrow(SourceUnavailable)
})

it('parses account-formatted dates', () => {
  expect(parseDate('7.6.2022', '%d.%m.%Y')).toBe('2022-06-07')
  expect(parseDate('06/07/2022', '%m/%d/%Y')).toBe('2022-06-07')
  expect(parseDate('garbage', '%d.%m.%Y')).toBeNull()
})
