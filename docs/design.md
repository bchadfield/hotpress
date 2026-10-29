# Hotpress design

Hotpress is a small static-site core that sites, and the agents working on them, build on. The core
does the generic, error-prone work: loading and validating content, rendering, bundling, deterministic
output, previewing, checking and publishing. Everything specific to a site lives in that site's own code.

## Principles

1. **Small core, sites own the rest.** There's no plugin system because the site's own code is the
   extension point. Ad slots, taxonomies, hierarchy rules, scheduling and quirks are site code. Common
   patterns are recipes in `examples/` to copy, not engine features.
2. **Deterministic builds.** Same checkout, same bytes. A build reads only the checked-out files and the
   env vars the site chooses to read. No clock, no randomness, no mtimes, no git history, no network.
3. **Explicit dates.** Publish and update dates come from content or data, never from the build.
4. **What you preview is what ships.** `hotpress dev` serves a production build the way the host does.
5. **One bad entry fails the site build.** Better no update than one broken page.
6. **Errors are written for agents.** Every error says what is wrong, where (file, row, URL), and how
   to fix it. With `--json`, errors come out as structured objects with a stable `code`.

## Templating: JSX with a string runtime

Components are TypeScript functions returning HTML, compiled by esbuild against `hotpress/jsx-runtime`.
There is no virtual DOM and no hydration. Rendering is synchronous, so data is loaded before rendering.
- Text and attributes are escaped. Raw HTML needs `raw()` or `dangerouslySetInnerHTML`.
- `children` is the default slot. Named slots are typed props.
- `class` and `className` both work.
- `true` gives a bare boolean attribute; `false`, `null` and `undefined` omit it.
- `usePage()` gives the URL being rendered and the mode (`build` / `preview`).
- MDX compiles against the same runtime (optional peer `@mdx-js/mdx`).

Reasons: types for props and children, escaping by default, one component system for pages and MDX,
and Astro templates port almost line for line.

## The site module

A site is one TypeScript module whose `build` function says what exists. It's code, not a
declarative config, so a site can do anything without the engine knowing about it.

```tsx
// hotpress.site.tsx
import { defineSite, markdown, csv, s, sitemap, robots } from "@benchadfield/hotpress";
import { Post, Home, Area } from "./src/templates";

export default defineSite({
  origin: "https://example.com",
  compat: "2026-10-29",                       // pins output defaults; see "Upgrades"
  async build(site) {
    const posts = await site.load(markdown("src/posts", {
      schema: { title: s.string(), date: s.date(), tags: s.array(s.string()).default([]) }
    }));
    const areas = await site.load(csv("data/areas.csv", {
      schema: { slug: s.slug(), name: s.string(), price: s.number().optional() }
    }));

    for (const post of posts) site.page(`/blog/${post.slug}/`, <Post post={post} />, { updated: post.data.date });
    for (const area of areas) site.page(`/area/${area.data.slug}/`, <Area area={area} />);
    site.page("/", <Home posts={posts} />);

    site.file("sitemap.xml", sitemap(site.origin, site.pages));
    site.file("robots.txt", robots({ sitemap: `${site.origin}/sitemap.xml` }));
  }
});
```

- **Entries** look the same whatever the source: `{ id, slug, data, body?, source }`. `data` holds the validated
  fields, and Markdown and MDX entries also have a `body`. The page template decides how an entry renders,
  whether it came from a Markdown file or a CSV row.
- **Loaders** in core: `markdown()` (frontmatter + Markdown), `mdx()`, `csv()`, `json()`. Each takes a
  `schema` and an optional `transform(fields, ctx)`, and each error carries the file and row.
- **Schema** (`s.*`) is a small builder with type inference: string, number, boolean, date, slug, enum,
  array, object, `.optional()`, `.default()`. All errors are collected and the build fails once.
- **Pages and files.** `site.page(url, element, meta?)` and `site.file(path, string | Buffer)`. URLs
  must be unique. `meta` carries `published`/`updated` dates for the change report and the sitemap helper.
- **Helpers** (plain functions, optional): `tree()` (group entries into levels, giving nodes with
  parent, children and breadcrumbs; a key of `null` skips a level), `paginate()`, `related()`,
  `sitemap()` (splits into an index above 45k URLs), `atom()`, `rss()`, `robots()`, `jsonLd()`,
  `absoluteUrl()`, `redirects()`/`headers()` for Netlify files.

## Assets and client JS

- **CSS.** `site.css("src/styles/main.css", { transform? })` bundles with esbuild. The transform hook is
  where a site runs PostCSS or Tailwind. It returns the public URL to link.
- **No client JS by default.** A component that needs browser code imports a browser module with a `?client`
  suffix and renders `<Script src={handle} />`. Only pages that render it get the script, bundled and
  deduplicated. Interactive pieces use progressive enhancement: the HTML is complete without JS, and
  the script adds behaviour. Charts should be SVG rendered at build time (a recipe), not client-side.
- **Images.** `<Image>` produces a `srcset` with AVIF, WebP and the original format via sharp (optional peer),
  cached by content hash.
- **Asset names** are `[name].[hash]` by default and configurable, so a migrated site can keep its old URLs.
- `public/` is copied as it is.

## Build pipeline

1. Bundle the site module with esbuild (TSX, MDX, JSON, tsconfig paths) and import it.
2. Run `build(site)`: loaders parse, validate and transform (cached by content hash), and the site adds
   pages and files. Any error stops the build here.
