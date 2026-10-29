// Plain helpers for the shapes content sites keep needing: nested indexes, pages, related items.

export interface TreeLevel<E> {
  name: string;
  /** Group key for this entry at this level; null/undefined skips the level for the entry. */
  key: (entry: E) => string | null | undefined;
  /** Display label for a node (default: the key). */
  label?: (key: string, entries: E[]) => string;
  /** Sort nodes within their parent (default: label, en locale, base sensitivity). */
  compare?: (a: TreeNode<E>, b: TreeNode<E>) => number;
}

export interface TreeNode<E> {
  level: string;
  key: string;
  label: string;
  depth: number;
  parent?: TreeNode<E>;
  children: TreeNode<E>[];
  /** Every entry under this node, at any depth, in input order. */
  entries: E[];
  /** Entries whose deepest level is this node. */
  leaves: E[];
}

export interface Tree<E> {
  root: TreeNode<E>;
  /** All nodes, depth-first, root excluded. */
  nodes: TreeNode<E>[];
  /** Nodes per level name, sorted. */
  levels: Record<string, TreeNode<E>[]>;
  /** The deepest node containing an entry. */
  nodeOf(entry: E): TreeNode<E>;
}

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, "en", { sensitivity: "base" });

/**
 * Group entries into a hierarchy. Levels are applied in order; an entry whose key for a level is
 * null skips that level (e.g. a region with no county). Node identity is the path of keys.
 */
export function tree<E>(entries: E[], levels: TreeLevel<E>[], rootLabel = "root"): Tree<E> {
  const root: TreeNode<E> = { level: "root", key: "", label: rootLabel, depth: 0, children: [], entries: [], leaves: [] };
  const byPath = new Map<string, TreeNode<E>>();
  const deepest = new Map<E, TreeNode<E>>();
  for (const entry of entries) {
    let node = root;
    let path = "";
    root.entries.push(entry);
    for (const level of levels) {
      const key = level.key(entry);
      if (key === null || key === undefined || key === "") continue;
      path += `\u0000${level.name}:${key}`;
      let next = byPath.get(path);
      if (!next) {
        next = { level: level.name, key, label: key, depth: node.depth + 1, parent: node, children: [], entries: [], leaves: [] };
        byPath.set(path, next);
        node.children.push(next);
      }
      next.entries.push(entry);
      node = next;
    }
    node.leaves.push(entry);
    deepest.set(entry, node);
  }
  const levelByName = new Map(levels.map((l) => [l.name, l]));
  const nodes: TreeNode<E>[] = [];
  const grouped: Record<string, TreeNode<E>[]> = Object.fromEntries(levels.map((l) => [l.name, []]));
  const visit = (node: TreeNode<E>) => {
    for (const c of node.children) {
      const level = levelByName.get(c.level)!;
      if (level.label) c.label = level.label(c.key, c.entries);
    }
    node.children.sort((a, b) => (levelByName.get(a.level)?.compare ?? byLabel)(a, b));
    for (const c of node.children) {
      nodes.push(c);
      grouped[c.level].push(c);
      visit(c);
    }
  };
  visit(root);
  for (const name of Object.keys(grouped)) grouped[name].sort(levelByName.get(name)?.compare ?? byLabel);
  return {
    root,
    nodes,
    levels: grouped,
    nodeOf(entry) {
      const node = deepest.get(entry);
      if (!node) throw new Error("entry is not in this tree");
      return node;
    }
  };
}

/** Root-to-node path, excluding the root. */
export function ancestors<E>(node: TreeNode<E>): TreeNode<E>[] {
  const out: TreeNode<E>[] = [];
  for (let n: TreeNode<E> | undefined = node; n && n.level !== "root"; n = n.parent) out.unshift(n);
  return out;
}

export interface PageOf<T> {
  items: T[];
  number: number;
  total: number;
  url: string;
  prev?: string;
  next?: string;
}

/** Split items into pages. url(1) is the first page's URL. */
export function paginate<T>(items: T[], size: number, url: (n: number) => string): PageOf<T>[] {
  if (size < 1) throw new Error("page size must be at least 1");
  const total = Math.max(1, Math.ceil(items.length / size));
  return Array.from({ length: total }, (_, i) => ({
    items: items.slice(i * size, (i + 1) * size),
    number: i + 1,
    total,
    url: url(i + 1),
    prev: i > 0 ? url(i) : undefined,
    next: i + 1 < total ? url(i + 2) : undefined
  }));
}

/** Items sharing the most values with `item` (e.g. tags), ties kept in input order. */
export function related<T>(item: T, items: T[], values: (x: T) => readonly string[], limit = 3): T[] {
  const mine = new Set(values(item));
  return items
    .filter((x) => x !== item)
    .map((x, index) => ({ x, index, score: values(x).filter((v) => mine.has(v)).length }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.x);
}

/** Group items by one or more values each (e.g. tags), keys in first-seen order. */
export function groupBy<T>(items: T[], values: (x: T) => string | readonly string[] | null | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const v = values(item);
    for (const key of v === null || v === undefined ? [] : typeof v === "string" ? [v] : v) {
      const list = out.get(key);
      if (list) list.push(item);
      else out.set(key, [item]);
    }
  }
  return out;
}
