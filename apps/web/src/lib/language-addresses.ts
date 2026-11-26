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

/**
 * `path` in the language whose prefix is `prefix` (/docs → /de/docs). Not the API or Next.js's files, which have no language,
 * nor a path already in one (a `next` to come back to after signing in keeps the page's).
 */
export function withLanguage(prefix: string, path: string): string {
  if (!prefix || !path.startsWith("/") || path.startsWith("//") || /^\/(api|_tuti)(\/|$)/.test(path) || splitLanguage(path.split(/[?#]/)[0]!)) {
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

/**
 * The language of `offered` an Accept-Language header asks for most (q-values, then order): a code matched whole, else by its
 * first part (de-AT → de, pt → pt-BR, zh-Hans-CN → zh-CN); null when it asks for none of them.
 */
export function preferredLanguage(accept: string | null, offered: Language[]): Language | null {
  const asked = (accept ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.split(";").map((s) => s.trim().toLowerCase());
      const q = Number(params.find((p) => p.startsWith("q="))?.slice(2) ?? 1);
      return { tag, q: Number.isFinite(q) ? q : 0, index };
    })
    .filter(({ tag, q }) => tag && tag !== "*" && q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  const primary = (tag: string) => tag.split("-")[0];
  for (const { tag } of asked) {
    const match = offered.find((code) => code.toLowerCase() === tag) ?? offered.find((code) => primary(code.toLowerCase()) === primary(tag));
    if (match) {
      return match;
    }
  }
  return null;
}
