import { createServer } from "node:http";

import { FAKE_PNG } from "./featurebase-fake";

/**
 * A team's public help center (imports by address): a robots.txt (one folder closed to crawlers, and its sitemap), a
 * sitemap, a start page whose links name its sections, articles in nested folders with a header, navigation and footer
 * around their main content, an image and links between them, a page out of the help center, and one that redirects
 * to a cloud's metadata address (which an import must never follow). `sitemap: false`: no sitemap, so an import goes by
 * the start page's links. `failing`: paths answered with an error (their status). `forbidRobots`: robots.txt answered with a 403.
 * `POST /_fake/hold` holds the start page's answers until `POST /_fake/release` (journeys, which run in other processes,
 * look at a check while it runs). `requests`: every path asked for, in order.
 */
export type HelpCenterFake = {
  url: string;
  origin: string;
  sitemap: boolean;
  failing: Map<string, number>;
  /** Paths in `failing` that fail once, then are answered as usual. */
  failingOnce: Set<string>;
  /** Sent as Retry-After with `failing`'s answers (null: none). */
  retryAfter: string | null;
  forbidRobots: boolean;
  /** Where the start page redirects to (none: it's served). */
  redirectStartTo: string | null;
  requests: string[];
  close: () => Promise<void>;
};

const page = (title: string, main: string) =>
  `<!doctype html><html><head><title>${title} | Acme Help</title></head><body>` +
  `<header><a href="/">Acme</a></header><nav><a href="/docs/getting-started">Getting started</a><a href="/docs/billing">Billing &amp; plans</a></nav>` +
  // As Docusaurus lays a page out: the article beside its table of contents (plain divs), both in <main>.
  `<main><nav aria-label="Breadcrumb"><a href="/docs">Help</a></nav><div class="toc">On this page <a href="#top">Top</a></div><article><h1>${title}</h1>${main}</article></main>` +
  `<footer>© Acme</footer></body></html>`;

const PAGES: Record<string, string> = {
  "/docs": `<!doctype html><html><head><title>Acme Help</title></head><body><main><h1>How can we help?</h1><ul>
    <li><a href="/docs/getting-started">Getting started</a></li><li><a href="/docs/billing">Billing &amp; plans</a></li>
    <li><a href="/docs/getting-started/install">Install Acme</a></li></ul></main></body></html>`,
  "/docs/getting-started": page("Getting started", `<p>Start here.</p>`),
  "/docs/getting-started/install": page("Install Acme", `<p>Download the app, then <a href="first-project">make your first project</a>.</p><p><img src="/images/installer.png" alt="The installer"></p>`),
  // No content container: the body, with the site's banner heading before the article's own.
  "/docs/getting-started/first-project": `<!doctype html><html><head><title>Your first project | Acme Help</title></head><body><header><h1>Acme Help</h1></header><div><h1>Your first project</h1><p>Click <strong>New project</strong>.</p></div><footer>© Acme</footer></body></html>`,
  // Its content straight in <main>, with a related article beside it (outside <main>).
  "/docs/billing/plans": `<!doctype html><html><head><title>Plans | Acme Help</title></head><body><main><h1>Plans</h1><p>Free and Pro. See <a href="/docs/billing/refunds">refunds</a>.</p></main>` +
    `<aside><h3>Related</h3><article><p>Billing FAQ</p></article></aside></body></html>`,
  // As Docusaurus gives a title from front matter: its <h1> in a <header> inside the content.
  "/docs/billing/refunds": `<!doctype html><html><head><title>Refunds | Acme Help</title></head><body><main><div class="theme-doc-markdown"><header><h1>Refunds</h1></header><p>Within 30 days.</p></div></main></body></html>`,
  "/docs/private/secret": page("Secret", `<p>Not for crawlers.</p>`),
  "/blog/launch": page("We launched", `<p>Not the help center.</p>`),
};

/** Pages served but neither in the sitemap nor linked (tests list them themselves). */
const UNLISTED: Record<string, string> = {
  // No content container and no heading of its own: only the site's banner one.
  "/docs/status": `<!doctype html><html><head><title>Status | Acme Help</title></head><body><header><h1>Acme Help</h1></header><div><p>All systems go.</p></div></body></html>`,
};

export async function startHelpCenterFake(): Promise<HelpCenterFake> {
  const fake = { sitemap: true, failing: new Map<string, number>(),
    failingOnce: new Set<string>(),
    retryAfter: null, forbidRobots: false, redirectStartTo: null, requests: [] as string[] } as HelpCenterFake;
  let held: { promise: Promise<void>; release: () => void } | null = null;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fake").pathname;
    if (req.method === "POST" && (path === "/_fake/hold" || path === "/_fake/release")) {
      if (path === "/_fake/hold") {
        let release = () => {};
        held = { promise: new Promise<void>((resolve) => (release = resolve)), release };
      } else {
        held?.release();
        held = null;
      }
      res.writeHead(200).end();
      return;
    }
    fake.requests.push(path);
    if (path === "/docs" && held) {
      await held.promise;
    }
    if (path === "/docs" && fake.redirectStartTo) {
      res.writeHead(301, { location: fake.redirectStartTo }).end();
    } else if (fake.failing.has(path)) {
      res.writeHead(fake.failing.get(path)!, fake.retryAfter ? { "retry-after": fake.retryAfter } : {}).end();
      if (fake.failingOnce.delete(path)) {
        fake.failing.delete(path);
      }
    } else if (path === "/robots.txt" && fake.forbidRobots) {
      res.writeHead(403).end();
    } else if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" }).end(`User-agent: *\nDisallow: /docs/private\n${fake.sitemap ? `Sitemap: ${fake.origin}/sitemap.xml\n` : ""}`);
    } else if (path === "/sitemap.xml" && fake.sitemap) {
      const urls = [...Object.keys(PAGES), "/docs/moved"].map((p) => `<url><loc>${fake.origin}${p}</loc></url>`).join("");
      res.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    } else if (path === "/docs/moved") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    } else if (path === "/images/installer.png") {
      res.writeHead(200, { "content-type": "image/png" }).end(FAKE_PNG);
    } else if (PAGES[path] ?? UNLISTED[path]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGES[path] ?? UNLISTED[path]);
    } else {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  fake.origin = `http://127.0.0.1:${port}`;
  fake.url = `${fake.origin}/docs`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}
