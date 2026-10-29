// SEO output primitives. Each returns a string (or Html) that the site writes with site.file()
// or renders in its head, so the site keeps full control of the exact output.

import { escapeText, raw, type Html } from "../jsx/runtime.ts";

export function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Join an origin and a path ("https://x.com" + "/a/" -> "https://x.com/a/"). Absolute URLs pass through. */
export function absoluteUrl(origin: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

export interface SitemapUrl {
  loc: string;
  lastmod?: string | Date;
  changefreq?: string;
  priority?: number | string;
}

export interface SitemapOptions {
  /** Format a Date lastmod (default: toISOString()). Strings are written as given. */
  formatDate?: (date: Date) => string;
  /** Split into a sitemap index above this many URLs (default 45,000; the protocol limit is 50,000). */
  maxUrls?: number;
  /** Split above this many bytes per file (default 45 MB; the limit is 50 MB). */
  maxBytes?: number;
  /** File name for split part n (1-based). Default: the index name with "-n" before ".xml" ("sitemap-1.xml"). */
  partName?: (n: number) => string;
  /** Lines before <urlset> etc. Default: XML declaration. */
  header?: string;
  /** Indentation unit (default two spaces). Whitespace is not significant in sitemaps. */
  indent?: string;
}

function urlXml(u: SitemapUrl, o: SitemapOptions, ind: string): string {
  const lastmod = u.lastmod instanceof Date ? (o.formatDate ?? ((d: Date) => d.toISOString()))(u.lastmod) : u.lastmod;
  let x = `${ind}<url>\n${ind}${ind}<loc>${xmlEscape(u.loc)}</loc>`;
  if (lastmod) x += `\n${ind}${ind}<lastmod>${xmlEscape(lastmod)}</lastmod>`;
  if (u.changefreq) x += `\n${ind}${ind}<changefreq>${xmlEscape(u.changefreq)}</changefreq>`;
  if (u.priority !== undefined) x += `\n${ind}${ind}<priority>${u.priority}</priority>`;
  return `${x}\n${ind}</url>`;
}

const NS = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`;

/**
 * Build sitemap files. Returns { "sitemap.xml": xml } for small sites, or an index plus parts
 * when the URL or size limit is exceeded. `file` is the index/main file name.
 */
export function sitemaps(file: string, origin: string, urls: SitemapUrl[], options: SitemapOptions = {}): Record<string, string> {
  const ind = options.indent ?? "  ";
  const header = options.header ?? `<?xml version="1.0" encoding="UTF-8"?>\n`;
  const maxUrls = options.maxUrls ?? 45_000;
  const maxBytes = options.maxBytes ?? 45 * 1024 * 1024;
  const bodies = urls.map((u) => urlXml(u, options, ind));
  const wrap = (parts: string[]) => `${header}<urlset ${NS}>\n${parts.join("\n")}\n</urlset>`;
  const single = wrap(bodies);
  if (urls.length <= maxUrls && Buffer.byteLength(single) <= maxBytes) return { [file]: single };

  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const body of bodies) {
    const size = Buffer.byteLength(body) + 1;
    if (current.length && (current.length >= maxUrls || bytes + size > maxBytes - 200)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(body);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  const partName = options.partName ?? ((n: number) => `${file.replace(/\.xml$/, "")}-${n}.xml`);
  const out: Record<string, string> = {};
  const entries = chunks.map((chunk, i) => {
    const name = partName(i + 1);
    if (name === file || name in out) throw new Error(`sitemaps(): part ${i + 1} is named "${name}", which another sitemap file already uses`);
    out[name] = wrap(chunk);
    return `${ind}<sitemap>\n${ind}${ind}<loc>${xmlEscape(absoluteUrl(origin, "/" + name.replace(/^\/+/, "")))}</loc>\n${ind}</sitemap>`;
  });
  out[file] = `${header}<sitemapindex ${NS}>\n${entries.join("\n")}\n</sitemapindex>`;
  return out;
}

export interface RobotsOptions {
  rules?: { userAgent: string; allow?: string[]; disallow?: string[] }[];
  sitemaps?: string[];
}

export function robots(options: RobotsOptions = {}): string {
  const rules = options.rules ?? [{ userAgent: "*", allow: ["/"] }];
  const lines: string[] = [];
  for (const r of rules) {
    lines.push(`User-agent: ${r.userAgent}`);
    for (const a of r.allow ?? []) lines.push(`Allow: ${a}`);
    for (const d of r.disallow ?? []) lines.push(`Disallow: ${d}`);
  }
  for (const s of options.sitemaps ?? []) lines.push(`Sitemap: ${s}`);
  return lines.join("\n") + "\n";
}

export interface FeedEntry {
  title: string;
  url: string;
  id?: string;
  updated: Date;
  published?: Date;
  summary?: string;
  /** HTML content (escaped into the feed). */
  content?: string;
  author?: string;
  /** Extra attributes on <content> (e.g. { "xml:lang": "en" }). */
  contentAttributes?: Record<string, string>;
}

export interface FeedOptions {
  title: string;
  subtitle?: string;
  /** Site home URL. */
  link: string;
  /** Absolute URL of the feed itself. */
  self: string;
  id?: string;
  updated?: Date;
  author?: { name: string; email?: string };
  entries: FeedEntry[];
  language?: string;
  /** Extra attributes on the root element (e.g. { "xml:base": "https://example.com/" }). */
  attributes?: Record<string, string>;
}

const attrs = (a?: Record<string, string>) => Object.entries(a ?? {}).map(([k, v]) => ` ${k}="${xmlEscape(v)}"`).join("");

/** RFC 3339 timestamp without milliseconds ("2024-01-31T00:00:00Z"). */
export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function atom(o: FeedOptions): string {
  const updated = o.updated ?? o.entries.reduce<Date | undefined>((max, e) => (!max || e.updated > max ? e.updated : max), undefined) ?? new Date(0);
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom"${o.language ? ` xml:lang="${xmlEscape(o.language)}"` : ""}${attrs(o.attributes)}>`,
    `  <title>${xmlEscape(o.title)}</title>`,
    ...(o.subtitle ? [`  <subtitle>${xmlEscape(o.subtitle)}</subtitle>`] : []),
    `  <link href="${xmlEscape(o.self)}" rel="self" />`,
    `  <link href="${xmlEscape(o.link)}" />`,
    `  <updated>${rfc3339(updated)}</updated>`,
    `  <id>${xmlEscape(o.id ?? o.link)}</id>`
  ];
  if (o.author) {
    lines.push(`  <author>`, `    <name>${xmlEscape(o.author.name)}</name>`);
    if (o.author.email !== undefined) lines.push(`    <email>${xmlEscape(o.author.email)}</email>`);
    lines.push(`  </author>`);
  }
  for (const e of o.entries) {
    lines.push(`  <entry>`, `    <title>${xmlEscape(e.title)}</title>`, `    <link href="${xmlEscape(e.url)}" />`);
    lines.push(`    <updated>${rfc3339(e.updated)}</updated>`);
    if (e.published) lines.push(`    <published>${rfc3339(e.published)}</published>`);
    lines.push(`    <id>${xmlEscape(e.id ?? e.url)}</id>`);
    if (e.summary) lines.push(`    <summary>${xmlEscape(e.summary)}</summary>`);
    if (e.content !== undefined) lines.push(`    <content${attrs(e.contentAttributes)} type="html">${xmlEscape(e.content)}</content>`);
    lines.push(`  </entry>`);
  }
  lines.push(`</feed>`);
  return lines.join("\n") + "\n";
}

