import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileToUrl, globToRegExp, isHtmlFile, listFiles } from "./files.ts";
import { StaticHost } from "./host.ts";
import { extractPage, normaliseText, SEO_FIELDS, type PageSeo } from "./html.ts";
import { parseFrameworksConfig, parseHeaders, parseRedirects, type HeaderRule, type RedirectRule } from "./netlify.ts";
import { child, flatten, localName, parseXml, rootElement, type XmlNode } from "./xml.ts";
import { lineDiff } from "./linediff.ts";

export interface DiffOptions {
  baseline: string;
  candidate: string;
  /** Origins treated as "this site" for absolute URLs. Inferred from the baseline if empty. */
  origins?: string[];
  /** URL globs excluded from every check (e.g. hashed build assets: "/_astro/**"). */
  ignore?: string[];
  /** Extra paths whose status codes are compared. */
  probes?: string[];
  /** Compare titles and descriptions byte-for-byte instead of whitespace-normalised. */
  strictWhitespace?: boolean;
}

export interface Finding {
  url?: string;
  field?: string;
  baseline?: string;
  candidate?: string;
  message: string;
}

export interface Section {
  id: string;
  title: string;
  /** Informational sections never fail the run. */
  informational?: boolean;
  checked: number;
  failures: Finding[];
  notes: Finding[];
}

export interface DiffReport {
  baseline: string;
  candidate: string;
  origins: string[];
  ok: boolean;
  sections: Section[];
  durationMs: number;
}

interface Side {
  dir: string;
  files: string[];
  fileSet: Set<string>;
  host: StaticHost;
  redirects: RedirectRule[];
  headers: HeaderRule[];
  pages: Map<string, PageSeo>;
  xml: Map<string, XmlNode>;
}

const PROBES = ["/__hotpress_probe__/", "/__hotpress_probe__", "/__hotpress_probe__.html", "/Index.html"];

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function loadSide(dir: string, ignore: RegExp[]): Promise<Side> {
  const all = await listFiles(dir);
  const files = all.filter((f) => !ignore.some((re) => re.test(fileToUrl(f))));
  const redirects: RedirectRule[] = [];
  const headers: HeaderRule[] = [];
  const redirectsText = await readOptional(join(dir, "_redirects"));
  if (redirectsText !== null) redirects.push(...parseRedirects(redirectsText));
  const headersText = await readOptional(join(dir, "_headers"));
  if (headersText !== null) headers.push(...parseHeaders(headersText));
  const frameworks = await readOptional(join(dir, ".netlify/v1/config.json"));
  if (frameworks !== null) {
    const parsed = parseFrameworksConfig(frameworks);
    redirects.push(...parsed.redirects);
    headers.push(...parsed.headers);
  }

  const pages = new Map<string, PageSeo>();
  const xml = new Map<string, XmlNode>();
  await mapLimit(files, 32, async (file) => {
    if (isHtmlFile(file)) {
      pages.set(file, extractPage(await readFile(join(dir, file), "utf8")));
    } else if (/\.(xml|rss|atom)$/i.test(file)) {
      xml.set(file, parseXml(await readFile(join(dir, file), "utf8")));
    }
  });
  // Unignored files only: an ignored file is not part of the comparison, but it still exists on
  // the host, so links to it resolve.
  return { dir, files, fileSet: new Set(files), host: new StaticHost(all, redirects), redirects, headers, pages, xml };
}

function section(id: string, title: string, informational = false): Section {
  return { id, title, informational, checked: 0, failures: [], notes: [] };
}

function inferOrigins(side: Side): string[] {
  const origins = new Set<string>();
  const home = side.pages.get("index.html");
  for (const c of home?.canonical ?? []) {
    try {
      origins.add(new URL(c).origin);
    } catch {}
  }
  if (!origins.size) {
    for (const [, doc] of side.xml) {
      const root = rootElement(doc);
      if (root && localName(root.name) === "urlset") {
        const loc = child(root.children[0] ?? root, "loc");
        if (loc) {
          try {
            origins.add(new URL(loc.text.trim()).origin);
          } catch {}
        }
      }
    }
  }
  return [...origins];
}

function compareUrls(a: Side, b: Side): Section {
  const s = section("urls", "URL set");
  const aUrls = new Map(a.files.map((f) => [fileToUrl(f), f]));
  const bUrls = new Map(b.files.map((f) => [fileToUrl(f), f]));
  s.checked = new Set([...aUrls.keys(), ...bUrls.keys()]).size;
  for (const [url] of aUrls) if (!bUrls.has(url)) s.failures.push({ url, message: "missing in candidate" });
  for (const [url] of bUrls) if (!aUrls.has(url)) s.failures.push({ url, message: "extra in candidate" });
  return s;
}

