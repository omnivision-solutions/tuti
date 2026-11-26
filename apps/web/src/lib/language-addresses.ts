import { isLanguage, type Language, LANGUAGE_CODES } from "@tuti/shared/languages";
import { portalPage, redirectKey, reservedPath } from "@tuti/shared/portal-redirects";

/**
 * Language addresses (docs/plan.md, Languages): the default language keeps the portal's addresses, another has its code in
 * front, lowercase (/de/docs/billing, /pt-br/changelog). proxy.ts takes the prefix off and says in LANGUAGE's headers which
 * language the address is in (the default one on its own addresses) and its prefix ("" there); always set there, so a request
 * can't say its own. Pages' links add the prefix back (portalHref, usePortalHref).
 */
export const LANGUAGE = { header: "x-tuti-language", prefix: "x-tuti-language-prefix" } as const;

/** A language's prefix: /de, /pt-br. */
export const languagePrefix = (code: Language) => `/${code.toLowerCase()}`;

const BY_PREFIX = new Map(LANGUAGE_CODES.map((code) => [languagePrefix(code), code]));

/** The offered language a portal path starts with, and the path without it (/de/docs → de, /docs; /de → de, /). */
export function splitLanguage(path: string): { code: Language; path: string } | null {
  const end = path.indexOf("/", 1);
  const code = BY_PREFIX.get(end === -1 ? path : path.slice(0, end));
  return code ? { code, path: end === -1 ? "/" : path.slice(end) } : null;
}

/** `path` in the language whose prefix is `prefix` (/docs → /de/docs). Not the API or Next.js's files, which have no language. */
export function withLanguage(prefix: string, path: string): string {
  if (!prefix || !path.startsWith("/") || path.startsWith("//") || /^\/(api|_tuti)(\/|$)/.test(path)) {
    return path;
  }
  return path === "/" ? prefix : /^\/[?#]/.test(path) ? `${prefix}${path.slice(1)}` : `${prefix}${path}`;
}

/**
 * Whether a path (without a language's prefix) is the portal's: its home, one of its pages (or one it may be) or an address it
 * keeps for itself. The team's redirects can't hide these under a live language's prefix (/de, /de/docs/<slug>, /de/llms.txt).
 */
export function ownAddress(path: string): boolean {
  const key = redirectKey(path);
  return key === "/" || portalPage(key) || reservedPath(key);
}

/**
 * A redirect's target for a path under `prefix` that took the rule of the path without it: a portal path gets the prefix back
 * (/docs/payments → /de/docs/payments); a whole address, or a path already in a language, stays as it is.
 */
export function prefixedTarget(to: string, prefix: string): string {
  return to.startsWith("/") && !to.startsWith("//") && !splitLanguage(new URL(to, "http://portal.invalid").pathname) ? withLanguage(prefix, to) : to;
}

/** The address's language and prefix from proxy.ts's headers (null and "" where it set none: not a portal page). */
export function languageFrom(headers: Headers | undefined | null): { language: Language | null; prefix: string } {
  const language = headers?.get(LANGUAGE.header) ?? "";
  const prefix = headers?.get(LANGUAGE.prefix) ?? "";
  return { language: isLanguage(language) ? language : null, prefix: BY_PREFIX.has(prefix) ? prefix : "" };
}
