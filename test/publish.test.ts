import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { publish, type PublishResult } from "../src/publish/publish.ts";
import { check, writePublishedIndex } from "../src/publish/check.ts";

const EXAMPLE = new URL("../examples/basic/", import.meta.url).pathname;
const TMP = new URL("./.tmp/", import.meta.url).pathname;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A site repo with one published commit, pushed to a local bare remote. */
async function repo(): Promise<{ dir: string; remote: string }> {
  await mkdir(TMP, { recursive: true });
  const base = await mkdtemp(join(TMP, "pub-"));
  const dir = join(base, "site");
  const remote = join(base, "remote.git");
  await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  await writeFile(join(dir, ".gitignore"), "dist\n.hotpress-cache\n");
  git(base, "init", "--quiet", "--bare", "-b", "main", remote);
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "Initial site");
  const first = await publish({ root: dir, offline: true, log: false });
  assert.equal(first.ok, true, JSON.stringify(first.problems));
  return { dir, remote };
}

const remoteHead = (remote: string) => git(remote, "rev-parse", "main");

test("publish commits, builds the commit, checks and pushes", async () => {
  const { dir, remote } = await repo();
  const post = join(dir, "content/posts/2024-02-01-second-post.md");
  await writeFile(post, (await readFile(post, "utf8")).replace("updated: 2024-02-03", "updated: 2024-03-01").replace("Some text", "Some new text"));
  const result = await publish({ root: dir, all: true, message: "Edit second post", offline: true, log: false });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.pushed, true);
  assert.equal(remoteHead(remote), git(dir, "rev-parse", "HEAD"));
  assert.equal(git(dir, "log", "-1", "--format=%s"), "Edit second post");
  assert.deepEqual(result.check!.changes!.changed.includes("/blog/second-post/"), true);
  assert.equal(existsSync(join(dir, ".hotpress-cache/publish-worktree")), false, "temporary worktree is cleaned up");
});

test("content changed without a new updated date is blocked, and the commit is undone", async () => {
  const { dir, remote } = await repo();
  const before = remoteHead(remote);
  const head = git(dir, "rev-parse", "HEAD");
  const post = join(dir, "content/posts/2024-02-01-second-post.md");
  await writeFile(post, (await readFile(post, "utf8")).replace("Some text", "Some changed text"));
  const result = await publish({ root: dir, all: true, message: "Edit without date", offline: true, log: false });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.problems.map((p) => `${p.code} ${p.url}`),
    ["date-stale /blog/second-post/"]
  );
  assert.equal(remoteHead(remote), before, "nothing pushed");
  assert.equal(git(dir, "rev-parse", "HEAD"), head, "commit undone");
  assert.match(git(dir, "diff", "--cached", "--name-only"), /second-post\.md/, "changes still staged");
});

test("a removed page without a redirect is blocked", async () => {
  const { dir } = await repo();
  await rm(join(dir, "content/posts/2024-01-10-hello-world.md"));
  const result = await publish({ root: dir, all: true, message: "Remove post", offline: true, log: false });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === "url-removed" && p.url === "/blog/hello-world/"));
  // Accepting it explicitly lets it through.
  const accepted = await publish({ root: dir, message: "Remove post", offline: true, log: false, allow: ["url-removed:/blog/hello-world/", "url-removed:/tags/meta/"] });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.problems));
});

test("a file left out of the commit fails the build of that commit", async () => {
  const { dir, remote } = await repo();
  const before = remoteHead(remote);
  await writeFile(join(dir, "src/extra.ts"), 'export const tagline = "Hello";\n');
  const sitePath = join(dir, "hotpress.site.tsx");
  await writeFile(sitePath, `import { tagline } from "./src/extra.ts";\nvoid tagline;\n${await readFile(sitePath, "utf8")}`);
  git(dir, "add", "hotpress.site.tsx"); // forgot src/extra.ts
  const result = await publish({ root: dir, message: "Use extra", offline: true, log: false });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, "compile");
  assert.equal(remoteHead(remote), before);
  // The working tree build is fine: only the committed snapshot is broken.
  assert.equal((await check({ root: dir, offline: true, log: false })).ok, true);
});