function comparePages(a: Side, b: Side, strictWhitespace: boolean): Section {
  const s = section("pages", "Page metadata (title, description, canonical, robots, OG/Twitter, JSON-LD, hreflang, h1)");
  for (const [file, pa] of a.pages) {
    const pb = b.pages.get(file);
    if (!pb) continue;
    s.checked++;
    const url = fileToUrl(file);
    for (const field of SEO_FIELDS) {
      const va = field === "base" ? [pa.base ?? "(none)"] : pa[field];
      const vb = field === "base" ? [pb.base ?? "(none)"] : pb[field];
      const ja = JSON.stringify(va);
      const jb = JSON.stringify(vb);
      if (ja !== jb) {
        const diff = lineDiff(va, vb);
        s.failures.push({ url, field, baseline: va.join("\n"), candidate: vb.join("\n"), message: diff });
      }
    }
    for (const field of ["title", "description"] as const) {
      const ra = JSON.stringify(pa.raw[field]);
      const rb = JSON.stringify(pb.raw[field]);
      if (ra !== rb && JSON.stringify(pa[field]) === JSON.stringify(pb[field])) {
        const finding = { url, field, baseline: ra, candidate: rb, message: "whitespace-only difference" };
        (strictWhitespace ? s.failures : s.notes).push(finding);
      }
    }
  }
  return s;
}

interface SitemapEntry {
  loc: string;
  fields: string;
}

function sitemapEntries(doc: XmlNode): { kind: string; entries: SitemapEntry[] } | null {
  const root = rootElement(doc);
  if (!root) return null;
  const kind = localName(root.name);
  if (kind !== "urlset" && kind !== "sitemapindex") return null;
  const entries = root.children
    .filter((c) => localName(c.name) === "url" || localName(c.name) === "sitemap")
    .map((c) => {
      const loc = normaliseText(child(c, "loc")?.text ?? "");
      const fields = c.children
        .filter((f) => localName(f.name) !== "loc")
        .flatMap((f) => flatten(f))
        .join("; ");
      return { loc, fields };
    });
  return { kind, entries };
}

function compareSitemaps(a: Side, b: Side): Section {
  const s = section("sitemaps", "Sitemaps");
  const find = (side: Side) => {
    const out = new Map<string, { kind: string; entries: SitemapEntry[] }>();
    for (const [file, doc] of side.xml) {
      const parsed = sitemapEntries(doc);
      if (parsed) out.set(file, parsed);
    }
    return out;
  };
  const sa = find(a);
  const sb = find(b);
  for (const file of new Set([...sa.keys(), ...sb.keys()])) {
    const url = fileToUrl(file);
    const ea = sa.get(file);
    const eb = sb.get(file);
    if (!ea || !eb) {
      s.failures.push({ url, message: ea ? "sitemap missing in candidate" : "extra sitemap in candidate" });
      continue;
    }
    s.checked += ea.entries.length;
    if (ea.kind !== eb.kind) s.failures.push({ url, message: `root element ${ea.kind} -> ${eb.kind}` });
    const mb = new Map(eb.entries.map((e) => [e.loc, e]));
    const ma = new Map(ea.entries.map((e) => [e.loc, e]));
    if (ma.size !== ea.entries.length) s.notes.push({ url, message: `baseline has ${ea.entries.length - ma.size} duplicate locs` });
    for (const e of ea.entries) {
      const other = mb.get(e.loc);
      if (!other) s.failures.push({ url, field: "loc", baseline: e.loc, message: `entry missing: ${e.loc}` });
      else if (other.fields !== e.fields)
        s.failures.push({ url, field: e.loc, baseline: e.fields, candidate: other.fields, message: `fields differ for ${e.loc}` });
    }
    for (const e of eb.entries) if (!ma.has(e.loc)) s.failures.push({ url, field: "loc", candidate: e.loc, message: `extra entry: ${e.loc}` });
    const orderA = ea.entries.map((e) => e.loc).filter((l) => mb.has(l));
    const orderB = eb.entries.map((e) => e.loc).filter((l) => ma.has(l));
    const firstDiff = orderA.findIndex((l, i) => orderB[i] !== l);
    if (firstDiff >= 0)
      s.failures.push({ url, field: "order", baseline: orderA[firstDiff], candidate: orderB[firstDiff], message: `entry order differs from position ${firstDiff + 1}` });
  }
  return s;
}

function robotsLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const idx = l.indexOf(":");
      return idx < 0 ? l : `${l.slice(0, idx).trim().toLowerCase()}: ${l.slice(idx + 1).trim()}`;
    });
}

async function compareRobots(a: Side, b: Side): Promise<Section> {
  const s = section("robots", "robots.txt");
  const ta = await readOptional(join(a.dir, "robots.txt"));
  const tb = await readOptional(join(b.dir, "robots.txt"));
  s.checked = 1;
  if (ta === null && tb === null) return s;
  if (ta === null || tb === null) {
    s.failures.push({ url: "/robots.txt", message: ta === null ? "extra in candidate" : "missing in candidate" });
    return s;
  }
  const la = robotsLines(ta);
  const lb = robotsLines(tb);
  if (JSON.stringify(la) !== JSON.stringify(lb)) s.failures.push({ url: "/robots.txt", message: lineDiff(la, lb) });
  else if (ta !== tb) s.notes.push({ url: "/robots.txt", message: "whitespace or comment differences only" });
  return s;
}

function compareFeeds(a: Side, b: Side): Section {
  const s = section("feeds", "RSS/Atom feeds");
  const feeds = (side: Side) => {
    const out = new Map<string, XmlNode>();
    for (const [file, doc] of side.xml) {
      const root = rootElement(doc);
      if (root && ["rss", "feed", "rdf:RDF"].includes(root.name)) out.set(file, root);
    }
    return out;
  };
  const fa = feeds(a);
  const fb = feeds(b);
  for (const file of new Set([...fa.keys(), ...fb.keys()])) {
    const url = fileToUrl(file);
    const na = fa.get(file);
    const nb = fb.get(file);
    if (!na || !nb) {
      s.failures.push({ url, message: na ? "feed missing in candidate" : "extra feed in candidate" });
      continue;
    }
    s.checked++;
    const la = flatten(na);
    const lb = flatten(nb);
    if (JSON.stringify(la) !== JSON.stringify(lb)) s.failures.push({ url, message: lineDiff(la, lb) });
  }
  return s;
}

function compareNetlify(a: Side, b: Side): Section {
  const s = section("netlify", "Netlify _redirects and _headers");
  const red = (rules: RedirectRule[]) =>
    rules.map((r) => `${r.from} ${r.to} ${r.status}${r.force ? "!" : ""}${r.conditions.length ? " " + r.conditions.join(" ") : ""}`);
  const head = (rules: HeaderRule[]) => rules.flatMap((r) => r.values.map(([k, v]) => `${r.for} | ${k}: ${v}`)).sort();
  const ra = red(a.redirects);
  const rb = red(b.redirects);
  const ha = head(a.headers);
  const hb = head(b.headers);
  s.checked = ra.length + ha.length;
  if (JSON.stringify(ra) !== JSON.stringify(rb)) s.failures.push({ url: "/_redirects", message: lineDiff(ra, rb) });
  if (JSON.stringify(ha) !== JSON.stringify(hb)) s.failures.push({ url: "/_headers", message: lineDiff(ha, hb) });
  return s;
}

function compareStatus(a: Side, b: Side, probes: string[], ignore: RegExp[]): Section {
  const s = section("status", "Status codes (404 page, redirects, directory/extension handling)");
  const paths = new Set<string>(probes);
  for (const side of [a, b]) {
    for (const file of side.files) {
      const url = fileToUrl(file);
      paths.add(url);
      if (url.endsWith("/") && url !== "/") paths.add(url.slice(0, -1));
    }
    for (const r of side.redirects) if (!/[:*]/.test(r.from)) paths.add(r.from);
  }
  const has404 = (side: Side) => side.fileSet.has("404.html");
  if (has404(a) !== has404(b)) s.failures.push({ url: "/404.html", message: has404(a) ? "404.html missing in candidate" : "404.html added in candidate" });
  for (const path of paths) {
    if (ignore.some((re) => re.test(path))) continue;
    s.checked++;
    const ra = a.host.resolve(path);
    const rb = b.host.resolve(path);
    const fa = `${ra.status}${ra.location ? " -> " + ra.location : ""}`;
    const fb = `${rb.status}${rb.location ? " -> " + rb.location : ""}`;
    if (fa !== fb) s.failures.push({ url: path, baseline: fa, candidate: fb, message: `${fa}  =>  ${fb}` });
  }
  return s;
}

function brokenLinks(side: Side, origins: string[]): Map<string, { url: string; from: string; target: string }> {
  return findBrokenLinks(side.pages, side.host, origins);
}

