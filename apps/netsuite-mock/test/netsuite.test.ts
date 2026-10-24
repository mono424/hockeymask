import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { createApp } from '../src'

const app = await createApp({ scale: 0.02, dataDir: mkdtempSync(join(tmpdir(), 'netsuite-')) })
const RECORD = 'http://ns.test/services/rest/record/v1'

async function suiteql(q: string, params: Record<string, number> = {}) {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString()
  const response = await app.request(`http://ns.test/services/rest/query/v1/suiteql?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

describe('SuiteQL', () => {
  it('pages like NetSuite', async () => {
    const { body } = await suiteql('SELECT id FROM item ORDER BY id', { limit: 75, offset: 0 })
    expect([body.count, body.offset, body.hasMore, body.totalResults]).toEqual([75, 0, true, 200])
    expect(body.links.map((l: { rel: string }) => l.rel)).toEqual(['next', 'first', 'last', 'self'])
    const last = await suiteql('SELECT id FROM item ORDER BY id', { limit: 75, offset: 150 })
    expect([last.body.count, last.body.hasMore]).toEqual([50, false])
  })

  it('sends every value as a string and leaves NULL fields out', async () => {
    const { body } = await suiteql(
      'SELECT id, itemid, upccode, baseprice, isinactive, custitem_case_qty FROM item ORDER BY id',
    )
    const values = body.items.flatMap((item: object) =>
      Object.entries(item)
        .filter(([k]) => k !== 'links')
        .map(([, v]) => v),
    )
    expect(values.every((v: unknown) => typeof v === 'string')).toBe(true)
    expect(body.items.some((item: object) => !('custitem_case_qty' in item))).toBe(true)
    expect(body.items.some((item: { upccode: string }) => item.upccode === '')).toBe(true)
    expect(new Set(body.items.map((item: { isinactive: string }) => item.isinactive))).toEqual(
      new Set(['T', 'F']),
    )
    expect(body.items[0]).toMatchObject({ itemid: 'AO-TENT-2P-GRN', baseprice: '184.99' })
  })

  it("renders dates in the account's date format", async () => {
    const { body } = await suiteql(
      'SELECT custitem_launch_date AS d FROM item WHERE custitem_launch_date IS NOT NULL',
    )
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.every((i: { d: string }) => /^\d{2}\.\d{2}\.\d{4}$/.test(i.d))).toBe(true)
  })

  it('supports BUILTIN.DF and NVL', async () => {
    const { body } = await suiteql(
      'SELECT BUILTIN.DF(i.class) AS c, BUILTIN.DF(custitem_color) color, NVL(custitem_case_qty, 0) q ' +
        "FROM item i WHERE BUILTIN.DF(i.class) = 'Camping : Tents'",
    )
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.every((i: { c: string }) => i.c === 'Camping : Tents')).toBe(true)
    expect(body.items.some((i: { color: string }) => i.color === 'Green')).toBe(true)
    expect(body.items.some((i: { q: string }) => i.q === '0')).toBe(true)
    const vendors = await suiteql('SELECT BUILTIN.DF(currency) AS cur FROM vendor')
    expect(vendors.body.items.map((i: { cur: string }) => i.cur)).toContain('US Dollar')
  })

  it('rejects anything but SELECT, and bad queries, NetSuite-style', async () => {
    const write = await suiteql('DELETE FROM item')
    expect(write.status).toBe(400)
    expect(write.body['o:errorDetails'][0].detail).toContain('Only SELECT')

    const bad = await suiteql('SELECT nope FROM item')
    expect(bad.status).toBe(400)
    expect(bad.body.title).toBe('Bad Request')
    expect(bad.body['o:errorDetails'][0]).toMatchObject({ 'o:errorCode': 'INVALID_PARAMETER' })
    expect(bad.body['o:errorDetails'][0].detail).toMatch(/^Invalid search query\./)

    expect((await suiteql('SELECT id FROM item', { limit: 1001 })).status).toBe(400)
  })

  it('requires a JSON body', async () => {
    const response = await app.request('http://ns.test/services/rest/query/v1/suiteql', {
      method: 'POST',
      body: 'q=SELECT 1',
    })
    expect(response.status).toBe(400)
  })
})

describe('metadata catalog', () => {
  it('lists record types', async () => {
    const body = (await (await app.request(`${RECORD}/metadata-catalog`)).json()) as any
    expect(body.items.map((i: { name: string }) => i.name)).toEqual(
      expect.arrayContaining([
        'item',
        'location',
        'vendor',
        'itemvendor',
        'classification',
        'currency',
      ]),
    )
  })

  it('describes a record as JSON Schema with NetSuite extensions', async () => {
    const response = await app.request(`${RECORD}/metadata-catalog/item`)
    expect(response.headers.get('content-type')).toContain('application/schema+json')
    const { properties } = (await response.json()) as any
    expect(properties.itemid.title).toBe('Item Name/Number')
    expect(properties.custitem_color['x-ns-custom-field']).toBe(true)
    expect(properties.itemid['x-ns-custom-field']).toBeUndefined()
    expect(properties.custitem_launch_date).toMatchObject({ format: 'date', nullable: true })
    expect(properties.isinactive.type).toBe('boolean')
    expect(properties.class.$ref).toMatch(/\/metadata-catalog\/classification$/)
    expect(properties.custitem_length_mm.title).toBe('Length (mm)')
  })

  it('404s unknown record types', async () => {
    const response = await app.request(`${RECORD}/metadata-catalog/salesorder`)
    expect(response.status).toBe(404)
    expect(((await response.json()) as any)['o:errorDetails'][0]['o:errorCode']).toBe(
      'NONEXISTENT_ID',
    )
  })
})
