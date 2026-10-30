import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** Every output file (relative to outDir) and its content hash. */
  files: Record<string, string>;
  /** Bundled, content-hashed assets (CSS, scripts, their fonts and images): their URLs change with their content. */
  assets: string[];
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

/** A git checkout's own files (a gh-pages clone or worktree in the out dir, say): never listed, so never deleted. */
const GIT = ".git";

async function listDir(dir: string, base = dir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === GIT) continue;
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

export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The out dir is emptied of everything the build didn't write, so it must never hold anything else:
 * not the site, its sources or public files, and not a folder of someone else's files.
 */
async function checkOutDir(
  root: string,
  outDir: string,
  inputs: Iterable<string>,
  publicDir: string | undefined,
  outputs: Map<string, Output>,
  written: Manifest | undefined,
  legacy: Manifest | undefined
): Promise<void> {
  const fail = (message: string, hint = "build into a folder of its own, such as dist"): never => {
    throw new HotpressError({ code: "bad-out-dir", message, hint });
  };
  const rel = relative(root, outDir) || ".";
  if (isInside(root, outDir)) fail(`the out dir "${rel}" contains the site itself, and the build deletes files it didn't write`);
  if (isInside(outDir, join(root, ".git"))) fail(`the out dir "${rel}" is inside .git`);
  if (publicDir && (isInside(publicDir, outDir) || isInside(outDir, publicDir))) fail(`the out dir "${rel}" overlaps the public dir "${relative(root, publicDir)}"`);
  for (const input of inputs) {
    if (isInside(input, outDir)) fail(`the out dir "${rel}" contains ${relative(root, input)}, which the build reads`);
  }
  if (written) return;
  const existing = await listDir(outDir);
  if (!isInside(outDir, root) && existing.length) {
    fail(`the out dir "${outDir}" is outside the site, not empty, and wasn't written by a previous build`);
  }
  // With no record of a build here, a file the build would delete may be someone's own (docs/, say).
  // Older versions kept one manifest for every out dir: what it lists was written by a build. So is a file
  // the site's repository ignores in an out dir it ignores as a whole (dist/ after the cache was deleted,
  // say); not one it un-ignores or tracks.
  let strays = existing.filter((file) => !outputs.has(file) && !(legacy && Object.hasOwn(legacy.files, file)));
  if (strays.length && ignoredBuildFolder(root, outDir)) {
    const ignored = gitIgnoredFiles(root, outDir, strays);
    strays = strays.filter((file) => !ignored.has(file));
  }
  if (strays.length) {
    fail(
      `the out dir "${rel}" holds files this build didn't write and no earlier build recorded: ${strays.slice(0, 3).join(", ")}${strays.length > 3 ? `, … (${strays.length})` : ""}`,
      "build into a folder of its own, such as dist; if this folder is only an old build, delete it or add it to .gitignore"
    );
  }
}

/**
 * Whether git ignores the out dir as a folder while the site itself is not ignored: the mark of a build
 * folder (init ignores dist/). Single ignored files say nothing (people ignore notes and .env files they
 * keep), and nor does a site with no repository of its own inside a folder another repository ignores.
 */
function ignoredBuildFolder(root: string, outDir: string): boolean {
  const ignored = (path: string): boolean | undefined => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: root, stdio: "ignore" });
      return true;
    } catch (error) {
      // 1: not ignored; anything else (no git, not a repository): unknown.
      return (error as { status?: number }).status === 1 ? false : undefined;
    }
  };
  return ignored(".") === false && ignored(`${relative(root, outDir).split(sep).join("/")}/`) === true;
}

/**
 * Which of `files` (relative to outDir) the site's repository ignores. Asked from the root, so a checkout
 * inside the out dir (a gh-pages clone) doesn't answer for it; tracked files are never ignored.
 */
function gitIgnoredFiles(root: string, outDir: string, files: string[]): Set<string> {
  const prefix = `${relative(root, outDir).split(sep).join("/")}/`;
  try {
    const out = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      cwd: root,
      input: files.map((file) => `${prefix}${file}\0`).join(""),
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["pipe", "pipe", "ignore"]
    });
    return new Set(out.split("\0").filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)));
  } catch {
    // Exit code 1: none of them is ignored.
    return new Set();
  }
}

async function removeEmptyDirs(dir: string, root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory() && e.name !== GIT) await removeEmptyDirs(join(dir, e.name), root);
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
  const result: BuildResult = { ok: false, outDir: "", problems: [], inputs: state.inputs, pages: [], files: {}, assets: [], root, durationMs: 0 };

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
    const outDir = resolve(root, options.outDir ?? config.outDir ?? "dist");
    result.outDir = outDir;
    result.config = config;
    result.origin = config.origin.replace(/\/+$/, "");

    const site = new Site({
      origin: config.origin,
      mode,
      root,
      state,
      loadContext: { root, cacheDir, importMdx: (files, mdx) => importMdxFiles(state, files, mdx), track: (file) => void state.inputs.add(file) }
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

    // One manifest per output directory: it records what is on disk there, and dev builds elsewhere.
    const manifestPath = join(cacheDir, `build-manifest-${sha1(outDir).slice(0, 12)}.json`);
    const previous = await readJson<Manifest>(manifestPath);
    const legacy = previous ? undefined : await readJson<Manifest>(join(cacheDir, "build-manifest.json"));
    await checkOutDir(root, outDir, state.inputs, publicDir, outputs, previous, legacy);
    const { report, files } = await writeOutputs(outDir, cacheDir, manifestPath, previous, outputs, pageHashes, new Set(site.pages.map((p) => p.file)), mode);
    result.report = report;
    result.files = files;
    result.assets = [...site.assets.keys()].sort();
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
  manifestPath: string,
  previous: Manifest | undefined,
  outputs: Map<string, Output>,
  pageHashes: Record<string, string>,
  pageFiles: Set<string>,
  mode: Mode
): Promise<{ report: ChangeReport; files: Record<string, string> }> {
  const indexPath = join(cacheDir, `pages-${mode}.json`);
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
    const lastPageFiles = new Set(
      Object.keys(last.pages).flatMap((url) => {
        try {
          return [urlToFile(url)];
        } catch {
          return []; // a URL an older version accepted
        }
      })
    );
    for (const file of new Set([...Object.keys(files), ...Object.keys(last.files)])) {
      if (pageFiles.has(file) || lastPageFiles.has(file)) continue;
      if (files[file] !== last.files[file]) report.files.push(file);
    }
    report.files.sort();
  }
  report.added.sort();
  report.removed.sort();
  report.changed.sort();
  return { report, files };
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
