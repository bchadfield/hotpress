import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "../src/build/build.ts";
import { runDiff } from "../src/diff/index.ts";

const EXAMPLE = new URL("../examples/basic/", import.meta.url).pathname;
// Inside the package so the example's `import "@benchadfield/hotpress"` resolves to this checkout.
const TMP = new URL("./.tmp/", import.meta.url).pathname;

async function copyExample(): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, "site-"));
  await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  return dir;
}

const read = (dir: string, file: string) => readFile(join(dir, "dist", file), "utf8");

test("example site builds the expected pages", async () => {
  const dir = await copyExample();
  const result = await build({ root: dir, log: false });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const urls = result.pages.map((p) => p.url).sort();
  assert.deepEqual(urls, [
    "/",
    "/404.html",
    "/blog/",
    "/blog/hello-world/",
    "/blog/second-post/",
    "/notes/welcome/",
    "/places/",
    "/places/north/",
    "/places/north/ashford/",
    "/places/north/ashford/old-quarter/",
    "/places/north/millbrook/",
    "/places/north/millbrook/hilltop/",
    "/places/north/millbrook/riverside/",
    "/places/south/",
    "/places/south/saltby/",
    "/places/south/saltby/harbour/",
    "/tags/meta/",
    "/tags/news/"
  ]);
  // Drafts are filtered by site code.
  assert.equal(urls.includes("/blog/unfinished/"), false);
  // CSV rows render through templates, with breadcrumbs from the hierarchy.
  const harbour = await read(dir, "places/south/saltby/harbour/index.html");
  assert.match(harbour, /<h1>Harbour<\/h1>/);
  assert.match(harbour, /Fishing boats, cafés and a ferry, &quot;weather permitting&quot;|Fishing boats, cafés and a ferry, "weather permitting"/);
  assert.match(harbour, /"name":"Saltby","item":"https:\/\/example.com\/places\/south\/saltby\/"/);
  // Zero JS by default: the client script only appears where a component asked for it.
  assert.match(await read(dir, "places/index.html"), /<script type="module" src="\/assets\/js\/filter\.[A-Z0-9]+\.js"><\/script>/);
  assert.doesNotMatch(harbour, /type="module"/);
  // Sitemap uses explicit dates only.
  const sitemap = await read(dir, "sitemap.xml");
  assert.match(sitemap, /<loc>https:\/\/example.com\/blog\/second-post\/<\/loc>\s*<lastmod>2024-02-03<\/lastmod>/);
  assert.match(sitemap, /<loc>https:\/\/example.com\/places\/south\/<\/loc>\s*<lastmod>2024-02-15<\/lastmod>/);
  assert.doesNotMatch(sitemap, /404\.html/);
  assert.match(await read(dir, "feed.xml"), /<entry>\s*<title>Second post<\/title>/);
  // MDX: Markdown inside a site component, rendered with the same JSX runtime.
  assert.match(await read(dir, "notes/welcome/index.html"), /<h1>Notes can use components<\/h1>\s*<aside class="callout callout-info">Plain <strong>Markdown<\/strong> inside a component.<\/aside>/);
  assert.equal(await read(dir, "favicon.svg"), await readFile(join(EXAMPLE, "public/favicon.svg"), "utf8"));
});

test("preview mode differs only where the site checks usePage().mode", async () => {
  const dir = await copyExample();
  await build({ root: dir, log: false });
  const prod = await read(dir, "blog/hello-world/index.html");
  await build({ root: dir, log: false, mode: "preview" });
  const preview = await read(dir, "blog/hello-world/index.html");
  assert.match(prod, /analytics\.example\.com/);
  assert.doesNotMatch(preview, /analytics\.example\.com/);
  assert.equal(preview, prod.replace('<script defer src="https://analytics.example.com/script.js"></script>', ""));
});

test("builds are deterministic", async () => {
  const a = await copyExample();
  const b = await copyExample();
  await build({ root: a, log: false });
  await build({ root: b, log: false });
  const report = await runDiff({ baseline: join(a, "dist"), candidate: join(b, "dist") });
  assert.equal(report.ok, true);
  assert.equal(report.sections.find((s) => s.id === "files")!.notes.length, 0, "every file byte-identical");
});

