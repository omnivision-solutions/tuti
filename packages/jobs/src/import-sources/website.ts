import { inertWindow } from "@tuti/content/html";
import { checkWebhookUrl, HOST_NOT_FOUND, LOOKUP_FAILED, publicOnlyLookup } from "@tuti/shared/webhook-url";
import { Agent, fetch } from "undici";

import type { FeaturebaseArticle, FeaturebaseCollection, Page } from "../featurebase";
import type { ImportSourceDefinition } from "./index";

/**
 * A public help center, by its address (docs/plan.md, Import a public help center by URL): GitBook,
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
/** Times an article's page that fails for a while (a 429, a 5xx, no answer) is asked for again (getRetrying). */
const RETRIES = 2;
/** The longest Retry-After a step waits out; one asking for more is read again by the content pass's next run. */
const RETRY_AFTER_MAX_MS = 30_000;
/** Between two requests to the site (a robots.txt Crawl-delay, up to 5s, if it asks for more). Changeable for tests. */
export const crawlPace = { ms: 500 };
/** Pages a step of the link crawl fetches at most (its time limits it too): changeable for tests, which cut it short. */
export const crawlBudget = { fetches: Infinity };
const USER_AGENT = "Tuti-Import/1 (+https://tuti.so)";
/** USER_AGENT's product token, as robots.txt's groups name it (lowercase). */
const PRODUCT_TOKEN = "tuti-import";

const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

/**
 * The site answered with an error (`status`), or couldn't be reached (0). `refused`: Tuti wouldn't read it (not public,
 * robots.txt, nothing found), with a status of 422 (callers tell one by `reason`: a site can answer 422 too);
 * `late`: the time ran out before it was asked; `unknown`: its host name doesn't exist.
 */
export class SiteError extends Error {
  readonly status: number;
  constructor(
    status: number,
    message: string,
    readonly reason: "refused" | "late" | "unknown" | null = null,
    /** The host it's about (an `unknown` one's). */
    readonly host: string | null = null,
  ) {
    super(message);
    this.status = reason === "refused" ? 422 : status;
  }
}

/**
 * Text from a site (a path, a robots.txt, a sitemap, a page) is read with indexOf and loops, not regexes that can
 * backtrack: a hostile site could make one take minutes on its 2 MB, stalling the worker.
 */

/** `path` without its trailing slashes (a loop: /\/+$/ backtracks on a long run of slashes). */
export function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") {
    end--;
  }
  return path.slice(0, end);
}

/** `text` with A–Z lowercased only: the same length, so a position found in it is the same in `text` ("İ".toLowerCase() is two characters). */
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The text between the first `open` (case aside; up to its `>`, for a tag with attributes) and the next `close` after it, or null. */
function between(text: string, open: string, close: string, { tag = false } = {}): string | null {
  const lower = asciiLower(text);
  let from = lower.indexOf(open);
  if (from === -1) {
    return null;
  }
  from = tag ? lower.indexOf(">", from) + 1 : from + open.length;
  const to = from > 0 ? lower.indexOf(close, from) : -1;
  return to === -1 ? null : text.slice(from, to);
}

/** A sitemap's `<loc>` addresses, CDATA unwrapped and trimmed, `&amp;` as `&`; those that aren't addresses left out. */
export function sitemapLocs(text: string): string[] {
  const lower = asciiLower(text);
  const locs: string[] = [];
  for (let at = lower.indexOf("<loc>"); at !== -1; at = lower.indexOf("<loc>", at)) {
    const end = lower.indexOf("</loc>", at + 5);
    if (end === -1) {
      break;
    }
    let loc = text.slice(at + 5, end).trim();
    if (loc.startsWith("<![CDATA[") && loc.endsWith("]]>")) {
      loc = loc.slice(9, -3).trim();
    }
    loc = loc.replaceAll("&amp;", "&");
    if (URL.canParse(loc)) {
      locs.push(loc);
    }
    at = end + 6;
  }
  return locs;
}

