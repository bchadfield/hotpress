import { createHash } from "node:crypto";
import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { build, isInside } from "../build/build.ts";
import { formatProblems } from "../errors.ts";
import { listFiles } from "../diff/files.ts";
import { StaticHost } from "../diff/host.ts";
import { matchRule, parseHeaders, parseRedirects, type HeaderRule } from "../diff/netlify.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".zip": "application/zip"
};

// Live reload uses a WebSocket, not EventSource: an open EventSource holds one of the browser's six
// HTTP/1.1 connections per host, so six preview tabs would leave none for the seventh page's requests.
const RELOAD_SCRIPT = `<script>(()=>{const s=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/__hotpress/events");s.onmessage=m=>{const{event,data}=JSON.parse(m.data);if(event==="reload")return location.reload();let d=document.getElementById("__hotpress_error");if(!d){d=document.createElement("pre");d.id="__hotpress_error";d.style.cssText="position:fixed;inset:auto 0 0 0;max-height:50vh;overflow:auto;margin:0;padding:1rem;background:#300;color:#fdd;font:12px/1.4 monospace;z-index:2147483647;white-space:pre-wrap";document.body.append(d)}d.textContent=data}})()</script>`;

/** One unmasked WebSocket text frame (server to client). */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.alloc(10);
  if (n >= 65536) {
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

export interface ServeOptions {
  dir: string;
  port: number;
  liveReload?: boolean;
  log?: (msg: string) => void;
}

export interface Server {
  url: string;
  /** Re-read the output directory (after a rebuild). */
  refresh(): Promise<void>;
  broadcast(event: "reload" | "failed", data?: string): void;
  close(): Promise<void>;
}

function headerMatches(rule: HeaderRule, path: string): boolean {
  return matchRule(rule.for, path) !== null || (rule.for.endsWith("/*") && path === rule.for.slice(0, -1));
}

/** Serve a build directory the way Netlify / GitHub Pages would. */
export async function serve(options: ServeOptions): Promise<Server> {
  const log = options.log ?? ((m: string) => process.stdout.write(m + "\n"));
  let host = new StaticHost([]);
  let headerRules: HeaderRule[] = [];
  const clients = new Set<Duplex>();

  let lastRefresh = 0;
  async function refresh(): Promise<void> {
    lastRefresh = Date.now();
    const files = await listFiles(options.dir).catch(() => [] as string[]);
    const redirectsText = await readFile(join(options.dir, "_redirects"), "utf8").catch(() => "");
    headerRules = parseHeaders(await readFile(join(options.dir, "_headers"), "utf8").catch(() => ""));
    host = new StaticHost(files, parseRedirects(redirectsText));
  }
  await refresh();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let resolved = host.resolve(url.pathname);
    // The directory may have been rebuilt underneath a plain `serve`: look again before a 404.
    if (resolved.status === 404 && Date.now() - lastRefresh > 1000) {
      await refresh();
      resolved = host.resolve(url.pathname);
    }
    if (resolved.location) {
      res.writeHead(resolved.status, { location: resolved.location + (url.search && !resolved.location.includes("?") ? url.search : "") });
      res.end();
      return;
    }
    const headers: Record<string, string> = { "cache-control": "no-store" };
    // Site headers apply to files that exist. During dev, nothing may be cached: files change under the same URL.
    if (resolved.status < 400) for (const rule of headerRules) if (headerMatches(rule, url.pathname)) for (const [k, v] of rule.values) headers[k] = v;
    if (options.liveReload) headers["cache-control"] = "no-store";
    if (!resolved.file) {
      res.writeHead(resolved.status, { "content-type": "text/plain; charset=utf-8" });
      res.end(resolved.status === 404 ? "Not found (and no 404.html in the build)" : `${resolved.status}`);
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(join(options.dir, resolved.file));
    } catch {
      res.writeHead(500);
      res.end("read error");
      return;
    }
    const type = TYPES[extname(resolved.file).toLowerCase()] ?? "application/octet-stream";
    if (options.liveReload && type.startsWith("text/html")) {
      const html = body.toString("utf8");
      const idx = html.lastIndexOf("</body>");
      body = Buffer.from(idx >= 0 ? html.slice(0, idx) + RELOAD_SCRIPT + html.slice(idx) : html + RELOAD_SCRIPT);
    }
    res.writeHead(resolved.status, { ...headers, "content-type": type, "content-length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!options.liveReload || new URL(req.url ?? "/", "http://localhost").pathname !== "/__hotpress/events" || typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => socket.destroy());
    // The page only listens, so anything it sends is a close frame (navigation, tab closed).
    socket.on("data", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://localhost:${port}/`;
  log(`Serving ${relative(process.cwd(), options.dir) || "."} at ${url}`);
  return {
    url,
    refresh,
    broadcast(event, data = "") {
      const frame = textFrame(JSON.stringify({ event, data }));
      for (const c of clients) c.write(frame);
    },
    async close() {
      for (const c of clients) c.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export interface DevOptions {
  root: string;
  configFile?: string;
  port: number;
  /** Render third-party scripts (analytics, ads) as in production. */
  thirdParty?: boolean;
  log?: boolean;
}

export interface DevServer {
  url: string;
  outDir: string;
  close(): Promise<void>;
}

/**
 * Where dev builds. Never `dist`: a preview-mode build there could be deployed, and a `build` or `check`
 * run alongside dev would overwrite what dev is serving.
 */
export const DEV_OUT_DIR = join(".hotpress-cache", "dev");

/** Folders (relative to the root) that never hold site sources. */
const IGNORED = ["node_modules", "dist", ".hotpress-cache"];

/**
 * Watch the site's sources: the root's own files plus each top-level folder, recursively, except
 * dot-folders and the `ignored` paths (which may be nested, like "src/out"). One recursive watch on the
 * root would add an inotify watch for every folder in node_modules on Linux.
 */
function watchSources(root: string, ignored: string[], onChange: () => void): () => void {
  const watchers = new Map<string, { watcher: FSWatcher; ino: number }>();
  const isIgnored = (rel: string) => ignored.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
  const skip = (name: string) => name.startsWith(".") || isIgnored(name);
  const watchDir = (name: string) => {
    if (skip(name)) return;
    let st;
    try {
      st = statSync(join(root, name));
    } catch {}
    const current = watchers.get(name);
    if (current && st?.isDirectory() && st.ino === current.ino) return;
    // Gone, now a file, or deleted and created again (a branch switch): the old watch sees nothing.
    if (current) {
      current.watcher.close();
      watchers.delete(name);
    }
    if (!st?.isDirectory()) return;
    try {
      const watcher = watch(join(root, name), { recursive: true }, (_event, filename) => {
        const rel = filename ? `${name}/${filename.toString().split(sep).join("/")}` : name;
        if (!isIgnored(rel)) onChange();
      });
      watcher.on("error", () => {
        watcher.close();
        if (watchers.get(name)?.watcher === watcher) watchers.delete(name);
      });
      watchers.set(name, { watcher, ino: st.ino });
    } catch {}
  };
  const top = watch(root, (_event, filename) => {
    const name = filename?.toString();
    if (!name || skip(name)) return;
    watchDir(name); // a new, removed or replaced folder
    onChange();
  });
  for (const name of readdirSync(root)) watchDir(name);
  return () => {
    top.close();
    for (const { watcher } of watchers.values()) watcher.close();
  };
}

/** Production build + host-accurate preview + rebuild and reload on change, until closed. */
export async function startDev(options: DevOptions): Promise<DevServer> {
  const mode = options.thirdParty ? "production" : "preview";
  const buildOptions = { root: options.root, configFile: options.configFile, mode, outDir: DEV_OUT_DIR, log: options.log } as const;
  const first = await build(buildOptions);
  const outDir = first.outDir || join(options.root, DEV_OUT_DIR);
  const server = await serve({ dir: outDir, port: options.port, liveReload: true, log: options.log === false ? () => {} : undefined });
  if (!options.thirdParty && options.log !== false) process.stdout.write("Third-party scripts are off in preview (usePage().mode === \"preview\"); use --third-party to include them.\n");

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;
  let closed = false;
  const rebuild = async () => {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    const result = await build(buildOptions).catch((error: Error) => ({ ok: false, problems: [{ code: "crash", message: error.stack ?? String(error) }] }));
    if (closed) return;
    if (result.ok) {
      await server.refresh();
      server.broadcast("reload");
    } else {
      server.broadcast("failed", formatProblems(result.problems));
    }
    running = false;
    if (again) {
      again = false;
      void rebuild();
    }
  };

  // A configured outDir (where `build` writes) must not trigger dev rebuilds either; only that folder,
  // not the top-level folder it is in ("src/out" leaves the rest of src watched).
  const configured = resolve(options.root, first.config?.outDir ?? "dist");
  const ignored =
    configured !== resolve(options.root) && isInside(configured, options.root) ? [...IGNORED, relative(options.root, configured).split(sep).join("/")] : IGNORED;
  const stopWatching = watchSources(options.root, ignored, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 80);
  });
  return {
    url: server.url,
    outDir,
    async close() {
      closed = true;
      clearTimeout(timer);
      stopWatching();
      await server.close();
    }
  };
}

/** `hotpress dev`: run until interrupted. */
export async function dev(options: DevOptions): Promise<void> {
  const server = await startDev(options);
  await new Promise<void>((resolve) => {
    const stop = () => void server.close().then(resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
