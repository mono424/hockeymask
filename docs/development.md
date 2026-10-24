# Development

Repository layout, local tooling, and implementation notes.

## Layout

```
packages/
  core/           @hockeymask/core   logic: schema types, the connector contract, mapping engine
  react/          @hockeymask/react  UI: React Flow graph builder built on core
  sample-data/    demo data (private): deterministic dataset for a fictional retailer
apps/
  netsuite-mock/  :8101  sample ERP: SuiteQL + metadata catalog over the dataset (DuckDB)
  snowflake-mock/ :8102  sample warehouse: Snowflake SQL API v2 over the dataset (DuckDB)
  api/            :8000  Hono + Drizzle on PGlite: target model, NetSuite/Snowflake connectors,
                         discovery, saved mappings
  web/            :5173  React demo app: sources, target model, graph builder, testbench
  landing/        :4321  static Astro site
tests/e2e/        the whole stack in-process
```

The toolkit is the two `@hockeymask/*` packages. `core` depends on nothing in this repo;
`react` depends only on `core`. Everything under `apps/` and `packages/sample-data` is demo.

The sample data describes Acme Outdoor, a fictional outdoor-gear retailer: items, locations,
vendors and classes in the ERP, and daily stock per item, location and bin in the warehouse.
It is generated deterministically from a seed (`SAMPLE_SEED`, `SAMPLE_SCALE`) and includes
the usual dirt: blank UPCs, mixed weight units, zero or negative dimensions, inactive records.

## Run

Requirements: Node ≥ 22.18, pnpm 10.

```bash
pnpm install
pnpm dev          # all services (vp run -r --parallel dev)
```

Open <http://localhost:5173>. On first start each demo source builds its dataset into
`.data/` (a few seconds); the API keeps its PGlite database there too. Nothing to download
or seed.

## Toolchain

[Vite+](https://viteplus.dev) (`vp`): Vite, Vitest, Oxlint (type-aware, with type-checking
via TypeScript 7) and Oxfmt in one CLI, configured in [`vite.config.ts`](../vite.config.ts).

```bash
pnpm test         # vp test: every workspace project
pnpm check        # vp check: format + lint + type-check
pnpm fmt          # vp fmt
pnpm build        # vp run -r build (libraries via vp pack, web via vp build)
```

Every operator file in core is held at 100% test coverage
(`pnpm --filter @hockeymask/core test:coverage`).

## Notes

- Core defines only the `Connector` contract; the demo's NetSuite and Snowflake clients live
  in [`apps/api/src/connectors`](../apps/api/src/connectors), since each host reaches its own
  systems. Connectors decode wire formats (numbers as strings, account-formatted dates, epoch
  days) but never interpret values: checkboxes stay `'T'`/`'F'`.
- The target model is defined by the Drizzle tables in
  [`apps/api/src/db/schema.ts`](../apps/api/src/db/schema.ts) and derived into a core
  `TargetSchema` by [`target.ts`](../apps/api/src/target.ts). Imported entities carry the
  identity triple `(source_system, source_id, secondary_source_id)`, unique per company.
- A mapping is a versioned JSON document whose nodes reference their inputs by id (see
  [`arch.md`](../arch.md); every operator is listed in [`operators.md`](operators.md)).
  `canConnect` in core is the single rule book for edges in the builder; `checkVersion`
  (types, structure, fixtures) is what the API reports on save.
- Engine decisions worth knowing: `if_after` needs `to_date` first (a format is not a type);
  a filter with `{ path, is_null: false }` narrows that field to non-null; sink keys must be
  non-null, except a nullable identity field of an entity whose identity is
  `NULLS NOT DISTINCT` (`nullsNotDistinct` on the target entity); null join keys never match;
  only `union` and `distinct` dedupe; fixtures and the testbench skip `count` envelopes;
  `unnest` is not built yet.
- The agent panel runs on the developer's own Claude Code through the Claude Agent SDK (no
  API key). Its tools live in the page ([`lib/agent/tools.ts`](../apps/web/src/lib/agent/tools.ts)):
  the API relays each call to the browser and the answer back to Claude, so the agent works
  on the same mapping list, drafts and testbench the user sees, and every message carries
  a description of what is on screen. Agent edits stay unsaved drafts until the user saves.

## Landing page

The static Astro site lives in [`apps/landing`](../apps/landing/README.md). Run
`pnpm --filter @hockeymask/landing dev` to preview it on port 4321. A Pages workflow builds
and deploys it separately from the demo stack.
