import { prisma } from "@tuti/db";
import { DEFAULT_LANGUAGE, isLanguage, type Language, languageLimit, liveLanguages } from "@tuti/shared";

/**
 * A portal's languages as its addresses need them (lib/language-addresses.ts): the default, the live ones (as languages.get
 * says), and every one stored (an offline one's addresses are the team's preview). For proxy.ts on every portal request and
 * the pages' links and metadata: kept for a few seconds per portal, as redirects are (server/portal-redirects.ts), so a
 * language going live or offline reaches every server within CACHE_MS.
 */
export type PortalLanguages = { default: Language; live: Language[]; stored: Language[] };

const CACHE_MS = 10_000;
const MAX_CACHED = 5_000;
const cache = new Map<string, { languages: PortalLanguages | null; until: number }>();
let forgets = 0;

/** `slug`'s portal's languages, or null when there's no such portal. */
export async function portalLanguages(slug: string): Promise<PortalLanguages | null> {
  const cached = cache.get(slug);
  if (cached && cached.until > Date.now()) {
    return cached.languages;
  }
  const started = forgets;
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { plan: true, language: true, languages: { select: { code: true, live: true }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] } },
  });
  const languages = project && {
    default: isLanguage(project.language) ? project.language : DEFAULT_LANGUAGE,
    live: liveLanguages(project.languages, languageLimit(project.plan)),
    stored: project.languages.map(({ code }) => code).filter(isLanguage),
  };
  if (forgets === started) {
    if (cache.size >= MAX_CACHED) {
      cache.clear();
    }
    cache.set(slug, { languages, until: Date.now() + CACHE_MS });
  }
  return languages;
}

/** After a portal's languages change (this module's copy only: the proxy's catches up within CACHE_MS). */
export function forgetLanguages(slug: string) {
  forgets++;
  cache.delete(slug);
}
