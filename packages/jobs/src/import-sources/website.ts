import { inertWindow } from "@tuti/content/html";
import { checkWebhookUrl, publicOnlyLookup } from "@tuti/shared/webhook-url";
import { Agent, fetch } from "undici";

import type { FeaturebaseArticle, FeaturebaseCollection, Page } from "../featurebase";
import type { ImportSourceDefinition } from "./index";

/**
 * A public help center, by its address (docs/plan.md, Import a public help center by URL): GitBook, Notion sites,
 * Docusaurus, Intercom or Zendesk's public centers, or a team's own. Its pages under the address are found from its
 * sitemap (else the links from the address's page, and theirs), and each page's main content becomes an article,
 * as a draft; its collections are the address's folders, named as the start page's links name them. Every fetch is to
 * public addresses only, as webhooks' are (checked before each fetch and each redirect, and again by the connection),
 * same-site, within robots.txt, one at a time at a polite pace, each with a size and time limit.
 *
 * Articles' and collections' ids are their addresses (`pageId`), so a repeat import knows them, links between them
 * are pointed at their new pages, and their old paths can be redirected (import-docs.ts).
 */

/** Pages it reads from one site at most. */
export const MAX_PAGES = 500;
/** Pages fetched to find the rest when there's no sitemap: the start page's links, and theirs. */
const MAX_LINK_PAGES = 100;
/** One page, body and all. */
const PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
/** Between two requests to the site (a robots.txt Crawl-delay, up to 5s, if it asks for more). Changeable for tests. */
export const crawlPace = { ms: 500 };
/** How long a site's list of pages is kept for the import's later steps. */
const LIST_KEPT_MS = 15 * 60_000;
const USER_AGENT = "Tuti-Import/1 (+https://tuti.so)";

const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

/** The site answered with an error (`status`), refused to be read (400: not public, robots.txt), or couldn't be reached (0). */
export class SiteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A page's address as its id: no query, fragment or trailing slash. */
export function pageId(url: string | URL): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.href;
}

const notPublic = (url: URL) => `${url.hostname} isn't a public address: Tuti only reads help centers anyone can open.`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "getting-started" as "Getting started". */
const fromSlug = (segment: string) => {
  const words = decodeURIComponent(segment).replace(/^\d+-/, "").replace(/\.\w+$/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Untitled";
};

/** robots.txt's rules for Tuti (its own group, else `*`'s): whether a path may be read, and its sitemaps and crawl delay. */
export function robotsRules(text: string): { allowed: (path: string) => boolean; sitemaps: string[]; delayMs: number } {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: RegExp; length: number }[]; delay: number }[] = [];
  const sitemaps: string[] = [];
  let group: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const [, field, value = ""] = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line) ?? [];
    const name = field?.toLowerCase();
    if (name === "sitemap") {
      sitemaps.push(value);
    } else if (name === "user-agent") {
      if (!lastWasAgent || !group) {
        group = { agents: [], rules: [], delay: 0 };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (name === "allow" || name === "disallow") && value) {
      const pattern = new RegExp(`^${value.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$")}`);
      group.rules.push({ allow: name === "allow", pattern, length: value.length });
    } else if (group && name === "crawl-delay") {
      group.delay = Number(value) || 0;
    }
    lastWasAgent = name === "user-agent";
  }
  const mine = groups.find((g) => g.agents.some((agent) => agent !== "*" && "tuti-import".includes(agent))) ?? groups.find((g) => g.agents.includes("*"));
  return {
    // The longest matching rule wins; Allow on a tie.
    allowed: (path) => {
      const match = (mine?.rules ?? []).filter((rule) => rule.pattern.test(path)).sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow))[0];
      return match?.allow ?? true;
    },
    sitemaps,
    delayMs: Math.min((mine?.delay ?? 0) * 1000, 5_000),
  };
}

/** A help center's pages, as one import's steps read them: the site's articles and collections, in its order. */
type SiteList = {
  pages: { id: string; collection: string | null }[];
  collections: { id: string; parent: string | null; name: string }[];
};

/** Sites' lists, by the address the team gave, kept for an import's later steps (each a job of its own). */
const lists = new Map<string, { list: SiteList; until: number }>();

