import { test } from "node:test";
import assert from "node:assert/strict";
import { jsx, Fragment, raw, render } from "../src/jsx/runtime.ts";
import { withPage, usePage } from "../src/jsx/context.ts";
import { s, validate } from "../src/content/schema.ts";
import { parseCsv, parseCsvRows } from "../src/content/csv.ts";
import { parseFrontmatter } from "../src/content/frontmatter.ts";
import { tree, ancestors, paginate, related, groupBy } from "../src/content/helpers.ts";
import { absoluteUrl, atom, jsonLdString, robots, sitemaps, absolutizeHtml, redirects, headers } from "../src/seo/index.ts";
import { urlToFile } from "../src/build/site.ts";

test("jsx escapes text and attributes, keeps raw html", () => {
  const html = render(jsx("p", { title: 'a "b" & c', children: ["<b>x</b>", raw("<i>y</i>")] }));
  assert.equal(html, '<p title="a &quot;b&quot; &amp; c">&lt;b&gt;x&lt;/b&gt;<i>y</i></p>');
});

test("jsx attributes: booleans, class lists, style objects, aliases, void elements", () => {
  assert.equal(render(jsx("input", { disabled: true, hidden: false, value: undefined, className: "a" })), '<input disabled class="a">');
  assert.equal(render(jsx("div", { class: ["a", false, "b"], style: { fontSize: "2px", "--x": 1 } })), '<div class="a b" style="font-size:2px;--x:1"></div>');
  assert.equal(render(jsx("label", { htmlFor: "x", children: "L" })), '<label for="x">L</label>');
});

test("jsx components, fragments and children", () => {
  const Card = (p: { title: string; children?: unknown }) => jsx("li", { children: [p.title, p.children] });
  const out = render(jsx(Fragment, { children: [jsx(Card, { title: "A", children: jsx("b", { children: 1 }) }), null, false, 0] }));
  assert.equal(out, "<li>A<b>1</b></li>0");
});

test("inline scripts are not escaped but cannot close early", () => {
  assert.equal(render(jsx("script", { children: 'if (a < b && c) x("</script>")' })), '<script>if (a < b && c) x("<\\/script>")</script>');
});

test("async components fail with a clear message", () => {
  const Async = async () => "x";
  assert.throws(() => render(jsx(Async, {})), /synchronous/);
});

test("usePage works only during a render", () => {
  assert.throws(() => usePage(), /only be called while a page is rendering/);
  const ctx = { url: "/a/", href: "https://x.com/a/", origin: "https://x.com", mode: "build" as const, meta: {}, scripts: new Set<string>() };
  assert.equal(withPage(ctx, () => usePage().url), "/a/");
});

test("schema coerces CSV strings and collects every issue with its path", () => {
  const shape = { slug: s.slug(), n: s.number().int(), when: s.date(), ok: s.boolean(), kind: s.enum(["a", "b"]), tags: s.array(s.string()).split("|"), note: s.string().optional() };
  const good = validate(shape, { slug: "a-b", n: "3", when: "2024-02-29", ok: "yes", kind: "a", tags: "x|y" });
  assert.deepEqual(good.issues, []);
  assert.equal(good.value.n, 3);
  assert.equal(good.value.when.toISOString(), "2024-02-29T00:00:00.000Z");
  assert.deepEqual(good.value.tags, ["x", "y"]);
  const bad = validate(shape, { slug: "A b", n: "3.5", when: "2023-02-29", ok: "maybe", kind: "c", tags: 5 });
  assert.deepEqual(
    bad.issues.map((i) => i.path),
    ["slug", "n", "when", "ok", "kind", "tags"]
  );
  assert.match(bad.issues.find((i) => i.path === "when")!.message, /expected date, got "2023-02-29"/);
});

test("schema: required, default, strict and nested objects", () => {
  const shape = s.object({ title: s.string(), tags: s.array(s.string()).default([]), seo: s.object({ title: s.string() }).optional() }).strict();
  const r = validate(shape, { tags: undefined, seo: { title: "" }, extra: 1 });
  assert.deepEqual(
    r.issues.map((i) => `${i.path}: ${i.message}`),
    ["extra: unknown field", "title: required string is missing", "seo.title: required string is missing"]
  );
  assert.deepEqual(validate(shape, { title: "x" }).value.tags, []);
});

test("csv parses quotes, escaped quotes, newlines in fields and CRLF, with record line numbers", () => {
  const text = 'a,b\r\n1,"x, ""y"""\r\n2,"multi\nline"\n\n3,z\n';
  const { headers, records } = parseCsv(text);
  assert.deepEqual(headers, ["a", "b"]);
  assert.deepEqual(
    records.map((r) => [r.line, r.fields.a, r.fields.b]),
    [
      [2, "1", 'x, "y"'],
      [3, "2", "multi\nline"],
      [6, "3", "z"]
    ]
  );
  assert.throws(() => parseCsv("a,b\n1\n"), /line 2: expected 2 columns, found 1/);
  assert.throws(() => parseCsvRows('a\n"open'), /unterminated/);
});

test("frontmatter keeps dates as strings for the schema to decide", () => {
  const fm = parseFrontmatter("---\ntitle: Hi\ndate: 2024-01-02\nflag: no\n---\nBody\n");
  assert.deepEqual(fm.data, { title: "Hi", date: "2024-01-02", flag: "no" });
  assert.equal(fm.body, "Body\n");
  assert.equal(fm.bodyLine, 6);
  assert.deepEqual(parseFrontmatter("No frontmatter").data, {});
});

