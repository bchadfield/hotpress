import { ancestors, raw, Script, type Entry, type PageOf, type TreeNode } from "hotpress";
import { Breadcrumbs, Layout } from "./Layout.tsx";
import filter from "./filter.ts?client";

export interface Post {
  title: string;
  description?: string;
  date: Date;
  updated?: Date;
  tags: string[];
  draft: boolean;
}

export interface Place {
  slug: string;
  name: string;
  town: string;
  region: string;
  population: number;
  summary: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export function PostPage(props: { post: Entry<Post>; related: Entry<Post>[] }) {
  const { post } = props;
  return (
    <Layout title={`${post.data.title} | Example Places`} description={post.data.description ?? post.data.title}>
      <article>
        <h1>{post.data.title}</h1>
        <p>
          <time datetime={day(post.data.date)}>{day(post.data.date)}</time> ·{" "}
          {post.data.tags.map((t) => (
            <a href={`/tags/${t}/`}>#{t} </a>
          ))}
        </p>
        {post.body}
      </article>
      {props.related.length > 0 && (
        <aside>
          <h2>Related</h2>
          <ul>
            {props.related.map((r) => (
              <li>
                <a href={`/blog/${r.slug}/`}>{r.data.title}</a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </Layout>
  );
}

export function PostList(props: { title: string; page: PageOf<Entry<Post>> }) {
  const { page } = props;
  return (
    <Layout title={`${props.title} | Example Places`} description={`${props.title}: posts from Example Places.`}>
      <h1>{props.title}</h1>
      <ul>
        {page.items.map((p) => (
          <li>
            <a href={`/blog/${p.slug}/`}>{p.data.title}</a> <small>{day(p.data.date)}</small>
          </li>
        ))}
      </ul>
      <nav aria-label="Pagination">
        {page.prev && <a href={page.prev} rel="prev">Newer</a>} {page.next && <a href={page.next} rel="next">Older</a>}
      </nav>
    </Layout>
  );
}

export function placeUrl(node: TreeNode<Entry<Place>>): string {
  return `/places/${ancestors(node).map((n) => n.key.toLowerCase()).join("/")}/`;
}

function trail(node: TreeNode<Entry<Place>>, last?: { name: string; url: string }) {
  return [{ name: "Places", url: "/places/" }, ...ancestors(node).map((n) => ({ name: n.label, url: placeUrl(n) })), ...(last ? [last] : [])];
}

/** One template for every level of the hierarchy: region and town pages are generated from the data. */
export function PlaceIndex(props: { node: TreeNode<Entry<Place>> }) {
  const { node } = props;
  const isRoot = node.level === "root";
  const title = isRoot ? "Places" : `Places in ${node.label}`;
  return (
    <Layout title={`${title} | Example Places`} description={`${node.entries.length} areas in ${isRoot ? "all regions" : node.label}.`}>
      {!isRoot && <Breadcrumbs items={trail(node)} />}
      <h1>{title}</h1>
      <ul data-filter-list>
        {node.children.length
          ? node.children.map((c) => (
              <li>
                <a href={placeUrl(c)}>{c.label}</a> ({c.entries.length})
              </li>
            ))
          : node.leaves.map((e) => (
              <li>
                <a href={`${placeUrl(node)}${e.slug}/`}>{e.data.name}</a>
              </li>
            ))}
      </ul>
      <Script src={filter} />
    </Layout>
  );
}

/** Detail page for a CSV row: same templating as Markdown entries. */
export function PlacePage(props: { place: Entry<Place>; node: TreeNode<Entry<Place>>; url: string }) {
  const { place, node } = props;
  return (
    <Layout title={`${place.data.name}, ${place.data.town} | Example Places`} description={place.data.summary}>
      <Breadcrumbs items={trail(node, { name: place.data.name, url: props.url })} />
      <h1>{place.data.name}</h1>
      <p>{place.data.summary}</p>
      <dl>
        <dt>Population</dt>
        <dd>{place.data.population.toLocaleString("en-GB")}</dd>
      </dl>
    </Layout>
  );
}

export function NotePage(props: { title: string; children?: import("hotpress").Child }) {
  return (
    <Layout title={`${props.title} | Example Places`} description={props.title}>
      <article>{props.children}</article>
    </Layout>
  );
}

export function NotFound() {
  return (
    <Layout title="Page not found | Example Places" description="That page doesn't exist.">
      <h1>Page not found</h1>
      <p>{raw('Try the <a href="/">home page</a>.')}</p>
    </Layout>
  );
}
