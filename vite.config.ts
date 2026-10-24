import { defineConfig } from 'vite-plus'

// Workspace-wide lint, format and test settings. `vp check` = fmt + lint + type-check.
export default defineConfig({
  lint: {
    plugins: ['typescript', 'unicorn', 'oxc', 'import'],
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ['**/dist/**', '**/drizzle/**', '.data/**'],
    // Mapping documents use `then` keys (`when` cases, `if_*` sugar); they are data, never awaited.
    rules: { 'unicorn/no-thenable': 'off' },
    overrides: [{ files: ['packages/react/**', 'apps/web/**'], plugins: ['react'] }],
  },
  fmt: {
    singleQuote: true,
    semi: false,
    printWidth: 100,
    ignorePatterns: ['**/dist/**', '**/drizzle/**', 'pnpm-lock.yaml'],
  },
  test: {
    projects: ['packages/*', 'apps/*', 'tests/*'],
  },
})
