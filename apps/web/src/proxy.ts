import { type NextRequest, NextResponse } from "next/server";

import { appPortalMount } from "@/lib/app-portal";
import { appUrl, portalUrl } from "@/lib/hosts";
import { ASSET_PATH, BASE_HEADER, BASE_PATTERN, CUSTOMIZE, PREVIEW } from "@/lib/portal-base";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { isUsableSlug, SLUG_PATTERN } from "@/lib/project-slugs";
import { CHECK_PATH, portalAddress, requestTarget, siteCheckToken, siteMount } from "@/server/custom-domains";
import { isArticleSlug } from "@/server/docs-queries";
import { destinationKey, redirectKey, redirectLocation } from "@/lib/portal-redirects";
import { PREVIEW_TOKEN_PARAM, PREVIEW_TTL_SECONDS } from "@/server/auth/preview-session";
import { PREVIEW_READER_COOKIE, portalVisitor, previewTokenFor, teamPreview, WIDGET_READER_COOKIE } from "@/server/auth/portal-readers";
import { redirectFor } from "@/server/portal-redirects";
import { LANGUAGE, languagePrefix, ownAddress, preferredLanguage, prefixedTarget, splitLanguage, withLanguage } from "@/lib/language-addresses";
import { LANGUAGE_COOKIE } from "@/lib/reader-language";
import { apiReferenceSlugs, inDefaultLanguage, portalLanguages } from "@/server/language-addresses";
import type { Language } from "@tuti/shared/languages";

