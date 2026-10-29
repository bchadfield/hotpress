import { HotpressError, type Problem } from "../errors.ts";
import type { Mode } from "../jsx/context.ts";
import type { Child } from "../jsx/runtime.ts";
import type { Entry, LoadContext, Loader } from "../content/loaders.ts";
import { bundleCss, bundleScript, type AssetOptions, type BundleState } from "./bundle.ts";

export interface PageMeta {
  /** First publication date. */
  published?: Date;
  /** Last meaningful content change. Used for sitemap lastmod and the date-stale check. */
  updated?: Date;
  /** Free-form page type ("post", "area", "legal"…) for site code that varies by type. */
  type?: string;
  /** Leave out of site.pages-based sitemaps (default false). */
  noindex?: boolean;
  [key: string]: unknown;
}

export interface PageRecord {
  url: string;
  /** Output path relative to the out dir. */
  file: string;
  meta: PageMeta;
  render: () => Child;
}

export interface FileRecord {
  file: string;
  content: string | Uint8Array | (() => string | Uint8Array);
}

export interface SiteOptions {
  /** Canonical origin, e.g. "https://example.com" (no trailing slash). */
  origin: string;
  /** Pins output defaults (see design: Upgrades). Written by `hotpress init`. */
  compat?: string;
  /** Output directory (default "dist"). */
  outDir?: string;
  /** Copied into the output as-is (default "public"; false to disable). */
  publicDir?: string | false;
  /** Where client script bundles go (default "assets/js"). */
  clientDir?: string;
  build: (site: Site) => void | Promise<void>;
  /** Settings for `hotpress check` and `hotpress publish`. */
  check?: CheckSettings;
  /** The site's own pre-publish tasks: run by `hotpress check` (report only) and `publish` / `check --fix`. */
  tasks?: SiteTask[];
}

/** A built page as a task sees it. */
export interface TaskPage {
  url: string;
  /** Output file relative to the out dir. */
  file: string;
  meta: PageMeta;
  html(): string;
  /** Visible text of the main content (first <article>, else <main>, else <body>), whitespace-normalised. */
  mainText(): string;
}

export interface TaskContext {
  /** Site root (the publish worktree during publish). Tasks may write files here when `fix` is true. */
  root: string;
  outDir: string;
  origin: string;
  /** True for `publish` and `check --fix`: the task may update files. False: report only. */
  fix: boolean;
  /** The publish date, YYYY-MM-DD (UTC; HOTPRESS_TODAY overrides). Tasks read this, never the clock. */
  today: string;
  pages: TaskPage[];
}

export interface TaskResult {
  problems?: Problem[];
  /** Files the task wrote, relative to root. publish commits them with the change. */
  changed?: string[];
}

export interface SiteTask {
  name: string;
  run(ctx: TaskContext): TaskResult | void | Promise<TaskResult | void>;
}

export interface CheckSettings {
  /** Branch that publish commits to and pushes (default "main"). */
  branch?: string;
  /** Git remote (default "origin"). */
  remote?: string;
  /**
   * Known, accepted problems: "<code>:<url-or-target glob>", e.g.
   * "link-broken:/assets/images/opengraph-default.jpg". Committed, so every exception is reviewed.
   */
  allow?: string[];
  /** Sitemap URL used for the url-removed check (default "<origin>/sitemap.xml"); false to skip. */
  liveSitemap?: string | false;
  /** Require title, description and a self-referencing canonical on indexable pages (default true). */
  seo?: boolean;
}

export function defineSite(options: SiteOptions): SiteOptions {
  return options;
}

/** An output path relative to the out dir (no leading slash), which must stay inside it. */
function safeOutputPath(path: string, what: string): string {
  const segments = path.split("/");
  const bad = segments.some((segment, i) => segment === "." || segment === ".." || (segment === "" && i < segments.length - 1));
  if (bad || path.includes("\\") || path.includes("\0")) {
    throw new Error(`${what} "${path}" must not contain "." or ".." segments, empty segments ("//"), backslashes or NUL`);
  }
  return path;
}