/** A page's `<title>`, trimmed (none: empty). */
export const pageTitle = (html: string) => between(html, "<title", "</title>", { tag: true })?.trim() ?? "";

/** A page's address as its id: no query, fragment or trailing slash. */
export function pageId(url: string | URL): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = withoutTrailingSlashes(parsed.pathname) || "/";
  return parsed.href;
}

const notPublic = (url: URL) => `${url.hostname} isn't a public address: Tuti only reads help centers anyone can open.`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "getting-started" as "Getting started". */
export const fromSlug = (segment: string) => {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape (/docs/100%-uptime): the segment as it is.
  }
  const words = decoded.replace(/^\d+-/, "").replace(/\.\w+$/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Untitled";
};

/**
 * Whether a robots.txt rule's pattern (`*` any run of characters, a final `$` the path's end) matches the start of
 * `path`, as RFC 9309 has it. Linear, without a RegExp: a site writes the pattern, and a backtracking match of one like
 * `/*a*a*a*a*b` on a long path would stall the worker. Each literal part is found at its leftmost place after the last,
 * which is all a pattern with only `*` needs.
 */
export function robotsMatch(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  if (!path.startsWith(parts[0]!)) {
    return false;
  }
  if (parts.length === 1) {
    return !anchored || path.length === parts[0]!.length;
  }
  let at = parts[0]!.length;
  for (const part of parts.slice(1, anchored ? -1 : undefined)) {
    const found = path.indexOf(part, at);
    if (found === -1) {
      return false;
    }
    at = found + part.length;
  }
  // Anchored: the last part ends the path, after what came before it.
  return !anchored || (path.endsWith(parts.at(-1)!) && path.length - parts.at(-1)!.length >= at);
}