/**
 * Routes requests by host:
 * - app host (tuti.so): served as-is; internal /portal routes are hidden.
 * - portal hosts (<project>.tuti.so, or a verified custom domain like help.acme.com):
 *   rewritten to /portal/<project>/…, so
 *   acme.tuti.so/b/ideas renders app/portal/[project]/(site)/b/[board].
 *   An article's Markdown, /docs/<slug>.md, goes to docs/[slug]/md, an API operation's,
 *   /docs/<reference>/<operation>.md, to docs/[slug]/[operation]/md, a changelog
 *   entry's, /changelog/<number>.md, to changelog/[number]/md, and a post's,
 *   <its path>.md, to feedback/[board]/[post]/md (a route segment can't be part
 *   dynamic, part ".md").
 * The auth API (/api/*) is served on every host so sessions stay per host.
 * Pages can't be framed by other sites (clickjacking), except a portal's
 * /widget, which customers embed with the widget script; the app may frame
 * portal pages (Customize's preview).
 *
 * A private portal (server/portal-access.ts) is enforced here, the one way into every portal
 * page and file: visitors who may not read it go to its sign-in page, with `next` to come back.
 * (Not in the portal's layout: layouts don't run for every request, and files bypass them.)
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // An address cut off mid-escape ("/users/50%") is no page; Next.js would fail decoding it (a 500) before any page runs.
  try {
    decodeURIComponent(pathname);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  // Health checks come from inside the host (e.g. localhost:3000), not a known hostname.
  if (pathname === "/api/health") {
    return NextResponse.next();
  }
  // Next.js's files, which pages load from /_tuti/_next (see next.config.ts): a team's site forwards /_tuti with its portal.
  if (pathname.startsWith(`${ASSET_PATH}/_next/`)) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.slice(ASSET_PATH.length);
    return NextResponse.rewrite(url);
  }
  const host = request.headers.get("host");
  const target = await requestTarget(host);

  if (target.kind === "portal") {
    if (isSharedApi(pathname)) {
      return NextResponse.next();
    }
    // "Check setup" for a portal under a path of the team's site: the site forwards <path>/.well-known/tuti-site here.
    if (pathname.endsWith(CHECK_PATH)) {
      const path = pathname.slice(0, -CHECK_PATH.length);
      // Under the mount's path, or under /_tuti (the site forwards both: "Check setup" asks through each).
      const token = path === ASSET_PATH ? await siteCheckToken(target.slug) : BASE_PATTERN.test(path) ? await siteCheckToken(target.slug, path) : null;
      if (token) {
        return new NextResponse(token, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
      }
    }
    // Under a path of the team's own site (acme.com/portal, forwarded here path and all): the portal,
    // with that path added back to its links (see lib/portal-base.ts). Not sent on anywhere else.
    const mount = await siteMount(target.slug);
    if (mount && (pathname === mount.path || pathname.startsWith(`${mount.path}/`))) {
      return mounted(request, target.slug, mount, pathname.slice(mount.path.length) || "/");
    }
    // A portal with a live custom domain answers there: its Tuti address sends pages on to it (not
    // the widget's panel, which customers' sites embed from here, nor forms posted from an open page,
    // nor Customize's preview, which shows the portal here whatever its address). Only the app frames
    // pages other than /widget, so a framed one is the preview's: a page's own redirect (the home's to
    // the part it opens) drops the preview's param, and Next.js then loads the page it goes to afresh.
    const customizing = request.nextUrl.searchParams.get(CUSTOMIZE.param) === CUSTOMIZE.value || request.headers.get("sec-fetch-dest") === "iframe";
    if (!target.customDomain && !customizing && pathname !== "/widget" && (request.method === "GET" || request.method === "HEAD")) {
      const address = await portalAddress(target.slug);
      // Not to localhost (Tuti's own portal on a local app): Next.js turns a redirect to the origin it
      // serves into a bare path, which would send the browser round in circles; it reads it here then.
      if (address !== portalUrl(target.slug) && new URL(address).hostname !== "localhost") {
        // The address can have a path (a portal under its site's /portal): the page's goes after it.
        const response = NextResponse.redirect(`${address}${pathname}${request.nextUrl.search}`, 308);
        // Permanent for search engines, but not kept by browsers: if the domain is removed, the Tuti address is the portal again.
        response.headers.set("cache-control", "no-store");
        return response;
      }
    }
    // On its own domain the portal stays there (help.acme.com/sign-in).
    const origin = target.customDomain ? `${new URL(portalUrl(target.slug)).protocol}//${host}` : portalUrl(target.slug);
    // Customize's preview, with the token of the team member it reads the portal as: kept as a cookie
    // (partitioned to the app's site, which frames it), and out of the address.
    const token = request.nextUrl.searchParams.get(PREVIEW_TOKEN_PARAM);
    if (token !== null) {
      const url = new URL(`${pathname}${request.nextUrl.search}`, origin);
      url.searchParams.delete(PREVIEW_TOKEN_PARAM);
      const response = NextResponse.redirect(url);
      response.headers.set("cache-control", "no-store");
      if (await previewTokenFor(target.slug, token)) {
        response.cookies.set(PREVIEW_READER_COOKIE, token, {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          partitioned: true,
          path: "/",
          maxAge: PREVIEW_TTL_SECONDS,
        });
      }
      return framedByApp(response);
    }
    return servePortal(request, target.slug, origin);
  }

  if (target.kind === "app") {
    // Tuti's own portal, under its path (tuti.so/help/…; see lib/app-portal.ts): like a team's site.
    const own = appPortalMount();
    if (own && (pathname === own.path || pathname.startsWith(`${own.path}/`))) {
      return mounted(request, own.slug, own, pathname.slice(own.path.length) || "/");
    }
    if (pathname === "/portal" || pathname.startsWith("/portal/")) {
      return new NextResponse(null, { status: 404 });
    }
    const response = NextResponse.next();
    const project = /^\/app\/([^/]+)/.exec(pathname)?.[1];
    if (project && SLUG_PATTERN.test(project) && isUsableSlug(project)) {
      response.cookies.set(LAST_PROJECT_COOKIE, project, {
        path: "/app",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    return noFraming(response);
  }

  // Unknown host: nothing (custom domains are portals once verified).
  return new NextResponse(null, { status: 404 });
}

/** The API, on every host: but not its reference (/api/docs), a page of the app's own. */
const isSharedApi = (path: string) => path.startsWith("/api/") && path !== "/api/docs";

/** A request under a portal's path on a site (`path`: the portal's own path of it). */
function mounted(request: NextRequest, slug: string, mount: { origin: string; path: string }, path: string) {
  // Signing in there: the auth API, under the path too; and Tuti's icon.
  if (isSharedApi(path) || path === "/icon.svg") {
    const url = request.nextUrl.clone();
    url.pathname = path;
    return NextResponse.rewrite(url, { request: { headers: fromSite(request, mount) } });
  }
  return servePortal(request, slug, `${mount.origin}${mount.path}`, path, mount);
}

/**
 * A request that came through the team's site: the path it's under (BASE_HEADER), and the site as
 * the host it came to, as a proxy says (X-Forwarded-Host), whatever the site's own proxy sent: so
 * forms posted from the site's pages count as posted to it (Next.js's server action check).
 */
