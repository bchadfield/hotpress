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
import { StaticHost } from "../src/diff/host.ts";
import { parseRedirects } from "../src/diff/netlify.ts";
import { Script } from "../src/build/scripts.ts";
import { execFileSync } from "node:child_process";

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

test("groupBy lists an item once per key, even if it repeats the key", () => {
  assert.deepEqual([...groupBy([{ t: ["a", "a", "b"] }], (x) => x.t)].map(([k, v]) => [k, v.length]), [["a", 1], ["b", 1]]);
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
  // Nothing may be written outside the out dir, or to two spellings of one file.
  assert.throws(() => urlToFile("/../../escape.html"), /"\." or "\.\." segments/);
  assert.throws(() => urlToFile("/a/./b/"), /segments/);
  assert.throws(() => urlToFile("/a//b/"), /empty segments/);
  assert.throws(() => urlToFile("/a/?page=2"), /query or fragment/);
});

test("Html from another copy of the runtime still renders as markup", () => {
  const foreign = { value: "<b>x</b>" };
  Object.defineProperty(foreign, Symbol.for("hotpress.html"), { value: true });
  assert.equal(render([raw("<i>"), foreign as never, "<"]), "<i><b>x</b>&lt;");
});

test("schema: impossible dates fail, defaults are per entry, split keeps refinements", () => {
  assert.equal(validate({ d: s.date() }, { d: "2024-02-30T10:00Z" }).issues.length, 1);
  assert.equal(validate({ d: s.date() }, { d: "2023-02-29" }).issues.length, 1);
  assert.equal(validate({ d: s.date() }, { d: "2024-02-29T23:30:00+01:00" }).value.d.toISOString(), "2024-02-29T22:30:00.000Z");
  const shape = { tags: s.array(s.string()).default([]), when: s.date().default(new Date(0)) };
  const a = validate(shape, {}).value;
  const b = validate(shape, {}).value;
  assert.notEqual(a.tags, b.tags, "each entry gets its own default array");
  assert.equal(a.when.getTime(), 0);
  const tags = s.array(s.string()).refine((v) => v.length <= 2, "at most two tags").split("|");
  assert.deepEqual(validate({ tags }, { tags: "a|b" }).value.tags, ["a", "b"]);
  assert.equal(validate({ tags }, { tags: "a|b|c" }).issues[0].message, "at most two tags");
});

test("host: non-3xx redirect rules are rewrites that keep their status", () => {
  const host = new StaticHost(["blog/404.html", "404.html", "new/index.html"], parseRedirects("/blog/* /blog/404.html 404\n/gone/ /404.html 410\n/old/ /new/ 301\n"));
  assert.deepEqual(host.resolve("/blog/missing/"), { status: 404, file: "blog/404.html" });
  assert.deepEqual(host.resolve("/gone/"), { status: 410, file: "404.html" });
  assert.deepEqual(host.resolve("/old/"), { status: 301, location: "/new/" });
  assert.equal(host.finalStatus("/old/"), 200);
});

test("sitemaps: split parts get their own names whatever the index is called", () => {
  const urls = Array.from({ length: 5 }, (_, i) => ({ loc: `https://x.com/${i}/` }));
  assert.deepEqual(Object.keys(sitemaps("sitemap", "https://x.com", urls, { maxUrls: 2 })).sort(), ["sitemap", "sitemap-1.xml", "sitemap-2.xml", "sitemap-3.xml"]);
  assert.throws(() => sitemaps("sitemap.xml", "https://x.com", urls, { maxUrls: 2, partName: () => "part.xml" }), /already uses/);
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

test("host: absolute redirects to the site are followed; to another site, the URL still resolves", () => {
  const rules = "/old/ https://example.com/new/ 301\n/lost/ https://example.com/missing/ 301\n/go/ https://partner.example/ 302\n";
  const host = new StaticHost(["new/index.html"], parseRedirects(rules));
  assert.equal(host.finalStatus("/old/", ["https://example.com"]), 200);
  assert.equal(host.finalStatus("/lost/", ["https://example.com"]), 404);
  assert.equal(host.finalStatus("/go/", ["https://example.com"]), 200);
  // "//host/..." is resolved like a browser would: another site, or this one.
  const relative = new StaticHost(["new/index.html"], parseRedirects("/cdn/ //cdn.example.net/new/ 301\n/self/ //example.com/new/ 301\n/gone/ //example.com/missing/ 301\n/up/ ../new/ 301\n"));
  assert.equal(relative.finalStatus("/cdn/", ["https://example.com"]), 200);
  assert.equal(relative.finalStatus("/self/", ["https://example.com"]), 200);
  assert.equal(relative.finalStatus("/gone/", ["https://example.com"]), 404);
  assert.equal(relative.finalStatus("/up/"), 200);
});

test("frontmatter: an empty block is frontmatter, and only the first block counts", () => {
  assert.deepEqual(parseFrontmatter("---\n---\nHello\n"), { data: {}, body: "Hello\n", bodyLine: 3 });
  assert.deepEqual(parseFrontmatter("---\n---\nHello\n---\nmore\n"), { data: {}, body: "Hello\n---\nmore\n", bodyLine: 3 });
  assert.deepEqual(parseFrontmatter("---\na: 1\n---\nx").data, { a: 1 });
});

test("related counts a repeated value once", () => {
  const item = { t: ["a", "b"] };
  const twiceA = { t: ["a", "a"] };
  const both = { t: ["a", "b"] };
  assert.deepEqual(related(item, [item, twiceA, both], (x) => x.t), [both, twiceA]);
});

test("csv: text after a closing quote is an error; spaces there are dropped", () => {
  assert.throws(() => parseCsv('a,b\n"x"y,z\n'), /line 2: unexpected "y" after a closing quote/);
  assert.deepEqual(parseCsv('a,b\n"x"  ,z\n', { trim: false }).records[0].fields, { a: "x", b: "z" });
});

test("Script escapes a string src", () => {
  const ctx = { url: "/", href: "https://x.com/", origin: "https://x.com", mode: "build" as const, meta: {}, scripts: new Set<string>() };
  const html = withPage(ctx, () => render(jsx(Script, { src: '/a.js" onload="x' })));
  assert.equal(html, '<script type="module" src="/a.js&quot; onload=&quot;x"></script>');
});

test("CLI: bad flags are usage errors (exit 2, no stack trace)", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const run = (...args: string[]) => {
    try {
      execFileSync(process.execPath, ["--conditions=hotpress-source", cli, ...args], { encoding: "utf8", stdio: "pipe" });
      return { code: 0, err: "" };
    } catch (error) {
      const e = error as { status: number; stderr: string };
      return { code: e.status, err: e.stderr };
    }
  };
  for (const [args, message] of [
    [["dev", "--port", "abc"], /--port must be a whole number from 0 to 65535, got "abc"/],
    [["serve", "--port", "70000"], /--port must be a whole number/],
    [["build", "--check", "--out", "x"], /--out can't be combined with --check/],
    [["build", "--nope"], /Unknown option '--nope'/]
  ] as const) {
    const r = run(...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, message);
    assert.doesNotMatch(r.err, /\n\s+at /, "no stack trace");
  }
});
