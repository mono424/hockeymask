import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { createApp } from '../src'

const app = await createApp({
  scale: 0.02,
  dataDir: mkdtempSync(join(tmpdir(), 'snowflake-')),
  partitionRows: 500,
})
const STOCK = 'ANALYTICS.INVENTORY.STOCK_SNAPSHOT'

async function sql(statement: string) {
  const response = await app.request('http://sf.test/api/v2/statements', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer demo',
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
    },
    body: JSON.stringify({ statement }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

const names = (body: Record<string, any>) =>
  body.resultSetMetaData.rowType.map((rt: { name: string }) => rt.name)

describe('statements', () => {
  it('answers in the SQL API shape, with Snowflake types and string values', async () => {
    const { body } = await sql(
      `SELECT *, CAST(ON_HAND AS DECIMAL(12,2)) AS VALUE FROM ${STOCK} ORDER BY SNAPSHOT_ID LIMIT 3`,
    )
    expect(body).toMatchObject({ code: '090001', message: 'Statement executed successfully.' })
    const meta = body.resultSetMetaData
    expect([meta.format, meta.numRows]).toEqual(['jsonv2', 3])
    const types = Object.fromEntries(
      meta.rowType.map((rt: any) => [rt.name, [rt.type, rt.precision, rt.scale]]),
    )
    expect(types.SNAPSHOT_ID).toEqual(['fixed', 38, 0])
    expect(types.BIN).toEqual(['text', null, null])
    expect(types.SNAPSHOT_DATE).toEqual(['date', null, null])
    expect(types.VALUE).toEqual(['fixed', 12, 2])
    expect(body.data.flat().every((v: unknown) => v === null || typeof v === 'string')).toBe(true)
  })

  it('splits large results into partitions fetched by handle', async () => {
    const { body } = await sql(`SELECT SNAPSHOT_ID FROM ${STOCK}`)
    const partitions = body.resultSetMetaData.partitionInfo
    expect(partitions.length).toBeGreaterThan(1)
    expect(body.data).toHaveLength(500)
    const second = (await (
      await app.request(`http://sf.test/api/v2/statements/${body.statementHandle}?partition=1`)
    ).json()) as Record<string, unknown>
    expect(Object.keys(second)).toEqual(['data'])
    expect(second.data).toHaveLength(partitions[1].rowCount)
    const total = partitions.reduce((n: number, p: { rowCount: number }) => n + p.rowCount, 0)
    expect(total).toBe(body.resultSetMetaData.numRows)
    expect((await app.request('http://sf.test/api/v2/statements/nope')).status).toBe(404)
  })

  it('sends DATE as days since the epoch', async () => {
    const { body } = await sql('SELECT MAX(SNAPSHOT_DATE) FROM STOCK_SNAPSHOT')
    const day = new Date(Number(body.data[0][0]) * 86_400_000).toISOString().slice(0, 10)
    expect(day).toBe('2026-10-04')
  })

  it('upper-cases unquoted identifiers and keeps NULL apart from blank', async () => {
    const { body } = await sql(
      'select left(bin, 0) as blank, count(*) from stock_snapshot group by 1',
    )
    expect(names(body)).toEqual(['BLANK', 'COUNT(*)'])
    expect(new Set(body.data.map((r: unknown[]) => r[0]))).toEqual(new Set(['', null]))
    const quoted = await sql('select bin as "bin" from stock_snapshot limit 1')
    expect(names(quoted.body)).toEqual(['bin'])
  })
})

describe('discovery', () => {
  it('serves INFORMATION_SCHEMA', async () => {
    const tables = await sql(
      "SELECT TABLE_NAME, ROW_COUNT FROM ANALYTICS.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'INVENTORY' ORDER BY 1",
    )
    const count = await sql(`SELECT COUNT(*) FROM ${STOCK}`)
    expect(tables.body.data).toEqual([['STOCK_SNAPSHOT', count.body.data[0][0]]])
    const columns = await sql(
      "SELECT COLUMN_NAME, DATA_TYPE, COMMENT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'STOCK_SNAPSHOT' ORDER BY ORDINAL_POSITION",
    )
    expect(columns.body.data.slice(0, 3).map((r: unknown[]) => r[0])).toEqual([
      'SNAPSHOT_ID',
      'ITEM_ID',
      'LOCATION_ID',
    ])
    expect(columns.body.data.find((r: unknown[]) => r[0] === 'ITEM_ID')).toEqual([
      'ITEM_ID',
      'NUMBER',
      'NetSuite item internal id',
    ])
  })

  it('supports SHOW TABLES and DESCRIBE TABLE', async () => {
    const shown = await sql("SHOW TABLES LIKE '%stock%' IN SCHEMA ANALYTICS.INVENTORY")
    expect(names(shown.body).slice(0, 2)).toEqual(['created_on', 'name'])
    expect(shown.body.data.map((r: unknown[]) => [r[1], r[5]])).toEqual([
      ['STOCK_SNAPSHOT', 'Daily on-hand stock per item, location and bin.'],
    ])
    const described = await sql('DESCRIBE TABLE STOCK_SNAPSHOT')
    expect(described.body.data[0].slice(0, 2)).toEqual(['SNAPSHOT_ID', 'NUMBER(38,0)'])
    expect(described.body.data[4].slice(0, 2)).toEqual(['BIN', 'VARCHAR(16777216)'])
  })
})

describe('errors', () => {
  it('uses Snowflake error codes', async () => {
    const missing = await sql('SELECT * FROM NOPE')
    expect(missing.status).toBe(422)
    expect([missing.body.code, missing.body.sqlState]).toEqual(['002003', '42S02'])
    expect((await sql('SELEC 1')).body.code).toBe('001003')
    const readOnly = await sql('DELETE FROM STOCK_SNAPSHOT')
    expect([readOnly.status, readOnly.body.code]).toEqual([422, '003001'])
    expect((await sql('SELECT 1; SELECT 2')).body.code).toBe('000008')
  })

  it('requires a JSON body', async () => {
    const response = await app.request('http://sf.test/api/v2/statements', {
      method: 'POST',
      body: 'statement=SELECT 1',
    })
    expect(response.status).toBe(400)
  })
})
