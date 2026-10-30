// `hotpress init`: a small starter site that builds and passes `hotpress check` as it is.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HotpressError } from "./errors.ts";
import { SITE_FILES } from "./build/build.ts";

export interface InitOptions {
  root: string;
  /** Canonical origin (default "https://example.com"). */
  origin?: string;
  /** Site name (default: the folder name). */
  name?: string;
  /** compat date, YYYY-MM-DD (default: today in UTC). */
  today?: string;
  log?: boolean;
}

export interface InitResult {
  created: string[];
  /** Files that already existed and were left alone (package.json and .gitignore are added to instead). */
  kept: string[];
  updated: string[];
}

const PACKAGE = "@benchadfield/hotpress";

function siteModule(origin: string, name: string, today: string): string {
  return `import { absoluteUrl, defineSite, markdown, robots, s, sitemaps } from "${PACKAGE}";
import { Layout, site as siteInfo } from "./src/Layout.tsx";

export default defineSite({
  origin: ${JSON.stringify(origin)},
  compat: ${JSON.stringify(today)},
  async build(site) {
    siteInfo.stylesheet = await site.css("styles/main.css");

    const posts = (
      await site.load(
        markdown("content/posts", {
          schema: {
            title: s.string(),
            description: s.string(),
            date: s.date(),
            updated: s.date().optional(),
            draft: s.boolean().default(false)
          }
        })
      )
    )
      .filter((post) => !post.data.draft)
      .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

    for (const post of posts) {
      site.page(
        \`/blog/\${post.slug}/\`,
        () => (
          <Layout title={post.data.title} description={post.data.description}>
            <article>
              <h1>{post.data.title}</h1>
              <p>
                <time datetime={post.data.date.toISOString().slice(0, 10)}>{post.data.date.toISOString().slice(0, 10)}</time>
              </p>
              {post.body}
            </article>
          </Layout>
        ),
        // Dates come from content, never the clock. Change \`updated\` when you change a post.
        { published: post.data.date, updated: post.data.updated ?? post.data.date, type: "post" }
      );
    }

    site.page(
      "/",
      () => (
        <Layout title={siteInfo.name} description={\`Latest posts from \${siteInfo.name}.\`}>
          <h1>{siteInfo.name}</h1>
          <ul>
            {posts.map((post) => (
              <li>
                <a href={\`/blog/\${post.slug}/\`}>{post.data.title}</a>
              </li>
            ))}
          </ul>
        </Layout>
      ),
      // A list of posts: it changes whenever a post does, so it has no \`updated\` of its own for the
      // date-stale check to hold it to. \`lastmod\` gives the sitemap the newest post's date instead.
      {
        lastmod: posts.reduce<Date | undefined>((latest, post) => {
          const date = post.data.updated ?? post.data.date;
          return !latest || date > latest ? date : latest;
        }, undefined)
      }
    );

    site.page(
      "/404.html",
      () => (
        <Layout title="Page not found" description="This page does not exist.">
          <h1>Page not found</h1>
          <p>
            <a href="/">Go to the home page</a>
          </p>
        </Layout>
      ),
      { noindex: true }
    );

    const urls = site.pages
      .filter((p) => !p.meta.noindex)
      .map((p) => ({ loc: absoluteUrl(site.origin, p.url), lastmod: p.meta.updated ?? (p.meta.lastmod as Date | undefined) }));
    for (const [file, xml] of Object.entries(sitemaps("sitemap.xml", site.origin, urls, { formatDate: (d) => d.toISOString().slice(0, 10) }))) {
      site.file(file, xml);
    }
    site.file("robots.txt", robots({ sitemaps: [\`\${site.origin}/sitemap.xml\`] }));
  }
});
`;
}

function layout(name: string): string {
  return `import { raw, usePage, type Child } from "${PACKAGE}";

export const site = { name: ${JSON.stringify(name)}, stylesheet: "" };

export function Layout(props: { title: string; description: string; children?: Child }) {
  const page = usePage();
  const noindex = Boolean(page.meta.noindex);
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{props.title}</title>
          <meta name="description" content={props.description} />
          {noindex ? <meta name="robots" content="noindex" /> : <link rel="canonical" href={page.href} />}
          <link rel="stylesheet" href={site.stylesheet} />
          {/* Analytics and ads: render them only when page.mode === "build", so previews send no traffic. */}
        </head>
        <body>
          <header>
            <a href="/">{site.name}</a>
          </header>
          <main>{props.children}</main>
        </body>
      </html>
    </>
  );
}
`;
}

