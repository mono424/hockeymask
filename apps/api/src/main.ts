import { serve } from '@hono/node-server'
import { createApp } from './app'
import { openDatabase } from './db/client'
import { settingsFromEnv } from './settings'
import { buildSources } from './sources'

const settings = settingsFromEnv()
const db = await openDatabase(settings.databaseDir)
const app = createApp({ db, sources: buildSources(settings) })

serve({ fetch: app.fetch, port: settings.port, hostname: '127.0.0.1' }, ({ port }) => {
  console.log(`api on http://127.0.0.1:${port}/api`)
})
