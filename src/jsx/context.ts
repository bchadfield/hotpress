// The page currently being rendered. Rendering is synchronous, so a module-level slot is safe:
// no two renders can interleave.

export type Mode = "build" | "preview";

export interface PageContext {
  /** URL path of the page being rendered, e.g. "/blog/hello/". */
  url: string;
  /** Absolute URL, using the site origin. */
  href: string;
  origin: string;
  mode: Mode;
  /** Page metadata passed to site.page(). */
  meta: Record<string, unknown>;
  /** Client scripts requested during this render (deduplicated by Script). */
  scripts: Set<string>;
}

// Kept on globalThis so every copy of this module (the CLI's and the site's) sees the same page.
const KEY = Symbol.for("hotpress.page");
const slot = globalThis as unknown as Record<symbol, PageContext | undefined>;

export function usePage(): PageContext {
  const current = slot[KEY];
  if (!current) throw new Error("usePage() can only be called while a page is rendering (inside a site.page() render function).");
  return current;
}

export function withPage<T>(ctx: PageContext, fn: () => T): T {
  const previous = slot[KEY];
  slot[KEY] = ctx;
  try {
    return fn();
  } finally {
    slot[KEY] = previous;
  }
}
