#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const HELP = `hotpress <command>

Commands
  init  [dir] [--origin https://example.com] [--name "Site name"]   Start a new site (a working starter)
  build [--config hotpress.site.tsx] [--out dist]     Production build + change report
        [--check]                                     ...then every offline check; fails on any problem (for CI)
  dev   [--port 4321] [--third-party]                 Production build served like the host, live reload
  serve [dir] [--port 4321]                           Serve an existing build like the host
  check [--fix] [--twice] [--offline] [--allow code:glob] [--json]   Build and run every pre-publish check
                                                    (--fix lets the site's tasks update files)
  publish -m "message" [--all] [--dry-run] [check options]    Commit, build that commit cleanly, check, push
  diff  <baseline> <candidate> [options]              Parity check two output directories

diff options
  --origin <url>       Site origin for absolute URLs (repeatable; inferred from the baseline)
  --ignore <glob>      Exclude URL paths, e.g. "/_astro/**" (repeatable)
  --probe <path>       Extra path whose status code is compared (repeatable)
  --strict-whitespace  Treat whitespace-only title/description changes as diffs
  --json <file>        Also write the full report as JSON
  --examples <n>       Examples shown per group (default 5)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "init") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { origin: { type: "string" }, name: { type: "string" } } });
    const root = resolve(positionals[0] ?? ".");
    await mkdir(root, { recursive: true });
    const { init } = await import("./init.ts");
    await init({ root, origin: values.origin, name: values.name });
    return 0;
  }
  if (command === "diff") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        origin: { type: "string", multiple: true },
        ignore: { type: "string", multiple: true },
        probe: { type: "string", multiple: true },
        "strict-whitespace": { type: "boolean" },
        json: { type: "string" },
        examples: { type: "string" }
      }
    });
    if (positionals.length !== 2) {
      process.stderr.write("usage: hotpress diff <baseline> <candidate>\n");
      return 2;
    }
    const missing = positionals.filter((dir) => !existsSync(resolve(dir)));
    if (missing.length) {
      process.stderr.write(`hotpress diff: no such directory: ${missing.join(", ")}\n`);
      return 2;
    }
    const { runDiff, formatReport } = await import("./diff/index.ts");
    const report = await runDiff({
      baseline: resolve(positionals[0]),
      candidate: resolve(positionals[1]),
      origins: values.origin,
      ignore: values.ignore,
      probes: values.probe,
      strictWhitespace: values["strict-whitespace"]
    });
    process.stdout.write(formatReport(report, Number(values.examples ?? 5)) + "\n");
    if (values.json) await writeFile(values.json, JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  if (command === "build" || command === "dev") {
    const { values } = parseArgs({
      args: rest,
      options: {
        config: { type: "string" },
        out: { type: "string" },
        port: { type: "string" },
        root: { type: "string" },
        "third-party": { type: "boolean" },
        check: { type: "boolean" }
      }
    });
    const root = resolve(values.root ?? ".");
    if (command === "build" && values.check) {
      // For CI: build, then every check that needs nothing outside the checkout (site tasks included,
      // report-only). Any problem fails the build, so the host keeps serving the previous deploy.
      if (values.out) throw new Error("--out can't be combined with --check");
      const { check } = await import("./publish/check.ts");
      const result = await check({ root, configFile: values.config, offline: true });
      if (!result.ok) process.stderr.write("\nBuild stopped: fix the problems above (or publish with `hotpress publish`, which runs the site's tasks).\n");
      return result.ok ? 0 : 1;
    }
    if (command === "build") {
      const { build } = await import("./build/build.ts");
      const result = await build({ root, configFile: values.config, outDir: values.out, mode: "production" });
      return result.ok ? 0 : 1;
    }
    const { dev } = await import("./preview/server.ts");
    await dev({ root, configFile: values.config, port: Number(values.port ?? 4321), thirdParty: values["third-party"] });
    return 0;
  }
  if (command === "serve") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { port: { type: "string" } } });
    const { serve } = await import("./preview/server.ts");
    await serve({ dir: resolve(positionals[0] ?? "dist"), port: Number(values.port ?? 4321) });
    await new Promise(() => {});
    return 0;
  }
  if (command === "check" || command === "publish") {
    const { values } = parseArgs({
      args: rest,
      options: {
        config: { type: "string" },
        root: { type: "string" },
        message: { type: "string", short: "m" },
        all: { type: "boolean", short: "a" },
        allow: { type: "string", multiple: true },
        offline: { type: "boolean" },
        twice: { type: "boolean" },
        "dry-run": { type: "boolean" },
        fix: { type: "boolean" },
        json: { type: "boolean" }
      }
    });
    const root = resolve(values.root ?? ".");
    const quiet = Boolean(values.json);
    const toJson = (problems: unknown, extra: Record<string, unknown>) =>
      process.stdout.write(JSON.stringify({ ...extra, problems }, null, 2) + "\n");
    if (command === "check") {
      const { check } = await import("./publish/check.ts");
      const r = await check({ root, configFile: values.config, allow: values.allow, offline: values.offline, twice: values.twice, fix: values.fix, log: !quiet });
      if (quiet) toJson(r.problems, { ok: r.ok, allowed: r.allowed, warnings: r.warnings, changes: r.changes, fixed: r.fixed });
      return r.ok ? 0 : 1;
    }
    const { publish } = await import("./publish/publish.ts");
    const r = await publish({
      root,
      configFile: values.config,
      message: values.message,
      all: values.all,
      allow: values.allow,
      offline: values.offline,
      twice: values.twice,
      dryRun: values["dry-run"],
      log: !quiet
    });
    if (quiet) toJson(r.problems, { ok: r.ok, pushed: r.pushed, commit: r.commit, changes: r.check?.changes, warnings: r.check?.warnings });
    return r.ok ? 0 : 1;
  }
  process.stderr.write(`Unknown command "${command}"\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const err = error as Error & { hotpress?: boolean };
    process.stderr.write(err.hotpress ? `\n${err.message}\n` : `${err.stack ?? err}\n`);
    process.exitCode = 1;
  }
);