function firstPost(today: string): string {
  return `---
title: Hello, world
description: The first post on this site.
date: ${today}
---

This site is built with [Hotpress](https://github.com/bchadfield/hotpress). Edit this post in
\`content/posts/\`, or add another Markdown file next to it.
`;
}

const STYLES = `body { margin: 0 auto; max-width: 42rem; padding: 1rem; font: 1rem/1.6 system-ui, sans-serif; }
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "jsxImportSource": "${PACKAGE}",
    "types": ["node", "${PACKAGE}/client"]
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules", "dist", ".hotpress-cache"]
}
`;

const SCRIPTS: Record<string, string> = {
  dev: "hotpress dev",
  // The host runs this: any problem fails the deploy, so the previous one stays live.
  build: "hotpress build --check",
  check: "hotpress check"
};

const IGNORES = ["node_modules/", "dist/", ".hotpress-cache/"];

/** A valid npm package name from a site name ("My Site!" -> "my-site"). */
function packageName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 214)
    .replace(/-+$/, "");
  return slug || "site";
}

export async function init(options: InitOptions): Promise<InitResult> {
  const root = options.root;
  const log = options.log === false ? () => {} : (m: string) => process.stdout.write(m + "\n");
  const existing = SITE_FILES.find((f) => existsSync(join(root, f)));
  if (existing) throw new HotpressError({ code: "init-exists", message: `${existing} already exists`, file: existing, hint: "init only starts new sites" });
  const origin = (options.origin ?? "https://example.com").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(origin)) throw new HotpressError({ code: "bad-origin", message: `origin must be like "https://example.com", got "${options.origin}"` });
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const name = options.name || basename(root) || "My site";
  const result: InitResult = { created: [], kept: [], updated: [] };

  const files: Record<string, string> = {
    "hotpress.site.tsx": siteModule(origin, name, today),
    "src/Layout.tsx": layout(name),
    "content/posts/hello-world.md": firstPost(today),
    "styles/main.css": STYLES,
    "tsconfig.json": TSCONFIG
  };
  // The site module imports Layout and site from here: someone else's file there would break the starter.
  const layoutPath = join(root, "src/Layout.tsx");
  if (existsSync(layoutPath) && (await readFile(layoutPath, "utf8")) !== files["src/Layout.tsx"]) {
    throw new HotpressError({
      code: "init-exists",
      message: "src/Layout.tsx already exists, and the starter's site module needs its own",
      file: "src/Layout.tsx",
      hint: "move it aside, or run init in a new folder"
    });
  }
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    if (existsSync(path)) {
      result.kept.push(file);
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    result.created.push(file);
  }

  // package.json: add what's missing, never change what's there.
  const pkgPath = join(root, "package.json");
  const hadPkg = existsSync(pkgPath);
  const pkg = hadPkg ? (JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>) : { name: packageName(name), private: true };
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  let changed = !hadPkg;
  for (const [key, value] of Object.entries(SCRIPTS)) {
    if (scripts[key] === undefined) {
      scripts[key] = value;
      changed = true;
    }
  }
  pkg.scripts = scripts;
  if (pkg.engines === undefined) {
    pkg.engines = { node: ">=22.12.0" };
    changed = true;
  }
  if (changed) {
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    (hadPkg ? result.updated : result.created).push("package.json");
  }

  const ignorePath = join(root, ".gitignore");
  const ignore = existsSync(ignorePath) ? await readFile(ignorePath, "utf8") : "";
  const lines = new Set(ignore.split(/\r?\n/).map((l) => l.trim().replace(/^\//, "")));
  const missing = IGNORES.filter((entry) => !lines.has(entry) && !lines.has(entry.slice(0, -1)));
  if (missing.length) {
    await writeFile(ignorePath, ignore + (ignore && !ignore.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
    (ignore ? result.updated : result.created).push(".gitignore");
  }

  const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
  log(
    [
      `Created ${result.created.join(", ") || "nothing"}${result.updated.length ? `; updated ${result.updated.join(", ")}` : ""}${result.kept.length ? `; kept existing ${result.kept.join(", ")}` : ""}.`,
      "",
      "Next:",
      ...(deps[PACKAGE] ? [] : [`  npm install --save-dev ${PACKAGE} typescript @types/node`]),
      ...(options.origin ? [] : [`  set origin in hotpress.site.tsx (it is ${origin} for now)`]),
      "  npm run dev       preview at http://localhost:4321/",
      "  npm run check     everything that would block a publish",
      "  git init, commit, add a remote, then: npx hotpress publish -m \"First publish\""
    ].join("\n")
  );
  return result;
}
