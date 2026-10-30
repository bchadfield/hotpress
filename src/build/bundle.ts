import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { HotpressError } from "../errors.ts";
import { parseFrontmatter } from "../content/frontmatter.ts";
import type { MdxCompileOptions } from "../content/loaders.ts";

// `import handle from "./widget.ts?client"` gives a ClientScript handle instead of the module.
const CLIENT_RE = /\?client$/;

export interface BundleState {
  root: string;
  cacheDir: string;
  /** Absolute paths of client scripts imported from server code. */
  clientScripts: Set<string>;
  /** Absolute paths of every source file the server bundles read. */
  inputs: Set<string>;
}

function clientPlugin(state: BundleState): esbuild.Plugin {
  return {
    name: "hotpress-client",
    setup(build) {
      build.onResolve({ filter: CLIENT_RE }, async (args) => {
        if (args.namespace === "hotpress-client" || args.pluginData?.skipClient) return undefined;
        const resolved = await build.resolve(args.path.replace(CLIENT_RE, ""), { resolveDir: args.resolveDir, kind: args.kind, namespace: "file", pluginData: { skipClient: true } });
        if (resolved.errors.length) return { errors: resolved.errors };
        return { path: resolved.path, namespace: "hotpress-client" };
      });
      build.onLoad({ filter: /.*/, namespace: "hotpress-client" }, (args) => {
        state.clientScripts.add(args.path);
        return { contents: `import { clientScript } from "${PACKAGE}";\nexport default clientScript(${JSON.stringify(args.path)});\n`, loader: "js", resolveDir: state.root };
      });
    }
  };
}

// The package name sites import, for generated imports and the JSX runtime.
const PACKAGE = "@benchadfield/hotpress";

let buildCounter = 0;
let tempCounter = 0;

interface MdxCompiler {
  compile: (source: string, file: string, options: MdxCompileOptions) => Promise<string>;
  /** What the compiled output depends on besides the source and plugins: the compiler and the JSX runtime. */
  id: string;
}

// One per installed copy of @mdx-js/mdx: two sites in one process may use different versions.
const mdxCompilers = new Map<string, Promise<MdxCompiler>>();

/** The version from the package.json that owns a resolved file. */
function packageVersion(file: string, name: string): string {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const pkg = join(dir, "package.json");
    if (!existsSync(pkg)) continue;
    const json = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string };
    if (json.name === name) return json.version ?? "";
  }
  return "";
}

async function loadMdx(root: string): Promise<MdxCompiler> {
  let path: string;
  try {
    path = createRequire(join(root, "package.json")).resolve("@mdx-js/mdx");
  } catch {
    throw new HotpressError({ code: "mdx-missing", message: "MDX files need the @mdx-js/mdx package", hint: "npm install --save-dev @mdx-js/mdx" });
  }
  let compiler = mdxCompilers.get(path);
  if (!compiler) {
    compiler = (async () => {
      const mod = (await import(pathToFileURL(path).href)) as { compile: (src: string, opts: Record<string, unknown>) => Promise<{ toString(): string }> };
      return {
        id: `${MDX_CACHE_FORMAT}|@mdx-js/mdx@${packageVersion(path, "@mdx-js/mdx")}|${PACKAGE}`,
        async compile(source, _file, options) {
          const compiled = await mod.compile(source, {
            jsxImportSource: PACKAGE,
            outputFormat: "program",
            development: false,
            remarkPlugins: options.remarkPlugins,
            rehypePlugins: options.rehypePlugins
          });
          return String(compiled);
        }
      };
    })();
    mdxCompilers.set(path, compiler);
  }
  return compiler;
}

/** Bump when the cached form of compiled MDX changes. */
const MDX_CACHE_FORMAT = 2;

/**
 * Plugins by what they do, not just their name: a function's source text, and its options with nested
 * functions and regular expressions written out (JSON would drop them, so changing one would reuse stale output).
 */