test("publishing from another branch or with nothing to publish is refused", async () => {
  const { dir } = await repo();
  assert.equal((await publish({ root: dir, offline: true, log: false })).problems[0].code, "nothing-to-publish");
  git(dir, "switch", "--quiet", "-c", "draft");
  assert.equal((await publish({ root: dir, offline: true, log: false })).problems[0].code, "git-branch");
});

// A small site task like a real "dates file": one line per page with a hash of its main content
// and the date that content last changed.
const DATES_TASK = `
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const datesTask = {
  name: "dates",
  run(ctx) {
    const file = join(ctx.root, "data/dates.tsv");
    const old = new Map(existsSync(file) ? readFileSync(file, "utf8").trim().split("\\n").filter(Boolean).map((l) => { const [u, h, d] = l.split("\\t"); return [u, { h, d }]; }) : []);
    const lines = ctx.pages.map((p) => {
      const h = createHash("sha1").update(p.mainText()).digest("hex").slice(0, 10);
      const before = old.get(p.url);
      return [p.url, h, before && before.h === h ? before.d : ctx.today].join("\\t");
    }).sort();
    const next = lines.join("\\n") + "\\n";
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (next === current) return;
    if (!ctx.fix) return { problems: [{ code: "dates-stale", message: "data/dates.tsv is out of date", hint: "hotpress check --fix" }] };
    writeFileSync(file, next);
    return { changed: ["data/dates.tsv"] };
  }
};
`;

async function withDatesTask(dir: string): Promise<void> {
  const sitePath = join(dir, "hotpress.site.tsx");
  const source = await readFile(sitePath, "utf8");
  await writeFile(sitePath, source.replace("export default defineSite({", `${DATES_TASK}\nexport default defineSite({\n  tasks: [datesTask],`));
}

test("site tasks report in check, fix with --fix, and are idempotent", async () => {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, "task-"));
  await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  await withDatesTask(dir);
  const reported = await check({ root: dir, offline: true, log: false, today: "2026-11-01" });
  assert.deepEqual(reported.problems.map((p) => p.code), ["dates-stale"]);
  const fixed = await check({ root: dir, offline: true, log: false, fix: true, today: "2026-11-01" });
  assert.equal(fixed.ok, true, JSON.stringify(fixed.problems));
  assert.deepEqual(fixed.fixed, ["data/dates.tsv"]);
  assert.match(await readFile(join(dir, "data/dates.tsv"), "utf8"), /^\/\t[0-9a-f]{10}\t2026-11-01$/m);
  const again = await check({ root: dir, offline: true, log: false, fix: true, today: "2026-12-01" });
  assert.deepEqual(again.fixed, [], "nothing changed, so nothing is rewritten");
});

