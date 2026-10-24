import { defineConfig } from 'astro/config'

// The Pages workflow supplies the actual origin and repository base path.
export default defineConfig({
  site: process.env.SITE_URL || 'http://localhost:4321',
  base: process.env.BASE_PATH || '/',
  output: 'static',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
})
