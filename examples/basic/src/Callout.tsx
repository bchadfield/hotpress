import type { Child } from "hotpress";

export default function Callout(props: { tone: "info" | "warn"; children?: Child }) {
  return <aside class={`callout callout-${props.tone}`}>{props.children}</aside>;
}