test("publish commits files updated by site tasks with the change", async () => {
  const { dir, remote } = await repo();
  await withDatesTask(dir);
  const first = await publish({ root: dir, all: true, message: "Add dates task", offline: true, log: false });
  assert.equal(first.ok, true, JSON.stringify(first.problems));
  assert.deepEqual(first.check!.fixed, ["data/dates.tsv"]);
  assert.equal(git(dir, "log", "-1", "--format=%s"), "Add dates task", "task output is amended into the change");
  assert.match(git(remote, "show", "main:data/dates.tsv"), /\/blog\/second-post\//);

  const post = join(dir, "content/posts/2024-02-01-second-post.md");
  await writeFile(post, (await readFile(post, "utf8")).replace("updated: 2024-02-03", "updated: 2024-03-01").replace("Some text", "Different text"));
  process.env.HOTPRESS_TODAY = "2027-01-15";
  try {
    const second = await publish({ root: dir, all: true, message: "Edit post", offline: true, log: false });
    assert.equal(second.ok, true, JSON.stringify(second.problems));
  } finally {
    delete process.env.HOTPRESS_TODAY;
  }
  const dates = git(remote, "show", "main:data/dates.tsv");
  assert.match(dates, /^\/blog\/second-post\/\t[0-9a-f]{10}\t2027-01-15$/m, "the edited page gets the publish date");
  assert.doesNotMatch(dates, /^\/places\/\t.*2027-01-15$/m, "untouched pages keep their date");
  assert.equal(git(dir, "status", "--porcelain"), "", "nothing left behind in the working tree");
});

test("build --check fails the build while a site task reports a problem", async () => {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, "ci-"));
  await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  await withDatesTask(dir);
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const run = () => {
    try {
      execFileSync(process.execPath, ["--conditions=hotpress-source", cli, "build", "--check", "--root", dir], { encoding: "utf8", stdio: "pipe" });
      return { code: 0, out: "" };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, out: e.stdout + e.stderr };
    }
  };
  const stale = run();
  assert.equal(stale.code, 1);
  assert.match(stale.out, /\[dates-stale\]/);
  assert.match(stale.out, /Build stopped/);
  await check({ root: dir, offline: true, log: false, fix: true, today: "2026-11-01" });
  assert.equal(run().code, 0);
});

test("a CSS-only change publishes, and the published index is committed without bundled assets", async () => {
  const { dir, remote } = await repo();
  const index = JSON.parse(git(remote, "show", "main:hotpress.published.json"));
  assert.equal(index.version, 2);
  assert.ok(index.urls.includes("/blog/hello-world/") && index.urls.includes("/favicon.svg"));
  assert.equal(index.urls.some((u: string) => u.startsWith("/assets/") || u === "/_headers"), false, "hashed assets are not tracked URLs");
  await writeFile(join(dir, "styles/main.css"), (await readFile(join(dir, "styles/main.css"), "utf8")) + "h1 { color: red; }\n");
  const result = await publish({ root: dir, all: true, message: "Tweak CSS", offline: true, log: false });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("a fresh clone checks against the committed index, not a local cache", async () => {
  const { dir, remote } = await repo();
  const clone = join(dir, "..", "clone");
  git(join(dir, ".."), "clone", "--quiet", remote, clone);
  await rm(join(clone, "content/posts/2024-01-10-hello-world.md"));
  const result = await check({ root: clone, offline: true, log: false });
  assert.ok(result.problems.some((p) => p.code === "url-removed" && p.url === "/blog/hello-world/"), JSON.stringify(result.problems));
  assert.equal(result.warnings.some((w) => w.code === "first-publish"), false);
});

test("an older local index (listing assets) still works, without flagging old assets", async () => {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, "legacy-"));
  await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  await mkdir(join(dir, ".hotpress-cache"), { recursive: true });
  const legacy = { version: 1, origin: "https://example.com", pages: {}, urls: ["/", "/assets/main.K2BRTKB97q.css", "/assets/js/filter.ABCDEFGH.js", "/old-page/"] };
  await writeFile(join(dir, ".hotpress-cache/published.json"), JSON.stringify(legacy));
  const result = await check({ root: dir, offline: true, log: false });
  assert.deepEqual(result.problems.map((p) => `${p.code} ${p.url}`), ["url-removed /old-page/"]);
});

test("check --twice compares every output file and fails if the second build fails", async () => {
  await mkdir(TMP, { recursive: true });
  const site = async (code: string) => {
    const dir = await mkdtemp(join(TMP, "twice-"));
    await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
    const sitePath = join(dir, "hotpress.site.tsx");
    await writeFile(sitePath, (await readFile(sitePath, "utf8")).replace("async build(site) {", `async build(site) {\n    ${code}`));
    return dir;
  };
  const random = await check({ root: await site('site.file("build-id.txt", String(Math.random()));'), twice: true, offline: true, log: false });
  assert.deepEqual(random.problems.map((p) => `${p.code} ${p.url}`), ["nondeterministic /build-id.txt"]);
  const flaky = await check({ root: await site('const g = globalThis as any; g.__flaky = (g.__flaky ?? 0) + 1; if (g.__flaky === 2) throw new Error("second time");'), twice: true, offline: true, log: false });
  assert.equal(flaky.ok, false);
  assert.match(flaky.problems[0].message, /second build failed: \[site-code\] second time/);
});

