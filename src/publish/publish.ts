// `hotpress publish`: commit, build exactly that commit in a clean worktree, check it, push.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { HotpressError, type Problem } from "../errors.ts";
import { importSiteModule } from "../build/bundle.ts";
import { findSiteFile } from "../build/build.ts";
import type { SiteOptions } from "../build/site.ts";
import { check, formatPublishedIndex, PUBLISHED_INDEX, type CheckResult } from "./check.ts";

export interface PublishOptions {
  root: string;
  configFile?: string;
  message?: string;
  /** Stage every change (git add -A) before committing. */
  all?: boolean;
  allow?: string[];
  offline?: boolean;
  twice?: boolean;
  /** Run everything except the push; the commit is undone afterwards. */
  dryRun?: boolean;
  log?: boolean;
}

export interface PublishResult {
  ok: boolean;
  pushed: boolean;
  commit?: string;
  problems: Problem[];
  check?: CheckResult;
}

function git(cwd: string, args: string[], allowFail = false): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFail) return "";
    const e = error as { stderr?: string; message: string };
    throw new HotpressError({ code: "git", message: `git ${args.join(" ")} failed: ${(e.stderr || e.message).trim()}` });
  }
}

async function siteConfig(root: string, configFile?: string): Promise<Partial<SiteOptions>> {
  const mod = await importSiteModule({ root, cacheDir: join(root, ".hotpress-cache"), clientScripts: new Set(), inputs: new Set() }, findSiteFile(root, configFile));
  return (mod.default as SiteOptions | undefined) ?? {};
}

