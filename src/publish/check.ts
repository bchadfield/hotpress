// `hotpress check`: everything that must be true before a build is allowed to reach production.

import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build, type BuildResult } from "../build/build.ts";
import type { PageMeta, SiteTask, TaskPage, TaskResult } from "../build/site.ts";
import { formatProblem, type Problem } from "../errors.ts";
import { fileToUrl, globToRegExp, listFiles } from "../diff/files.ts";
import { StaticHost } from "../diff/host.ts";
import { extractPage, type PageSeo } from "../diff/html.ts";
import { findBrokenLinks } from "../diff/index.ts";
import { parseRedirects } from "../diff/netlify.ts";
import { child, localName, parseXml, rootElement } from "../diff/xml.ts";
import { mapLimit, plural, sha1 } from "../util.ts";

export interface CheckOptions {
  root: string;
  configFile?: string;
  /** Build twice and compare, to catch non-deterministic output. */
  twice?: boolean;
  /** Extra one-off allowances ("code:glob"), on top of the site's committed check.allow. */
  allow?: string[];
  /** Skip checks that need the network (the live sitemap). */
  offline?: boolean;
  /** Published index to compare with (default <root>/hotpress.published.json, committed by publish). */
  publishedIndex?: string;
  /** Read this instead when the published index doesn't exist (older versions kept it in .hotpress-cache). */
  legacyIndex?: string;
  /** Let the site's tasks update files (publish, `check --fix`). */
  fix?: boolean;
  /** Publish date for tasks, YYYY-MM-DD (default: HOTPRESS_TODAY, else today in UTC). */
  today?: string;
  log?: boolean;
}

export interface CheckResult {
  ok: boolean;
  /** Problems that block publishing. */
  problems: Problem[];
  /** Problems matched by an allow rule, reported but not blocking. */
  allowed: Problem[];
  /** Things that couldn't be checked (e.g. offline). Never blocking. */
  warnings: Problem[];
  build?: BuildResult;
  index?: PublishedIndex;
  /** Pages added, removed or with changed visible text since the last publish. */
  changes?: { added: string[]; removed: string[]; changed: string[] };
  /** Files the site's tasks updated (relative to root), when run with fix. */
  fixed: string[];
}

/**
 * What was last published: used to spot removed URLs and content changes without a new date.
 * `publish` commits it with each change, so every clone and CI build compares with the same history.
 */
export interface PublishedIndex {
  version: 2;
  origin: string;
  pages: Record<string, { text: string; updated?: string }>;
  /** Every URL that served a 200, except bundled assets (their names change with their content). */
  urls: string[];
}

/** File name of the published index, in the site root. */
export const PUBLISHED_INDEX = "hotpress.published.json";

/** Hashed bundle names from older indexes, which listed bundled assets too. */
const LEGACY_ASSET = /(^|\/)(chunk\.)?[^/]*\.[A-Za-z0-9_-]{8,}\.(css|js|mjs)$/;

export async function readPublishedIndex(path: string, legacy?: string): Promise<PublishedIndex | undefined> {
  for (const file of legacy ? [path, legacy] : [path]) {
    let index: { version: number } & Omit<PublishedIndex, "version">;
    try {
      index = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (index.version === 2) return index as PublishedIndex;
    if (index.version === 1) return { ...index, version: 2, urls: index.urls.filter((u) => !LEGACY_ASSET.test(u)) };
  }
  return undefined;
}

/** One page or URL per line, sorted, so a publish's diff of the index shows what it changed. */
export function formatPublishedIndex(index: PublishedIndex): string {
  const pages = Object.keys(index.pages)
    .sort()
    .map((url) => `    ${JSON.stringify(url)}: ${JSON.stringify(index.pages[url])}`);
  const urls = [...index.urls].sort().map((url) => `    ${JSON.stringify(url)}`);
  return `{\n  "version": ${index.version},\n  "origin": ${JSON.stringify(index.origin)},\n  "pages": {\n${pages.join(",\n")}\n  },\n  "urls": [\n${urls.join(",\n")}\n  ]\n}\n`;
}

export async function writePublishedIndex(path: string, index: PublishedIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatPublishedIndex(index));
}

