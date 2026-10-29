import { Parser } from "htmlparser2";
import { normaliseText } from "./html.ts";

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** Parse XML into a small tree. Text is concatenated per element (CDATA included). */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const node: XmlNode = { name, attrs, children: [], text: "" };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      },
      ontext(text) {
        stack[stack.length - 1].text += text;
      },
      oncdatastart() {},
      onclosetag() {
        if (stack.length > 1) stack.pop();
      }
    },
    { xmlMode: true, decodeEntities: true, recognizeCDATA: true }
  );
  parser.write(xml);
  parser.end();
  return root;
}

export function rootElement(doc: XmlNode): XmlNode | undefined {
  return doc.children.find((c) => !c.name.startsWith("?") && !c.name.startsWith("!"));
}

export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => localName(c.name) === name);
}

export function localName(name: string): string {
  const idx = name.indexOf(":");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/** Flatten a tree into "path = value" lines with whitespace normalised, for comparison. */
export function flatten(node: XmlNode, prefix = ""): string[] {
  const path = prefix ? `${prefix}/${node.name}` : node.name;
  const lines: string[] = [];
  const attrs = Object.keys(node.attrs)
    .sort()
    .map((k) => `@${k}=${normaliseText(node.attrs[k])}`);
  if (attrs.length) lines.push(`${path} ${attrs.join(" ")}`);
  const text = normaliseText(node.text);
  if (text) lines.push(`${path} = ${text}`);
  for (const c of node.children) lines.push(...flatten(c, path));
  return lines;
}