test("a failed push undoes the commit and leaves the published index as it was", async () => {
  const { dir, remote } = await repo();
  const before = remoteHead(remote);
  const head = git(dir, "rev-parse", "HEAD");
  await writeFile(join(remote, "hooks/pre-receive"), "#!/bin/sh\necho rejected >&2\nexit 1\n", { mode: 0o755 });
  const post = join(dir, "content/posts/2024-02-01-second-post.md");
  await writeFile(post, (await readFile(post, "utf8")).replace("updated: 2024-02-03", "updated: 2024-03-01").replace("Some text", "Some new text"));
  const result = await publish({ root: dir, all: true, message: "Edit", offline: true, log: false });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, "git-push");
  assert.equal(remoteHead(remote), before);
  assert.equal(git(dir, "rev-parse", "HEAD"), head, "commit undone");
  assert.equal(git(dir, "status", "--porcelain"), "M  content/posts/2024-02-01-second-post.md", "only the change is left, staged");
});

test("init starts a site that builds and passes every check", async () => {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, "init-"));
  await writeFile(join(dir, ".gitignore"), "/node_modules\n");
  const { init } = await import("../src/init.ts");
  const created = await init({ root: dir, origin: "https://blog.example.org", name: "My Blog", today: "2026-10-29", log: false });
  assert.deepEqual(created.created.sort(), ["content/posts/hello-world.md", "hotpress.site.tsx", "package.json", "src/Layout.tsx", "styles/main.css", "tsconfig.json"]);
  assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "/node_modules\ndist/\n.hotpress-cache/\n");
  // Its own package.json hides this checkout from self-reference: install it the way npm would.
  await mkdir(join(dir, "node_modules/@benchadfield"), { recursive: true });
  await symlink(new URL("..", import.meta.url).pathname, join(dir, "node_modules/@benchadfield/hotpress"), "dir");
  const result = await check({ root: dir, offline: true, log: false });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.deepEqual(result.build!.pages.map((p) => p.url), ["/blog/hello-world/", "/", "/404.html"]);
  await assert.rejects(init({ root: dir, log: false }), /already exists/);
});

test("pages without a doctype fail the SEO check", async () => {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, "doctype-"));
  await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  const layout = join(dir, "src/Layout.tsx");
  await writeFile(layout, (await readFile(layout, "utf8")).replace('{raw("<!DOCTYPE html>")}', ""));
  const result = await check({ root: dir, offline: true, log: false });
  assert.ok(result.problems.length > 0 && result.problems.every((p) => p.code === "seo" && p.field === "doctype"), JSON.stringify(result.problems));
});

async function copySite(prefix: string): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, prefix));
  await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  return dir;
}

async function withTask(dir: string, task: string, settings = ""): Promise<void> {
  const sitePath = join(dir, "hotpress.site.tsx");
  const source = await readFile(sitePath, "utf8");
  await writeFile(sitePath, source.replace("export default defineSite({", `const task = ${task};\nexport default defineSite({\n  tasks: [task],${settings}`));
}

test("pages redirected to an absolute URL are not removed, and links through such redirects are not broken", async () => {
  const dir = await copySite("abs-");
  await writeFile(join(dir, "public/_redirects"), "/moved/ https://example.com/blog/ 301\n/partner/ https://partner.example/ 302\n/lost/ https://example.com/nowhere/ 301\n");
  await mkdir(join(dir, ".hotpress-cache"), { recursive: true });
  await writeFile(join(dir, ".hotpress-cache/published.json"), JSON.stringify({ version: 2, origin: "https://example.com", pages: {}, urls: ["/", "/moved/", "/partner/", "/lost/"] }));
  const post = join(dir, "content/posts/2024-01-10-hello-world.md");
  await writeFile(post, (await readFile(post, "utf8")) + "\n[Our partner](/partner/)\n");
  const result = await check({ root: dir, offline: true, log: false });
  assert.deepEqual(result.problems.map((p) => `${p.code} ${p.url}`), ["url-removed /lost/"]);
});

