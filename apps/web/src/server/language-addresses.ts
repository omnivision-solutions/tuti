import { prisma } from "@tuti/db";
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
 * Whether a path is an API operation's page (`/docs/<reference>/<operation>`, or its `.md`) on `slug`'s portal: one of the
 * portal's own pages, which the team's rules can't hide under a live language's prefix. Asked only when a rule would.
 */
export async function isOperationPage(slug: string, path: string): Promise<boolean> {
  const reference = /^\/docs\/([^/]+)\/[^/]+$/.exec(path)?.[1];
  return !!reference && !!(await prisma.apiReference.findFirst({ where: { project: { slug }, slug: decodeURIComponent(reference) }, select: { id: true } }));
}
