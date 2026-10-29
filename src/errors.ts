// Errors meant to be read by a person or an agent: a stable code, where, what, and how to fix it.

export interface Problem {
  code: string;
  message: string;
  file?: string;
  line?: number;
  url?: string;
  field?: string;
  hint?: string;
}

export class HotpressError extends Error {
  readonly hotpress = true;
  readonly problems: Problem[];
  constructor(problems: Problem[] | Problem) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(formatProblems(list));
    this.problems = list;
  }
}

export function formatProblem(p: Problem): string {
  const where = [p.file && (p.line ? `${p.file}:${p.line}` : p.file), p.url, p.field].filter(Boolean).join(" ");
  return `[${p.code}] ${where ? where + ": " : ""}${p.message}${p.hint ? `\n    hint: ${p.hint}` : ""}`;
}

export function formatProblems(problems: Problem[], limit = 50): string {
  // The same error on thousands of pages (a template bug) is one entry with a count.
  const groups = new Map<string, Problem[]>();
  for (const p of problems) {
    const key = `${p.code}|${p.file ?? ""}|${p.message}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const shown = [...groups.values()].slice(0, limit).map((items) => {
    if (items.length === 1) return formatProblem(items[0]);
    const urls = items.slice(0, 3).map((p) => p.url ?? p.file).filter(Boolean).join(", ");
    return formatProblem({ ...items[0], url: undefined, message: `${items[0].message} (${items.length} pages: ${urls}${items.length > 3 ? ", …" : ""})` });
  });
  if (groups.size > limit) shown.push(`… and ${groups.size - limit} more`);
  return `${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${shown.join("\n")}`;
}