function pluginKey(options: MdxCompileOptions): string {
  const describe = (value: unknown, seen = new Set<unknown>()): string => {
    if (typeof value === "function") return `fn:${value.toString()}`;
    if (value instanceof RegExp) return `re:${value.toString()}`;
    if (Array.isArray(value)) return `[${value.map((v) => describe(v, seen)).join(",")}]`;
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${describe((value as Record<string, unknown>)[k], seen)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? String(value);
  };
  return `${describe(options.remarkPlugins ?? [])}|${describe(options.rehypePlugins ?? [])}|${options.cacheKey ?? ""}`;
}

function mdxPlugin(state: BundleState, options: MdxCompileOptions = {}): esbuild.Plugin {
  return {
    name: "hotpress-mdx",
    setup(build) {
      // The same for every file in this build: worked out once, on the first MDX file.
      let compilerPromise: Promise<MdxCompiler> | undefined;
      let plugins: string | undefined;
      build.onLoad({ filter: /\.mdx$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const compiler = await (compilerPromise ??= loadMdx(state.root));
        plugins ??= pluginKey(options);
        const key = createHash("sha1").update(source).update("\0").update(plugins).update("\0").update(compiler.id).digest("hex");
        const cached = join(state.cacheDir, "mdx", `${key}.js`);
        let code: string;
        try {
          code = await readFile(cached, "utf8");
        } catch {
          let fm;
          try {
            fm = parseFrontmatter(source);
          } catch (error) {
            return { errors: [{ text: `frontmatter: ${(error as Error).message}` }] };
          }
          let body: string;
          try {
            // Pad with newlines so MDX error line numbers match the file.
            body = await compiler.compile("\n".repeat(fm.bodyLine - 1) + fm.body, args.path, options);
          } catch (error) {
            return { errors: [{ text: (error as Error).message, location: { file: args.path } }] };
          }
          code = `export const frontmatter = ${JSON.stringify(fm.data)};\n${body}`;
          // Written whole, then renamed into place: another build may be reading the cache at the same time.
          // The temp name is unique per write, since two files with the same source share a key.
          await mkdir(dirname(cached), { recursive: true });
          const temp = `${cached}.${process.pid}-${++tempCounter}.tmp`;
          await writeFile(temp, code);
          await rename(temp, cached);
        }
        return { contents: code, loader: "js", resolveDir: dirname(args.path) };
      });
    }
  };
}

function serverOptions(state: BundleState, mdx: MdxCompileOptions = {}): esbuild.BuildOptions {
  return {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    jsx: "automatic",
    jsxImportSource: PACKAGE,
    loader: { ".svg": "text", ".txt": "text", ".md": "text", ".html": "text" },
    absWorkingDir: state.root,
    metafile: true,
    logLevel: "silent",
    // .mjs so the bundle is ESM whatever the site's package.json "type" says.
    outExtension: { ".js": ".mjs" },
    plugins: [clientPlugin(state), mdxPlugin(state, mdx)]
  };
}

function bundleError(error: unknown, root: string): HotpressError {
  const failure = error as esbuild.BuildFailure;
  if (failure.errors) {
    return new HotpressError(
      failure.errors.map((e) => ({
        code: "compile",
        message: e.text,
        file: e.location ? relative(root, join(root, e.location.file)) : undefined,
        line: e.location?.line
      }))
    );
  }
  return error as HotpressError;
}

function recordInputs(state: BundleState, meta: esbuild.Metafile): void {
  for (const input of Object.keys(meta.inputs)) {
    // Keys are relative to the working dir, or absolute behind a plugin namespace ("hotpress-client:/…").
    const path = input.replace(/^[\w-]+:/, "");
    state.inputs.add(resolve(state.root, path));
  }
}

/** Bundle and import the site module. */
export async function importSiteModule(state: BundleState, entry: string): Promise<Record<string, unknown>> {
  const outdir = join(state.cacheDir, "site");
  let result: esbuild.BuildResult;
  try {
    // One file, no shared chunks: every build imports a fresh copy (see importOutputs), so module-level
    // caches in site code can never survive into the next build.
    result = await esbuild.build({ ...serverOptions(state), entryPoints: [entry], outdir, entryNames: "site", write: false });
  } catch (error) {
    throw bundleError(error, state.root);
  }
  recordInputs(state, result.metafile!);
  return importOutputs(result, outdir, "site.mjs");
}

async function importOutputs(result: esbuild.BuildResult, outdir: string, main: string): Promise<Record<string, unknown>> {
  const dir = await writeVersioned(outdir, result);
  try {
    return await import(pathToFileURL(join(dir, main)).href);
  } catch (error) {
    const e = error as Error & { code?: string };
    throw new HotpressError({
      code: "import",
      message: `loading the site module failed: ${e.message}`,
      hint:
        e.code === "ERR_UNKNOWN_FILE_EXTENSION"
          ? "a package import of a non-JS file (image, CSS) can't run in Node; reference the file by URL, e.g. copy it to public/"
          : e.stack?.split("\n").slice(1, 4).join("\n").trim()
    });
  }
}

/** How long another process's bundle folder is kept: long enough for any build still importing from it. */
const FOREIGN_BUNDLE_MS = 10 * 60_000;

/**
 * Write a bundle into a folder of its own, outdir/<pid>-<n>/. Each build gets a new folder, so Node's module
 * cache never serves a module (or a shared chunk) from an earlier build, and two processes sharing the
 * cache (dev next to check) never write or delete each other's files: this process's older folders go now,
 * another's only once it can no longer be loading them.
 */
async function writeVersioned(outdir: string, result: esbuild.BuildResult): Promise<string> {
  const name = `${process.pid}-${++buildCounter}`;
  const dir = join(outdir, name);
  await mkdir(outdir, { recursive: true });
  const now = Date.now();
  for (const entry of await readdir(outdir)) {
    if (entry === name) continue;
    const full = join(outdir, entry);
    const mine = entry.startsWith(`${process.pid}-`);
    try {
      if (mine || now - (await stat(full)).mtimeMs > FOREIGN_BUNDLE_MS) await rm(full, { recursive: true, force: true });
    } catch {}
  }
  for (const f of result.outputFiles!) {
    const target = join(dir, relative(outdir, f.path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.contents);
  }
  return dir;
}

/** Compile and import a set of MDX files in one bundle (shared chunks for components). */
export async function importMdxFiles(state: BundleState, files: string[], mdx: MdxCompileOptions = {}): Promise<Map<string, { default: (props?: Record<string, unknown>) => unknown; frontmatter?: unknown }>> {
  const out = new Map();
  if (!files.length) return out;
  const outdir = join(state.cacheDir, "mdx-bundle");
  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      ...serverOptions(state, mdx),
      entryPoints: files,
      outdir,
      outbase: state.root,
      entryNames: "[dir]/[name]",
      splitting: true,
      write: false
    });
  } catch (error) {
    throw bundleError(error, state.root);
  }
  recordInputs(state, result.metafile!);
  const dir = await writeVersioned(outdir, result);
  for (const [outPath, meta] of Object.entries(result.metafile!.outputs)) {
    if (!meta.entryPoint) continue;
    const source = join(state.root, meta.entryPoint);
    const target = join(dir, relative(outdir, join(state.root, outPath)));
    out.set(source, await import(pathToFileURL(target).href));
  }
  return out;
}

