import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDiff, type DiffReport } from "../src/diff/index.ts";

const page = (o: { title?: string; desc?: string; canonical?: string; h1?: string; ld?: string; extra?: string; body?: string } = {}) => `<!doctype html>
<html><head>
<title>${o.title ?? "Home"}</title>
<meta name="description" content="${o.desc ?? "A site"}">
<link rel="canonical" href="${o.canonical ?? "https://example.com/"}">
<meta property="og:title" content="${o.title ?? "Home"}">
<script type="application/ld+json">${o.ld ?? '{"@type":"WebSite","name":"Example"}'}</script>
${o.extra ?? ""}
</head><body><svg><title>icon</title></svg><h1>${o.h1 ?? "Welcome"}</h1>${o.body ?? '<a href="/about/">About</a>'}</body></html>`;

const sitemap = (urls: [string, string][]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map(([loc, lastmod]) => `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`)
    .join("")}</urlset>`;

const BASE: Record<string, string> = {
  "index.html": page(),
  "about/index.html": page({ title: "About", canonical: "https://example.com/about/", h1: "About" }),
  "404.html": page({ title: "Not found", canonical: "https://example.com/404.html", h1: "Not found" }),
  "sitemap.xml": sitemap([
    ["https://example.com/", "2024-01-01"],
    ["https://example.com/about/", "2024-01-02"]
  ]),
  "robots.txt": "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n",
  "feed.xml": `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Example</title><entry><title>Post</title><content type="html">&lt;p&gt;Hi&lt;/p&gt;</content></entry></feed>`,
  _redirects: "/old /about/ 301\n",
  _headers: "/assets/*\n  Cache-Control: max-age=60\n"
};

async function site(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hotpress-diff-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), content);
  }
  return dir;
}

async function diffWith(changes: Record<string, string | null>): Promise<DiffReport> {
  const next: Record<string, string> = { ...BASE };
  for (const [file, content] of Object.entries(changes)) {
    if (content === null) delete next[file];
    else next[file] = content;
  }
  return runDiff({ baseline: await site(BASE), candidate: await site(next) });
}

const failures = (report: DiffReport, id: string) => report.sections.find((s) => s.id === id)!.failures;

test("identical outputs pass", async () => {
  const report = await diffWith({});
  assert.equal(report.ok, true);
  assert.deepEqual(report.origins, ["https://example.com"]);
});

test("missing and extra URLs are reported, including trailing-slash and casing changes", async () => {
  const report = await diffWith({ "about/index.html": null, "about.html": BASE["about/index.html"], "News/index.html": page() });
  const urls = failures(report, "urls").map((f) => `${f.message} ${f.url}`);
  assert.ok(urls.includes("missing in candidate /about/"));
  assert.ok(urls.includes("extra in candidate /about.html"));
  assert.ok(urls.includes("extra in candidate /News/"));
  assert.equal(report.ok, false);
});

test("each metadata field is compared", async () => {
  const report = await diffWith({
    "index.html": page({
      title: "Home!",
      desc: "Another",
      canonical: "https://example.com/index.html",
      h1: "Hello",
      ld: '{"name":"Example","@type":"Organization"}',
      extra: '<meta name="robots" content="noindex"><link rel="alternate" hreflang="en" href="https://example.com/">'
    })
  });
  const fields = new Set(failures(report, "pages").map((f) => f.field));
  for (const field of ["title", "description", "canonical", "h1", "jsonld", "robots", "hreflang", "social"]) assert.ok(fields.has(field), field);
});

test("JSON-LD key order and whitespace do not matter, values do", async () => {
  const same = await diffWith({ "index.html": page({ ld: '{ "name" : "Example",\n "@type": "WebSite" }' }) });
  assert.equal(failures(same, "pages").length, 0);
});

test("whitespace-only title changes are notes, not diffs", async () => {
  const report = await diffWith({ "index.html": page({ title: "\n  Home  \n" }) });
  assert.equal(report.ok, true);
  assert.equal(report.sections.find((s) => s.id === "pages")!.notes.length, 1);
  const strict = await runDiff({
    baseline: await site(BASE),
    candidate: await site({ ...BASE, "index.html": page({ title: "\n  Home  \n" }) }),
    strictWhitespace: true
  });
  assert.equal(strict.ok, false);
});

test("sitemap lastmod, missing entries and order are diffs", async () => {
  const report = await diffWith({
    "sitemap.xml": sitemap([
      ["https://example.com/about/", "2024-01-02"],
      ["https://example.com/", "2024-02-01"]
    ])
  });
  const messages = failures(report, "sitemaps").map((f) => f.message);
  assert.ok(messages.some((m) => m.startsWith("fields differ for https://example.com/")));
  assert.ok(messages.some((m) => m.startsWith("entry order differs")));
});

test("robots, feeds, redirects and headers changes are diffs", async () => {
  const report = await diffWith({
    "robots.txt": "User-agent: *\nDisallow: /\n",
    "feed.xml": BASE["feed.xml"].replace("Hi", "Hello"),
    _redirects: "/old /about/ 302\n",
    _headers: "/assets/*\n  Cache-Control: max-age=120\n"
  });
  assert.equal(failures(report, "robots").length, 1);
  assert.equal(failures(report, "feeds").length, 1);
  assert.equal(failures(report, "netlify").length, 2);
  assert.ok(failures(report, "status").some((f) => f.url === "/old"));
});

test("removing the 404 page changes status handling", async () => {
  const report = await diffWith({ "404.html": null });
  assert.ok(failures(report, "status").some((f) => f.url === "/404.html"));
});

test("new broken internal links fail; links broken in both are notes", async () => {
  const report = await diffWith({ "index.html": page({ body: '<a href="/missing/">x</a><a href="https://example.com/about">y</a><a href="https://other.com/nope">z</a>' }) });
  const links = failures(report, "links");
  assert.deepEqual(
    links.map((f) => f.candidate),
    ["/missing/ (404)"]
  );
});

test("<base href> is honoured when resolving relative links", async () => {
  const withBase = page({ extra: '<base href="/about/">', body: '<a href="humans.txt">h</a>' });
  const report = await runDiff({ baseline: await site({ ...BASE, "index.html": withBase }), candidate: await site({ ...BASE, "index.html": withBase }) });
  const notes = report.sections.find((s) => s.id === "links")!.notes;
  assert.ok(notes.some((n) => n.candidate === "/about/humans.txt (404)"));
});
