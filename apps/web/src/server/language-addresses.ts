import { prisma } from "@tuti/db";

import { SIGNED_OUT } from "@/lib/read-access";

import { readableArticle, servedArticle } from "./docs-queries";
import { cache } from "react";
import { DEFAULT_LANGUAGE, isLanguage, type Language, languageLimit, liveLanguages } from "@tuti/shared";

/**
 * A portal's languages as its addresses need them (lib/language-addresses.ts): the default, the live ones (as languages.get
 * says), whether first visits are sent to their language, and every one stored (an offline one's addresses are the team's preview). For proxy.ts on every portal request and
 * the pages' links and metadata. The proxy keeps them a few seconds per portal, as redirects are (server/portal-redirects.ts), so a
 * language going live or offline reaches every server within CACHE_MS; pages read them afresh (pageLanguages).
 */
export type PortalLanguages = { default: Language; live: Language[]; stored: Language[]; sendVisitors: boolean };

const CACHE_MS = 10_000;
const MAX_CACHED = 5_000;
/**
 * On globalThis, not the module: Next.js bundles the proxy apart from the routes that change languages, each with its own
 * copy of this module, so a change forgets the proxy's copy too on the server that made it (others catch up within CACHE_MS).
 */
const shared = ((globalThis as { tutiPortalLanguages?: { cache: Map<string, { languages: PortalLanguages | null; until: number }>; forgets: number } })
  .tutiPortalLanguages ??= { cache: new Map(), forgets: 0 });
const languagesCache = shared.cache;

/** `slug`'s portal's languages as saved, read once per request: for pages (proxy.ts keeps them a few seconds: portalLanguages). */
export const pageLanguages = cache(async (slug: string): Promise<PortalLanguages | null> => {
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { plan: true, language: true, sendToLanguage: true, languages: { select: { code: true, live: true }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } },
  });
  return (
    project && {
      default: isLanguage(project.language) ? project.language : DEFAULT_LANGUAGE,
      live: liveLanguages(project.languages, languageLimit(project.plan)),
      stored: project.languages.map(({ code }) => code).filter(isLanguage),
      // "Send visitors to their language": a first visit to the home goes to the live one the browser asks for (proxy.ts).
      sendVisitors: project.sendToLanguage,
    }
  );
});

/** `slug`'s portal's languages for proxy.ts, kept CACHE_MS; null when there's no such portal. */
export async function portalLanguages(slug: string): Promise<PortalLanguages | null> {
  const cached = languagesCache.get(slug);
  if (cached && cached.until > Date.now()) {
    return cached.languages;
  }
  const started = shared.forgets;
  const languages = await pageLanguages(slug);
  if (shared.forgets === started) {
    if (languagesCache.size >= MAX_CACHED) {
      languagesCache.clear();
    }
    languagesCache.set(slug, { languages, until: Date.now() + CACHE_MS });
  }
  return languages;
}

/** After a portal's languages change: on this server, the proxy's copy too (see `shared`). */
export function forgetLanguages(slug: string) {
  shared.forgets++;
  languagesCache.delete(slug);
}

/**
 * `slug`'s API references' slugs: an API operation's page (`/docs/<reference>/<operation>`, or its `.md`) is one of the
 * portal's own, which the team's rules can't hide under a live language's prefix. proxy.ts reads them once per request, and
 * only when a rule would take such a path.
 */
export async function apiReferenceSlugs(slug: string): Promise<Set<string>> {
  const references = await prisma.apiReference.findMany({ where: { project: { slug } }, select: { slug: true } });
  return new Set(references.map((reference) => reference.slug));
}

/**
 * Where an offline or removed language's address goes in the default language (docs/plan.md, Languages): the same path, but
 * an article's page (/docs/<slug>, or its .md) found by that language's slug, current then old, goes to its
 * default-language slug (/de/docs/abrechnung → /docs/billing), never the path without the prefix. Only an article anyone
 * may read on its page (served, and for people signed out): the redirect names its slug before the reader is known.
 */
export async function inDefaultLanguage(slug: string, code: Language, path: string): Promise<string> {
  const match = /^\/docs\/([^/]+?)(\.md)?$/.exec(path);
  let asked: string;
  try {
    asked = decodeURIComponent(match?.[1] ?? "");
  } catch {
    return path;
  }
  if (!match || !asked) {
    return path;
  }
  // A private portal's readers are known only after this: nothing named for them.
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true, portalAccess: true } });
  if (!project || project.portalAccess !== "PUBLIC") {
    return path;
  }
  const article = { projectId: project.id, ...servedArticle, ...(await readableArticle(project.id, SIGNED_OUT)) };
  // In the order the language's own address would find it (articleNamed): its slug there, then an article's default-language
  // slug (the same page without the prefix), then an old slug there.
  const select = { article: { select: { slug: true } } } as const;
  const [current, byDefault, old] = await Promise.all([
    prisma.articleTranslation.findFirst({ where: { language: code, slug: asked, article }, select }),
    prisma.article.findFirst({ where: { ...article, slug: asked }, select: { id: true } }),
    prisma.articleOldSlug.findFirst({ where: { language: code, slug: asked, article }, orderBy: { createdAt: "desc" }, select }),
  ]);
  const found = current ?? (byDefault ? null : old);
  return found ? `/docs/${encodeURIComponent(found.article.slug)}${match[2] ?? ""}` : path;
}
