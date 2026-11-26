import { headers } from "next/headers";

import { languageFrom, withLanguage } from "@/lib/language-addresses";
import { BASE_HEADER, BASE_PATTERN, withBase } from "@/lib/portal-base";

/** The path the portal is under on the team's site for this request ("" on its own addresses). */
export async function portalBase(): Promise<string> {
  const base = (await headers()).get(BASE_HEADER) ?? "";
  return BASE_PATTERN.test(base) ? base : "";
}

/**
 * This request's address's language (lib/language-addresses.ts): `language`, the default one on the portal's own addresses
 * (null off the portal), and `prefix`, "/de" under another's ("" for the default's).
 */
export async function portalLanguage() {
  return languageFrom(await headers());
}

/** What the portal's links go under for this request: the site's path, then the language's prefix (/portal/de). */
export async function portalLinkBase(): Promise<string> {
  const [base, { prefix }] = await Promise.all([portalBase(), portalLanguage()]);
  return `${base}${prefix}`;
}

/** A root-relative portal path for this request: /docs becomes /portal/docs under acme.com/portal, /de/docs on a German page. */
export async function portalHref(path: string): Promise<string> {
  return (await portalLinks())(path);
}

/** For a page making several links: `at("/docs")` is that path for this request. */
export async function portalLinks(): Promise<(path: string) => string> {
  const [base, { prefix }] = await Promise.all([portalBase(), portalLanguage()]);
  return (path) => withBase(base, withLanguage(prefix, path));
}

/**
 * The language the team's and people's words are in: the project's default (docs/plan.md, Languages: "its content carries the
 * default language's `lang`"), for their `lang` on a portal page, whatever the address's language; undefined off the
 * portal. The one mechanism with the portal's client components' useTeamLanguage (L5's, from PortalIntl): this reads the same
 * default from proxy.ts's header, for server components. What the team or people wrote (an article, a post and its comments,
 * a changelog entry, and the lists and search results made of them, the docs' tree and collections included) carries it;
 * the portal's own text doesn't (L5 translates it), nor the names the team gives boards, statuses and tabs (L13–L15
 * translate those). Translated articles (L8) and entries (L17) will take their own.
 */
export async function teamLanguage(): Promise<string | undefined> {
  return (await portalLanguage()).defaultLanguage ?? undefined;
}
