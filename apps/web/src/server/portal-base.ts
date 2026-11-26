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
