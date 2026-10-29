// A JSX runtime that renders straight to HTML strings. No virtual DOM: jsx() returns an Html value
// holding escaped markup, so rendering a page is a chain of synchronous function calls.

// Html is recognised by a global brand, not instanceof: the CLI and a site can load different copies of
// this module (a global install, npm link), and markup from one must still render in the other.
const HTML = Symbol.for("hotpress.html");

export class Html {
  readonly value: string;
  declare readonly [HTML]: true;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[HTML] === true;
  }
}
Object.defineProperty(Html.prototype, HTML, { value: true });

export type Child = Html | string | number | bigint | boolean | null | undefined | Child[];
export type Component<P = Record<string, unknown>> = (props: P) => Child;

export const Fragment = Symbol.for("hotpress.fragment");

/** Mark a string as trusted HTML. */
export function raw(html: string): Html {
  return new Html(html);
}

const TEXT_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTR_ESCAPES: Record<string, string> = { "&": "&amp;", '"': "&quot;" };

export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (c) => TEXT_ESCAPES[c]);
}

export function escapeAttr(value: string): string {
  return value.replace(/[&"]/g, (c) => ATTR_ESCAPES[c]);
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style"]);
const ATTR_ALIASES: Record<string, string> = { className: "class", htmlFor: "for", httpEquiv: "http-equiv" };

export function renderChild(child: Child, rawText = false): string {
  if (child === null || child === undefined || child === false || child === true) return "";
  if (child instanceof Html) return child.value;
  if (Array.isArray(child)) {
    let out = "";
    for (const c of child) out += renderChild(c, rawText);
    return out;
  }
  if (typeof child === "object" || typeof child === "function") {
    if (typeof (child as { then?: unknown }).then === "function") {
      throw new Error("Hotpress components are synchronous. Load data before rendering instead of awaiting inside a component.");
    }
    throw new Error(`Cannot render ${typeof child} as a child: ${String(child)}`);
  }
  return rawText ? String(child) : escapeText(String(child));
}

function styleToString(style: Record<string, unknown>): string {
  return Object.entries(style)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => `${k.startsWith("--") ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
    .join(";");
}

function renderAttrs(props: Record<string, unknown>): string {
  let out = "";
  for (const key in props) {
    if (key === "children" || key === "dangerouslySetInnerHTML" || key === "key") continue;
    let value = props[key];
    if (value === null || value === undefined || value === false) continue;
    const name = ATTR_ALIASES[key] ?? key;
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    if (name === "style" && typeof value === "object") value = styleToString(value as Record<string, unknown>);
    else if (name === "class" && Array.isArray(value)) value = value.filter(Boolean).join(" ");
    else if (value instanceof Html) value = value.value;
    out += ` ${name}="${escapeAttr(String(value))}"`;
  }
  return out;
}

/** Inline <script>/<style> text is not escaped, but must not close its own element early. */
function guardRawText(tag: string, text: string): string {
  return text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");
}

export function jsx(type: unknown, props: Record<string, unknown>): Html {
  if (type === Fragment) return new Html(renderChild(props.children as Child));
  if (typeof type === "function") {
    const result = (type as Component)(props);
    return new Html(renderChild(result));
  }
  if (typeof type !== "string") throw new Error(`Invalid JSX element type: ${String(type)}`);
  const attrs = renderAttrs(props);
  if (VOID.has(type)) return new Html(`<${type}${attrs}>`);
  const inner = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  let content: string;
  if (inner) content = inner.__html;
  else if (RAW_TEXT.has(type)) content = guardRawText(type, renderChild(props.children as Child, true));
  else content = renderChild(props.children as Child);
  return new Html(`<${type}${attrs}>${content}</${type}>`);
}

export const jsxs = jsx;
export const jsxDEV = jsx;

/** Render any child (element, string, array) to a string. */
export function render(child: Child): string {
  return renderChild(child);
}