/** One site's reader for one job: fetches one at a time, `crawlPace` apart, none past `deadline`. */
function site(start: string, deadline: number) {
  const robots = new Map<string, Promise<ReturnType<typeof robotsRules>>>();
  let last = 0;
  let delayMs = 0;

  /** The body at `url` (following up to 3 redirects on its own host; any public one for the start page), or null for a page that's gone. */
  async function get(url: string, { anyHost = false, robotsFile = false } = {}): Promise<{ url: string; type: string; text: string } | null> {
    let at = url;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const parsed = new URL(at);
      try {
        await checkWebhookUrl(at);
      } catch {
        throw new SiteError(400, parsed.protocol === "https:" ? notPublic(parsed) : "Tuti reads help centers at https:// addresses only.");
      }
      if (!robotsFile && !(await rules(parsed.origin)).allowed(parsed.pathname)) {
        throw new SiteError(400, `${parsed.hostname}'s robots.txt asks crawlers not to read ${parsed.pathname}, so Tuti doesn't.`);
      }
      const wait = last + Math.max(crawlPace.ms, delayMs) - Date.now();
      if (Date.now() + Math.max(wait, 0) >= deadline) {
        throw new SiteError(0, `${parsed.hostname} took too long to read.`);
      }
      await pause(Math.max(wait, 0));
      last = Date.now();
      let response;
      try {
        response = await fetch(at, {
          redirect: "manual",
          signal: AbortSignal.timeout(Math.max(0, Math.min(PAGE_TIMEOUT_MS, deadline - Date.now()))),
          ...(process.env.WEBHOOK_ALLOW_PRIVATE_URLS !== "true" && { dispatcher: publicOnly }),
          headers: { "user-agent": USER_AGENT, accept: "text/html,application/xml;q=0.9,*/*;q=0.8" },
        });
      } catch (error) {
        throw (error as { cause?: { code?: string } }).cause?.code === "EPRIVATE"
          ? new SiteError(400, notPublic(parsed))
          : new SiteError(0, `Tuti couldn't reach ${parsed.hostname}.`);
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        const next = new URL(location, at);
        // Off the site: not followed (a page here sends nobody elsewhere, say to a cloud's metadata address).
        if (!anyHost && next.host !== parsed.host) {
          return null;
        }
        at = next.href;
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        return null;
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new SiteError(response.status, `${parsed.hostname} answered ${response.status}.`);
      }
      if (Number(response.headers.get("content-length")) > PAGE_BYTES) {
        await response.body.cancel();
        return null;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        // Too big to be an article: left out.
        if (size > PAGE_BYTES) {
          return null;
        }
        chunks.push(chunk);
      }
      return { url: at, type: response.headers.get("content-type") ?? "", text: Buffer.concat(chunks).toString("utf8") };
    }
    return null;
  }

  /** The origin's robots.txt (none: everything may be read). */
  function rules(origin: string) {
    if (!robots.has(origin)) {
      robots.set(
        origin,
        // None (a 404) lets everything be read; one the site can't answer for (an error, no answer) nothing, as RFC 9309 has it.
        get(`${origin}/robots.txt`, { robotsFile: true })
          .catch((error: unknown) => {
            throw error instanceof SiteError && error.status === 400 ? error : new SiteError(0, `${new URL(origin).hostname}'s robots.txt couldn't be read, so Tuti doesn't read the site yet.`);
          })
          .then((file) => {
            const parsed = robotsRules(file && !/html/i.test(file.type) ? file.text : "");
            delayMs = Math.max(delayMs, parsed.delayMs);
            return parsed;
          }),
      );
    }
    return robots.get(origin)!;
  }

  /** The start page, where the site really is (after its redirects): what's under its folder is the help center. */
  async function home() {
    const page = await get(start, { anyHost: true });
    if (!page) {
      throw new SiteError(404, `Tuti found no page at ${new URL(start).hostname}. Check the address.`);
    }
    const url = new URL(page.url);
    const base = url.pathname.replace(/\/+$/, "");
    const within = (href: string) => {
      const u = new URL(href);
      return u.origin === url.origin && (base === "" || u.pathname === base || u.pathname.startsWith(`${base}/`)) && !/\.(png|jpe?g|gif|webp|svg|pdf|zip|xml|json|txt|css|js)$/i.test(u.pathname);
    };
    return { page, origin: url.origin, base, within };
  }

  /** Links in `html` (relative ones from `url`), with their text. */
  function links(html: string, url: string): { href: string; text: string }[] {
    const window = inertWindow();
    try {
      const document = new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;
      return [...document.body.querySelectorAll("a[href]")].flatMap((a) => {
        try {
          return [{ href: pageId(new URL(a.getAttribute("href")!, url)), text: (a.textContent ?? "").replace(/\s+/g, " ").trim() }];
        } catch {
          return [];
        }
      });
    } finally {
      void window.happyDOM.close();
    }
  }

  /** The addresses a sitemap (or sitemap index, one level down) lists. */
  async function sitemap(url: string, origin: string, depth = 0): Promise<string[]> {
    // One that's gone is none; one that fails fails the step (tried again), rather than a help center coming across short.
    const file = await get(url);
    if (!file) {
      return [];
    }
    const locs = [...file.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
    if (/<sitemapindex/i.test(file.text) && depth === 0) {
      const all: string[] = [];
      for (const child of locs.filter((loc) => URL.canParse(loc) && new URL(loc).origin === origin).slice(0, 10)) {
        all.push(...(await sitemap(child, origin, 1)));
      }
      return all;
    }
    return locs;
  }

  /** The help center's pages and collections: from its sitemap, else its links (`complete`: not cut short by the deadline). */
  async function discover(): Promise<SiteList & { complete: boolean }> {
    const { page, origin, base, within } = await home();
    const robotsFile = await rules(origin);
    const startId = pageId(page.url);
    const readable = (id: string) => within(id) && id !== startId && robotsFile.allowed(new URL(id).pathname);
    const homeLinks = links(page.text, page.url);
    const found = new Set<string>();
    for (const map of robotsFile.sitemaps.filter((s) => URL.canParse(s) && new URL(s).origin === origin).concat(robotsFile.sitemaps.length ? [] : [`${origin}/sitemap.xml`])) {
      for (const loc of await sitemap(map, origin)) {
        if (URL.canParse(loc) && readable(pageId(loc)) && found.size < MAX_PAGES) {
          found.add(pageId(loc));
        }
      }
    }
    let complete = true;
    if (found.size === 0) {
      // No sitemap (or nothing under the address in it): the start page's links, and theirs, breadth first.
      const queue = homeLinks.map((l) => l.href).filter(readable);
      queue.forEach((id) => found.add(id));
      for (let fetched = 0; fetched < queue.length && fetched < MAX_LINK_PAGES && found.size < MAX_PAGES; fetched++) {
        // Starting an import checks within seconds: what the start page links to is enough to say there's something.
        if (Date.now() > deadline - 30_000) {
          complete = false;
          break;
        }
        const next = await get(queue[fetched]!).catch(() => null);
        // Gone (or off the site): not an article.
        if (!next) {
          found.delete(queue[fetched]!);
        }
        for (const { href } of next ? links(next.text, next.url) : []) {
          if (readable(href) && !found.has(href) && found.size < MAX_PAGES) {
            found.add(href);
            queue.push(href);
          }
        }
      }
    }
    // Collections: the folders pages are in, below the address (named as the start page's links name them).
    const named = new Map(homeLinks.filter((l) => l.text).map((l) => [l.href, l.text]));
    const folder = (id: string) => {
      const path = new URL(id).pathname;
      const parent = path.slice(0, path.lastIndexOf("/"));
      return parent.length > base.length ? `${origin}${parent}` : null;
    };
    const collections = new Map<string, { id: string; parent: string | null; name: string }>();
    const add = (id: string | null): void => {
      if (id && !collections.has(id)) {
        add(folder(id));
        collections.set(id, { id, parent: folder(id), name: (named.get(id) ?? fromSlug(id.split("/").at(-1)!)).slice(0, 60) });
      }
    };
    found.forEach((id) => add(folder(id)));
    // A page that's a folder's own (/billing, of /billing/refunds) goes first in it.
    let pages = [...found].map((id) => ({ id, collection: collections.has(id) ? id : folder(id) }));
    pages = [...pages.filter((p) => p.collection === p.id), ...pages.filter((p) => p.collection !== p.id)];
    // No folders: all of them in one collection, named as the site names itself.
    if (collections.size === 0 && pages.length > 0) {
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(page.text)?.[1]?.trim();
      const one = { id: pageId(page.url), parent: null, name: (title || new URL(origin).hostname).slice(0, 60) };
      collections.set(one.id, one);
      pages = pages.map((p) => ({ ...p, collection: one.id }));
    }
    return { pages, collections: [...collections.values()], complete };
  }

  /** The site's list, found once for an import's steps (a list cut short isn't kept: the next step finds it all). */
  async function list(): Promise<SiteList> {
    const now = Date.now();
    [...lists].filter(([, kept]) => kept.until <= now).forEach(([key]) => lists.delete(key));
    const kept = lists.get(start);
    if (kept) {
      return kept.list;
    }
    const found = await discover();
    if (found.complete) {
      lists.set(start, { list: found, until: now + LIST_KEPT_MS });
    }
    return found;
  }

  /** A page as an article: its title (its main heading, else its title) and main content, links and images made absolute. */
  async function article(id: string, collection: string | null, order: number): Promise<FeaturebaseArticle | null> {
    const page = await get(id);
    if (!page || !/html/i.test(page.type || "text/html")) {
      return null;
    }
    const window = inertWindow();
    try {
      const document = new window.DOMParser().parseFromString(page.text, "text/html") as unknown as Document;
      const meta = (name: string) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute("content")?.trim();
      const main =
        document.querySelector("main article, article, main, [role=main], .theme-doc-markdown, .markdown, #content, .content") ?? document.body;
      main.querySelectorAll("nav, header, footer, aside, [role=navigation], [aria-label*=breadcrumb], [aria-label*=Breadcrumb], .breadcrumb, .breadcrumbs, script, style").forEach((el) => el.remove());
      const heading = main.querySelector("h1");
      const title = heading?.textContent?.replace(/\s+/g, " ").trim() || meta("og:title") || document.title.trim() || fromSlug(id.split("/").at(-1)!);
      heading?.remove();
      for (const [selector, attribute] of [["a[href]", "href"], ["img[src]", "src"], ["img[data-src]", "data-src"]] as const) {
        main.querySelectorAll(selector).forEach((el) => {
          try {
            el.setAttribute(attribute === "data-src" ? "src" : attribute, new URL(el.getAttribute(attribute)!, page.url).href);
          } catch {
            // Left as it is.
          }
        });
      }
      const segment = new URL(id).pathname.split("/").at(-1) ?? "";
      return {
        id,
        parentId: collection,
        title,
        body: main.innerHTML,
        slug: segment,
        order,
        // Drafts: the team reads them over before they're live.
        isPublished: false,
        state: "draft",
      };
    } finally {
      await window.happyDOM.close();
    }
  }

  return { home, list, article };
}

