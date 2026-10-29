import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
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
        return { contents: `import { clientScript } from "hotpress";\nexport default clientScript(${JSON.stringify(args.path)});\n`, loader: "js", resolveDir: state.root };
      });
    }
  };
}

let buildCounter = 0;

type MdxCompile = (source: string, file: string, options: MdxCompileOptions) => Promise<string>;
let mdxCompiler: MdxCompile | undefined;

async function loadMdx(root: string): Promise<MdxCompile> {
  if (mdxCompiler) return mdxCompiler;
  let mod: { compile: (src: string, opts: Record<string, unknown>) => Promise<{ toString(): string }> };
  try {
    const require = createRequire(join(root, "package.json"));
    mod = await import(pathToFileURL(require.resolve("@mdx-js/mdx")).href);
  } catch {
    throw new HotpressError({ code: "mdx-missing", message: "MDX files need the @mdx-js/mdx package", hint: "npm install --save-dev @mdx-js/mdx" });
  }
  mdxCompiler = async (source, file, options) => {
    const compiled = await mod.compile(source, {
      jsxImportSource: "hotpress",
      outputFormat: "program",
      development: false,
      remarkPlugins: options.remarkPlugins,
      rehypePlugins: options.rehypePlugins
    });
    return String(compiled);
  };
  return mdxCompiler;
}

function pluginKey(options: MdxCompileOptions): string {
  const names = (list?: unknown[]) => (list ?? []).map((p) => (Array.isArray(p) ? `${(p[0] as Function).name}:${JSON.stringify(p[1] ?? null)}` : (p as Function).name)).join(",");
  return `${names(options.remarkPlugins)}|${names(options.rehypePlugins)}|${options.cacheKey ?? ""}`;
}

function mdxPlugin(state: BundleState, options: MdxCompileOptions = {}): esbuild.Plugin {
  return {
    name: "hotpress-mdx",
    setup(build) {
      build.onLoad({ filter: /\.mdx$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const key = createHash("sha1").update(source).update("\0").update(pluginKey(options)).digest("hex");
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
          const compile = await loadMdx(state.root);
          let body: string;
          try {
            // Pad with newlines so MDX error line numbers match the file.
            body = await compile("\n".repeat(fm.bodyLine - 1) + fm.body, args.path, options);
          } catch (error) {
            return { errors: [{ text: (error as Error).message, location: { file: args.path } }] };
          }
          code = `export const frontmatter = ${JSON.stringify(fm.data)};\n${body}`;
          await mkdir(dirname(cached), { recursive: true });
          await writeFile(cached, code);
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
    jsxImportSource: "hotpress",
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
    const path = input.replace(/^[\w-]+:/, "");
    state.inputs.add(join(state.root, path));
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
  // Each build goes in its own content-addressed folder so Node's module cache never serves a stale copy.
  const hash = createHash("sha1");
  for (const f of result.outputFiles!) hash.update(f.path).update(f.contents);
  const dir = await writeVersioned(outdir, hash.digest("hex").slice(0, 16), result);
  try {
    return await import(`${pathToFileURL(join(dir, main)).href}?build=${++buildCounter}`);
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

/** Write a build into outdir/<version>/ and remove older versions. */
async function writeVersioned(outdir: string, version: string, result: esbuild.BuildResult): Promise<string> {
  const dir = join(outdir, version);
  await mkdir(outdir, { recursive: true });
  for (const name of await readdir(outdir)) if (name !== version) await rm(join(outdir, name), { recursive: true, force: true });
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
  const hash = createHash("sha1");
  for (const f of result.outputFiles!) hash.update(f.path).update(f.contents);
  const dir = await writeVersioned(outdir, hash.digest("hex").slice(0, 16), result);
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
      jsxImportSource: "hotpress"
    });
  } catch (error) {
    throw bundleError(error, state.root);
  }
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
): Promise<{ path: string; contents: Uint8Array }> {
  const file = join(state.root, entry);
  state.inputs.add(file);
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
      const result = await esbuild.build({ entryPoints: [file], bundle: true, minify: options.minify ?? true, write: false, logLevel: "silent", absWorkingDir: state.root, outdir: "/out", metafile: true });
      recordInputs(state, result.metafile!);
      css = result.outputFiles.find((f) => f.path.endsWith(".css"))!.contents;
    } catch (error) {
      throw bundleError(error, state.root);
    }
  }
  return { path: outputName(options.output ?? "assets/[name].[hash].css", entry, css), contents: css };
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
