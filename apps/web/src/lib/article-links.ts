import type { JSONContent } from "@tiptap/core";

/** An article's slug, as /docs/<slug> has it. */
const ARTICLE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The portal's own docs page a link points to, at any of the portal's `addresses` (its Tuti address, its domain, its site and
 * path): the slug in /docs/<slug> and the link's #heading, or null for any other link (another site, another page, a query).
 */
export function portalDocsLink(href: string, addresses: string[]): { slug: string; hash: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.search) {
    return null;
  }
  for (const address of addresses) {
    const at = new URL(address);
    const docs = `${at.pathname.replace(/\/$/, "")}/docs/`;
    const slug = url.pathname.startsWith(docs) ? url.pathname.slice(docs.length) : "";
    if (url.origin === at.origin && ARTICLE_SLUG.test(slug)) {
      return { slug, hash: url.hash };
    }
  }
  return null;
}

/** Every link's address in a document, once each. */
export function docLinks(doc: JSONContent): string[] {
  const found = new Set<string>();
  const walk = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type === "link" && typeof mark.attrs?.href === "string") {
        found.add(mark.attrs.href);
      }
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return [...found];
}

/** What an article is about, in a line: the team's meta description, else its text's first lines. */
export function articleDescription(article: { description: string; body: string }): string {
  const text = article.body.replace(/\s+/g, " ").trim();
  return article.description || (text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text);
}