function fromSite(request: NextRequest, mount: { origin: string; path: string }) {
  const headers = new Headers(request.headers);
  const site = new URL(mount.origin);
  headers.set(BASE_HEADER, mount.path);
  headers.set("x-forwarded-host", site.host);
  headers.set("x-forwarded-proto", site.protocol.replace(":", ""));
  return headers;
}

/**
 * A portal page or file, for `slug`'s portal at `origin`: its readers only, if it's private.
 * `pathname` is the portal's own path; `mount`, where it is on the team's site, when the request came through it.
 */
async function servePortal(request: NextRequest, slug: string, origin: string, address = request.nextUrl.pathname, mount?: { origin: string; path: string }) {
  const reading = request.method === "GET" || request.method === "HEAD";
  // A language's prefix (docs/plan.md, Languages; lib/language-addresses.ts): /de/docs/billing is /docs/billing in German.
  const languages = await portalLanguages(slug);
  const inLanguage = splitLanguage(address);
  const live = !!inLanguage && !!languages?.live.includes(inLanguage.code);
  // The team's redirects (Settings → Domain → Redirects) first: an old address goes on, whoever's asking. Under a live
  // language's prefix a rule can't hide the portal's own addresses (/de/docs/<slug>), and a path with no rule of its own
  // takes the rule of the path without the prefix, in the language (/de/docs/billing → /de/docs/payments). The exact rules
  // come first under any other prefix too (an imported /fr/articles/… while French is offline).
  if (reading) {
    const isLive = (code: Language) => !!languages?.live.includes(code);
    // An API operation's page (`/docs/<reference>/<operation>`, or its `.md`): the references read once per request, if asked.
    let references: Promise<Set<string>> | undefined;
    const isOperation = async (path: string) => {
      const reference = /^\/docs\/([^/]+)\/[^/]+$/.exec(path)?.[1];
      return !!reference && (await (references ??= apiReferenceSlugs(slug))).has(decodeURIComponent(reference));
    };
    // The rule a path takes, as above.
    const ruleFor = async (path: string) => {
      const split = splitLanguage(path);
      if (!split || !isLive(split.code)) {
        return redirectFor(slug, path);
      }
      const own = await redirectFor(slug, path);
      if (own && !ownAddress(split.path) && !(await isOperation(split.path))) {
        return own;
      }
      // The path's own rule in the language, but not one that lands on the path itself (/docs/billing → /de/docs/billing,
      // taken at /de/docs/billing): that's no rule there.
      const rule = await redirectFor(slug, split.path);
      const target = rule && prefixedTarget(rule, languagePrefix(split.code));
      return target && destinationKey(target) !== redirectKey(path) ? target : null;
    };
    // Never round in circles: a rule is skipped (the page shows) when its chain, followed as requests go (each address's
    // own rule first, else an offline language's address going on to the default's; a whole address or a page ends it),
    // goes round anywhere. Then every chain a request follows has no circle in it: each address on it keeps its rule, and
    // one whose rule is skipped either shows its page or, under an offline prefix, goes on to an address whose chain goes
    // round too, which shows its page. Rules can't be saved as a chain, but a prefix's rules and a language going offline
    // make ones no save could check (/kb → /fr/legacy, /legacy → /fr/kb while French is offline; /docs/billing →
    // /de/docs/billing, asked at /de/docs/billing). ponytail: follows up to 20 addresses, as many as browsers do before
    // giving up; a chain still going after them counts as going round.
    let to = await ruleFor(address);
    const seen = new Set([redirectKey(address)]);
    for (let next = to && destinationKey(to), hops = 0; to && next; hops++) {
      if (seen.has(next) || hops === 20) {
        to = null;
        break;
      }
      seen.add(next);
      const rule = await ruleFor(next);
      const split = splitLanguage(next);
      next = rule ? destinationKey(rule) : split && !isLive(split.code) ? redirectKey(await inDefaultLanguage(slug, split.code, split.path)) : null;
    }
    if (to) {
      const response = NextResponse.redirect(redirectLocation(to, origin, request.nextUrl.search), 308);
      // Permanent for search engines, but not kept by browsers: the team can change it.
      response.headers.set("cache-control", "no-store");
      return framedByApp(response);
    }
  }
  // A language that isn't live (offline, removed, never added, or the default's own code): the same page in the default
  // language, a temporary redirect (it may come back), never a 404. Except for the team's preview of one they have
  // (marked "Not live yet" and kept from search engines by the pages). Forms posted there are the default language's.
  const preview =
    !!inLanguage && !live && !!languages?.stored.includes(inLanguage.code) && (await teamPreview(slug, request.headers, request.cookies.get(PREVIEW_READER_COOKIE)?.value));
  if (inLanguage && !live && !preview && reading) {
    // An article by that language's slug goes to its default-language slug.
    const response = NextResponse.redirect(redirectLocation(await inDefaultLanguage(slug, inLanguage.code, inLanguage.path), origin, request.nextUrl.search), 307);
    response.headers.set("cache-control", "no-store");
    return framedByApp(response);
  }
  // "Send visitors to their language" (off by default): a first visit to the portal's home (no language chosen in this
  // browser yet) goes to the live language the browser asks for (Accept-Language); never other pages, nor Customize's
  // preview. Kept as this browser's choice (the switcher's cookie), so the visit after stays where the reader went. Only a
  // page the browser says it loads itself (Sec-Fetch-Dest: document, or Sec-Fetch-Mode: navigate), never the router's
  // prefetches or client navigations, which would use up the first visit or show /de inside the layout as it was (both
  // addresses are one route to it). Next keeps its own router headers from the proxy, so the browser's are all there is to
  // go by, and one that says neither isn't sent anywhere.
  const framed = request.nextUrl.searchParams.get(CUSTOMIZE.param) === CUSTOMIZE.value || request.headers.get("sec-fetch-dest") === "iframe";
  const pageLoad = request.headers.get("sec-fetch-dest") === "document" || request.headers.get("sec-fetch-mode") === "navigate";
  if (reading && address === "/" && pageLoad && languages?.sendVisitors && !request.cookies.has(LANGUAGE_COOKIE) && !framed) {
    const wanted = preferredLanguage(request.headers.get("accept-language"), [languages.default, ...languages.live]);
    if (wanted && wanted !== languages.default) {
      const response = NextResponse.redirect(redirectLocation(languagePrefix(wanted), origin, request.nextUrl.search), 307);
      response.headers.set("cache-control", "no-store");
      response.cookies.set(LANGUAGE_COOKIE, wanted, { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), maxAge: 60 * 60 * 24 * 365, path: "/" });
      return framedByApp(response);
    }
  }
  const language = inLanguage && (live || preview) ? inLanguage.code : null;
  const prefix = language ? languagePrefix(language) : "";
  const pathname = inLanguage ? inLanguage.path : address;
  const visitor = OPEN_PORTAL_PATHS.test(pathname)
    ? "public"
    : await portalVisitor(slug, request.headers, { preview: request.cookies.get(PREVIEW_READER_COOKIE)?.value, widgetReader: request.cookies.get(WIDGET_READER_COOKIE)?.value });
  if (visitor === "refused") {
    // A script's request (a client navigation: the page's router asking for the next page's payload) gets no redirect:
    // followed, it would show the sign-in page inside the layout as it was for someone who could read the portal (its
    // parts, its widget). Refused, the router loads the address as a page instead, which comes back here and is sent to
    // sign in. (Next keeps its own router headers from the proxy; the browser says what kind of request it is.)
    if (request.headers.get("sec-fetch-dest") === "empty") {
      return framedByApp(new NextResponse(null, { status: 403, headers: { "cache-control": "private, no-store" } }));
    }
    const signIn = new URL(`${new URL(origin).pathname.replace(/\/$/, "")}${prefix}/sign-in`, origin);
    // In the page's language: signing in comes back to it, a language's home too (every way of signing in goes to / without one).
    const back = withLanguage(prefix, pathname);
    if (back !== "/") {
      signIn.searchParams.set("next", back + request.nextUrl.search);
    }
    const response = NextResponse.redirect(signIn);
    response.headers.set("cache-control", "private, no-store");
    return framedByApp(response);
  }
  const url = request.nextUrl.clone();
  // An article's page asked for as Markdown (an AI agent's Accept header): its .md, the same route. A tab's or
  // collection's page (the same kind of path) has no Markdown: the page.
  // A changelog entry's page likewise (one that isn't published: its Markdown is a 404 as the page is), and a post's: every
  // /feedback/<board>/<post> is one, as every /docs/<reference>/<operation> is an API operation's.
  const docsPage = /^\/docs\/[^/]+$/.test(pathname) && !pathname.endsWith(".md");
  const operationPage = /^\/docs\/[^/]+\/[^/]+$/.test(pathname) && !pathname.endsWith(".md");
  const entryPage = /^\/changelog\/\d+$/.test(pathname);
  const postPage = /^\/feedback\/[^/]+\/[^/]+$/.test(pathname) && !pathname.endsWith(".md");
  const markdown =
    (docsPage || entryPage || postPage || operationPage) &&
    (request.method === "GET" || request.method === "HEAD") &&
    prefersMarkdown(request.headers.get("accept")) &&
    (entryPage || postPage || operationPage || (await isArticleSlug(slug, decodeURIComponent(pathname.slice("/docs/".length)))));
  const path = markdown ? `${pathname}/md` : pathname.replace(/^\/(docs\/[^/]+(?:\/[^/]+)?|changelog\/\d+|feedback\/[^/]+\/[^/]+)\.md$/, "/$1/md");
  url.pathname = `/portal/${slug}${path === "/" ? "" : path}`;
  // Always set, so a request can't say a path of its own.
  const forwarded = mount ? fromSite(request, mount) : new Headers(request.headers);
  if (!mount) {
    forwarded.set(BASE_HEADER, "");
  }
  // "Preview as a reader": always set here, so only the page's own query can ask for it (see currentReader).
  forwarded.set(LANGUAGE.header, language ?? languages?.default ?? "");
  forwarded.set(LANGUAGE.prefix, prefix);
  forwarded.set(LANGUAGE.default, languages?.default ?? "");
  forwarded.set(PREVIEW.header, request.nextUrl.searchParams.get(PREVIEW.param) === PREVIEW.value ? PREVIEW.value : "");
  // Customize's preview: its param (on the links it follows) or a framed page; always set here too.
  const customizing = request.nextUrl.searchParams.get(CUSTOMIZE.param) === CUSTOMIZE.value || request.headers.get("sec-fetch-dest") === "iframe";
  forwarded.set(CUSTOMIZE.header, customizing ? CUSTOMIZE.value : "");
  const response = NextResponse.rewrite(url, { request: { headers: forwarded } });
  if (visitor === "allowed" || preview) {
    // A private portal's feeds and files are for this reader only, and the team's preview of a language that isn't live for
    // the team only (kept, it would be served to readers in place of the redirect): no shared cache may keep them.
    // (Set here, it wins over the routes' own public cache-control.)
    response.headers.set("cache-control", "private, no-store");
  }
  if (docsPage || entryPage || postPage || operationPage) {
    // HTML or Markdown by the Accept header: caches keep them apart.
    response.headers.set("vary", "Accept");
  }
  return pathname === "/widget" ? response : framedByApp(response);
}