test("change report lists what changed; removed pages are deleted", async () => {
  const dir = await copyExample();
  await build({ root: dir, log: false });
  const post = join(dir, "content/posts/2024-02-01-second-post.md");
  await writeFile(post, (await readFile(post, "utf8")).replace("Some text", "Some edited text"));
  await rm(join(dir, "content/posts/2024-01-10-hello-world.md"));
  const result = await build({ root: dir, log: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.report!.removed, ["/blog/hello-world/", "/tags/meta/"]);
  assert.ok(result.report!.changed.includes("/blog/second-post/"));
  assert.ok(result.report!.files.includes("feed.xml"));
  assert.equal(existsSync(join(dir, "dist/blog/hello-world/index.html")), false);
  assert.equal(existsSync(join(dir, "dist/blog/hello-world")), false, "empty directories are removed");
  // A rebuild with no changes reports nothing changed.
  const again = await build({ root: dir, log: false });
  assert.deepEqual([again.report!.changed, again.report!.added, again.report!.removed, again.report!.files], [[], [], [], []]);
});

test("one invalid row fails the whole build with file and line", async () => {
  const dir = await copyExample();
  await build({ root: dir, log: false });
  const before = await readdir(join(dir, "dist"));
  const csvPath = join(dir, "data/places.csv");
  await writeFile(csvPath, (await readFile(csvPath, "utf8")) + 'Bad Slug,Bad,Town,Region,lots,"x"\n');
  const result = await build({ root: dir, log: false });
  assert.equal(result.ok, false);
  const codes = result.problems.map((p) => `${p.code} ${p.file}:${p.line} ${p.field}`);
  assert.deepEqual(codes, ["schema data/places.csv:6 slug", "schema data/places.csv:6 population"]);
  assert.deepEqual(await readdir(join(dir, "dist")), before, "a failed build leaves the previous output untouched");
});

test("duplicate URLs and bad URLs are build errors", async () => {
  const dir = await copyExample();
  const sitePath = join(dir, "hotpress.site.tsx");
  const source = await readFile(sitePath, "utf8");
  await writeFile(sitePath, source.replace('site.page("/404.html"', 'site.page("/blog/", () => <NotFound />);\n    site.page("/oops", () => <NotFound />);\n    site.page("/404.html"'));
  const result = await build({ root: dir, log: false });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.problems.map((p) => p.code),
    ["duplicate-url", "bad-url"]
  );
});

test("compile errors point at the file and line", async () => {
  const dir = await copyExample();
  await writeFile(join(dir, "src/Broken.tsx"), "export const x = <div>;\n");
  const sitePath = join(dir, "hotpress.site.tsx");
  await writeFile(sitePath, `import "./src/Broken.tsx";\n${await readFile(sitePath, "utf8")}`);
  const result = await build({ root: dir, log: false });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, "compile");
  assert.equal(result.problems[0].file, "src/Broken.tsx");
});

test("module-level state in site code does not survive into the next build", async () => {
  const dir = await copyExample();
  const sitePath = join(dir, "hotpress.site.tsx");
  // A cache that would go stale if the same module instance were reused.
  await writeFile(
    sitePath,
    (await readFile(sitePath, "utf8")).replace("export default defineSite({", 'let cachedTitle: string | undefined;\nexport default defineSite({').replace(
      'site.page("/404.html", () => <NotFound />, { noindex: true });',
      'cachedTitle ??= all[0].data.title;\n    site.file("first-title.txt", cachedTitle);\n    site.page("/404.html", () => <NotFound />, { noindex: true });'
    )
  );
  await build({ root: dir, log: false });
  assert.equal(await read(dir, "first-title.txt"), "Hello, world");
  const post = join(dir, "content/posts/2024-01-10-hello-world.md");
  await writeFile(post, (await readFile(post, "utf8")).replace("title: Hello, world", "title: Hello again"));
  await build({ root: dir, log: false });
  assert.equal(await read(dir, "first-title.txt"), "Hello again");
});

