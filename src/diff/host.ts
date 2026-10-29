import { applyParams, matchRule, type RedirectRule } from "./netlify.ts";

export interface Resolution {
  status: number;
  /** Final file served (for 200/404 with a custom page), or redirect target. */
  file?: string;
  location?: string;
}

/**
 * A static host simulator with the semantics shared by Netlify and GitHub Pages: exact files,
 * directory indexes, "/x" -> 301 "/x/" when only x/index.html exists, "/x" -> x.html, then
 * redirect rules (forced rules first), then 404.html with status 404.
 */
export class StaticHost {
  private files: Set<string>;
  private rules: RedirectRule[];

  constructor(files: Iterable<string>, rules: RedirectRule[] = []) {
    this.files = new Set(files);
    this.rules = rules;
  }

  has(file: string): boolean {
    return this.files.has(file);
  }

  private fileFor(path: string): Resolution | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      decoded = path;
    }
    const rel = decoded.replace(/^\/+/, "");
    if (rel === "" || rel.endsWith("/")) {
      const index = `${rel}index.html`;
      if (this.files.has(index)) return { status: 200, file: index };
      return null;
    }
    if (this.files.has(rel)) return { status: 200, file: rel };
    if (this.files.has(`${rel}/index.html`)) return { status: 301, location: `${path}/` };
    if (this.files.has(`${rel}.html`)) return { status: 200, file: `${rel}.html` };
    return null;
  }

  private applyRules(path: string, forced: boolean): Resolution | null {
    for (const rule of this.rules) {
      if (rule.force !== forced || rule.conditions.length) continue;
      const params = matchRule(rule.from, path);
      if (!params) continue;
      const to = applyParams(rule.to, params);
      if (rule.status === 200) {
        // Rewrite: serve the target's file with the rule's status.
        const inner = /^https?:/.test(to) ? null : this.fileFor(to);
        return inner ?? { status: 404 };
      }
      return { status: rule.status, location: to };
    }
    return null;
  }

  resolve(pathWithQuery: string): Resolution {
    const path = pathWithQuery.replace(/[?#].*$/, "") || "/";
    const forced = this.applyRules(path, true);
    if (forced) return forced;
    const file = this.fileFor(path);
    if (file) return file;
    const rule = this.applyRules(path, false);
    if (rule) return rule;
    return this.files.has("404.html") ? { status: 404, file: "404.html" } : { status: 404 };
  }

  /** Follow internal redirects (max 5 hops) and return the final status. */
  finalStatus(path: string): number {
    let current = path;
    for (let hop = 0; hop < 5; hop++) {
      const res = this.resolve(current);
      if (res.status < 300 || res.status >= 400 || !res.location) return res.status;
      if (/^https?:/.test(res.location)) return res.status;
      current = res.location;
    }
    return 310;
  }
}
