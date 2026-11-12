/** The link a path is under: the longest href that is the path or a folder of it (/settings/integrations/github is under /settings/integrations). */
export function activeHref(pathname: string, hrefs: string[]): string | undefined {
  return hrefs
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * The view a URL is on, of views told apart by their query string (/feedback, /feedback?view=mine): of those on its path
 * whose every parameter it has (others too: ?view=mine&page=2), the one with the most parameters; else the one without a query whose
 * path the URL is under (`activeHref`).
 */
export function activeView(pathname: string, search: string, hrefs: string[]): string | undefined {
  const params = new URLSearchParams(search);
  const matching = hrefs.filter((href) => {
    const [path, query] = href.split("?");
    return query !== undefined && path === pathname && [...new URLSearchParams(query)].every(([key, value]) => params.getAll(key).includes(value));
  });
  const count = (href: string) => [...new URLSearchParams(href.split("?")[1])].length;
  return matching.sort((a, b) => count(b) - count(a))[0] ?? activeHref(pathname, hrefs.filter((href) => !href.includes("?")));
}