export interface ClientBundle {
  /** Source path -> public URL. */
  urls: Map<string, string>;
  /** Public path (no leading slash) -> contents. */
  files: Map<string, Uint8Array>;
}

/** Bundle client scripts for the browser with shared, hashed chunks. */
export async function bundleClientScripts(state: BundleState, entries: string[], assetDir: string, minify: boolean): Promise<ClientBundle> {
  const urls = new Map<string, string>();
  const files = new Map<string, Uint8Array>();
  if (!entries.length) return { urls, files };
  const outdir = join(state.root, "__hotpress_out__", assetDir);
  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      entryPoints: [...entries].sort(),
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      target: "es2020",
      minify,
      outdir,
      entryNames: "[name].[hash]",
      chunkNames: "chunk.[hash]",
      absWorkingDir: state.root,
      metafile: true,
      write: false,
      logLevel: "silent",
      jsx: "automatic",
      jsxImportSource: PACKAGE
    });
  } catch (error) {
    throw bundleError(error, state.root);
  }
  recordInputs(state, result.metafile!);
  const base = join(state.root, "__hotpress_out__");
  for (const f of result.outputFiles!) files.set(relative(base, f.path).split("\\").join("/"), f.contents);
  for (const [outPath, meta] of Object.entries(result.metafile!.outputs)) {
    if (!meta.entryPoint) continue;
    const rel = relative(base, join(state.root, outPath)).split("\\").join("/");
    urls.set(join(state.root, meta.entryPoint), `/${rel}`);
  }
  return { urls, files };
}

