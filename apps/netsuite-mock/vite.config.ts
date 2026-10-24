import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: { name: 'netsuite-mock', environment: 'node' },
})
