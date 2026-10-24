import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as schema from './schema'

export const DEMO_COMPANY_ID = 1

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url))

export type Database = Awaited<ReturnType<typeof openDatabase>>

/**
 * Postgres via PGlite (embedded, no server needed). `dataDir` persists between runs;
 * omit it for an in-memory database (tests). Applies migrations and seeds the demo company.
 */
export async function openDatabase(dataDir?: string) {
  const client = new PGlite(dataDir)
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  await db
    .insert(schema.company)
    .values({ id: DEMO_COMPANY_ID, name: 'Acme Outdoor' })
    .onConflictDoNothing()
  // keep the serial in step with the explicit id above
  await db.execute(sql`SELECT setval('company_id_seq', GREATEST(1, (SELECT MAX(id) FROM company)))`)
  return db
}
