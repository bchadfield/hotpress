import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "../src/build/build.ts";
import { serve, startDev } from "../src/preview/server.ts";

const EXAMPLE = new URL("../examples/basic/", import.meta.url).pathname;
// Inside the package so the example's import of the package resolves to this checkout.
const TMP = new URL("./.tmp/", import.meta.url).pathname;

test("live reload reaches open pages over a WebSocket, not a held HTTP connection", async () => {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, "serve-"));
  await writeFile(join(dir, "index.html"), "<html><body><p>hi</p></body></html>");
  const server = await serve({ dir, port: 0, liveReload: true, log: () => {} });
  try {
    const html = await (await fetch(server.url)).text();
    assert.match(html, /new WebSocket\(/);
    assert.doesNotMatch(html, /EventSource/);

    const ws = new WebSocket(server.url.replace("http:", "ws:") + "__hotpress/events");
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const received: { event: string; data: string }[] = [];
    const all = new Promise<void>((resolve) => {
      ws.onmessage = (m) => {
        received.push(JSON.parse(m.data as string));
        if (received.length === 3) resolve();
      };
    });
    // Short, 16-bit and 64-bit frame lengths.
    const medium = "x".repeat(1000);
    const long = "y".repeat(70_000);
    server.broadcast("reload");
    server.broadcast("failed", medium);
    server.broadcast("failed", long);
    await all;
    assert.deepEqual(received, [
      { event: "reload", data: "" },
      { event: "failed", data: medium },
      { event: "failed", data: long }
    ]);
    ws.close();
  } finally {
    await server.close();
  }
});

test("dev builds outside dist, so a production build alongside it changes neither", async () => {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, "dev-"));
  await cp(EXAMPLE, root, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  const analytics = /analytics\.example\.com/;
  const dev = await startDev({ root, port: 0, log: false });
  try {
    assert.ok(!existsSync(join(root, "dist")), "dev must not write dist");
    assert.doesNotMatch(await (await fetch(dev.url)).text(), analytics);

    const prod = await build({ root, mode: "production", log: false });
    assert.ok(prod.ok);
    assert.match(await readFile(join(root, "dist", "index.html"), "utf8"), analytics);
    assert.doesNotMatch(await (await fetch(dev.url)).text(), analytics);
    assert.doesNotMatch(await readFile(join(dev.outDir, "index.html"), "utf8"), analytics);
  } finally {
    await dev.close();
  }
});

/** Fetch until the page matches (dev rebuilds after a short debounce). */
async function waitFor(url: string, pattern: RegExp, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < until) {
    last = await (await fetch(url)).text();
    if (pattern.test(last)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${url} never matched ${pattern}:\n${last.slice(0, 500)}`);
}

test("dev ignores only the configured out dir, and keeps watching folders that are replaced", async () => {
  await mkdir(TMP, { recursive: true });
  const root = await mkdtemp(join(TMP, "dev-"));
  await cp(EXAMPLE, root, { recursive: true, filter: (src) => !/[/\\](dist|\.hotpress-cache)([/\\]|$)/.test(src) });
  const sitePath = join(root, "hotpress.site.tsx");
  await writeFile(sitePath, (await readFile(sitePath, "utf8")).replace("export default defineSite({", 'export default defineSite({\n  outDir: "src/out",'));
  const dev = await startDev({ root, port: 0, log: false });
  try {
    const post = `${dev.url}blog/hello-world/`;
    // src/ holds the out dir, but the rest of it is still sources.
    const layout = join(root, "src/Layout.tsx");
    await writeFile(layout, (await readFile(layout, "utf8")).replace("<body>", "<body><p>layout-edit</p>"));
    await waitFor(post, /layout-edit/);
    // A folder deleted and created again (as a branch switch does) is still watched.
    const content = join(root, "content");
    await rename(content, join(root, "content-old"));
    await cp(join(root, "content-old"), content, { recursive: true });
    await rm(join(root, "content-old"), { recursive: true });
    await waitFor(post, /<h1>/);
    const file = join(content, "posts/2024-01-10-hello-world.md");
    await writeFile(file, (await readFile(file, "utf8")) + "\nreplaced-folder-edit\n");
    await waitFor(post, /replaced-folder-edit/);
  } finally {
    await dev.close();
  }
});
