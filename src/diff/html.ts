import { Parser } from "htmlparser2";

/** The search-relevant facts of one HTML page, as Google would read them. */
export interface PageSeo {
  title: string[];
  description: string[];
  canonical: string[];
  /** name=robots / googlebot / bingbot etc., as "name: content". */
  robots: string[];
  /** og:*, twitter:*, article:*, fb:* meta tags as "key: content", in document order. */
  social: string[];
  /** JSON-LD blocks, re-serialised with sorted keys (or raw text if invalid JSON). */
  jsonld: string[];
  hreflang: string[];
  h1: string[];
  base: string | null;
  /** Raw (unnormalised) title and description, to tell whitespace-only changes apart. */
  raw: { title: string[]; description: string[] };
  /** Every URL the page references, unresolved, with where it came from. */
  refs: { url: string; from: string }[];
  /** Visible body text, whitespace-normalised (for the informational content comparison). */
  text: string;
  /** Visible text of the primary content: the first <article>, else <main>, else the body. */
  mainText: string;
}

export function normaliseText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function canonicalJson(text: string): string {
  try {
    return JSON.stringify(sortKeys(JSON.parse(text)));
  } catch {
    return `INVALID JSON: ${normaliseText(text)}`;
  }
}

const SOCIAL_PREFIXES = ["og:", "twitter:", "article:", "fb:", "profile:", "book:"];
const ROBOTS_NAMES = new Set(["robots", "googlebot", "googlebot-news", "bingbot"]);
const URL_ATTRS: Record<string, string[]> = {
  a: ["href"],
  area: ["href"],
  link: ["href"],
  img: ["src"],
  script: ["src"],
  iframe: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  form: ["action"]
};
const SKIP_LINK_RELS = new Set(["preconnect", "dns-prefetch"]);

export function extractPage(html: string): PageSeo {
  const page: PageSeo = {
    title: [],
    description: [],
    canonical: [],
    robots: [],
    social: [],
    jsonld: [],
    hreflang: [],
    h1: [],
    base: null,
    raw: { title: [], description: [] },
    refs: [],
    text: "",
    mainText: ""
  };
  let articleState = 0; // 0 not seen, >0 depth inside the first article, -1 done
  let mainState = 0;
  let articleBuf = "";
  let mainBuf = "";
  let inBody = false;
  let hiddenDepth = 0;
  let textBuf = "";

  let svgDepth = 0;
  let titleBuf: string | null = null;
  let h1Depth = 0;
  let h1Buf = "";
  let jsonBuf: string | null = null;

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "body") inBody = true;
        if (name === "article" && articleState >= 0) articleState++;
        if (name === "main" && mainState >= 0) mainState++;
        if (name === "script" || name === "style" || name === "template" || name === "noscript") hiddenDepth++;
        if (name === "svg") svgDepth++;
        if (name === "title" && svgDepth === 0) titleBuf = "";
        if (name === "h1") {
          if (h1Depth === 0) h1Buf = "";
          h1Depth++;
        }
        if (name === "script" && (attrs.type ?? "").trim().toLowerCase() === "application/ld+json") jsonBuf = "";
        if (name === "base" && attrs.href !== undefined && page.base === null) page.base = attrs.href;
        if (name === "meta") {
          const key = (attrs.property ?? attrs.name ?? "").trim();
          const lower = key.toLowerCase();
          const content = attrs.content ?? "";
          if (lower === "description") {
            page.description.push(normaliseText(content));
            page.raw.description.push(content);
          } else if (ROBOTS_NAMES.has(lower)) {
            page.robots.push(`${lower}: ${normaliseText(content).toLowerCase()}`);
          } else if (SOCIAL_PREFIXES.some((p) => lower.startsWith(p))) {
            page.social.push(`${key}: ${normaliseText(content)}`);
            if (/^(og:image|og:url|og:image:url|og:image:secure_url|twitter:image)$/.test(lower) && content) {
              page.refs.push({ url: content.trim(), from: `meta ${key}` });
            }
          }
        }
        if (name === "link") {
          const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
          if (rel.includes("canonical")) page.canonical.push((attrs.href ?? "").trim());
          if (rel.includes("alternate") && attrs.hreflang !== undefined) {
            page.hreflang.push(`${attrs.hreflang.trim().toLowerCase()}: ${(attrs.href ?? "").trim()}`);
          }
          if (rel.some((r) => SKIP_LINK_RELS.has(r))) return;
        }
        const urlAttrs = URL_ATTRS[name];
        if (urlAttrs) {
          for (const attr of urlAttrs) {
            const value = attrs[attr];
            if (value !== undefined && value.trim() !== "") page.refs.push({ url: value.trim(), from: `${name}[${attr}]` });
          }
        }
        for (const attr of ["srcset", "imagesrcset"]) {
          const srcset = attrs[attr];
          if (srcset) {
            for (const candidate of srcset.split(",")) {
              const url = candidate.trim().split(/\s+/)[0];
              if (url) page.refs.push({ url, from: `${name}[${attr}]` });
            }
          }
        }
      },
      ontext(text) {
        if (inBody && hiddenDepth === 0) {
          textBuf += text;
          if (articleState > 0) articleBuf += text;
          if (mainState > 0) mainBuf += text;
        }
        if (titleBuf !== null) titleBuf += text;
        if (h1Depth > 0) h1Buf += text;
        if (jsonBuf !== null) jsonBuf += text;
      },
      onclosetag(name) {
        if ((name === "script" || name === "style" || name === "template" || name === "noscript") && hiddenDepth > 0) hiddenDepth--;
        if (name === "svg" && svgDepth > 0) svgDepth--;
        // Block boundaries separate words, as a browser would render them.
        if (inBody) {
          textBuf += " ";
          if (articleState > 0) articleBuf += " ";
          if (mainState > 0) mainBuf += " ";
        }
        if (name === "article" && articleState > 0 && --articleState === 0) articleState = -1;
        if (name === "main" && mainState > 0 && --mainState === 0) mainState = -1;
        if (name === "title" && titleBuf !== null) {
          page.title.push(normaliseText(titleBuf));
          page.raw.title.push(titleBuf);
          titleBuf = null;
        }
        if (name === "h1" && h1Depth > 0) {
          h1Depth--;
          if (h1Depth === 0) page.h1.push(normaliseText(h1Buf));
        }
        if (name === "script" && jsonBuf !== null) {
          page.jsonld.push(canonicalJson(jsonBuf));
          jsonBuf = null;
        }
      }
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );
  parser.write(html);
  parser.end();
  page.text = normaliseText(textBuf);
  page.mainText = normaliseText(articleState !== 0 ? articleBuf : mainState !== 0 ? mainBuf : textBuf);
  return page;
}

export const SEO_FIELDS = ["title", "description", "canonical", "robots", "social", "jsonld", "hreflang", "h1", "base"] as const;
export type SeoField = (typeof SEO_FIELDS)[number];