3. Check that URLs are unique, bundle CSS and client scripts, render every page, and process images.
4. Write `dist/` deterministically: only changed files are rewritten, files for removed URLs are deleted,
   and `build-manifest.json` (URL → content hash and dates) goes in the cache.
5. **Change report**: compare with the previous manifest (pages added, removed and changed) and flag
   pages whose content changed while their `updated` date didn't.

Every build is a full build. Determinism plus content hashes mean that Netlify, and diffs between builds,
only see files that really changed, and nothing can go stale. Expensive steps (MDX compiling, image
processing) are cached by content hash. If the dev loop is ever slow, add something then, once it's
been measured.

**Determinism guarantees**:
- The CLI runs with `TZ=UTC`.
- It warns if the Node version doesn't match the site's `.nvmrc`/`engines`, because ICU data changes sort
  order and `Intl` output.
- Core never reads the clock.
- Output order is the order the site added pages.
- `hotpress check --twice` builds twice and compares the outputs.

## Commands

| Command | What it does |
|---|---|
| `hotpress dev` | Production build into `dist/`, served like the host (see below). Rebuilds and reloads on change |
| `hotpress build` | Production build plus the change report |
| `hotpress serve [dir]` | Serve an existing build like the host |
| `hotpress check` | Every pre-publish check, no git (below) |
| `hotpress publish -m "…"` | `check`, then commit and push |
| `hotpress diff <a> <b>` | Parity checker (migrations, engine upgrades) |
| `hotpress init` | New site from the example, with `compat` set to today |

**Preview** (`dev`, `serve`) uses the host simulator from the parity checker: `x/index.html`, a 301 from
`/x` to `/x/`, `_redirects`, `_headers`, and `404.html` with status 404. The only differences from
production: a live-reload script injected when the page is served, and `usePage().mode === "preview"`, which
site components use to leave out analytics and ads (the recipe does this).

## `hotpress check` and `hotpress publish`

`publish` is the only path to production: it's how an agent, or you, ships a content change.

1. **Git preflight.** You're on the publish branch (default `main`), up to date with the remote after a
   fetch, and `dist/` and the cache aren't tracked.
2. **Commit locally**, using the agent's message. It includes only staged changes, or everything with `--all`.
3. **Build from the commit, not the working tree.** A temporary worktree is checked out at the new commit, with
   `node_modules` linked if the lockfile hasn't changed, and built there. This catches files you
   forgot to add, inputs you rely on that are gitignored, and filename casing problems. What gets
   checked is exactly what the host will build.
4. **Checks**, each with an error code:
   - `build`: the build fails (schema, transform, duplicate URL).
   - `url-removed`: a URL in the live sitemap (fetched over the network; publishing isn't hermetic,
     builds are) or in the last published manifest is gone and has no redirect.
   - `link-broken`: an internal link, canonical or `og:image` doesn't resolve.
   - `date-stale`: content changed but `updated` didn't.
   - `seo`: a missing title, description or canonical, or a canonical pointing elsewhere (rules the site can change).
   - `nondeterministic`: with `--twice`, the two builds differ.
5. **Result.** If anything fails, the local commit is undone (`reset --soft`, so your changes are kept) and the
   errors are printed. With `--json` they're structured for the agent, which fixes the problem or asks you. Warnings can be
   accepted explicitly and individually (`--allow url-removed:/old-page/`), never all at once.
   If everything passes, it pushes and prints the change report as a summary.

`check` runs steps 3–4 against the working tree with no commit, so agents can iterate before publishing.

**Site tasks** are how a site adds its own steps without the engine knowing about them: `defineSite({ tasks })`.
Each task gets the built pages (URL, meta, HTML, main-content text), `today` and a `fix` flag. `check` runs
them report-only. `check --fix` and `publish` let them write files, and publish amends those into the commit
and re-checks the final commit from scratch. Example: a sitemap dates file that records each data page's
main-content hash and the date it last changed.

## Upgrades: pinned output

The lockfile pins the engine version. On top of that, `compat` (a date, written by `init`) fixes the defaults that shape output: escaping, whitespace and the
formatting helpers. A new engine version keeps old behaviour for old `compat` dates, so upgrading
never changes a site's HTML until the site bumps `compat`. Releases are gated on a parity diff of every
example and fixture, and any change to output without a compat flag is a major version.

## Parity checker

`hotpress diff <baseline> <candidate>` compares the URL set, per-page SEO tags, sitemaps, robots, feeds,
`_redirects`/`_headers`, status codes and internal links. An informational section compares the visible text of
each page's main content, to support visual QA. Its report is the source of truth for migrations.

## Package layout

```
src/jsx/      runtime, escaping, usePage
src/content/  loaders (markdown, mdx, csv, json), schema, tree/paginate/related
src/seo/      sitemap, feeds, robots, jsonLd, netlify files
src/build/    site loader, assets, scripts, images, render, writer, manifest, change report
src/preview/  dev + serve
src/publish/  check + publish
src/diff/     parity checker
examples/     a basic site (also the test fixture) and recipes (charts, ads, scheduling, hierarchy pages)
AGENTS.md     how to build a site on Hotpress, for coding agents
```

Runtime dependencies: `esbuild`, `markdown-it`, `yaml`, `htmlparser2`. Optional peers: `@mdx-js/mdx`, `sharp`.
