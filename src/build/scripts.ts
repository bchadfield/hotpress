// Opt-in client JavaScript. Importing "./file.ts?client" from server code yields a handle;
// rendering <Script src={handle} /> adds the bundled script to that page only.

import { usePage } from "../jsx/context.ts";
import { escapeAttr, raw, type Html } from "../jsx/runtime.ts";

export interface ClientScript {
  readonly __hotpressClient: string;
}

interface Registry {
  urls: Map<string, string>;
}

const KEY = Symbol.for("hotpress.clientScripts");
const g = globalThis as unknown as Record<symbol, Registry>;
g[KEY] ??= { urls: new Map() };

/** Used by the bundler's generated stub modules. */
export function clientScript(path: string): ClientScript {
  return { __hotpressClient: path };
}

export function setClientScriptUrls(urls: Map<string, string>): void {
  g[KEY].urls = urls;
}

export function clientScriptUrl(handle: ClientScript): string {
  const url = g[KEY].urls.get(handle.__hotpressClient);
  if (!url) throw new Error(`client script ${handle.__hotpressClient} was not bundled (import it from server code so the build can find it)`);
  return url;
}

export interface ScriptProps {
  src: ClientScript | string;
  /** "module" (default) or "classic". */
  type?: "module" | "classic";
  defer?: boolean;
  async?: boolean;
}

/** A script tag, rendered once per page however many components ask for it. */
export function Script(props: ScriptProps): Html {
  const url = typeof props.src === "string" ? props.src : clientScriptUrl(props.src);
  const page = usePage();
  if (page.scripts.has(url)) return raw("");
  page.scripts.add(url);
  const type = props.type === "classic" ? "" : ` type="module"`;
  return raw(`<script${type} src="${escapeAttr(url)}"${props.defer ? " defer" : ""}${props.async ? " async" : ""}></script>`);
}
