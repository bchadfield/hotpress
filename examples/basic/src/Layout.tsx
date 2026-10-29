import { raw, usePage, JsonLd, type Child } from "@benchadfield/hotpress";

export interface LayoutProps {
  title: string;
  description: string;
  head?: Child;
  children?: Child;
}

export const site = { name: "Example Places", stylesheet: "" };

/** Breadcrumb trail rendered as a nav and as BreadcrumbList JSON-LD. */
export function Breadcrumbs(props: { items: { name: string; url: string }[] }) {
  const page = usePage();
  return (
    <>
      <nav aria-label="Breadcrumb">
        <ol>
          {props.items.map((item, i) => (
            <li>{i === props.items.length - 1 ? <span aria-current="page">{item.name}</span> : <a href={item.url}>{item.name}</a>}</li>
          ))}
        </ol>
      </nav>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: props.items.map((item, i) => ({ "@type": "ListItem", position: i + 1, name: item.name, item: page.origin + item.url }))
        }}
      />
    </>
  );
}

export function Layout(props: LayoutProps) {
  const page = usePage();
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{props.title}</title>
          <meta name="description" content={props.description} />
          <link rel="canonical" href={page.href} />
          <meta property="og:title" content={props.title} />
          <meta property="og:description" content={props.description} />
          <meta property="og:url" content={page.href} />
          <link rel="icon" href="/favicon.svg" />
          <link rel="stylesheet" href={site.stylesheet} />
          <link rel="alternate" type="application/atom+xml" href="/feed.xml" title={site.name} />
          {/* Analytics only in production builds, never in local previews. */}
          {page.mode === "build" && <script defer src="https://analytics.example.com/script.js"></script>}
          {props.head}
        </head>
        <body>
          <header>
            <a href="/">{site.name}</a> · <a href="/blog/">Blog</a> · <a href="/places/">Places</a>
          </header>
          <main>{props.children}</main>
        </body>
      </html>
    </>
  );
}