test("in fix mode, a site task's problems are printed and check.allow applies to them", async () => {
  const dir = await copySite("fixlog-");
  await withTask(dir, `{ name: "always", run: () => ({ problems: [{ code: "always", message: "this task always complains", file: "data/places.csv" }] }) }`);
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  let blocked;
  try {
    blocked = await check({ root: dir, offline: true, fix: true });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(blocked.ok, false);
  assert.match(out.join(""), /Check failed: 1 problem[\s\S]*\[always\] data\/places\.csv: this task always complains/);
  // A bare code, and a glob matching the file, both allow a problem that has no URL.
  for (const rule of ["always", "always:data/*.csv"]) {
    const allowed = await check({ root: dir, offline: true, fix: true, log: false, allow: [rule] });
    assert.equal(allowed.ok, true, `${rule}: ${JSON.stringify(allowed.problems)}`);
    assert.deepEqual(allowed.allowed.map((p) => p.code), ["always"], rule);
  }
});

test("a published index that can't be read is a problem, not a first publish", async () => {
  const dir = await copySite("badindex-");
  for (const text of ["{ not json", JSON.stringify({ version: 9, urls: [] })]) {
    await writeFile(join(dir, "hotpress.published.json"), text);
    const result = await check({ root: dir, offline: true, log: false });
    assert.deepEqual(result.problems.map((p) => `${p.code} ${p.file}`), ["published-index hotpress.published.json"], text);
    assert.equal(result.warnings.some((w) => w.code === "first-publish"), true);
  }
});

test("a live sitemap shared between checks is fetched once", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/xml" });
    res.end('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const dir = await copySite("sitemap-");
    const sitePath = join(dir, "hotpress.site.tsx");
    await writeFile(sitePath, (await readFile(sitePath, "utf8")).replace("export default defineSite({", `export default defineSite({\n  check: { liveSitemap: "http://127.0.0.1:${port}/sitemap.xml" },`));
    const sitemapCache = new Map<string, Promise<string[]>>();
    for (let i = 0; i < 2; i++) {
      const result = await check({ root: dir, log: false, sitemapCache });
      assert.equal(result.ok, true, JSON.stringify(result.problems));
      assert.equal(result.warnings.some((w) => w.code === "live-sitemap"), false);
    }
    assert.equal(requests, 1);
  } finally {
    server.close();
  }
});

