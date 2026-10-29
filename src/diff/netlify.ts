// Parsers for Netlify's _redirects and _headers files, plus the Frameworks API config
// (.netlify/v1/config.json) that adapters write, so baselines can include adapter rules.

export interface RedirectRule {
  from: string;
  to: string;
  status: number;
  force: boolean;
  /** Anything after the status (conditions such as Country=… or Role=…), kept verbatim. */
  conditions: string[];
}

export interface HeaderRule {
  for: string;
  values: [string, string][];
}

export function parseRedirects(text: string): RedirectRule[] {
  const rules: RedirectRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [from, to, ...rest] = parts;
    let status = 301;
    let force = false;
    const conditions: string[] = [];
    for (const part of rest) {
      const m = /^(\d{3})(!?)$/.exec(part);
      if (m && conditions.length === 0) {
        status = Number(m[1]);
        force = m[2] === "!";
      } else {
        conditions.push(part);
      }
    }
    rules.push({ from, to, status, force, conditions });
  }
  return rules;
}

export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine) || !rawLine.trim()) continue;
    if (!/^\s/.test(rawLine)) {
      current = { for: rawLine.trim(), values: [] };
      rules.push(current);
      continue;
    }
    const line = rawLine.trim();
    const idx = line.indexOf(":");
    if (idx < 0 || !current) continue;
    current.values.push([line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()]);
  }
  return rules;
}

interface FrameworksConfig {
  headers?: { for: string; values: Record<string, string> }[];
  redirects?: { from: string; to: string; status?: number; force?: boolean }[];
}

export function parseFrameworksConfig(text: string): { headers: HeaderRule[]; redirects: RedirectRule[] } {
  const config = JSON.parse(text) as FrameworksConfig;
  return {
    headers: (config.headers ?? []).map((h) => ({
      for: h.for,
      values: Object.entries(h.values).map(([k, v]) => [k.toLowerCase(), v] as [string, string])
    })),
    redirects: (config.redirects ?? []).map((r) => ({
      from: r.from,
      to: r.to,
      status: r.status ?? 301,
      force: Boolean(r.force),
      conditions: []
    }))
  };
}

/** Match a Netlify "from" pattern (splats and :placeholders) against a path. */
export function matchRule(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  let re = "";
  const segments = pattern.split("/");
  segments.forEach((segment, i) => {
    if (i > 0) re += "/";
    if (segment === "*") {
      names.push("splat");
      re += "(.*)";
    } else if (segment.startsWith(":")) {
      names.push(segment.slice(1));
      re += "([^/]+)";
    } else {
      re += segment.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
    }
  });
  const m = new RegExp(`^${re}/?$`).exec(path);
  if (!m) return null;
  const params: Record<string, string> = {};
  names.forEach((name, i) => (params[name] = m[i + 1]));
  return params;
}

export function applyParams(target: string, params: Record<string, string>): string {
  return target.replace(/:([A-Za-z_]\w*)/g, (whole, name: string) => (name in params ? params[name] : whole));
}
