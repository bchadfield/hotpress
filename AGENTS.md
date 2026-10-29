# Building sites on Hotpress (for coding agents)

Hotpress is a deliberately small core. **Put site-specific behaviour in the site's own code. Don't look
for engine options.** If a site needs something the API doesn't offer, write it in the site.

## Mental model

1. `hotpress.site.tsx` exports `defineSite({ origin, compat, check?, build })`.
2. `build(site)` loads entries (`await site.load(markdown(...))`), then calls `site.page(url, render, meta)`
   and `site.file(path, content)` for everything that should exist. Nothing else is generated.
3. `render` is a function returning JSX. It runs later, during rendering, where `usePage()` gives the page's URL,
   absolute `href`, `origin` and `mode` (`"build"` or `"preview"`).
4. Rendering is **synchronous**: load and compute data in `build`, then pass it to components as props.
   An `async` component throws.

## Rules that keep sites correct

- **URLs** end in `/` (`/blog/x/` → `blog/x/index.html`) or a file extension (`/404.html`). Duplicates
  fail the build.
- **Dates are explicit.** Pass `meta.updated` (and `published`) from content or data fields. Never use
  `new Date()` or file mtimes: builds must be deterministic. `hotpress check --twice` proves it.
- **When a page's main content changes, update its date.** `publish` blocks with `date-stale` otherwise.
  For data-driven pages, use the data export date, or a constant you bump when the template changes
  materially.
- **URLs must never disappear silently.** If a page goes, add a redirect (`redirects()` → `_redirects`)
  or explicitly allow `url-removed:/path/`.
- **Escaping**: text and attributes are escaped. Use `raw(html)` only for trusted HTML (rendered
  Markdown is already `Html`). JSON-LD: `<JsonLd data={...} />`.
- **Third-party scripts** (analytics, ads): render them only when `usePage().mode === "build"`, so local
  previews don't send traffic.
- **Client JS**: put browser code in a `.ts` file, import it with a `?client` suffix (`import filter from "./filter.ts?client"`), render `<Script src={filter} />` in the
  component that needs it. The HTML must work without it (progressive enhancement).

## Recipes (see `examples/basic/hotpress.site.tsx`)

- **Drafts**: `s.boolean().default(false)` in the schema, then filter with `entries.filter(e => !e.data.draft)`.
- **Scheduled posts**: filter by date against a date you pass in (for example from an env var the CI sets).
  Don't read the clock in templates.
- **Nested indexes**: `tree(entries, [{ name: "region", key: e => e.data.region }, ...])`, then
  `site.page()` for `tree.root`, every `tree.nodes` entry and every leaf. Build breadcrumbs from `ancestors(node)`.
- **Taxonomies**: `groupBy(posts, p => p.data.tags)` plus `paginate()`.
- **Sitemaps**: map `site.pages` (skip `meta.noindex`) to `{ loc, lastmod }` and pass them to `sitemaps()`.
- **Charts**: render SVG at build time in a component. No client chart library needed.
- **Ad slots by page type**: pass `meta.type` and decide in the layout, e.g.
  `<article class={adsEnabled(type) ? "ad-zone prose" : "prose"}>`.

## Site tasks (your own pre-publish steps)

Anything a site needs checked or updated before publishing, such as a dates file, a generated index or a
content rule, is a task in the site module, not an engine feature:

```ts
defineSite({
  tasks: [{
    name: "lastmod",
    run(ctx) {            // ctx.pages: url, meta, html(), mainText(); ctx.today; ctx.fix
      if (upToDate) return;
      if (!ctx.fix) return { problems: [{ code: "lastmod-stale", message: "…", hint: "hotpress check --fix" }] };
      writeFileSync(join(ctx.root, "src/data/lastmod.tsv"), next);
      return { changed: ["src/data/lastmod.tsv"] };
    }
  }],
  …
});
```

- `hotpress check` runs tasks report-only (`ctx.fix` false). A task must not write files then.
- `hotpress check --fix` and `hotpress publish` run them with `ctx.fix` true. `publish` adds the changed
  files to the commit, rebuilds that commit from scratch, and checks again before pushing.
- To stop the host deploying anything that skipped `publish`, make the site's build script
  `hotpress build --check`: it runs the checks and the site's tasks report-only, and fails the build on any
  problem, so the previous deploy stays live.
- Use `ctx.today` (the publish date), never the clock. Builds read the files tasks write, so builds stay
  deterministic.

## Workflow

```bash
npm run dev                         # preview (production build, host rules, live reload; never writes dist/)
npx hotpress check --json           # what would block a publish, as structured problems
npx hotpress publish -m "Add post about X" --all --json
```

`publish` exits non-zero with `problems: [{ code, message, url?, file?, line?, field?, hint? }]`.
Codes: `schema`, `transform`, `csv`, `frontmatter`, `compile`, `render`, `site-code`, `duplicate-url`,
`bad-url`, `link-broken`, `seo`, `url-removed`, `date-stale`, `nondeterministic`, `git-*`,
`nothing-to-publish`. Fix the cause and run it again. Known, accepted issues go in the site's
`check.allow` (`"code:glob"`) with a comment saying why. Don't add them silently.

## Migrating a site

1. Build the old site and keep its output as the baseline.
2. Port templates to TSX and wire `build`.
3. `npx hotpress diff <baseline> dist` until it reports zero diffs. Pass `--ignore "/_astro/**"` for
   bundler-hashed asset directories that can't be reproduced.
