import { prisma } from "@tuti/db";

import { redirectKey } from "@/lib/portal-redirects";

/**
 * A portal's redirects (Customize → Redirects), for proxy.ts on every portal request: kept for a
 * few seconds per portal. Forgetting them when they change reaches this module's own copy only (the
 * proxy is bundled apart from the app's actions, as with custom domains), so the proxy catches up
 * within CACHE_MS.
 */
const CACHE_MS = 10_000;
const MAX_CACHED = 5_000;
const cache = new Map<string, { rules: Map<string, string>; until: number }>();
let forgets = 0;

/** Where a request for `path` on `slug`'s portal goes, or null when no rule takes it. */
export async function redirectFor(slug: string, path: string): Promise<string | null> {
  let cached = cache.get(slug);
  if (!cached || cached.until <= Date.now()) {
    const started = forgets;
    const rows = await prisma.portalRedirect.findMany({ where: { project: { slug } }, select: { from: true, to: true } });
    cached = { rules: new Map(rows.map((row) => [row.from, row.to])), until: Date.now() + CACHE_MS };
    if (forgets === started) {
      if (cache.size >= MAX_CACHED) {
        cache.clear();
      }
      cache.set(slug, cached);
    }
  }
  return cached.rules.size > 0 ? (cached.rules.get(redirectKey(path)) ?? null) : null;
}

/** After a portal's redirects change. */
export function forgetRedirects(slug: string) {
  forgets++;
  cache.delete(slug);
}