test("the out dir can never be the site, hold its sources, or be someone else's folder", async () => {
  const dir = await copyExample();
  for (const [outDir, message] of [
    [".", /contains the site itself/],
    ["..", /contains the site itself/],
    ["content", /contains content\/posts\/.+, which the build reads/],
    ["public", /overlaps the public dir/]
  ] as const) {
    const result = await build({ root: dir, outDir, log: false });
    assert.equal(result.ok, false, outDir);
    assert.equal(result.problems[0].code, "bad-out-dir");
    assert.match(result.problems[0].message, message);
  }
  assert.ok(existsSync(join(dir, "hotpress.site.tsx")) && existsSync(join(dir, "content/posts")), "nothing was deleted");
  // A non-empty folder outside the site that no build wrote is left alone.
  const elsewhere = await mkdtemp(join(TMP, "elsewhere-"));
  await writeFile(join(elsewhere, "notes.txt"), "mine");
  const outside = await build({ root: dir, outDir: elsewhere, log: false });
  assert.equal(outside.problems[0]?.code, "bad-out-dir");
  assert.equal(await readFile(join(elsewhere, "notes.txt"), "utf8"), "mine");
  await rm(elsewhere, { recursive: true });
});

test("file paths cannot leave the out dir", async () => {
  const dir = await copyExample();
  const sitePath = join(dir, "hotpress.site.tsx");
  await writeFile(sitePath, (await readFile(sitePath, "utf8")).replace('site.file("robots.txt"', 'site.file("../escape.txt", "x");\n    site.file("robots.txt"'));
  const result = await build({ root: dir, log: false });
  assert.deepEqual(result.problems.map((p) => p.code), ["bad-url"]);
  assert.equal(existsSync(join(dir, "escape.txt")), false);
});

test("stylesheets bundle the fonts and images they reference; root-relative urls are left alone", async () => {
  const dir = await copyExample();
  await mkdir(join(dir, "styles/fonts"), { recursive: true });
  await writeFile(join(dir, "styles/fonts/body.woff2"), "font");
  await writeFile(join(dir, "styles/main.css"), "@font-face{font-family:b;src:url(./fonts/body.woff2)}\nbody{background:url(/favicon.svg)}\n");
  const result = await build({ root: dir, log: false });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const font = result.assets.find((f) => f.endsWith(".woff2"))!;
  assert.match(font, /^assets\/body\.[A-Z0-9]+\.woff2$/);
  assert.equal(await read(dir, font), "font");
  const css = await read(dir, result.assets.find((f) => f.endsWith(".css"))!);
  assert.ok(css.includes(`"/${font}"`) && css.includes("url(/favicon.svg)"), css);
});

test("nested index files take their folder's slug; JSON problems name the record", async () => {
  const dir = await copyExample();
  await mkdir(join(dir, "content/guides/setup"), { recursive: true });
  await mkdir(join(dir, "content/guides/deploy"), { recursive: true });
  await writeFile(join(dir, "content/guides/setup/index.md"), "---\ntitle: Setup\n---\nx\n");
  await writeFile(join(dir, "content/guides/deploy/index.md"), "---\ntitle: Deploy\n---\nx\n");
  await writeFile(join(dir, "data/items.json"), JSON.stringify([{ slug: "a", n: 1 }, { slug: "b", n: "many" }]));
  const sitePath = join(dir, "hotpress.site.tsx");
  await writeFile(
    sitePath,
    (await readFile(sitePath, "utf8")).replace(
      'site.page("/404.html"',
      `const guides = await site.load(markdown("content/guides"));
    site.file("guides.txt", guides.map((g) => g.slug).join(","));
    await site.load(json("data/items.json", { schema: { slug: s.slug(), n: s.number() } }));
    site.page("/404.html"`
    ).replace("import { absoluteUrl,", "import { json, absoluteUrl,")
  );
  const result = await build({ root: dir, log: false });
  assert.deepEqual(result.problems.map((p) => `${p.code} ${p.file} ${p.line} ${p.field}`), ["schema data/items.json undefined [1].n"]);
  await writeFile(join(dir, "data/items.json"), JSON.stringify([{ slug: "a", n: 1 }]));
  assert.equal((await build({ root: dir, log: false })).ok, true);
  assert.equal(await read(dir, "guides.txt"), "deploy,setup");
});