export const websiteSource: ImportSourceDefinition = {
  name: "your help center",
  credential: "url",
  status: (error) => (error instanceof SiteError ? error.status : null),
  connect: (address, { deadline }) => {
    const reader = site(address, deadline);
    return {
      checkCredential: () => reader.home(),
      checks: {
        docs: async () => {
          if ((await reader.list()).pages.length === 0) {
            throw new SiteError(400, "Tuti found no articles at this address: no sitemap lists pages under it, and its page links to none.");
          }
        },
      },
      read: {
        // Nobody's named: the team's articles are by no one, as the team writes them.
        admins: async () => [],
        collections: async (): Promise<Page<FeaturebaseCollection>> => ({
          items: (await reader.list()).collections.map((c, order) => ({ id: c.id, parentId: c.parent, name: c.name, slug: c.id.split("/").at(-1), order })),
          next: null,
        }),
        // Without a limit (making them empty, first): the list, titled from their addresses. With one: each page read.
        articles: async (cursor, limit) => {
          const { pages } = await reader.list();
          const from = Number(cursor ?? 0);
          if (!limit) {
            const items = pages.slice(from, from + 100).map((p, i) => {
              const segment = new URL(p.id).pathname.split("/").at(-1) ?? "";
              return { id: p.id, parentId: p.collection, title: fromSlug(segment), slug: segment, order: from + i, isPublished: false, state: "draft" as const };
            });
            return { items, next: from + 100 < pages.length ? String(from + 100) : null };
          }
          const items: FeaturebaseArticle[] = [];
          let at = from;
          for (; at < Math.min(from + limit, pages.length); at++) {
            // Out of time: the rest on the next page, unless this one has none yet.
            if (at > from && Date.now() > deadline - PAGE_TIMEOUT_MS - 5_000) {
              break;
            }
            // One that's gone or refused is left for the last check (articleExists) to say.
            const read = await reader.article(pages[at]!.id, pages[at]!.collection, at).catch((error: unknown) => {
              // Only the site's own answers: anything else is ours, and fails the page.
              if (!(error instanceof SiteError) || (error.status === 0 && at === from)) {
                throw error;
              }
              return null;
            });
            if (read) {
              items.push(read);
            }
          }
          return { items, next: at < pages.length ? String(at) : null };
        },
        articleDraft: async () => null,
        articleExists: async (id) => (await reader.article(id, null, 0)) !== null,
      },
    };
  },
};
