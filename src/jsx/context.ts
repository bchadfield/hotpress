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

let current: PageContext | undefined;

export function usePage(): PageContext {
  if (!current) throw new Error("usePage() can only be called while a page is rendering (inside a site.page() render function).");
  return current;
}

export function withPage<T>(ctx: PageContext, fn: () => T): T {
  const previous = current;
  current = ctx;
  try {
    return fn();
  } finally {
    current = previous;
  }
}
