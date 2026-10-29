import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import MarkdownIt from "markdown-it";
import { HotpressError, type Problem } from "../errors.ts";
import { raw, type Html } from "../jsx/runtime.ts";
import { parseCsv } from "./csv.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { validate, type Field, type Infer, type Issue, type ObjectField, type Shape } from "./schema.ts";

export interface Entry<T = Record<string, unknown>> {
  /** Stable id: path within the collection without extension, or the row's slug/index. */
  id: string;
  slug: string;
  data: T;
  /** Rendered body for Markdown and MDX entries. */
  body?: Html;
  /** For MDX entries: the compiled component, to render with custom components. */
  Content?: (props?: Record<string, unknown>) => Html;
  source: { file: string; line?: number };
}

export interface LoadContext {
  root: string;
  cacheDir: string;
  /** Compile and import MDX files (provided by the build, which owns esbuild). */
  importMdx(
    files: string[],
    options?: MdxCompileOptions
  ): Promise<Map<string, { default: (props?: Record<string, unknown>) => unknown; frontmatter?: unknown }>>;
}

export interface Loader<T> {
  kind: string;
  describe: string;
  load(ctx: LoadContext): Promise<Entry<T>[]>;
}

type SchemaInput = Shape | ObjectField<Shape>;
type Out<S, Fallback> = S extends ObjectField<infer X> ? Infer<X> : S extends Shape ? Infer<S> : Fallback;

export interface CommonOptions<S extends SchemaInput | undefined, T> {
  schema?: S;
  /** Derive or reshape fields after validation. Throw to fail the build for this entry. */
  transform?: (data: Out<S, Record<string, unknown>>, info: { id: string; file: string; line?: number }) => T;
  /** Field that holds the slug (default "slug"); falls back to the id's last segment. */
  slugField?: string;
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

async function walk(dir: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  async function go(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (error) {
      throw new HotpressError({ code: "source-missing", message: `cannot read directory`, file: d, hint: String((error as Error).message) });
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await go(full);
      else if (exts.includes(extname(e.name).toLowerCase())) out.push(full);
    }
  }
  await go(dir);
  return out.sort();
}

function finish<T>(
  kind: string,
  rows: { id: string; file: string; line?: number; data: Record<string, unknown>; extra?: Partial<Entry<T>> }[],
  options: CommonOptions<SchemaInput | undefined, T>
): Entry<T>[] {
  const problems: Problem[] = [];
  const entries: Entry<T>[] = [];
  const slugs = new Map<string, string>();
  for (const row of rows) {
    const where = { file: row.file, line: row.line };
    let data: Record<string, unknown> = row.data;
    if (options.schema) {
      const { value, issues } = validate(options.schema as Shape, row.data);
      if (issues.length) {
        problems.push(...issues.map((i: Issue) => ({ code: "schema", message: i.message, field: i.path, ...where })));
        continue;
      }
      data = value as Record<string, unknown>;
    }
    let final: unknown = data;
    if (options.transform) {
      try {
        final = options.transform(data as never, { id: row.id, ...where });
      } catch (error) {
        problems.push({ code: "transform", message: (error as Error).message, ...where });
        continue;
      }
    }
    const slugField = options.slugField ?? "slug";
    const fromData = (final as Record<string, unknown>)?.[slugField];
    const slug = typeof fromData === "string" && fromData ? fromData : basename(row.id).replace(DATE_PREFIX, "");
    const clash = slugs.get(slug);
    if (clash) {
      problems.push({ code: "duplicate-slug", message: `slug "${slug}" is also used by ${clash}`, ...where });
      continue;
    }
    slugs.set(slug, row.line ? `${row.file}:${row.line}` : row.file);
    entries.push({ id: row.id, slug, data: final as T, source: where, ...row.extra });
  }
  if (problems.length) throw new HotpressError(problems);
  return entries;
}

export type MarkdownRenderer = (source: string, entry: { id: string; file: string; data: Record<string, unknown> }) => string;

const defaultMarkdown = new MarkdownIt({ html: true });

export interface MarkdownOptions<S extends SchemaInput | undefined, T> extends CommonOptions<S, T> {
  /** Render function for the body. Default: markdown-it with HTML enabled. */
  render?: MarkdownRenderer;
  extensions?: string[];
}

/** A folder of Markdown files with YAML frontmatter. */
export function markdown<S extends SchemaInput | undefined = undefined, T = Out<S, Record<string, unknown>>>(
  dir: string,
  options: MarkdownOptions<S, T> = {}
): Loader<T> {
  return {
    kind: "markdown",
    describe: dir,
    async load(ctx) {
      const files = await walk(join(ctx.root, dir), options.extensions ?? [".md", ".markdown"]);
      const problems: Problem[] = [];
      const rows = [];
      for (const full of files) {
        const file = toPosix(relative(ctx.root, full));
        const id = toPosix(relative(join(ctx.root, dir), full)).replace(/\.[^.]+$/, "");
        try {
          const fm = parseFrontmatter(await readFile(full, "utf8"));
          rows.push({ id, file, data: fm.data, body: fm.body });
        } catch (error) {
          problems.push({ code: "frontmatter", message: (error as Error).message, file });
        }
      }
      if (problems.length) throw new HotpressError(problems);
      const render = options.render ?? ((src: string) => defaultMarkdown.render(src));
      const entries = finish(
        "markdown",
        rows.map((r) => ({ id: r.id, file: r.file, data: r.data })),
        options as CommonOptions<SchemaInput | undefined, T>
      );
      const bodies = new Map(rows.map((r) => [r.id, r]));
      for (const entry of entries) {
        const row = bodies.get(entry.id)!;
        entry.body = raw(render(row.body, { id: entry.id, file: row.file, data: entry.data as Record<string, unknown> }));
      }
      return entries;
    }
  };
}

export interface MdxCompileOptions {
  /** remark plugins (e.g. remark-gfm), as accepted by @mdx-js/mdx. */
  remarkPlugins?: unknown[];
  /** rehype plugins (e.g. rehype-slug), as accepted by @mdx-js/mdx. */
  rehypePlugins?: unknown[];
  /** Change this when plugin options change, so cached compiles are not reused. */
  cacheKey?: string;
}

export interface MdxOptions<S extends SchemaInput | undefined, T> extends CommonOptions<S, T>, MdxCompileOptions {
  /** Components passed to every MDX file (overrides for h1, a, etc.). */
  components?: Record<string, unknown>;
}

/** A folder of MDX files. Requires the optional peer dependency @mdx-js/mdx. */
export function mdx<S extends SchemaInput | undefined = undefined, T = Out<S, Record<string, unknown>>>(
  dir: string,
  options: MdxOptions<S, T> = {}
): Loader<T> {
  return {
    kind: "mdx",
    describe: dir,
    async load(ctx) {
      const files = await walk(join(ctx.root, dir), [".mdx"]);
      const modules = await ctx.importMdx(files, { remarkPlugins: options.remarkPlugins, rehypePlugins: options.rehypePlugins, cacheKey: options.cacheKey });
      const rows = files.map((full) => {
        const mod = modules.get(full)!;
        return {
          id: toPosix(relative(join(ctx.root, dir), full)).replace(/\.mdx$/, ""),
          file: toPosix(relative(ctx.root, full)),
          data: (mod.frontmatter ?? {}) as Record<string, unknown>,
          mod
        };
      });
      const entries = finish("mdx", rows, options as CommonOptions<SchemaInput | undefined, T>);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const entry of entries) {
        const Component = byId.get(entry.id)!.mod.default;
        entry.Content = (props = {}) => raw(String(Component({ components: options.components, ...props }) ?? ""));
      }
      return entries;
    }
  };
}

