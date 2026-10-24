import { fileURLToPath } from 'node:url'

export interface Settings {
  port: number
  netsuiteUrl: string
  netsuiteDateFormat: string
  snowflakeUrl: string
  /** PGlite data directory; the repo's .data/ by default. */
  databaseDir: string
}

const REPO_DATA = fileURLToPath(new URL('../../../.data/api-pglite', import.meta.url))

export function settingsFromEnv(env = process.env): Settings {
  return {
    port: Number(env.API_PORT ?? 8000),
    netsuiteUrl: env.NETSUITE_URL ?? 'http://localhost:8101',
    netsuiteDateFormat: env.NETSUITE_DATE_FORMAT ?? '%d.%m.%Y',
    snowflakeUrl: env.SNOWFLAKE_URL ?? 'http://localhost:8102',
    databaseDir: env.DATABASE_DIR ?? REPO_DATA,
  }
}