function allowedBy(problem: Problem, rules: string[]): boolean {
  return rules.some((rule) => {
    const idx = rule.indexOf(":");
    const code = idx < 0 ? rule : rule.slice(0, idx);
    const glob = idx < 0 ? "**" : rule.slice(idx + 1);
    if (code !== problem.code) return false;
    const re = globToRegExp(glob);
    return [problem.url, problem.field].some((v) => v !== undefined && re.test(v));
  });
}

async function fetchSitemapUrls(url: string, depth = 0): Promise<string[]> {
  const res = await fetch(url, { headers: { "user-agent": "hotpress-check" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const root = rootElement(parseXml(await res.text()));
  if (!root) return [];
  const locs = root.children.map((c) => child(c, "loc")?.text.trim()).filter((l): l is string => Boolean(l));
  if (localName(root.name) === "sitemapindex" && depth < 2) {
    const nested = await Promise.all(locs.map((l) => fetchSitemapUrls(l, depth + 1)));
    return nested.flat();
  }
  return locs;
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const log = options.log === false ? () => {} : (m: string) => process.stdout.write(m + "\n");
  const result: CheckResult = { ok: false, problems: [], allowed: [], warnings: [], fixed: [] };
  const today = options.today ?? process.env.HOTPRESS_TODAY ?? new Date().toISOString().slice(0, 10);
  let built = await build({ root: options.root, configFile: options.configFile, mode: "production", log: options.log });
  result.build = built;
  if (!built.ok) {
    result.problems = built.problems;
    return result;
  }
  const tasks = built.config?.tasks ?? [];

  // Site tasks get the first chance to fix things; the checks below then see the rebuilt site.
  if (options.fix && tasks.length) {
    for (const task of tasks) {
      const outcome = await runTask(task, built, true, today);
      result.fixed.push(...(outcome.changed ?? []));
      result.problems.push(...(outcome.problems ?? []));
    }
    if (result.problems.length) return result;
    if (result.fixed.length) {
      log(`Site tasks updated ${result.fixed.join(", ")}; rebuilding.`);
      built = await build({ root: options.root, configFile: options.configFile, mode: "production", log: options.log });
      result.build = built;
      if (!built.ok) {
        result.problems = built.problems;
        return result;
      }
    }
  }
  const origin = built.origin!;
  const settings = built.config?.check ?? {};
  const allow = [...(settings.allow ?? []), ...(options.allow ?? [])];
  const problems: Problem[] = [];

  const files = await listFiles(built.outDir);
  const redirectsText = await readFile(join(built.outDir, "_redirects"), "utf8").catch(() => "");
  const host = new StaticHost(files, parseRedirects(redirectsText));
  const pages = new Map<string, PageSeo>();
  const noDoctype = new Set<string>();
  await mapLimit(built.pages, 32, async (p) => {
    const html = await readFile(join(built.outDir, p.file), "utf8");
    pages.set(p.file, extractPage(html));
    if (p.file.endsWith(".html") && !/^\uFEFF?\s*(<!--[\s\S]*?-->\s*)*<!doctype html[\s>]/i.test(html)) noDoctype.add(p.file);
  });

  // Links, canonicals and og:image must resolve.
  for (const link of findBrokenLinks(pages, host, [origin]).values()) {
    problems.push({ code: "link-broken", url: link.url, field: link.path, message: `${link.from} points to ${link.path}, which returns ${link.status}` });
  }

  // Indexable pages need the basics, with a canonical pointing at themselves.
  if (settings.seo !== false) {
    for (const p of built.pages) {
      const seo = pages.get(p.file)!;
      // Without a doctype, browsers render in quirks mode: a layout bug on every page, indexed or not.
      if (noDoctype.has(p.file)) problems.push({ code: "seo", url: p.url, field: "doctype", message: "missing <!DOCTYPE html>", hint: 'start the layout with {raw("<!DOCTYPE html>")}' });
      if (p.meta.noindex || seo.robots.some((r) => r.includes("noindex"))) continue;
      const self = origin + p.url;
      if (!seo.title.some(Boolean)) problems.push({ code: "seo", url: p.url, field: "title", message: "missing <title>" });
      if (!seo.description.some(Boolean)) problems.push({ code: "seo", url: p.url, field: "description", message: "missing meta description" });
      if (!seo.canonical.length) problems.push({ code: "seo", url: p.url, field: "canonical", message: "missing canonical link" });
      else if (seo.canonical[0] !== self) problems.push({ code: "seo", url: p.url, field: "canonical", message: `canonical is ${seo.canonical[0]}, expected ${self}` });
    }
  }

  // Nothing that was published may disappear without a redirect.
  const indexPath = options.publishedIndex ?? join(options.root, PUBLISHED_INDEX);
  const previous = await readPublishedIndex(indexPath, options.legacyIndex ?? join(options.root, ".hotpress-cache", "published.json"));
  const gone = (path: string) => host.finalStatus(path) !== 200;
  const removed = new Set<string>();
  for (const url of previous?.urls ?? []) if (gone(url)) removed.add(url);
  if (settings.liveSitemap !== false && !options.offline) {
    const sitemapUrl = settings.liveSitemap || `${origin}/sitemap.xml`;
    try {
      for (const loc of await fetchSitemapUrls(sitemapUrl)) {
        let u: URL;
        try {
          u = new URL(loc);
        } catch {
          continue;
        }
        if (u.origin === origin && gone(u.pathname)) removed.add(u.pathname);
      }
    } catch (error) {
      result.warnings.push({ code: "live-sitemap", message: `could not read the live sitemap (${(error as Error).message}); removed URLs were checked against the last publish only` });
    }
  } else if (options.offline) {
    result.warnings.push({ code: "live-sitemap", message: "offline: removed URLs were checked against the last publish only" });
  }
  for (const url of [...removed].sort()) {
    problems.push({ code: "url-removed", url, message: "was published but now returns 404 with no redirect", hint: "restore the page, add a redirect, or allow it explicitly" });
  }

  // Changed content needs a new updated date.
  // Bundled assets and the host's own config files are not URLs anyone links to.
  const unlisted = new Set([...built.assets, "_redirects", "_headers"]);
  const index: PublishedIndex = { version: 2, origin, pages: {}, urls: files.filter((f) => !unlisted.has(f)).map(fileToUrl) };
  for (const p of built.pages) {
    const text = sha1(pages.get(p.file)!.mainText);
    const updated = p.meta.updated instanceof Date ? p.meta.updated.toISOString() : undefined;
    index.pages[p.url] = { text, updated };
    const before = previous?.pages[p.url];
    if (before && updated && before.updated === updated && before.text !== text) {
      problems.push({ code: "date-stale", url: p.url, message: `content changed but updated is still ${updated.slice(0, 10)}`, hint: "set a new updated date for this page" });
    }
  }
  if (previous) {
    const now = Object.keys(index.pages);
    result.changes = {
      added: now.filter((u) => !previous.pages[u]).sort(),
      removed: Object.keys(previous.pages).filter((u) => !index.pages[u]).sort(),
      changed: now.filter((u) => previous.pages[u] && previous.pages[u].text !== index.pages[u].text).sort()
    };
  }
  if (!previous) result.warnings.push({ code: "first-publish", message: `no ${PUBLISHED_INDEX} yet (publish writes it); date-stale and removed-URL checks used the live sitemap only` });
  result.index = index;

  // The site's own checks: report only, so a task that still wants changes is a problem.
  for (const task of tasks) {
    const outcome = await runTask(task, built, false, today);
    problems.push(...(outcome.problems ?? []));
    if (outcome.changed?.length) {
      problems.push({ code: "task", message: `task "${task.name}" changed ${outcome.changed.join(", ")} while only checking`, hint: "tasks must only write files when ctx.fix is true" });
    }
  }

  if (options.twice) {
    // Every output file, not just pages: sitemaps, feeds and assets must be reproducible too.
    const outDir = join(".hotpress-cache", "check-twice");
    const again = await build({ root: options.root, configFile: options.configFile, mode: "production", outDir, log: false });
    if (!again.ok) {
      for (const p of again.problems) problems.push({ ...p, code: "nondeterministic", message: `the second build failed: [${p.code}] ${p.message}` });
    } else {
      for (const file of [...new Set([...Object.keys(built.files), ...Object.keys(again.files)])].sort()) {
        const a = built.files[file];
        const b = again.files[file];
        if (a === b) continue;
        const what = a === undefined ? "only the second build wrote it" : b === undefined ? "only the first build wrote it" : "two builds of the same checkout wrote different bytes";
        problems.push({ code: "nondeterministic", url: fileToUrl(file), message: what });
      }
    }
    await rm(join(options.root, outDir), { recursive: true, force: true });
  }

  for (const p of problems) (allowedBy(p, allow) ? result.allowed : result.problems).push(p);
  result.ok = result.problems.length === 0;
  log(formatCheck(result));
  return result;
}

async function runTask(task: SiteTask, built: BuildResult, fix: boolean, today: string): Promise<TaskResult> {
  const cache = new Map<string, { html: string; seo?: PageSeo }>();
  const load = (file: string) => {
    let entry = cache.get(file);
    if (!entry) cache.set(file, (entry = { html: readFileSync(join(built.outDir, file), "utf8") }));
    return entry;
  };
  const pages: TaskPage[] = built.pages.map((p) => ({
    url: p.url,
    file: p.file,
    meta: p.meta as PageMeta,
    html: () => load(p.file).html,
    mainText: () => {
      const entry = load(p.file);
      entry.seo ??= extractPage(entry.html);
      return entry.seo.mainText;
    }
  }));
  try {
    return (await task.run({ root: built.root ?? join(built.outDir, ".."), outDir: built.outDir, origin: built.origin!, fix, today, pages })) ?? {};
  } catch (error) {
    const e = error as Error;
    return { problems: [{ code: "task", message: `task "${task.name}" failed: ${e.message}`, hint: e.stack?.split("\n").slice(1, 4).join("\n").trim() }] };
  }
}

export function formatCheck(r: CheckResult, limit = 25): string {
  const lines: string[] = [];
  if (r.problems.length) {
    lines.push(`Check failed: ${plural(r.problems.length, "problem")}`);
    // The same problem on many pages is one line with a count and examples.
    const groups = new Map<string, Problem[]>();
    const generic = (text: string, url?: string) => (url && url.length > 1 ? text.split(url).join("{page}/") : text);
    for (const p of r.problems) {
      const key = `${p.code}|${p.field?.startsWith("/") ? "" : (p.field ?? "")}|${generic(p.message, p.url)}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    let shown = 0;
    for (const items of groups.values()) {
      if (shown++ >= limit) break;
      const first = items[0];
      if (items.length === 1) lines.push("  " + formatProblem(first));
      else {
        const pages = items.slice(0, 3).map((p) => p.url).join(", ");
        lines.push(`  [${first.code}] ${items.length} pages (${pages}${items.length > 3 ? ", …" : ""}): ${generic(first.message, first.url)}`);
        if (first.hint) lines.push(`    hint: ${first.hint}`);
      }
    }
    if (groups.size > limit) lines.push(`  … and ${groups.size - limit} more kinds of problem (use --json for all)`);
  } else {
    lines.push("Check passed.");
  }
  if (r.fixed.length) lines.push(`Site tasks updated: ${r.fixed.join(", ")}`);
  if (r.allowed.length) lines.push(`${plural(r.allowed.length, "known problem")} allowed by check.allow`);
  for (const w of r.warnings) lines.push(`warning: ${w.message}`);
  return lines.join("\n");
}
