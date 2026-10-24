/**
 * Integrations: a connected source plus the mapping graphs built for it.
 *
 * Client-side only for now (no backend for integrations yet): the list lives in
 * localStorage through `store.ts`; graph documents go through the API under
 * `${integrationId}--${graphSlug}`.
 */

export type IntegrationKind = 'netsuite' | 'snowflake'

export interface GraphRef {
  /** Graph document id in the API. */
  id: string
  name: string
}

export interface Integration {
  id: string
  name: string
  kind: IntegrationKind
  settings: Record<string, string>
  graphs: GraphRef[]
  createdAt: string
}

export interface SettingField {
  key: string
  label: string
  value: string
}

export interface KindInfo {
  label: string
  description: string
  defaultName: string
  settings: SettingField[]
}

/** The two demo backends, with the settings a real connection form would ask for. */
export const KINDS: Record<IntegrationKind, KindInfo> = {
  netsuite: {
    label: 'NetSuite (demo)',
    description: 'ERP: items, locations, vendors and their custom fields, over SuiteQL.',
    defaultName: 'Acme NetSuite',
    settings: [
      { key: 'baseUrl', label: 'Base URL', value: 'http://localhost:8101' },
      { key: 'accountId', label: 'Account ID', value: 'ACME' },
      { key: 'auth', label: 'Authentication', value: 'Token-based (demo token)' },
      { key: 'dateFormat', label: 'Date format', value: 'DD.MM.YYYY' },
    ],
  },
  snowflake: {
    label: 'Snowflake (demo)',
    description:
      'Analytics warehouse: daily stock snapshots per item and location, over the SQL API.',
    defaultName: 'Acme Snowflake',
    settings: [
      { key: 'baseUrl', label: 'Base URL', value: 'http://localhost:8102' },
      { key: 'account', label: 'Account', value: 'ACME-ANALYTICS' },
      { key: 'warehouse', label: 'Warehouse', value: 'COMPUTE_WH' },
      { key: 'database', label: 'Database', value: 'ANALYTICS' },
      { key: 'schema', label: 'Schema', value: 'INVENTORY' },
      { key: 'role', label: 'Role', value: 'ANALYST' },
      { key: 'auth', label: 'Authentication', value: 'Key-pair JWT (demo)' },
    ],
  },
}

export function defaultSettings(kind: IntegrationKind): Record<string, string> {
  return Object.fromEntries(KINDS[kind].settings.map((s) => [s.key, s.value]))
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'graph'
  )
}

export function newIntegrationId(name: string): string {
  return `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`
}

/** A graph document id unique within the integration: `${integrationId}--${slug}`. */
export function graphId(integrationId: string, name: string, taken: readonly GraphRef[]): string {
  const base = `${integrationId}--${slugify(name)}`
  const ids = new Set(taken.map((g) => g.id))
  let id = base
  for (let n = 2; ids.has(id); n += 1) id = `${base}-${n}`
  return id
}
