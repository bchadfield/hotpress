import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
