import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: { name: 'snowflake-mock', environment: 'node' },
})