export interface CsvOptions<S extends SchemaInput | undefined, T> extends CommonOptions<S, T> {
  /** Trim whitespace around every field (default true). */
  trim?: boolean;
  /** Columns that must exist in the header, even if empty in some rows. */
  requiredColumns?: string[];
}

/** A CSV file: one entry per row, header row gives field names. */
export function csv<S extends SchemaInput | undefined = undefined, T = Out<S, Record<string, string>>>(
  file: string,
  options: CsvOptions<S, T> = {}
): Loader<T> {
  return {
    kind: "csv",
    describe: file,
    async load(ctx) {
      let parsed;
      try {
        parsed = parseCsv(await readFile(join(ctx.root, file), "utf8"), { trim: options.trim });
      } catch (error) {
        throw new HotpressError({ code: "csv", message: (error as Error).message, file });
      }
      const required = options.requiredColumns ?? [];
      const missing = required.filter((c) => !parsed.headers.includes(c));
      if (missing.length) throw new HotpressError({ code: "csv-columns", message: `missing required columns: ${missing.join(", ")}`, file, line: 1 });
      if (!parsed.records.length) throw new HotpressError({ code: "csv-empty", message: "no data rows", file });
      const rows = parsed.records.map((r, i) => ({ id: r.fields[options.slugField ?? "slug"] || String(i + 1), file, line: r.line, data: r.fields }));
      return finish("csv", rows, options as CommonOptions<SchemaInput | undefined, T>);
    }
  };
}

export interface JsonOptions<S extends SchemaInput | undefined, T> extends CommonOptions<S, T> {
  /** Pick the array out of the parsed document (default: the document itself). */
  select?: (doc: unknown) => unknown[];
}

/** A JSON file holding an array of records. */
export function json<S extends SchemaInput | undefined = undefined, T = Out<S, Record<string, unknown>>>(
  file: string,
  options: JsonOptions<S, T> = {}
): Loader<T> {
  return {
    kind: "json",
    describe: file,
    async load(ctx) {
      let doc: unknown;
      try {
        doc = JSON.parse(await readFile(join(ctx.root, file), "utf8"));
      } catch (error) {
        throw new HotpressError({ code: "json", message: (error as Error).message, file });
      }
      const list = options.select ? options.select(doc) : doc;
      if (!Array.isArray(list)) throw new HotpressError({ code: "json", message: "expected an array of records", file });
      const rows = list.map((item, i) => ({
        id: String((item as Record<string, unknown>)?.[options.slugField ?? "slug"] ?? i + 1),
        file,
        line: i + 1,
        data: item as Record<string, unknown>
      }));
      return finish("json", rows, options as CommonOptions<SchemaInput | undefined, T>);
    }
  };
}

export type { Field };
