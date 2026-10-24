# Hockeymask landing page

A static Astro 7.3.5 site. This was the latest stable version published on npm when created on 2026-10-04. Fonts are bundled locally; no frontend framework or backend is required.

From the repository root:

```sh
pnpm install
pnpm --filter @hockeymask/landing dev
pnpm --filter @hockeymask/landing check
pnpm --filter @hockeymask/landing build
```

Local preview: http://localhost:4321. Build output: `apps/landing/dist`.

Content follows [`arch.md`](../../arch.md): typed collection graphs, per-field pipelines, source contracts, output expectations, and versioned mappings. The clickable books/authors graph illustrates source, join, map, and sink nodes. The input/output switch demonstrates the documented kilograms-to-grams field pipeline with a fixed browser-side fixture. The copyable JSON is a map-node excerpt from the architecture, not a complete mapping document or an executable SDK example. Planned compiler, execution, and contract capabilities are distinguished from the available schema types, connectors, and graph builder.

## GitHub Pages

1. Push the repository to GitHub.
2. Under Settings > Pages, choose **GitHub Actions** as the source.
3. Run the **Deploy landing page** workflow, or push a landing-page change to `main`.

The workflow gets the domain and repository base path from `actions/configure-pages`, builds the site, and deploys only `apps/landing/dist`. No repository owner or domain is hard-coded. The GitHub links are enabled when `PUBLIC_REPOSITORY_URL` is set; local development links to the on-page developer section instead.

For a local project-path check:

```sh
SITE_URL=https://example.github.io BASE_PATH=/hockeymask/ pnpm --filter @hockeymask/landing build
pnpm --filter @hockeymask/landing preview
```

For a custom domain, configure it in GitHub Pages first. The workflow will use that domain and its base path on the next deployment.

Brand assets are saved in `public/`. The monochrome mask is displayed in white on the dark page with CSS, preserving its source shape.
