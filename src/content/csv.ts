// RFC 4180 CSV parsing: quoted fields, escaped quotes, newlines inside quotes, CRLF.

export interface CsvRecord {
  /** 1-based line where the record starts in the file (header is line 1). */
  line: number;
  fields: Record<string, string>;
}

export class CsvError extends Error {}

export function parseCsvRows(text: string): { line: number; values: string[] }[] {
  const rows: { line: number; values: string[] }[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const startLine = line;
    const values: string[] = [];
    let field = "";
    let inQuotes = false;
    let quotedField = false;
    for (; i < n; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          if (c === "\n") line++;
          field += c;
        }
        continue;
      }
      if (c === '"' && field === "" && !quotedField) {
        inQuotes = true;
        quotedField = true;
      } else if (c === ",") {
        values.push(field);
        field = "";
        quotedField = false;
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        i++;
        line++;
        break;
      } else {
        field += c;
      }
    }
    if (inQuotes) throw new CsvError(`unterminated quoted field starting on line ${startLine}`);
    values.push(field);
    if (values.length === 1 && values[0] === "") continue; // blank line
    rows.push({ line: startLine, values });
  }
  return rows;
}

export function parseCsv(text: string, options: { trim?: boolean } = {}): { headers: string[]; records: CsvRecord[] } {
  const rows = parseCsvRows(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].values.map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h)) throw new CsvError(`duplicate column "${h}" in header`);
    seen.add(h);
  }
  const records = rows.slice(1).map(({ line, values }) => {
    if (values.length !== headers.length) {
      throw new CsvError(`line ${line}: expected ${headers.length} columns, found ${values.length}`);
    }
    const fields: Record<string, string> = {};
    headers.forEach((h, idx) => (fields[h] = options.trim === false ? values[idx] : values[idx].trim()));
    return { line, fields };
  });
  return { headers, records };
}
