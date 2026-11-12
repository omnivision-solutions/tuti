/** The link a path is under: the longest href that is the path or a folder of it (/settings/integrations/github is under /settings/integrations). */
export function activeHref(pathname: string, hrefs: string[]): string | undefined {
  return hrefs
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * The view a URL is on, of views told apart by their query string (/feedback, /feedback?view=mine): the one that is the
 * whole URL, else the one without a query whose path the URL is under (`activeHref`).
 */
export function activeView(pathname: string, search: string, hrefs: string[]): string | undefined {
  const here = search ? `${pathname}?${search}` : pathname;
  return hrefs.find((href) => href === here) ?? activeHref(pathname, hrefs.filter((href) => !href.includes("?")));
}
