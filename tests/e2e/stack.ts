/**
 * The whole demo stack in-process: both demo sources, the API's connectors over them
 * (fetch goes straight to the Hono apps, no ports), and the API on an in-memory PGlite.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp as netsuiteApp } from 'netsuite-mock'
import { createApp as snowflakeApp } from 'snowflake-mock'
import {
  createApp as apiApp,
  type FetchLike,
  NetSuiteConnector,
  openDatabase,
  SnowflakeConnector,
} from 'api'
import { generate } from 'sample-data'

export const SCALE = 0.02

const inProcess =
  (app: {
    request: (input: string, init?: RequestInit) => Response | Promise<Response>
  }): FetchLike =>
  async (input, init) =>
    app.request(input, init)

export async function startStack() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hockeymask-e2e-'))
  const [ns, sf, db] = await Promise.all([
    netsuiteApp({ scale: SCALE, dataDir }),
    snowflakeApp({ scale: SCALE, dataDir, partitionRows: 1000 }),
    openDatabase(),
  ])
  const netsuite = new NetSuiteConnector({ baseUrl: 'http://netsuite', fetch: inProcess(ns) })
  const snowflake = new SnowflakeConnector({
    baseUrl: 'http://snowflake',
    database: 'ANALYTICS',
    schema: 'INVENTORY',
    fetch: inProcess(sf),
  })
  const api = apiApp({
    db,
    sources: {
      netsuite: {
        key: 'netsuite',
        description: 'ERP',
        baseUrl: 'http://netsuite',
        connector: netsuite,
        ping: async () => true,
      },
      snowflake: {
        key: 'snowflake',
        description: 'Mart',
        baseUrl: 'http://snowflake',
        connector: snowflake,
        ping: async () => true,
      },
    },
  })
  return { dataset: generate({ scale: SCALE }), netsuite, snowflake, api }
}

export async function readAll<T>(rows: AsyncIterable<T[]>): Promise<T[]> {
  const out: T[] = []
  for await (const batch of rows) out.push(...batch)
  return out
}