/** Internal links (incl. canonical and og:image) that don't resolve to a 200, keyed by page+source+target. */
export function findBrokenLinks(
  pages: Map<string, PageSeo>,
  host: StaticHost,
  origins: string[]
): Map<string, { url: string; from: string; target: string; path: string; status: number }> {
  const broken = new Map<string, { url: string; from: string; target: string; path: string; status: number }>();
  const statusCache = new Map<string, number>();
  const primary = origins[0] ?? "https://hotpress.invalid";
  for (const [file, page] of pages) {
    const pageUrl = new URL(fileToUrl(file), primary);
    let base = pageUrl;
    if (page.base !== null) {
      try {
        base = new URL(page.base, pageUrl);
      } catch {}
    }
    for (const ref of page.refs) {
      let target: URL;
      try {
        target = new URL(ref.url, base);
      } catch {
        continue;
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") continue;
      if (!origins.includes(target.origin) && target.origin !== new URL(primary).origin) continue;
      const path = target.pathname;
      let status = statusCache.get(path);
      if (status === undefined) {
        status = host.finalStatus(path);
        statusCache.set(path, status);
      }
      if (status !== 200) broken.set(`${fileToUrl(file)} ${ref.from} ${path}`, { url: fileToUrl(file), from: ref.from, target: `${path} (${status})`, path, status });
    }
  }
  return broken;
}

function compareLinks(a: Side, b: Side, origins: string[]): Section {
  const s = section("links", "Internal links resolve");
  const ba = brokenLinks(a, origins);
  const bb = brokenLinks(b, origins);
  s.checked = [...b.pages.values()].reduce((n, p) => n + p.refs.length, 0);
  for (const [key, link] of bb) {
    const finding = { url: link.url, field: link.from, candidate: link.target, message: `broken: ${link.target} (${link.from})` };
    if (ba.has(key)) s.notes.push({ ...finding, message: `pre-existing in baseline: ${finding.message}` });
    else s.failures.push(finding);
  }
  return s;
}

/** Where two strings first differ, with some context either side. */
function firstDifference(a: string, b: string, context = 60): { baseline: string; candidate: string } {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const start = Math.max(0, i - context);
  const cut = (s: string) => `${start > 0 ? "…" : ""}${s.slice(start, i + context)}${i + context < s.length ? "…" : ""}`;
  return { baseline: cut(a), candidate: cut(b) };
}

function compareContent(a: Side, b: Side): Section {
  const s = section("content", "Visible page text (informational: for visual/markup QA)", true);
  for (const [file, pa] of a.pages) {
    const pb = b.pages.get(file);
    if (!pb) continue;
    s.checked++;
    if (pa.text !== pb.text) {
      const d = firstDifference(pa.text, pb.text);
      s.notes.push({ url: fileToUrl(file), ...d, message: "text differs" });
    }
  }
  return s;
}

async function compareOtherFiles(a: Side, b: Side): Promise<Section> {
  const s = section("files", "Other files (informational: assets, manifests, data)", true);
  const common = a.files.filter((f) => b.fileSet.has(f) && !isHtmlFile(f) && !/\.(xml|rss|atom)$/i.test(f) && !["robots.txt", "_redirects", "_headers"].includes(f));
  const hash = async (path: string) => createHash("sha1").update(await readFile(path)).digest("hex");
  await mapLimit(common, 32, async (file) => {
    s.checked++;
    if ((await hash(join(a.dir, file))) !== (await hash(join(b.dir, file)))) s.notes.push({ url: fileToUrl(file), message: "content differs" });
  });
  return s;
}

export async function runDiff(options: DiffOptions): Promise<DiffReport> {
  const started = Date.now();
  const ignore = (options.ignore ?? []).map(globToRegExp);
  const [a, b] = await Promise.all([loadSide(options.baseline, ignore), loadSide(options.candidate, ignore)]);
  const origins = options.origins?.length ? options.origins : inferOrigins(a);
  const sections = [
    compareUrls(a, b),
    comparePages(a, b, options.strictWhitespace ?? false),
    compareSitemaps(a, b),
    await compareRobots(a, b),
    compareFeeds(a, b),
    compareNetlify(a, b),
    compareStatus(a, b, [...PROBES, ...(options.probes ?? [])], ignore),
    compareLinks(a, b, origins),
    compareContent(a, b),
    await compareOtherFiles(a, b)
  ];
  return {
    baseline: options.baseline,
    candidate: options.candidate,
    origins,
    ok: sections.every((sec) => sec.informational || sec.failures.length === 0),
    sections,
    durationMs: Date.now() - started
  };
}

export { formatReport } from "./report.ts";
