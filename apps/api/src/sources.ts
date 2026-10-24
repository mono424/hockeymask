import type { Connector } from '@hockeymask/core'
import { NetSuiteConnector, SnowflakeConnector } from './connectors'
import type { Settings } from './settings'

export interface Source {
  key: string
  description: string
  baseUrl: string
  connector: Connector
  ping: () => Promise<boolean>
}

export function httpPing(url: string): () => Promise<boolean> {
  return async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      return response.status < 500
    } catch {
      return false
    }
  }
}

/** The connected source systems. For the demo: a NetSuite ERP and a Snowflake warehouse. */
export function buildSources(settings: Settings): Record<string, Source> {
  return {
    netsuite: {
      key: 'netsuite',
      description: 'ERP: items, classes, locations, vendors and their custom fields.',
      baseUrl: settings.netsuiteUrl,
      connector: new NetSuiteConnector({
        baseUrl: settings.netsuiteUrl,
        dateFormat: settings.netsuiteDateFormat,
      }),
      ping: httpPing(settings.netsuiteUrl),
    },
    snowflake: {
      key: 'snowflake',
      description:
        'Data warehouse ANALYTICS.INVENTORY: daily stock snapshots per item and location.',
      baseUrl: settings.snowflakeUrl,
      connector: new SnowflakeConnector({
        baseUrl: settings.snowflakeUrl,
        database: 'ANALYTICS',
        schema: 'INVENTORY',
      }),
      ping: httpPing(settings.snowflakeUrl),
    },
  }
}
