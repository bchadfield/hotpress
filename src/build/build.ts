import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { HotpressError, formatProblems, type Problem } from "../errors.ts";
import { withPage, type Mode } from "../jsx/context.ts";
import { render } from "../jsx/runtime.ts";
import { mapLimit, plural, sha1 } from "../util.ts";
import { bundleClientScripts, importMdxFiles, importSiteModule, type BundleState } from "./bundle.ts";
import { setClientScriptUrls } from "./scripts.ts";
import { Site, urlToFile, type SiteOptions } from "./site.ts";

export const SITE_FILES = ["hotpress.site.tsx", "hotpress.site.ts", "hotpress.site.jsx", "hotpress.site.js"];
const MANIFEST_VERSION = 1;

export interface BuildOptions {
  root: string;
  configFile?: string;
  outDir?: string;
  mode?: "production" | "preview";
  /** Print progress and the change report (default true). */
  log?: boolean;
}

export interface ChangeReport {
  first: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  /** Non-page output files that changed, were added or removed. */
  files: string[];
}

export interface BuildResult {
  ok: boolean;
  outDir: string;
  problems: Problem[];
  report?: ChangeReport;
  /** Every source file the build read (for watching). */
  inputs: Set<string>;
  pages: { url: string; file: string; hash: string; meta: Record<string, unknown> }[];
  /** The site module's options (for check/publish settings). */
  config?: SiteOptions;
  origin?: string;
  /** Site root the build ran in. */
  root?: string;
  durationMs: number;
}

/** What is on disk in the out dir (decides which files need writing). */
interface Manifest {
  version: number;
  files: Record<string, string>;
}

/** Page hashes from the last build in a mode (the change report compares like with like). */
interface PageIndex {
  version: number;
  pages: Record<string, string>;
  files: Record<string, string>;
}

interface Output {
  data?: Uint8Array | string;
  copyFrom?: string;
  hash?: string;
}

export function findSiteFile(root: string, configFile?: string): string {
  if (configFile) return join(root, configFile);
  for (const name of SITE_FILES) if (existsSync(join(root, name))) return join(root, name);
  throw new HotpressError({ code: "no-site", message: `no site module found in ${root}`, hint: `create ${SITE_FILES[0]} (see the README quick start)` });
}

