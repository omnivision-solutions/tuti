import { createServer } from "node:http";

import { FAKE_PNG } from "./featurebase-fake";

/**
 * A team's public help center (imports by address): a robots.txt (one folder closed to crawlers, and its sitemap), a
 * sitemap, a start page whose links name its sections, articles in nested folders with a header, navigation and footer
 * around their main content, an image and links between them, a page out of the help center, and one that redirects
 * to a cloud's metadata address (which an import must never follow). `sitemap: false`: no sitemap, so an import goes by
 * the start page's links. `requests`: every path asked for, in order.
 */
export type HelpCenterFake = { url: string; origin: string; sitemap: boolean; requests: string[]; close: () => Promise<void> };

const page = (title: string, main: string) =>
  `<!doctype html><html><head><title>${title} | Acme Help</title></head><body>` +
  `<header><a href="/">Acme</a></header><nav><a href="/docs/getting-started">Getting started</a><a href="/docs/billing">Billing &amp; plans</a></nav>` +
  `<main><nav aria-label="Breadcrumb"><a href="/docs">Help</a></nav><h1>${title}</h1>${main}</main><footer>© Acme</footer></body></html>`;

const PAGES: Record<string, string> = {
  "/docs": `<!doctype html><html><head><title>Acme Help</title></head><body><main><h1>How can we help?</h1><ul>
    <li><a href="/docs/getting-started">Getting started</a></li><li><a href="/docs/billing">Billing &amp; plans</a></li>
    <li><a href="/docs/getting-started/install">Install Acme</a></li></ul></main></body></html>`,
  "/docs/getting-started": page("Getting started", `<p>Start here.</p>`),
  "/docs/getting-started/install": page("Install Acme", `<p>Download the app, then <a href="first-project">make your first project</a>.</p><p><img src="/images/installer.png" alt="The installer"></p>`),
  "/docs/getting-started/first-project": page("Your first project", `<p>Click <strong>New project</strong>.</p>`),
  "/docs/billing/plans": page("Plans", `<p>Free and Pro. See <a href="/docs/billing/refunds">refunds</a>.</p>`),
  "/docs/billing/refunds": page("Refunds", `<p>Within 30 days.</p>`),
  "/docs/private/secret": page("Secret", `<p>Not for crawlers.</p>`),
  "/blog/launch": page("We launched", `<p>Not the help center.</p>`),
};

export async function startHelpCenterFake(): Promise<HelpCenterFake> {
  const fake = { sitemap: true, requests: [] as string[] } as HelpCenterFake;
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fake").pathname;
    fake.requests.push(path);
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" }).end(`User-agent: *\nDisallow: /docs/private\n${fake.sitemap ? `Sitemap: ${fake.origin}/sitemap.xml\n` : ""}`);
    } else if (path === "/sitemap.xml" && fake.sitemap) {
      const urls = [...Object.keys(PAGES), "/docs/moved"].map((p) => `<url><loc>${fake.origin}${p}</loc></url>`).join("");
      res.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    } else if (path === "/docs/moved") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    } else if (path === "/images/installer.png") {
      res.writeHead(200, { "content-type": "image/png" }).end(FAKE_PNG);
    } else if (PAGES[path]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGES[path]);
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