export interface AssetOptions {
  /** Output path pattern; [name] and [hash] are replaced. Default "assets/[name].[hash].<ext>". */
  output?: string;
  minify?: boolean;
}

/** url(/x.png) and @import "/x.css" in a stylesheet name files the site serves itself (public/): keep them. */
const rootRelativeUrls: esbuild.Plugin = {
  name: "hotpress-root-relative",
  setup(build) {
    build.onResolve({ filter: /^\// }, (args) => (args.kind === "url-token" || args.kind === "import-rule" ? { path: args.path, external: true } : undefined));
  }
};

/** Files a stylesheet references with url() (fonts, images), copied next to it with hashed names. */
const CSS_FILE_LOADERS: Record<string, esbuild.Loader> = Object.fromEntries(
  [".woff2", ".woff", ".ttf", ".otf", ".eot", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".cur"].map((ext) => [ext, "file"])
);

function outputName(pattern: string, entry: string, contents: Uint8Array): string {
  const name = entry.split("/").pop()!.replace(/\.[^.]+$/, "");
  const hash = createHash("sha256").update(contents).digest("base64url").slice(0, 10);
  return pattern.replace("[name]", name).replace("[hash]", hash).replace(/^\/+/, "");
}

/** Bundle a CSS entry with esbuild (or a site-provided build function). */
export async function bundleCss(
  state: BundleState,
  entry: string,
  options: AssetOptions & { build?: (file: string) => Promise<string> | string }
): Promise<{ path: string; contents: Uint8Array; files: Map<string, Uint8Array> }> {
  const file = join(state.root, entry);
  state.inputs.add(file);
  const pattern = options.output ?? "assets/[name].[hash].css";
  const files = new Map<string, Uint8Array>();
  let css: Uint8Array;
  if (options.build) {
    let text = await options.build(file);
    if (options.minify !== false) {
      try {
        text = (await esbuild.transform(text, { loader: "css", minify: true, logLevel: "silent" })).code;
      } catch (error) {
        throw bundleError(error, state.root);
      }
    }
    css = new TextEncoder().encode(text);
  } else {
    try {
      // Root-relative url()s point at files the site serves itself (public/): leave them alone.
      // Relative ones are bundled as hashed files beside the stylesheet's own output folder.
      const dir = dirname(pattern.replace(/^\/+/, ""));
      const result = await esbuild.build({
        entryPoints: [file],
        bundle: true,
        minify: options.minify ?? true,
        write: false,
        logLevel: "silent",
        absWorkingDir: state.root,
        outdir: "/out",
        metafile: true,
        plugins: [rootRelativeUrls],
        loader: CSS_FILE_LOADERS,
        assetNames: `${dir === "." ? "" : `${dir}/`}[name].[hash]`,
        publicPath: "/"
      });
      recordInputs(state, result.metafile!);
      const main = result.outputFiles.find((f) => f.path.endsWith(".css") && dirname(f.path) === "/out")!;
      css = main.contents;
      for (const f of result.outputFiles) if (f !== main) files.set(relative("/out", f.path).split("\\").join("/"), f.contents);
    } catch (error) {
      throw bundleError(error, state.root);
    }
  }
  return { path: outputName(pattern, entry, css), contents: css, files };
}

/** Bundle a page-wide script entry (not per component). */
export async function bundleScript(state: BundleState, entry: string, options: AssetOptions & { format?: "esm" | "iife" }): Promise<{ path: string; contents: Uint8Array }> {
  const file = join(state.root, entry);
  try {
    const result = await esbuild.build({
      entryPoints: [file],
      bundle: true,
      minify: options.minify ?? true,
      format: options.format ?? "esm",
      target: "es2020",
      write: false,
      logLevel: "silent",
      absWorkingDir: state.root,
      outdir: "/out",
      metafile: true
    });
    recordInputs(state, result.metafile!);
    const js = result.outputFiles.find((f) => f.path.endsWith(".js"))!.contents;
    return { path: outputName(options.output ?? "assets/[name].[hash].js", entry, js), contents: js };
  } catch (error) {
    throw bundleError(error, state.root);
  }
}

export async function clearCache(cacheDir: string): Promise<void> {
  await rm(cacheDir, { recursive: true, force: true });
}
