import type { DiffReport, Finding, Section } from "./index.ts";

function indent(text: string, by = "      "): string {
  return text
    .split("\n")
    .map((l) => by + l)
    .join("\n");
}

function groupKey(section: Section, f: Finding): string {
  if (section.id === "pages") return f.field ?? "other";
  if (section.id === "urls") return f.message;
  if (section.id === "sitemaps") return `${f.url} ${f.field === "loc" || f.field === "order" ? f.field : "fields"}`;
  if (section.id === "links") return f.field ?? "link";
  if (section.id === "content") return "text differs";
  return f.url ?? "other";
}

function describe(section: Section, f: Finding): string {
  if (section.id === "pages") return `${f.url}\n${indent(f.message, "    ")}`;
  if (section.id === "urls" || section.id === "status") return `${f.url}${section.id === "status" ? `  ${f.message}` : ""}`;
  if (section.id === "links") return `${f.url} -> ${f.candidate}`;
  if (section.id === "content") return `${f.url}\n    - ${f.baseline}\n    + ${f.candidate}`;
  if (section.id === "sitemaps" && f.field !== "loc" && f.field !== "order")
    return `${f.field}\n    - ${f.baseline}\n    + ${f.candidate}`;
  return f.message.includes("\n") ? `${f.url ?? ""}\n${indent(f.message, "    ")}` : `${f.url ?? ""} ${f.message}`;
}

export function formatReport(report: DiffReport, maxExamples = 5): string {
  const out: string[] = [];
  out.push(`hotpress diff`);
  out.push(`  baseline:  ${report.baseline}`);
  out.push(`  candidate: ${report.candidate}`);
  out.push(`  origins:   ${report.origins.join(", ") || "(none found)"}`);
  out.push("");
  for (const s of report.sections) {
    const status = s.informational ? "info" : s.failures.length ? "FAIL" : "ok";
    const notes = s.notes.length ? `, ${s.notes.length} note${s.notes.length === 1 ? "" : "s"}` : "";
    out.push(`[${status.padEnd(4)}] ${s.title}: ${s.checked} checked, ${s.failures.length} diff${s.failures.length === 1 ? "" : "s"}${notes}`);
  }
  for (const s of report.sections) {
    for (const [label, findings] of [
      ["diffs", s.failures],
      ["notes", s.notes]
    ] as const) {
      if (!findings.length) continue;
      out.push("");
      out.push(`== ${s.title}: ${findings.length} ${label}`);
      const groups = new Map<string, Finding[]>();
      for (const f of findings) {
        const key = groupKey(s, f);
        groups.set(key, [...(groups.get(key) ?? []), f]);
      }
      for (const [key, items] of groups) {
        out.push(`  ${key} (${items.length})`);
        for (const f of items.slice(0, maxExamples)) out.push(indent(describe(s, f), "    "));
        if (items.length > maxExamples) out.push(`    … and ${items.length - maxExamples} more`);
      }
    }
  }
  out.push("");
  out.push(report.ok ? `PASS: zero diffs (${report.durationMs} ms)` : `FAIL: diffs found (${report.durationMs} ms)`);
  return out.join("\n");
}
