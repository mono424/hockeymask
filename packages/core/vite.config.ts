import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    name: '@hockeymask/core',
    environment: 'node',
    // `test:coverage` holds every mapping operator (record ops, predicates, collection nodes,
    // expectations) at 100%. The rest of the engine is covered by the worked-example tests.
    coverage: {
      provider: 'v8',
      include: [
        'src/mapping/ops/**',
        'src/mapping/nodes/**',
        'src/mapping/predicate.ts',
        'src/mapping/pipeline.ts',
        'src/mapping/expect.ts',
      ],
      thresholds: { 100: true },
    },
  },
  pack: { entry: ['src/index.ts'], dts: true, format: ['esm'], sourcemap: true },
})