export function urlToFile(url: string): string {
  if (!url.startsWith("/")) throw new Error(`page URL must start with "/": "${url}"`);
  if (/[?#]/.test(url)) throw new Error(`page URL "${url}" must not have a query or fragment`);
  const path = safeOutputPath(decodeURI(url).slice(1), "page URL");
  if (path === "" || path.endsWith("/")) return `${path}index.html`;
  if (/\.[A-Za-z0-9]+$/.test(path.split("/").pop()!)) return path;
  throw new Error(`page URL "${url}" must end with "/" or a file extension (e.g. "/about/" or "/404.html")`);
}

export class Site {
  readonly origin: string;
  readonly mode: Mode;
  readonly root: string;
  readonly pages: PageRecord[] = [];
  readonly files: FileRecord[] = [];
  readonly assets = new Map<string, Uint8Array>();
  private urls = new Map<string, string>();
  private problems: Problem[] = [];
  /** @internal */ readonly state: BundleState;
  /** @internal */ readonly loadContext: LoadContext;

  constructor(options: { origin: string; mode: Mode; root: string; state: BundleState; loadContext: LoadContext }) {
    this.origin = options.origin.replace(/\/+$/, "");
    this.mode = options.mode;
    this.root = options.root;
    this.state = options.state;
    this.loadContext = options.loadContext;
  }

  /** Load and validate a collection. Fails the build on any invalid entry. */
  async load<T>(loader: Loader<T>): Promise<Entry<T>[]> {
    return loader.load(this.loadContext);
  }

  private claim(file: string, what: string): boolean {
    const owner = this.urls.get(file);
    if (owner) {
      this.problems.push({ code: "duplicate-url", message: `${what} writes ${file}, already written by ${owner}`, hint: "every page and file needs its own URL" });
      return false;
    }
    this.urls.set(file, what);
    return true;
  }

  /** Add an HTML page. `render` runs during the render phase, where usePage() works. */
  page(url: string, render: () => Child, meta: PageMeta = {}): void {
    let file: string;
    try {
      file = urlToFile(url);
    } catch (error) {
      this.problems.push({ code: "bad-url", message: (error as Error).message, url });
      return;
    }
    if (this.claim(file, `page ${url}`)) this.pages.push({ url, file, meta, render });
  }

  /** Add a non-HTML file (sitemap, robots.txt, JSON…). A function is evaluated after pages render. */
  file(path: string, content: FileRecord["content"]): void {
    let file: string;
    try {
      file = safeOutputPath(path.replace(/^\/+/, ""), "file path");
      if (!file || file.endsWith("/")) throw new Error(`file path "${path}" must name a file`);
    } catch (error) {
      this.problems.push({ code: "bad-url", message: (error as Error).message, url: path });
      return;
    }
    if (this.claim(file, `file ${file}`)) this.files.push({ file, content });
  }

  /** Bundle a stylesheet and return its public URL. */
  async css(entry: string, options: AssetOptions & { build?: (file: string) => Promise<string> | string } = {}): Promise<string> {
    const out = await bundleCss(this.state, entry, options);
    if (this.claim(out.path, `stylesheet ${entry}`)) this.assets.set(out.path, out.contents);
    for (const [file, contents] of out.files) {
      // Two stylesheets may share a font: same content, same hashed name.
      if (this.assets.has(file) && Buffer.compare(this.assets.get(file)!, contents) === 0) continue;
      if (this.claim(file, `file used by stylesheet ${entry}`)) this.assets.set(file, contents);
    }
    return `/${out.path}`;
  }

  /** Bundle a site-wide script and return its public URL. */
  async script(entry: string, options: AssetOptions & { format?: "esm" | "iife" } = {}): Promise<string> {
    const out = await bundleScript(this.state, entry, options);
    if (this.claim(out.path, `script ${entry}`)) this.assets.set(out.path, out.contents);
    return `/${out.path}`;
  }

  /** @internal */
  claimFile(file: string, what: string): boolean {
    return this.claim(file, what);
  }

  /** @internal */
  throwIfProblems(): void {
    if (this.problems.length) throw new HotpressError(this.problems);
  }
}
