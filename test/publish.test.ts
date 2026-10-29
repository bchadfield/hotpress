import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { publish } from "../src/publish/publish.ts";
import { check } from "../src/publish/check.ts";

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
  const post = join(dir, "content/posts/2024-02-01-second-post.md");
  await writeFile(post, (await readFile(post, "utf8")).replace("Some text", "Some changed text"));
  const result = await publish({ root: dir, all: true, message: "Edit without date", offline: true, log: false });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.problems.map((p) => `${p.code} ${p.url}`),
    ["date-stale /blog/second-post/"]
  );
  assert.equal(remoteHead(remote), before, "nothing pushed");
  assert.equal(git(dir, "log", "-1", "--format=%s"), "Initial site", "commit undone");
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