/** robots.txt's rules for Tuti (its own group, else `*`'s): whether a path may be read, and its sitemaps and crawl delay. */
export function robotsRules(text: string): { allowed: (path: string) => boolean; sitemaps: string[]; delayMs: number } {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number }[] = [];
  const sitemaps: string[] = [];
  let group: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    // "Field: value # comment", read with indexOf and trim.
    const hash = line.indexOf("#");
    const bare = hash === -1 ? line : line.slice(0, hash);
    const colon = bare.indexOf(":");
    const name = colon === -1 ? undefined : bare.slice(0, colon).trim().toLowerCase();
    const value = colon === -1 ? "" : bare.slice(colon + 1).trim();
    if (name === "sitemap") {
      sitemaps.push(value);
    } else if (name === "user-agent") {
      if (!lastWasAgent || !group) {
        group = { agents: [], rules: [], delay: 0 };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (name === "allow" || name === "disallow") && value) {
      group.rules.push({ allow: name === "allow", pattern: value });
    } else if (group && name === "crawl-delay") {
      group.delay = Number(value) || 0;
    }
    lastWasAgent = name === "user-agent";
  }
  // As RFC 9309 has it: every group naming Tuti's product token (exactly, case aside), merged; else every `*` group.
  const named = groups.filter((g) => g.agents.includes(PRODUCT_TOKEN));
  const picked = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
  const mine = picked.length > 0 ? { rules: picked.flatMap((g) => g.rules), delay: Math.max(...picked.map((g) => g.delay)) } : null;
  return {
    // The longest matching rule wins; Allow on a tie.
    allowed: (path) => {
      const match = (mine?.rules ?? []).filter((rule) => robotsMatch(rule.pattern, path)).sort((a, b) => b.pattern.length - a.pattern.length || Number(b.allow) - Number(a.allow))[0];
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

/** What `find` keeps on the import: the link crawl so far (its pages in the order found, how many of them it fetched, those gone), then the list. */
type CrawlState = { crawl?: { found: string[]; fetched: number; gone: string[] }; list?: SiteList };

/** One site's reader for one job: fetches one at a time, `crawlPace` apart, none past `deadline`. */
function site(start: string, deadline: number, kept: unknown) {
  let state = (typeof kept === "object" && kept !== null ? kept : {}) as CrawlState;
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
      } catch (error) {
        // Its name not looked up: unreachable, so a step fails and is tried again, never refused, which would count the
        // page as gone. One that doesn't exist is marked: when the team enters it, a mistake in the address (checkCredential).
        const code = (error as { code?: string }).code;
        if (code === HOST_NOT_FOUND || code === LOOKUP_FAILED) {
          throw new SiteError(0, `Tuti couldn't reach ${parsed.hostname}.`, code === HOST_NOT_FOUND ? "unknown" : null, parsed.hostname);
        }
        throw new SiteError(0, parsed.protocol === "https:" ? notPublic(parsed) : "Tuti reads help centers at https:// addresses only.", "refused");
      }
      if (!robotsFile && !(await rules(parsed.origin)).allowed(parsed.pathname)) {
        throw new SiteError(0, `${parsed.hostname}'s robots.txt asks crawlers not to read ${parsed.pathname}, so Tuti doesn't.`, "refused");
      }
      const wait = last + Math.max(crawlPace.ms, delayMs) - Date.now();
      if (Date.now() + Math.max(wait, 0) >= deadline) {
        throw new SiteError(0, `${parsed.hostname} took too long to read.`, "late");
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
          ? new SiteError(0, notPublic(parsed), "refused")
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
        // How long it asks to be left (Retry-After: seconds, or a date), for a fetch that tries again (getRetrying).
        const after = response.headers.get("retry-after");
        const afterMs = after === null ? NaN : /^\d+$/.test(after.trim()) ? Number(after) * 1000 : Date.parse(after) - Date.now();
        throw Object.assign(new SiteError(response.status, `${parsed.hostname} answered ${response.status}.`), { retryAfterMs: Number.isFinite(afterMs) ? Math.max(afterMs, 0) : null });
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

  /**
   * An article's page, as `get`, tried again for what fails for a while (a 429, a 5xx, no answer) up to RETRIES times:
   * after what the site asks (Retry-After, up to 30s; more, not asked again here), else twice the pace each time, never past the deadline; and
   * paced as every request is. What still fails is thrown (the content pass reads it again in its next run).
   */
  async function getRetrying(url: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await get(url);
      } catch (error) {
        const passing = error instanceof SiteError && !error.reason && (error.status === 0 || error.status === 429 || error.status >= 500);
        if (!passing || attempt >= RETRIES) {
          throw error;
        }
        const asked = (error as { retryAfterMs?: number | null }).retryAfterMs;
        // Asked to wait longer than a step should (Retry-After over RETRY_AFTER_MAX_MS): not asked again early, against
        // what the site said; thrown, so the content pass stops there and its next run reads the page.
        if (asked != null && asked > RETRY_AFTER_MAX_MS) {
          throw error;
        }
        const wait = asked ?? Math.max(crawlPace.ms, delayMs) * 2 ** (attempt + 1);
        if (Date.now() + wait >= deadline) {
          throw error;
        }
        await pause(wait);
      }
    }
  }

  /** The origin's robots.txt (none: everything may be read). */
  function rules(origin: string) {
    if (!robots.has(origin)) {
      robots.set(
        origin,
        // As RFC 9309 has it: none (a 4xx) lets everything be read; one the site can't answer for (a 5xx, no answer) nothing.
        get(`${origin}/robots.txt`, { robotsFile: true })
          .catch((error: unknown) => {
            if (error instanceof SiteError && !error.reason && error.status >= 400 && error.status < 500) {
              return null;
            }
            throw error instanceof SiteError && error.reason ? error : new SiteError(0, `${new URL(origin).hostname}'s robots.txt couldn't be read, so Tuti doesn't read the site yet.`);
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

  /** The start page, where the site really is (after its redirects): what's under its folder is the help center. Fetched once. */
  let homePage: ReturnType<typeof readHome> | undefined;
  const home = () => (homePage ??= readHome());
  async function readHome() {
    const page = await get(start, { anyHost: true });
    if (!page) {
      throw new SiteError(404, `Tuti found no page at ${new URL(start).hostname}. Check the address.`);
    }
    const url = new URL(page.url);
    const base = withoutTrailingSlashes(url.pathname);
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

  /**
   * The addresses a sitemap (or sitemap index, one level down) lists that `keep` takes; `first`: once one is found, no
   * more files are read; `guessed`: not one robots.txt names.
   */
  async function sitemap(url: string, origin: string, keep: (id: string) => boolean, first = false, depth = 0, guessed = false): Promise<string[]> {
    // One that's gone is none; one robots.txt names that fails fails the step (tried again), rather than a help center
    // coming across short. A guessed one (/sitemap.xml) the site refuses (a 4xx, as a bucket behind a CDN answers for
    // what it hasn't) is none: the links are read instead; one it can't answer for (a 5xx, no answer) fails the step too.
    const file = await get(url).catch((error: unknown) => {
      const refused = error instanceof SiteError && (error.reason === "refused" || (!error.reason && error.status >= 400 && error.status < 500 && error.status !== 429));
      if (guessed && refused) {
        return null;
      }
      throw error;
    });
    if (!file) {
      return [];
    }
    const locs = sitemapLocs(file.text);
    if (asciiLower(file.text).includes("<sitemapindex") && depth === 0) {
      const all: string[] = [];
      for (const child of locs.filter((loc) => new URL(loc).origin === origin).slice(0, 10)) {
        all.push(...(await sitemap(child, origin, keep, first, 1)));
        if (first && all.length > 0) {
          break;
        }
      }
      return all;
    }
    return locs.map(pageId).filter(keep);
  }

  /** What's under the address that may be read, and the site's sitemaps (robots.txt's, else /sitemap.xml). */
  async function bounds() {
    const { page, origin, base, within } = await home();
    const robotsFile = await rules(origin);
    const startId = pageId(page.url);
    const readable = (id: string) => within(id) && id !== startId && robotsFile.allowed(new URL(id).pathname);
    const maps = robotsFile.sitemaps.filter((s) => URL.canParse(s) && new URL(s).origin === origin);
    // None named: /sitemap.xml, guessed, so anything but an answer there is no sitemap (`guessed`).
    return { page, origin, base, readable, maps: maps.length > 0 ? maps.map((url) => ({ url, guessed: false })) : [{ url: `${origin}/sitemap.xml`, guessed: true }] };
  }

  /** Whether there's a page to import (starting one checks within seconds): the first sitemap file that lists one, else the start page's links. */
  async function anyPage(): Promise<boolean> {
    const { page, origin, readable, maps } = await bounds();
    try {
      for (const map of maps) {
        if ((await sitemap(map.url, origin, readable, true, 0, map.guessed)).length > 0) {
          return true;
        }
      }
    } catch (error) {
      // Out of time (a long Crawl-delay) with the start page read: the import's first step looks properly.
      if (error instanceof SiteError && error.reason === "late") {
        return true;
      }
      throw error;
    }
    return links(page.text, page.url).some((link) => readable(link.href));
  }

  /**
   * A step's worth of finding the help center's pages, from where `state` left it: the sitemap, all at once; else the
   * start page's links and theirs, breadth first, as long as the step has time, carried on by the next step. Done, the
   * list: its pages and its collections (the folders they're in, below the address, named as the start page's links
   * name them).
   */
  async function find(): Promise<{ state: CrawlState; done: boolean; progress: string }> {
    const { page, origin, base, readable, maps } = await bounds();
    if (!state.list && !state.crawl) {
      const listed = new Set<string>();
      for (const map of maps) {
        for (const id of await sitemap(map.url, origin, readable, false, 0, map.guessed)) {
          if (listed.size < MAX_PAGES) {
            listed.add(id);
          }
        }
      }
      // No sitemap (or nothing under the address in it): the links.
      const ids = listed.size > 0 ? [...listed] : [...new Set(links(page.text, page.url).map((l) => l.href).filter(readable))];
      state = listed.size > 0 ? { list: listOf(ids, page, origin, base) } : { crawl: { found: ids, fetched: 0, gone: [] } };
    }
    const crawl = state.crawl;
    if (crawl) {
      const found = new Set(crawl.found);
      for (let fetches = 0; crawl.fetched < crawl.found.length && crawl.fetched < MAX_LINK_PAGES && found.size < MAX_PAGES; crawl.fetched++, fetches++) {
        // Time left to save where it got to: the next step goes on from there.
        const notYet = { state, done: false, progress: String(crawl.fetched) };
        if (Date.now() > deadline - 30_000 || fetches >= crawlBudget.fetches) {
          return notYet;
        }
        const id = crawl.found[crawl.fetched]!;
        let next: Awaited<ReturnType<typeof get>>;
        try {
          next = await get(id);
        } catch (error) {
          // Out of time before it was asked: the next step asks. Refused (a redirect into a folder robots.txt closes):
          // gone. Anything else (a 5xx, a 429, no answer) fails the step, as a sitemap's does, rather than a list
          // that's quietly short.
          if (error instanceof SiteError && error.reason === "late") {
            return notYet;
          }
          if (!(error instanceof SiteError && error.reason === "refused")) {
            throw error;
          }
          next = null;
        }
        // Gone (a 404, or off the site): not an article.
        if (!next) {
          crawl.gone.push(id);
        }
        for (const { href } of next ? links(next.text, next.url) : []) {
          if (readable(href) && !found.has(href) && found.size < MAX_PAGES) {
            found.add(href);
            crawl.found.push(href);
          }
        }
      }
      state = { list: listOf(crawl.found.filter((id) => !crawl.gone.includes(id)), page, origin, base) };
    }
    return { state, done: true, progress: "done" };
  }

  /** Pages and their collections from the pages' addresses. */
  function listOf(ids: string[], page: { text: string; url: string }, origin: string, base: string): SiteList {
    const named = new Map(links(page.text, page.url).filter((l) => l.text).map((l) => [l.href, l.text]));
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
    ids.forEach((id) => add(folder(id)));
    // A page that's a folder's own (/billing, of /billing/refunds) goes first in it.
    let pages = ids.map((id) => ({ id, collection: collections.has(id) ? id : folder(id) }));
    pages = [...pages.filter((p) => p.collection === p.id), ...pages.filter((p) => p.collection !== p.id)];
    // No folders: all of them in one collection, named as the site names itself.
    if (collections.size === 0 && pages.length > 0) {
      const title = pageTitle(page.text);
      const one = { id: pageId(page.url), parent: null, name: (title || new URL(origin).hostname).slice(0, 60) };
      collections.set(one.id, one);
      pages = pages.map((p) => ({ ...p, collection: one.id }));
    }
    return { pages, collections: [...collections.values()] };
  }

  /** The list `find` made (the import's first step), as every later step reads it. */
  async function list(): Promise<SiteList> {
    if (!state.list) {
      throw new Error("The help center's pages weren't found first.");
    }
    return state.list;
  }

  /** A page as an article: its title (its main heading, else its title) and main content, links and images made absolute. */
  async function article(id: string, collection: string | null, order: number): Promise<FeaturebaseArticle | null> {
    const page = await getRetrying(id);
    if (!page || !/html/i.test(page.type || "text/html")) {
      return null;
    }
    const window = inertWindow();
    try {
      const document = new window.DOMParser().parseFromString(page.text, "text/html") as unknown as Document;
      const meta = (name: string) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute("content")?.trim();
      // The most specific first: a list in one querySelector would take whichever comes first in the page (a <main> around
      // Docusaurus's article and its table of contents, say).
      const main =
        [".theme-doc-markdown", "main article", "[role=main] article", "main", "[role=main]", "article", ".markdown", "#content", ".content"].map((selector) => document.querySelector(selector)).find(Boolean) ??
        document.body;
      // Its heading first, before the chrome below goes: the first <h1> outside the chrome (not a site banner's), else one
      // in a <header> inside the content (Docusaurus and Zendesk put the title there). With no content container (the
      // body), a <header>'s is the site's banner: the page's own title instead.
      const chrome = "nav, header, footer, aside, [role=navigation]";
      const headings = [...main.querySelectorAll("h1")];
      const inContentHeader = (h: Element) => {
        const header = h.closest("header");
        return header !== null && main !== document.body && main.contains(header);
      };
      const heading = headings.find((h) => !h.closest(chrome)) ?? headings.find(inContentHeader) ?? null;
      const title = heading?.textContent?.replace(/\s+/g, " ").trim() || meta("og:title") || document.title.trim() || fromSlug(id.split("/").at(-1)!);
      heading?.remove();
      main.querySelectorAll(`${chrome}, [aria-label*=breadcrumb], [aria-label*=Breadcrumb], .breadcrumb, .breadcrumbs, script, style`).forEach((el) => el.remove());
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

  return { home, anyPage, find, list, article };
}

export const websiteSource: ImportSourceDefinition = {
  name: "your help center",
  credential: "url",
  // Its articles' and collections' ids are their pages' addresses: a link to one is its address.
  docsLink: (_path, url) => ({ ref: pageId(url) }),
  status: (error) => (error instanceof SiteError ? error.status : null),
  connect: (address, { deadline, state }) => {
    const reader = site(address, deadline, state);
    return {
      // The address the team just entered: a host name that doesn't exist is a mistake in it, not something to try again
      // (or, one its start page redirects to, the site's).
      checkCredential: () =>
        reader.home().catch((error: unknown) => {
          if (!(error instanceof SiteError && error.reason === "unknown")) {
            throw error;
          }
          const entered = new URL(address).hostname;
          throw new SiteError(
            404,
            error.host === entered ? `Tuti couldn't find ${entered}. Check the address.` : `${entered} sends visitors to ${error.host}, which can't be found.`,
          );
        }),
      checks: {
        docs: async () => {
          if (!(await reader.anyPage())) {
            throw new SiteError(0, "Tuti found no articles at this address: no sitemap lists pages under it, and its page links to none.", "refused");
          }
        },
      },
      read: {
        find: () => reader.find(),
        // Nobody's named: the team's articles are by no one, as the team writes them.
        admins: async () => [],
        collections: async (): Promise<Page<FeaturebaseCollection>> => ({
          items: (await reader.list()).collections.map((c, order) => ({ id: c.id, parentId: c.parent, name: c.name, slug: c.id.split("/").at(-1), order })),
          next: null,
        }),
        // The list, titled from their addresses: each page is read when the content pass gets to it (`article`).
        articles: async (cursor, limit = 100) => {
          const { pages } = await reader.list();
          const from = Number(cursor ?? 0);
          const items = pages.slice(from, from + limit).map((p, i) => {
            const segment = new URL(p.id).pathname.split("/").at(-1) ?? "";
            return { id: p.id, parentId: p.collection, title: fromSlug(segment), slug: segment, order: from + i, isPublished: false, state: "draft" as const };
          });
          return { items, next: from + limit < pages.length ? String(from + limit) : null };
        },
        article: async (item) => {
          try {
            return await reader.article(item.id, item.parentId ?? null, item.order ?? 0);
          } catch (error) {
            // Refused (robots.txt, not public) or answered with a 4xx: none, for the last check to say. Anything else
            // (a 429, a 5xx, no answer, out of time) is for a while, and thrown.
            if (error instanceof SiteError && (error.reason === "refused" || (!error.reason && error.status >= 400 && error.status < 500 && error.status !== 429))) {
              return null;
            }
            throw error;
          }
        },
        articleDraft: async () => null,
        articleExists: async (id) => (await reader.article(id, null, 0)) !== null,
      },
    };
  },
};
