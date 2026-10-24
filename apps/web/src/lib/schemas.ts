import { type JsonSchema, type MappingVersion, type Table, tableJsonSchema } from '@hockeymask/core'

/**
 * The `expectedSchema` for a source table, describing rows as its connector delivers them.
 * NetSuite declares checkboxes `boolean` but SuiteQL sends 'T' / 'F', so they are strings.
 */
export function sourceSchema(table: Table, system: string): JsonSchema {
  const columns =
    system === 'netsuite'
      ? table.columns.map((c) =>
          c.logicalType === 'boolean' ? { ...c, logicalType: 'string' as const } : c,
        )
      : table.columns
  return tableJsonSchema({ ...table, columns }, system)
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/**
 * The `expectedSchema` entries a version is missing: one per source that names a table but has
 * no schema yet, derived from the described table. Callers merge them into their draft.
 */
export async function missingSourceSchemas(
  version: MappingVersion,
  describe: (system: string, entity: string) => Promise<Table>,
): Promise<Record<string, JsonSchema>> {
  const missing = version.nodes.filter(
    (n) => n.op === 'source' && text(n.system) && text(n.entity) && !version.expectedSchema[n.id],
  )
  const entries = await Promise.all(
    missing.map(async (n) => {
      const system = text(n.system)
      return [n.id, sourceSchema(await describe(system, text(n.entity)), system)] as const
    }),
  )
  return Object.fromEntries(entries)
}
