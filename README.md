# Hotpress

A small static site generator for content sites, designed for agents to build on.

Hotpress does the generic, error-prone parts: loading and validating content, rendering JSX to HTML,
bundling assets, writing deterministic output, previewing it the way your host serves it, and
checking and publishing changes. Everything specific to your site (templates, URL scheme, hierarchy
rules, ads, analytics) is plain code in your repo, with no plugin system to fight.

- **Content from Markdown, MDX, CSV or JSON.** Every source becomes the same entry shape, validated by a schema. One bad
  entry fails the build, with the file and line.
- **JSX templates rendered straight to strings.** Typed props, escaping by default, no client runtime.
- **Zero JavaScript by default.** A component that needs browser code opts in with `<Script>`.
- **Deterministic builds.** The same checkout gives the same bytes. Dates come from content, never the clock.
- **`hotpress dev`** serves a production build with the host's rules (redirects, headers, 404).
- **`hotpress publish`** commits, builds that exact commit, checks links, SEO basics, removed URLs and
  stale dates, then pushes. Your host builds and deploys from there.
- **`hotpress diff`** compares two builds on everything search engines care about. Use it for
  migrations and upgrades.

## Quick start

```bash
npm install @benchadfield/hotpress
```

`hotpress.site.tsx`:

```tsx
import { defineSite, markdown, csv, s, sitemaps, robots, absoluteUrl } from "@benchadfield/hotpress";
import { Layout } from "./src/Layout.tsx";

export default defineSite({
  origin: "https://example.com",
  compat: "2026-10-29",
  async build(site) {
    const posts = await site.load(markdown("content/posts", {
      schema: { title: s.string(), date: s.date(), tags: s.array(s.string()).default([]) }
    }));
    const places = await site.load(csv("data/places.csv", {
      schema: { slug: s.slug(), name: s.string(), population: s.number().int() }
    }));

    for (const post of posts) {
      site.page(`/blog/${post.slug}/`, () => (
        <Layout title={post.data.title}>{post.body}</Layout>
      ), { updated: post.data.date });
    }
    for (const place of places) {
      site.page(`/places/${place.slug}/`, () => (
        <Layout title={place.data.name}><p>Population {place.data.population}</p></Layout>
      ));
    }

    const urls = site.pages.map((p) => ({ loc: absoluteUrl(site.origin, p.url), lastmod: p.meta.updated }));
    for (const [file, xml] of Object.entries(sitemaps("sitemap.xml", site.origin, urls))) site.file(file, xml);
    site.file("robots.txt", robots({ sitemaps: [`${site.origin}/sitemap.xml`] }));
  }
});
```

`package.json` scripts: `"dev": "hotpress dev"`, `"build": "hotpress build"`.
`tsconfig.json`: `"jsx": "react-jsx"`, `"jsxImportSource": "@benchadfield/hotpress"`, `"types": ["node", "@benchadfield/hotpress/client"]`.

## Content model

| Loader | Source | Entry |
|---|---|---|
| `markdown(dir, opts)` | `*.md` with YAML frontmatter | `data` = frontmatter, `body` = rendered HTML |
| `mdx(dir, opts)` | `*.mdx` (needs `@mdx-js/mdx`) | `data` = frontmatter, `Content` = component |
| `csv(file, opts)` | CSV with a header row | `data` = the row |
| `json(file, opts)` | JSON array | `data` = the record |

Each entry is `{ id, slug, data, body?, source }`. `schema` validates and coerces fields (`s.string()`,
`s.number()`, `s.date()`, `s.slug()`, `s.boolean()`, `s.enum()`, `s.array()`, `s.object()`,
`.optional()`, `.default()`). `transform` derives fields. Slugs must be unique.

Pages are whatever your `build` function adds: `site.page(url, render, meta)` for HTML and `site.file(path,
content)` for anything else. Helpers for common shapes:

- `tree(entries, levels)`: nested indexes (region → town → area), with `children`, `entries`, `parent` and
  `ancestors()` for breadcrumbs. A level key of `null` skips that level for an entry.
- `paginate(items, size, url)`, `related(item, items, values)`, `groupBy(items, values)` (taxonomies).
- `sitemaps()` (splits into an index above 45k URLs), `atom()`, `rss()`, `robots()`, `JsonLd`,
  `redirects()`, `headers()` (Netlify), `absoluteUrl()`.

Drafts, scheduling, ads and analytics are your code: see `examples/basic` and [AGENTS.md](AGENTS.md).

## Commands

| | |
|---|---|
| `hotpress dev [--port] [--third-party]` | Production build served like the host, rebuilt and reloaded on change |
| `hotpress build [--check]` | Build to `dist/` and report which pages changed; `--check` also runs every offline check and fails on any problem (use it as the CI build) |
| `hotpress serve [dir]` | Serve a build like the host |
| `hotpress check [--twice] [--json]` | Every pre-publish check |
| `hotpress publish -m "…" [--all] [--dry-run] [--json]` | Commit, build the commit cleanly, check, push |
| `hotpress diff <a> <b>` | Compare two builds: URLs, metadata, JSON-LD, sitemaps, feeds, redirects, status codes, links |

## Site tasks

Sites add their own pre-publish steps with `defineSite({ tasks: [...] })`. A task sees the built pages,
reports problems during `check`, and may update files during `check --fix` and `publish`. `publish` commits those
files with the change. See [AGENTS.md](AGENTS.md).

## Requirements

Node 22.12+. Runtime dependencies: esbuild, markdown-it, yaml, htmlparser2. Optional: `@mdx-js/mdx` for
MDX, `sharp` for images.

## License

MIT