/** Publish a site at ws/sites/blog whose task needs ws/node_modules (hoisted packages) in the worktree. */
async function publishWorkspace(lockfile: string, ignore: string): Promise<PublishResult> {
  await mkdir(TMP, { recursive: true });
  const base = await mkdtemp(join(TMP, "ws-"));
  const ws = join(base, "ws");
  const site = join(ws, "sites", "blog");
  const remote = join(base, "remote.git");
  await cp(EXAMPLE, site, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  await writeFile(join(ws, lockfile), "lockfileVersion: '9.0'\n");
  await mkdir(join(ws, "node_modules/hoisted-marker"), { recursive: true });
  await writeFile(join(ws, ".gitignore"), `node_modules\ndist\n.hotpress-cache\n${ignore}`);
  await withTask(
    site,
    `{ name: "deps", run: (ctx) => existsSync(join(ctx.root, "../../node_modules/hoisted-marker")) ? undefined : { problems: [{ code: "no-deps", message: "workspace packages missing in " + ctx.root }] } }`
  );
  const sitePath = join(site, "hotpress.site.tsx");
  await writeFile(sitePath, `import { existsSync } from "node:fs";\nimport { join } from "node:path";\n${await readFile(sitePath, "utf8")}`);
  git(base, "init", "--quiet", "--bare", "-b", "main", remote);
  git(ws, "init", "--quiet", "-b", "main");
  git(ws, "config", "user.email", "test@example.com");
  git(ws, "config", "user.name", "Test");
  git(ws, "remote", "add", "origin", remote);
  git(ws, "add", "-A");
  git(ws, "commit", "--quiet", "-m", "Workspace");
  const result = await publish({ root: site, offline: true, log: false });
  if (result.ok) assert.equal(git(remote, "show", "main:sites/blog/hotpress.published.json").includes('"version": 2'), true);
  return result;
}

test("the publish worktree reuses installed packages for any lockfile, and hoisted workspace ones", async () => {
  // pnpm at the workspace root, packages hoisted there: no package-lock.json anywhere.
  const result = await publishWorkspace("pnpm-lock.yaml", "");
  assert.equal(result.ok, true, JSON.stringify(result.problems));
});

test("a lockfile that isn't committed doesn't leave the publish worktree without packages", async () => {
  const result = await publishWorkspace("package-lock.json", "package-lock.json\n");
  assert.equal(result.ok, true, JSON.stringify(result.problems));
});

/** A started site, with this checkout installed the way npm would. */
async function initSite(options: { name?: string } = {}): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, "init-"));
  const { init } = await import("../src/init.ts");
  await init({ root: dir, today: "2026-01-10", log: false, ...options });
  await mkdir(join(dir, "node_modules/@benchadfield"), { recursive: true });
  await symlink(new URL("..", import.meta.url).pathname, join(dir, "node_modules/@benchadfield/hotpress"), "dir");
  return dir;
}

test("the starter's home page doesn't block publishing when an older post changes or goes", async () => {
  const dir = await initSite();
  const older = join(dir, "content/posts/older.md");
  await writeFile(older, "---\ntitle: Older post\ndescription: An older one.\ndate: 2025-06-01\n---\n\nBody.\n");
  const first = await check({ root: dir, offline: true, log: false });
  assert.equal(first.ok, true, JSON.stringify(first.problems));
  await writePublishedIndex(join(dir, "hotpress.published.json"), first.index!);
  await writeFile(older, "---\ntitle: Older post, renamed\ndescription: An older one.\ndate: 2025-06-01\nupdated: 2026-02-01\n---\n\nBody.\n");
  const renamed = await check({ root: dir, offline: true, log: false });
  assert.equal(renamed.ok, true, JSON.stringify(renamed.problems));
  assert.match(await readFile(join(dir, "dist/sitemap.xml"), "utf8"), /<loc>https:\/\/example\.com\/<\/loc>\s*<lastmod>2026-02-01<\/lastmod>/);
  await rm(older);
  const removed = await check({ root: dir, offline: true, log: false });
  assert.deepEqual(removed.problems.map((p) => `${p.code} ${p.url}`), ["url-removed /blog/older/"], "only the removed post itself");
});

test("init: package names are valid, engines are added, and someone else's Layout is not reused", async () => {
  const named = await initSite({ name: "My Site!" });
  const pkg = JSON.parse(await readFile(join(named, "package.json"), "utf8"));
  assert.equal(pkg.name, "my-site");
  assert.deepEqual(pkg.engines, { node: ">=22.12.0" });

  const { init } = await import("../src/init.ts");
  const dir = await mkdtemp(join(TMP, "init-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "a", build: "b", check: "c" } }));
  const result = await init({ root: dir, log: false });
  assert.deepEqual(result.updated, ["package.json"]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).engines, { node: ">=22.12.0" });

  const other = await mkdtemp(join(TMP, "init-"));
  await mkdir(join(other, "src"));
  await writeFile(join(other, "src/Layout.tsx"), "export const Mine = 1;\n");
  await assert.rejects(init({ root: other, log: false }), /src\/Layout\.tsx already exists/);
  assert.equal(existsSync(join(other, "hotpress.site.tsx")), false, "nothing written");
});
