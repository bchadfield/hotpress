// Example site: a Markdown blog and a CSV-driven place directory with generated nested indexes.
import { absoluteUrl, atom, csv, defineSite, groupBy, markdown, mdx, paginate, related, robots, s, sitemaps, tree } from "hotpress";
import { site as siteInfo } from "./src/Layout.tsx";
import { NotePage, NotFound, PlaceIndex, PlacePage, PostList, PostPage, placeUrl, type Place, type Post } from "./src/templates.tsx";
import updated from "./data/updated.json" with { type: "json" };

export default defineSite({
  origin: "https://example.com",
  compat: "2026-10-29",
  async build(site) {
    siteInfo.stylesheet = await site.css("styles/main.css");

    const all = await site.load(
      markdown("content/posts", {
        schema: {
          title: s.string(),
          description: s.string().optional(),
          date: s.date(),
          updated: s.date().optional(),
          tags: s.array(s.string()).default([]),
          draft: s.boolean().default(false)
        },
        transform: (data): Post => data
      })
    );
    // Drafts are a site decision, not an engine feature.
    const posts = all.filter((p) => !p.data.draft).sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

    for (const post of posts) {
      const rel = related(post, posts, (p) => p.data.tags);
      site.page(`/blog/${post.slug}/`, () => <PostPage post={post} related={rel} />, {
        published: post.data.date,
        updated: post.data.updated ?? post.data.date,
        type: "post"
      });
    }
    for (const page of paginate(posts, 10, (n) => (n === 1 ? "/blog/" : `/blog/page/${n}/`))) {
      site.page(page.url, () => <PostList title="Blog" page={page} />);
    }
    for (const [tag, tagged] of groupBy(posts, (p) => p.data.tags)) {
      for (const page of paginate(tagged, 10, (n) => (n === 1 ? `/tags/${tag}/` : `/tags/${tag}/page/${n}/`))) {
        site.page(page.url, () => <PostList title={`Tagged #${tag}`} page={page} />);
      }
    }

    const places = await site.load(
      csv("data/places.csv", {
        schema: { slug: s.slug(), name: s.string(), town: s.string(), region: s.string(), population: s.number().int(), summary: s.string() },
        transform: (data): Place => data
      })
    );
    const dataDate = new Date(`${updated.exported}T00:00:00Z`);
    const hierarchy = tree(places, [
      { name: "region", key: (p) => p.data.region },
      { name: "town", key: (p) => p.data.town }
    ]);
    site.page("/places/", () => <PlaceIndex node={hierarchy.root} />, { updated: dataDate });
    for (const node of hierarchy.nodes) site.page(placeUrl(node), () => <PlaceIndex node={node} />, { updated: dataDate });
    for (const place of places) {
      const node = hierarchy.nodeOf(place);
      const url = `${placeUrl(node)}${place.slug}/`;
      site.page(url, () => <PlacePage place={place} node={node} url={url} />, { updated: dataDate, type: "place" });
    }

    // MDX entries render components from the site; Content() returns the rendered HTML.
    for (const note of await site.load(mdx("content/notes", { schema: { title: s.string() } }))) {
      site.page(`/notes/${note.slug}/`, () => <NotePage title={note.data.title}>{note.Content!()}</NotePage>);
    }

    site.page("/", () => <PostList title="Latest" page={paginate(posts, 5, () => "/")[0]} />);
    site.page("/404.html", () => <NotFound />, { noindex: true });

    const sitemap = site.pages.filter((p) => !p.meta.noindex).map((p) => ({ loc: absoluteUrl(site.origin, p.url), lastmod: p.meta.updated }));
    for (const [file, xml] of Object.entries(sitemaps("sitemap.xml", site.origin, sitemap, { formatDate: (d) => d.toISOString().slice(0, 10) }))) {
      site.file(file, xml);
    }
    site.file("robots.txt", robots({ sitemaps: [`${site.origin}/sitemap.xml`] }));
    site.file("feed.xml", () =>
      atom({
        title: "Example Places",
        link: `${site.origin}/`,
        self: `${site.origin}/feed.xml`,
        author: { name: "Example" },
        entries: posts.map((p) => ({ title: p.data.title, url: absoluteUrl(site.origin, `/blog/${p.slug}/`), updated: p.data.updated ?? p.data.date, content: String(p.body) }))
      })
    );
    site.file("_headers", "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n");
  }
});
