import { headers } from "next/headers";

import { BASE_HEADER, BASE_PATTERN, withBase } from "@/lib/portal-base";

/** The path the portal is under on the team's site for this request ("" on its own addresses). */
export async function portalBase(): Promise<string> {
  const base = (await headers()).get(BASE_HEADER) ?? "";
  return BASE_PATTERN.test(base) ? base : "";
}

/** A root-relative portal path for this request: /docs becomes /portal/docs under acme.com/portal. */
export async function portalHref(path: string): Promise<string> {
  return withBase(await portalBase(), path);
}

/** For a page making several links: `at("/docs")` is that path for this request. */
export async function portalLinks(): Promise<(path: string) => string> {
  const base = await portalBase();
  return (path) => withBase(base, path);
}
