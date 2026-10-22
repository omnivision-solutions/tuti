/** The link a path is under: the longest href that is the path or a folder of it (/settings/integrations/github is under /settings/integrations). */
export function activeHref(pathname: string, hrefs: string[]): string | undefined {
  return hrefs
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
}
