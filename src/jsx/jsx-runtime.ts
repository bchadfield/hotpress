import { Fragment, jsx, jsxDEV, jsxs, type Child, type Html } from "./runtime.ts";

export { Fragment, jsx, jsxDEV, jsxs };

type Attr = string | number | boolean | null | undefined | Html;

export declare namespace JSX {
  type Element = Html;
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface HtmlProps {
    children?: Child;
    class?: Attr | (string | false | null | undefined)[];
    className?: Attr;
    style?: string | Record<string, string | number | null | undefined>;
    dangerouslySetInnerHTML?: { __html: string };
    [attr: string]: unknown;
  }
  interface IntrinsicElements {
    [tag: string]: HtmlProps;
  }
}