export function rss(o: FeedOptions): string {
  const date = (d: Date) => d.toUTCString();
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"${attrs(o.attributes)}>`,
    `  <channel>`,
    `    <title>${xmlEscape(o.title)}</title>`,
    `    <link>${xmlEscape(o.link)}</link>`,
    `    <description>${xmlEscape(o.subtitle ?? o.title)}</description>`,
    `    <atom:link href="${xmlEscape(o.self)}" rel="self" type="application/rss+xml" />`
  ];
  if (o.language) lines.push(`    <language>${xmlEscape(o.language)}</language>`);
  for (const e of o.entries) {
    lines.push(`    <item>`, `      <title>${xmlEscape(e.title)}</title>`, `      <link>${xmlEscape(e.url)}</link>`);
    lines.push(`      <guid>${xmlEscape(e.id ?? e.url)}</guid>`, `      <pubDate>${date(e.published ?? e.updated)}</pubDate>`);
    if (e.content ?? e.summary) lines.push(`      <description>${xmlEscape(e.content ?? e.summary!)}</description>`);
    lines.push(`    </item>`);
  }
  lines.push(`  </channel>`, `</rss>`);
  return lines.join("\n") + "\n";
}

/** Make root-relative href/src attributes in an HTML fragment absolute (for feed content). */
export function absolutizeHtml(html: string, base: string): string {
  return html.replace(/(\s(?:href|src)=)(["'])([^"']*)\2/gi, (whole, attr: string, q: string, url: string) => {
    if (!url || url.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return whole;
    try {
      return `${attr}${q}${new URL(url, base).href}${q}`;
    } catch {
      return whole;
    }
  });
}

/** JSON for a <script type="application/ld+json"> body, safe against </script> and HTML comments. */
export function jsonLdString(data: unknown, space?: number): string {
  return JSON.stringify(data, null, space)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function JsonLd(props: { data: unknown; space?: number }): Html {
  return raw(`<script type="application/ld+json">${jsonLdString(props.data, props.space)}</script>`);
}

export interface RedirectRule {
  from: string;
  to: string;
  status?: number;
  force?: boolean;
}

/** Netlify _redirects file. */
export function redirects(rules: RedirectRule[]): string {
  return rules.map((r) => `${r.from} ${r.to} ${r.status ?? 301}${r.force ? "!" : ""}`).join("\n") + (rules.length ? "\n" : "");
}

/** Netlify _headers file. */
export function headers(rules: { for: string; values: Record<string, string> }[]): string {
  return rules.map((r) => [r.for, ...Object.entries(r.values).map(([k, v]) => `  ${k}: ${v}`)].join("\n")).join("\n\n") + (rules.length ? "\n" : "");
}

export { escapeText };