async function listDir(dir: string, base = dir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listDir(full, base)));
    else if (e.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

async function readJson<T extends { version: number }>(path: string): Promise<T | undefined> {
  try {
    const m = JSON.parse(await readFile(path, "utf8")) as T;
    return m.version === MANIFEST_VERSION ? m : undefined;
  } catch {
    return undefined;
  }
}

async function removeEmptyDirs(dir: string, root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(join(dir, e.name), root);
  if (dir !== root && (await readdir(dir)).length === 0) await rmdir(dir);
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  // Dates must format the same on every machine; CI runs in UTC.
  process.env.TZ = "UTC";
  const log = options.log !== false ? (msg: string) => process.stdout.write(msg + "\n") : () => {};
  const root = options.root;
  const cacheDir = join(root, ".hotpress-cache");
  const state: BundleState = { root, cacheDir, clientScripts: new Set(), inputs: new Set() };
  const mode: Mode = options.mode === "preview" ? "preview" : "build";
  const result: BuildResult = { ok: false, outDir: "", problems: [], inputs: state.inputs, pages: [], root, durationMs: 0 };

  try {
    const siteFile = findSiteFile(root, options.configFile);
    const mod = await importSiteModule(state, siteFile);
    const config = mod.default as SiteOptions | undefined;
    if (!config || typeof config.build !== "function" || typeof config.origin !== "string") {
      throw new HotpressError({ code: "bad-site", message: "the site module must `export default defineSite({ origin, build })`", file: relative(root, siteFile) });
    }
    if (!/^https?:\/\/[^/]+$/.test(config.origin.replace(/\/+$/, ""))) {
      throw new HotpressError({ code: "bad-origin", message: `origin must be like "https://example.com", got "${config.origin}"`, file: relative(root, siteFile) });
    }
    const outDir = join(root, options.outDir ?? config.outDir ?? "dist");
    result.outDir = outDir;
    result.config = config;
    result.origin = config.origin.replace(/\/+$/, "");

    const site = new Site({
      origin: config.origin,
      mode,
      root,
      state,
      loadContext: { root, cacheDir, importMdx: (files, mdx) => importMdxFiles(state, files, mdx) }
    });
    try {
      await config.build(site);
    } catch (error) {
      const err = error as HotpressError;
      if (err.hotpress) throw err;
      const e = error as Error;
      throw new HotpressError({ code: "site-code", message: e.message, file: relative(root, siteFile), hint: e.stack?.split("\n").slice(1, 5).join("\n").trim() });
    }
    site.throwIfProblems();

    // Client scripts are known once every server module has been bundled.
    const clientDir = (config.clientDir ?? "assets/js").replace(/^\/+|\/+$/g, "");
    const client = await bundleClientScripts(state, [...state.clientScripts], clientDir, true);
    setClientScriptUrls(client.urls);
    for (const [file, contents] of client.files) if (site.claimFile(file, "client script bundle")) site.assets.set(file, contents);
    site.throwIfProblems();

    const outputs = new Map<string, Output>();
    const problems: Problem[] = [];
    const pageHashes: Record<string, string> = {};
    for (const page of site.pages) {
      try {
        const html = withPage(
          { url: page.url, href: site.origin + page.url, origin: site.origin, mode, meta: page.meta, scripts: new Set() },
          () => render(page.render())
        );
        const hash = sha1(html);
        outputs.set(page.file, { data: html, hash });
        pageHashes[page.url] = hash;
        result.pages.push({ url: page.url, file: page.file, hash, meta: page.meta });
      } catch (error) {
        const err = error as Error;
        problems.push({ code: "render", message: err.message, url: page.url, hint: err.stack?.split("\n").slice(1, 4).join("\n").trim() });
      }
    }
    for (const f of site.files) {
      try {
        outputs.set(f.file, { data: typeof f.content === "function" ? f.content() : f.content });
      } catch (error) {
        problems.push({ code: "render", message: (error as Error).message, file: f.file });
      }
    }
    for (const [file, contents] of site.assets) outputs.set(file, { data: contents });
    if (problems.length) throw new HotpressError(problems);

    const publicDir = config.publicDir === false ? undefined : join(root, config.publicDir ?? "public");
    if (publicDir) {
      for (const file of await listDir(publicDir)) {
        if (outputs.has(file)) {
          problems.push({ code: "duplicate-url", message: `public/${file} clashes with a generated file of the same path` });
          continue;
        }
        outputs.set(file, { copyFrom: join(publicDir, file) });
      }
      if (problems.length) throw new HotpressError(problems);
    }

    const report = await writeOutputs(outDir, cacheDir, outputs, pageHashes, new Set(site.pages.map((p) => p.file)), mode);
    result.report = report;
    result.ok = true;
    result.durationMs = Date.now() - started;
    log(`Built ${plural(site.pages.length, "page")} and ${plural(outputs.size - site.pages.length, "other file")} in ${(result.durationMs / 1000).toFixed(1)}s → ${relative(root, outDir) || "."}`);
    log(formatChangeReport(report));
  } catch (error) {
    const err = error as HotpressError;
    if (!err.hotpress) throw error;
    result.problems = err.problems;
    result.durationMs = Date.now() - started;
    log(`Build failed: ${formatProblems(err.problems)}`);
  }
  return result;
}

async function writeOutputs(
  outDir: string,
  cacheDir: string,
  outputs: Map<string, Output>,
  pageHashes: Record<string, string>,
  pageFiles: Set<string>,
  mode: Mode
): Promise<ChangeReport> {
  // One manifest per output directory: it records what is on disk there, and dev builds elsewhere.
  const manifestPath = join(cacheDir, `build-manifest-${sha1(outDir).slice(0, 12)}.json`);
  const indexPath = join(cacheDir, `pages-${mode}.json`);
  const previous = await readJson<Manifest>(manifestPath);
  const last = await readJson<PageIndex>(indexPath);
  const files: Record<string, string> = {};
  await mapLimit([...outputs], 64, async ([file, out]) => {
    const data = out.data ?? (await readFile(out.copyFrom!));
    const hash = out.hash ?? sha1(data);
    files[file] = hash;
    const target = join(outDir, file);
    if (previous?.files[file] === hash) {
      try {
        const st = await stat(target);
        if (st.size === Buffer.byteLength(data as string)) return;
      } catch {}
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  });
  for (const file of await listDir(outDir)) if (!outputs.has(file)) await rm(join(outDir, file), { force: true });
  await removeEmptyDirs(outDir, outDir);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ version: MANIFEST_VERSION, files } satisfies Manifest));
  await writeFile(indexPath, JSON.stringify({ version: MANIFEST_VERSION, pages: pageHashes, files } satisfies PageIndex));

  const report: ChangeReport = { first: !last, added: [], removed: [], changed: [], unchanged: 0, files: [] };
  if (last) {
    for (const [url, hash] of Object.entries(pageHashes)) {
      if (!(url in last.pages)) report.added.push(url);
      else if (last.pages[url] !== hash) report.changed.push(url);
      else report.unchanged++;
    }
    for (const url of Object.keys(last.pages)) if (!(url in pageHashes)) report.removed.push(url);
    const lastPageFiles = new Set(Object.keys(last.pages).map(urlToFile));
    for (const file of new Set([...Object.keys(files), ...Object.keys(last.files)])) {
      if (pageFiles.has(file) || lastPageFiles.has(file)) continue;
      if (files[file] !== last.files[file]) report.files.push(file);
    }
    report.files.sort();
  }
  report.added.sort();
  report.removed.sort();
  report.changed.sort();
  return report;
}

export function formatChangeReport(r: ChangeReport, max = 10): string {
  if (r.first) return "Changes: first build (no previous build to compare with).";
  const list = (label: string, items: string[]) =>
    items.length ? [`  ${label} (${items.length}):`, ...items.slice(0, max).map((i) => `    ${i}`), ...(items.length > max ? [`    … ${items.length - max} more`] : [])] : [];
  const lines = [
    `Changes since last build: ${r.changed.length} changed, ${r.added.length} added, ${r.removed.length} removed, ${r.unchanged} unchanged pages; ${plural(r.files.length, "other file")} changed.`,
    ...list("changed", r.changed),
    ...list("added", r.added),
    ...list("removed", r.removed),
    ...list("other files", r.files)
  ];
  return lines.join("\n");
}
