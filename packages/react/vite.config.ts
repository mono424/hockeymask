import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [react()],
  test: { name: '@hockeymask/react', environment: 'jsdom' },
  pack: {
    entry: ['src/index.ts'],
    dts: true,
    format: ['esm'],
    sourcemap: true,
    copy: [{ from: 'src/styles.css', to: 'dist' }],
  },
})