/**
 * Whether an Accept header asks for Markdown (text/markdown, named) at least as much as HTML
 * (text/html, else text/*, else *\/*). Browsers never name text/markdown, so they get HTML.
 */
export function prefersMarkdown(accept: string | null): boolean {
  const q = new Map<string, number>();
  for (const part of (accept ?? "").split(",")) {
    const [type, ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    const value = params.find((p) => p.startsWith("q="));
    const weight = value ? Number(value.slice(2)) : 1;
    if (type && !q.has(type)) {
      q.set(type, Number.isFinite(weight) ? weight : 0);
    }
  }
  const markdown = q.get("text/markdown") ?? 0;
  const html = q.get("text/html") ?? q.get("text/*") ?? q.get("*/*") ?? 0;
  return markdown > 0 && markdown >= html;
}

/**
 * What anyone may open on a private portal: signing in (every way, and its emailed links), the
 * SSO and email links, robots.txt (which says keep out), and the widget's panel (which asks
 * people to sign in itself, since the customer's site signs them in there). Sign-up is open
 * here only to say it's off.
 */
const OPEN_PORTAL_PATHS =
  /^\/(sign-in|sign-in\/link|sign-up|forgot-password|reset-password|sso|sso\/error|continue|unsubscribe|unsubscribe\/confirm|changelog\/subscription|changelog\/subscription\/unsubscribe|changelog\/subscription\/confirm|changelog\/subscription\/emails-on|robots\.txt|widget)$/;

/** Portal pages: only the app may frame them (Customize's preview of the portal). */
function framedByApp(response: NextResponse): NextResponse {
  response.headers.set("Content-Security-Policy", `frame-ancestors ${appUrl().origin}`);
  return response;
}

function noFraming(response: NextResponse): NextResponse {
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}

export const config = {
  // Everything except Next.js internals and static files.
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
