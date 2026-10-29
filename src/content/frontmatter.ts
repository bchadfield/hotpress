import { parse } from "yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  /** Line in the file where the body starts (1-based). */
  bodyLine: number;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(source: string): Frontmatter {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = FENCE.exec(text);
  if (!match) return { data: {}, body: text, bodyLine: 1 };
  const yaml = match[1];
  // YAML 1.1 types would turn bare dates into Date objects in the local zone and "no" into false;
  // the core schema keeps them as strings and the collection schema decides.
  const data = (yaml.trim() ? parse(yaml, { schema: "core" }) : {}) as unknown;
  if (data !== null && (typeof data !== "object" || Array.isArray(data))) {
    throw new Error("frontmatter must be a YAML mapping (key: value pairs)");
  }
  const consumed = match[0];
  return { data: (data ?? {}) as Record<string, unknown>, body: text.slice(consumed.length), bodyLine: consumed.split("\n").length };
}
