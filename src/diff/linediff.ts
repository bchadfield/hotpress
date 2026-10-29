/** A compact line diff ("- removed" / "+ added") using LCS, capped for huge inputs. */
export function lineDiff(a: string[], b: string[], maxLines = 40): string {
  // Trim the common prefix and suffix first; most diffs are small edits in long lists.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  const out: string[] = [];
  if (ma.length * mb.length > 4_000_000) {
    for (const l of ma) out.push(`- ${l}`);
    for (const l of mb) out.push(`+ ${l}`);
  } else {
    const dp: number[][] = Array.from({ length: ma.length + 1 }, () => new Array(mb.length + 1).fill(0));
    for (let i = ma.length - 1; i >= 0; i--)
      for (let j = mb.length - 1; j >= 0; j--)
        dp[i][j] = ma[i] === mb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < ma.length || j < mb.length) {
      if (i < ma.length && j < mb.length && ma[i] === mb[j]) {
        i++;
        j++;
      } else if (j < mb.length && (i === ma.length || dp[i][j + 1] >= dp[i + 1][j])) {
        out.push(`+ ${mb[j++]}`);
      } else {
        out.push(`- ${ma[i++]}`);
      }
    }
  }
  // Long lines (feed content, JSON-LD) are cut to a window around where they differ from their pair.
  for (let k = 0; k < out.length; k++) {
    if (out[k].length <= 240) continue;
    const pair = out[k].startsWith("- ") ? out.find((l) => l.startsWith("+ ")) : out.find((l) => l.startsWith("- "));
    const text = out[k].slice(2);
    let i = 0;
    const other = pair ? pair.slice(2) : "";
    while (i < text.length && i < other.length && text[i] === other[i]) i++;
    const from = Math.max(0, i - 100);
    out[k] = `${out[k].slice(0, 2)}${from > 0 ? "…" : ""}${text.slice(from, i + 140)}${i + 140 < text.length ? "…" : ""}`;
  }
  const prefix = start > 0 ? [`  (${start} identical line${start === 1 ? "" : "s"})`] : [];
  const lines = [...prefix, ...out];
  if (lines.length > maxLines) return [...lines.slice(0, maxLines), `  … ${lines.length - maxLines} more`].join("\n");
  return lines.join("\n");
}
