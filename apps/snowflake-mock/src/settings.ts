import { fileURLToPath } from 'node:url'

export interface Settings {
  scale: number
  seed: number
  /** Where the cached DuckDB file lives; defaults to the repo-root `.data/`. */
  dataDir: string
  /** Rows per result partition; larger results are fetched partition by partition. */
  partitionRows: number
  defaultDatabase: string
  defaultSchema: string
  host: string
  port: number
}

export const defaultSettings: Settings = {
  scale: 1,
  seed: 42,
  dataDir: fileURLToPath(new URL('../../../.data', import.meta.url)),
  partitionRows: 10_000,
  defaultDatabase: 'ANALYTICS',
  defaultSchema: 'INVENTORY',
  host: '127.0.0.1',
  port: 8102,
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    ...defaultSettings,
    scale: Number(env.SAMPLE_SCALE ?? defaultSettings.scale),
    seed: Number(env.SAMPLE_SEED ?? defaultSettings.seed),
    dataDir: env.HOCKEYMASK_DATA_DIR ?? defaultSettings.dataDir,
    partitionRows: Number(env.SNOWFLAKE_PARTITION_ROWS ?? defaultSettings.partitionRows),
    host: env.SNOWFLAKE_HOST ?? defaultSettings.host,
    port: Number(env.SNOWFLAKE_PORT ?? defaultSettings.port),
  }
}