export async function publish(options: PublishOptions): Promise<PublishResult> {
  const log = options.log === false ? () => {} : (m: string) => process.stdout.write(m + "\n");
  const root = git(options.root, ["rev-parse", "--show-toplevel"]);
  // git prints the real path; options.root may reach the same folder through a symlink.
  const siteRel = relative(root, realpathSync(options.root)).split("\\").join("/");
  const config = await siteConfig(options.root, options.configFile);
  const settings = config.check ?? {};
  const branch = settings.branch ?? "main";
  const remote = settings.remote ?? "origin";
  const fail = (problems: Problem[]): PublishResult => {
    log(problems.map((p) => `[${p.code}] ${p.message}${p.hint ? `\n    hint: ${p.hint}` : ""}`).join("\n"));
    return { ok: false, pushed: false, problems };
  };

  // 1. Git preflight.
  const current = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== branch) return fail([{ code: "git-branch", message: `on branch "${current}", but publishing happens from "${branch}"`, hint: `git switch ${branch}` }]);
  const outputs = [config.outDir ?? "dist", ".hotpress-cache"].map((dir) => (siteRel ? `${siteRel}/${dir}` : dir));
  const tracked = git(root, ["ls-files", "--", ...outputs]);
  if (tracked) return fail([{ code: "git-tracked-output", message: "build output is tracked by git", hint: `git rm -r --cached ${outputs.join(" ")} and add them to .gitignore` }]);
  const hasRemote = git(root, ["remote"]).split("\n").includes(remote);
  if (!hasRemote) return fail([{ code: "git-remote", message: `no git remote named "${remote}"` }]);
  if (!options.offline) git(root, ["fetch", "--quiet", remote, branch]);
  const upstream = `${remote}/${branch}`;
  const hasUpstream = git(root, ["rev-parse", "--verify", "--quiet", upstream], true) !== "";
  if (hasUpstream) {
    const behind = Number(git(root, ["rev-list", "--count", `HEAD..${upstream}`]));
    if (behind > 0) return fail([{ code: "git-behind", message: `${upstream} has ${behind} commit(s) you don't have`, hint: `git pull --rebase ${remote} ${branch}, then publish again` }]);
  }

  // 2. Commit.
  if (options.all) git(root, ["add", "-A"]);
  const staged = git(root, ["diff", "--cached", "--name-only"]);
  const ahead = hasUpstream ? Number(git(root, ["rev-list", "--count", `${upstream}..HEAD`])) : 1;
  let committed = false;
  if (staged) {
    if (!options.message) return fail([{ code: "git-message", message: "changes are staged but no commit message was given", hint: 'hotpress publish -m "Describe the change"' }]);
    git(root, ["commit", "--quiet", "-m", options.message]);
    committed = true;
  } else if (ahead === 0) {
    return fail([{ code: "nothing-to-publish", message: "no staged changes and no unpushed commits", hint: "stage changes (or use --all) and pass -m" }]);
  }
  const unstaged = git(root, ["status", "--porcelain"]);
  if (unstaged) log(`note: uncommitted changes are not part of this publish:\n${unstaged.split("\n").map((l) => "  " + l).join("\n")}`);
  let commit = git(root, ["rev-parse", "HEAD"]);
  const undo = () => {
    if (committed) git(root, ["reset", "--soft", "HEAD~1"]);
  };

  // 3. Build that exact commit in a clean worktree, so forgotten or ignored files show up as failures.
  const checkCommit = async (sha: string, fix: boolean): Promise<{ result: CheckResult; fixed: Map<string, Buffer> }> => {
    const work = join(root, ".hotpress-cache", "publish-worktree");
    git(root, ["worktree", "remove", "--force", work], true);
    await rm(work, { recursive: true, force: true });
    git(root, ["worktree", "add", "--quiet", "--detach", work, sha]);
    try {
      const siteRoot = join(work, siteRel);
      const lockHere = join(options.root, "package-lock.json");
      const lockThere = join(siteRoot, "package-lock.json");
      const sameLock = existsSync(lockHere) && existsSync(lockThere) && readFileSync(lockHere, "utf8") === readFileSync(lockThere, "utf8");
      if (existsSync(join(options.root, "node_modules")) && sameLock) {
        await symlink(join(options.root, "node_modules"), join(siteRoot, "node_modules"), "dir");
      } else if (existsSync(lockThere)) {
        log("package-lock.json differs from the installed packages: running npm ci in the publish worktree");
        // npm's output goes to stderr: stdout may be carrying --json for an agent.
        execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: siteRoot, stdio: ["ignore", 2, 2] });
      }
      const result = await check({
        root: siteRoot,
        configFile: options.configFile,
        allow: options.allow,
        offline: options.offline,
        twice: options.twice,
        fix,
        legacyIndex: join(options.root, ".hotpress-cache", "published.json"),
        log: options.log
      });
      const fixed = new Map(result.fixed.map((file) => [file, readFileSync(join(siteRoot, file))]));
      return { result, fixed };
    } finally {
      git(root, ["worktree", "remove", "--force", work], true);
      await rm(work, { recursive: true, force: true });
    }
  };

  let result: CheckResult;
  try {
    const first = await checkCommit(commit, true);
    result = first.result;
    // Files the site's tasks updated (e.g. a dates file) become part of this publish, and the final
    // commit is checked again from scratch, so what is pushed is exactly what was checked.
    if (result.ok && first.fixed.size) {
      for (const [file, contents] of first.fixed) {
        await writeFile(join(options.root, file), contents);
        git(root, ["add", "--", join(siteRel, file)]);
      }
      if (committed) git(root, ["commit", "--quiet", "--amend", "--no-edit"]);
      else {
        git(root, ["commit", "--quiet", "-m", `Update ${[...first.fixed.keys()].join(", ")} (site tasks)`]);
        committed = true;
      }
      commit = git(root, ["rev-parse", "HEAD"]);
      result = (await checkCommit(commit, false)).result;
      result.fixed = [...first.fixed.keys()];
    }
  } catch (error) {
    undo();
    throw error;
  }

  if (!result.ok) {
    undo();
    log(committed ? "Publish stopped. Your commit was undone (changes are still staged)." : "Publish stopped.");
    return { ok: false, pushed: false, problems: result.problems, check: result };
  }
  if (options.dryRun) {
    undo();
    log("Dry run: checks passed, nothing pushed" + (committed ? " (commit undone, changes still staged)." : "."));
    return { ok: true, pushed: false, commit, problems: [], check: result };
  }

  // 4. Record what is now live in the commit itself, so every clone checks against it. The build doesn't
  // read the index, so the checked output is unchanged.
  const indexFile = join(options.root, PUBLISHED_INDEX);
  const indexText = formatPublishedIndex(result.index!);
  if (!existsSync(indexFile) || readFileSync(indexFile, "utf8") !== indexText) {
    await writeFile(indexFile, indexText);
    git(root, ["add", "--", siteRel ? `${siteRel}/${PUBLISHED_INDEX}` : PUBLISHED_INDEX]);
    if (committed) git(root, ["commit", "--quiet", "--amend", "--no-edit"]);
    else {
      git(root, ["commit", "--quiet", "-m", `Update ${PUBLISHED_INDEX}`]);
      committed = true;
    }
    commit = git(root, ["rev-parse", "HEAD"]);
  }

  // 5. Push.
  try {
    git(root, ["push", "--quiet", remote, `HEAD:${branch}`]);
  } catch (error) {
    undo();
    // The index must keep describing what is live, or the next publish compares with a publish that never happened.
    const indexPath = siteRel ? `${siteRel}/${PUBLISHED_INDEX}` : PUBLISHED_INDEX;
    if (git(root, ["ls-tree", "--name-only", "HEAD", "--", indexPath], true)) git(root, ["checkout", "HEAD", "--", indexPath]);
    else {
      git(root, ["rm", "--quiet", "--cached", "--ignore-unmatch", "--", indexPath], true);
      await rm(indexFile, { force: true });
    }
    const problem = (error as HotpressError).problems?.[0] ?? { code: "git", message: String(error) };
    return fail([{ ...problem, code: "git-push", hint: `nothing was published${committed ? "; your commit was undone (changes are still staged)" : ""}. Fix the push problem, then publish again` }]);
  }
  log(`Published ${commit.slice(0, 7)} to ${remote}/${branch}. The host builds and deploys it from there.`);
  if (result.fixed.length) log(`Included updates from site tasks: ${result.fixed.join(", ")}`);
  const c = result.changes;
  if (c) log(`Since the last publish: ${c.changed.length} pages changed, ${c.added.length} added, ${c.removed.length} removed.`);
  return { ok: true, pushed: true, commit, problems: [], check: result };
}
