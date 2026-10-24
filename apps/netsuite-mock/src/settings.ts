import { fileURLToPath } from 'node:url'

export interface Settings {
  scale: number
  seed: number
  /**
   * The account's date preference (strftime-style). Defaults to DD.MM.YYYY, so clients
   * must decode dates per account rather than assume ISO.
   */
  dateFormat: string
  /** Where the cached DuckDB file lives; defaults to the repo-root `.data/`. */
  dataDir: string
  host: string
  port: number
}

export const defaultSettings: Settings = {
  scale: 1,
  seed: 42,
  dateFormat: '%d.%m.%Y',
  dataDir: fileURLToPath(new URL('../../../.data', import.meta.url)),
  host: '127.0.0.1',
  port: 8101,
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    scale: Number(env.SAMPLE_SCALE ?? defaultSettings.scale),
    seed: Number(env.SAMPLE_SEED ?? defaultSettings.seed),
    dateFormat: env.NETSUITE_DATE_FORMAT ?? defaultSettings.dateFormat,
    dataDir: env.HOCKEYMASK_DATA_DIR ?? defaultSettings.dataDir,
    host: env.NETSUITE_HOST ?? defaultSettings.host,
    port: Number(env.NETSUITE_PORT ?? defaultSettings.port),
  }
}
