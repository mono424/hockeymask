import { serve } from '@hono/node-server'
import { createApp } from './app'
import { settingsFromEnv } from './settings'

const settings = settingsFromEnv()
const app = await createApp(settings)
serve({ fetch: app.fetch, hostname: settings.host, port: settings.port }, (info) => {
  console.log(`netsuite-mock on http://${settings.host}:${info.port}`)
})