test("tree builds nested levels, skips null levels and exposes ancestry", () => {
  const rows = [
    { n: "a", nation: "England", county: "Kent", lad: "Dover" },
    { n: "b", nation: "England", county: "Kent", lad: "Ashford" },
    { n: "c", nation: "Wales", county: null, lad: "Cardiff" }
  ];
  const t = tree(rows, [
    { name: "nation", key: (r) => r.nation },
    { name: "county", key: (r) => r.county },
    { name: "lad", key: (r) => r.lad }
  ]);
  assert.deepEqual(
    t.root.children.map((c) => c.label),
    ["England", "Wales"]
  );
  assert.deepEqual(
    t.levels.lad.map((n) => n.label),
    ["Ashford", "Cardiff", "Dover"]
  );
  const cardiff = t.nodeOf(rows[2]);
  assert.deepEqual(
    ancestors(cardiff).map((n) => `${n.level}:${n.label}`),
    ["nation:Wales", "lad:Cardiff"]
  );
  assert.equal(t.nodeOf(rows[0]).parent!.entries.length, 2);
});

test("paginate, related and groupBy", () => {
  const pages = paginate([1, 2, 3, 4, 5], 2, (n) => (n === 1 ? "/b/" : `/b/page/${n}/`));
  assert.deepEqual(
    pages.map((p) => [p.url, p.items, p.prev, p.next]),
    [
      ["/b/", [1, 2], undefined, "/b/page/2/"],
      ["/b/page/2/", [3, 4], "/b/", "/b/page/3/"],
      ["/b/page/3/", [5], "/b/page/2/", undefined]
    ]
  );
  assert.equal(paginate([], 10, () => "/").length, 1);
  const items = [{ t: ["a", "b"] }, { t: ["b"] }, { t: ["a", "b", "c"] }, { t: ["z"] }];
  assert.deepEqual(related(items[0], items, (x) => x.t), [items[2], items[1]]);
  assert.deepEqual([...groupBy(items, (x) => x.t).keys()], ["a", "b", "c", "z"]);
});

test("URLs map to files and reject ambiguous paths", () => {
  assert.equal(urlToFile("/"), "index.html");
  assert.equal(urlToFile("/a/b/"), "a/b/index.html");
  assert.equal(urlToFile("/404.html"), "404.html");
  assert.equal(urlToFile("/feed.xml"), "feed.xml");
  assert.throws(() => urlToFile("/about"), /must end with "\/" or a file extension/);
  assert.throws(() => urlToFile("about/"), /must start with/);
});

test("sitemaps: single file, and an index when over the limit", () => {
  const urls = Array.from({ length: 5 }, (_, i) => ({ loc: `https://x.com/${i}/`, lastmod: new Date(Date.UTC(2024, 0, i + 1)) }));
  const one = sitemaps("sitemap.xml", "https://x.com", urls);
  assert.deepEqual(Object.keys(one), ["sitemap.xml"]);
  assert.match(one["sitemap.xml"], /<lastmod>2024-01-01T00:00:00.000Z<\/lastmod>/);
  const split = sitemaps("sitemap.xml", "https://x.com", urls, { maxUrls: 2 });
  assert.deepEqual(Object.keys(split).sort(), ["sitemap-1.xml", "sitemap-2.xml", "sitemap-3.xml", "sitemap.xml"]);
  assert.match(split["sitemap.xml"], /<sitemapindex[\s\S]*<loc>https:\/\/x.com\/sitemap-3.xml<\/loc>/);
});

test("feeds, robots, JSON-LD, Netlify files, absolute URLs", () => {
  const feed = atom({ title: "T & co", link: "https://x.com/", self: "https://x.com/feed.xml", entries: [{ title: "P", url: "https://x.com/p/", updated: new Date("2024-01-02T03:04:05.678Z"), content: "<p>a</p>" }] });
  assert.match(feed, /<title>T &amp; co<\/title>/);
  assert.match(feed, /<updated>2024-01-02T03:04:05Z<\/updated>/);
  assert.match(feed, /<content type="html">&lt;p&gt;a&lt;\/p&gt;<\/content>/);
  assert.equal(robots({ rules: [{ userAgent: "*", disallow: ["/404.html"] }], sitemaps: ["https://x.com/sitemap.xml"] }), "User-agent: *\nDisallow: /404.html\nSitemap: https://x.com/sitemap.xml\n");
  assert.equal(jsonLdString({ a: "</script><!--" }), '{"a":"\\u003c/script\\u003e\\u003c!--"}');
  assert.equal(redirects([{ from: "/old", to: "/new/" }, { from: "/x/*", to: "/y/:splat", status: 302, force: true }]), "/old /new/ 301\n/x/* /y/:splat 302!\n");
  assert.equal(headers([{ for: "/a/*", values: { "Cache-Control": "no-cache" } }]), "/a/*\n  Cache-Control: no-cache\n");
  assert.equal(absoluteUrl("https://x.com/", "/a/"), "https://x.com/a/");
  assert.equal(absoluteUrl("https://x.com", "https://y.com/"), "https://y.com/");
  assert.equal(absolutizeHtml('<a href="/a/">x</a><img src="b.png"><a href="#f">', "https://x.com/p/"), '<a href="https://x.com/a/">x</a><img src="https://x.com/p/b.png"><a href="#f">');
});
