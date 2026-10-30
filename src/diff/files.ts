import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Folders that hold version control or host metadata, never served files. Other dot-folders are served
 * like any other (.well-known/security.txt, say).
 */
const METADATA = new Set([".git", ".hg", ".svn", ".netlify", ".vercel"]);

/** Every file in an output directory, as site-relative paths ("about/index.html"). */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // A .git file too: a worktree's pointer to its repository.
      if (METADATA.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  }
  await walk(root);
  return out.sort();
}

/** The canonical URL path a file is served at: "a/index.html" -> "/a/", "x.xml" -> "/x.xml". */
export function fileToUrl(file: string): string {
  if (file === "index.html") return "/";
  if (file.endsWith("/index.html")) return `/${file.slice(0, -"index.html".length)}`;
  return `/${file}`;
}

export function isHtmlFile(file: string): boolean {
  return file.endsWith(".html") || file.endsWith(".htm");
}

/** Minimal glob: "*" matches within a segment, "**" across segments. Patterns match URL paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}
