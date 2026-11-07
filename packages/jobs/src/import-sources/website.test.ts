import * as guard from "@tuti/shared/webhook-url";
import { startHelpCenterFake } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@tuti/shared/webhook-url", async (original) => {
  const real = await original<typeof guard>();
  return { ...real, checkWebhookUrl: vi.fn(real.checkWebhookUrl) };
});

import { crawlPace, fromSlug, pageId, pageTitle, robotsMatch, robotsRules, sitemapLocs, websiteSource, withoutTrailingSlashes } from "./website";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  crawlPace.ms = 500;
});

test("robots.txt's patterns: * any run, a final $ the end, the longest rule winning and Allow on a tie", () => {
  expect(robotsMatch("/docs/private", "/docs/private/secret")).toBe(true);
  expect(robotsMatch("/docs/private", "/docs/pub")).toBe(false);
  expect(robotsMatch("/*.pdf$", "/files/a.pdf")).toBe(true);
  expect(robotsMatch("/*.pdf$", "/files/a.pdf?x")).toBe(false);
  expect(robotsMatch("/a*b*c", "/axxbyyc/more")).toBe(true);
  expect(robotsMatch("/a*b$", "/ab")).toBe(true);
  expect(robotsMatch("/ab*b$", "/ab")).toBe(false);
  expect(robotsMatch("/page$", "/page")).toBe(true);
  expect(robotsMatch("/page$", "/pages")).toBe(false);

  const rules = robotsRules("User-agent: *\nDisallow: /docs/\nAllow: /docs/public\nDisallow: /x\nAllow: /x\nCrawl-delay: 2");
  expect(rules.allowed("/docs/secret")).toBe(false);
  expect(rules.allowed("/docs/public/a")).toBe(true);
  expect(rules.allowed("/x")).toBe(true);
  expect(rules.delayMs).toBe(2000);
});

test("a pattern built to make a backtracking match take forever is matched at once", () => {
  const rules = robotsRules(`User-agent: *\nDisallow: /*${"a*".repeat(12)}b`);
  // A backtracking match of this one wouldn't end within the test's time limit.
  expect(rules.allowed(`/${"a".repeat(5000)}`)).toBe(true);
  expect(rules.allowed(`/${"a".repeat(5000)}b`)).toBe(false);
});

test("starting one, a check that runs out of time once the start page is read lets the import's first step look properly", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  const site = await startHelpCenterFake();
  try {
    // robots.txt and the start page at once; then the clock jumps past the check's time.
    crawlPace.ms = 0;
    const now = Date.now.bind(Date);
    const started = now();
    vi.spyOn(Date, "now").mockImplementation(() => now() + (site.requests.includes("/docs") ? 60_000 : 0));
    const connection = websiteSource.connect(site.url, { deadline: started + 30_000 });
    await connection.checkCredential();
    await expect(connection.checks.docs!()).resolves.toBeUndefined();
    expect(site.requests).toEqual(["/robots.txt", "/docs"]);
  } finally {
    await site.close();
  }
});

test("a crawled page whose name can't be looked up for a moment fails the step, rather than counting as gone", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  crawlPace.ms = 0;
  const site = await startHelpCenterFake();
  site.sitemap = false;
  try {
    const real = await vi.importActual<typeof guard>("@tuti/shared/webhook-url");
    vi.mocked(guard.checkWebhookUrl).mockImplementation(async (url) => {
      if (new URL(url).pathname === "/docs/getting-started") {
        // As the guard says it (its own test checks it does).
        throw Object.assign(new Error("127.0.0.1 can't be found"), { code: guard.HOST_NOT_FOUND });
      }
      return real.checkWebhookUrl(url);
    });
    const connection = websiteSource.connect(site.url, { deadline: Date.now() + 60_000 });
    await expect(connection.read.find!()).rejects.toThrow("Tuti couldn't reach 127.0.0.1.");
  } finally {
    vi.mocked(guard.checkWebhookUrl).mockImplementation((await vi.importActual<typeof guard>("@tuti/shared/webhook-url")).checkWebhookUrl);
    await site.close();
  }
});

test("the start page's name not found during an import's step is unreachable (tried again), not a mistake in the address", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  crawlPace.ms = 0;
  const site = await startHelpCenterFake();
  const real = await vi.importActual<typeof guard>("@tuti/shared/webhook-url");
  try {
    vi.mocked(guard.checkWebhookUrl).mockImplementation(async (url) => {
      if (new URL(url).pathname === "/docs") {
        throw Object.assign(new Error("127.0.0.1 can't be found"), { code: guard.HOST_NOT_FOUND });
      }
      return real.checkWebhookUrl(url);
    });
    const step = websiteSource.connect(site.url, { deadline: Date.now() + 60_000 });
    await expect(step.read.find!()).rejects.toMatchObject({ status: 0, message: "Tuti couldn't reach 127.0.0.1." });
    // Entered so, it's a mistake in the address.
    const check = websiteSource.connect(site.url, { deadline: Date.now() + 60_000 });
    await expect(check.checkCredential()).rejects.toMatchObject({ status: 404, message: "Tuti couldn't find 127.0.0.1. Check the address." });
  } finally {
    vi.mocked(guard.checkWebhookUrl).mockImplementation(real.checkWebhookUrl);
    await site.close();
  }
});

test("entered, an address that redirects to a host that doesn't exist says so, naming that host, not the address", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  crawlPace.ms = 0;
  const site = await startHelpCenterFake();
  const real = await vi.importActual<typeof guard>("@tuti/shared/webhook-url");
  try {
    vi.mocked(guard.checkWebhookUrl).mockImplementation(async (url) => {
      if (new URL(url).hostname === "localhost") {
        throw Object.assign(new Error("localhost can't be found"), { code: guard.HOST_NOT_FOUND });
      }
      return real.checkWebhookUrl(url);
    });
    // The start page redirects (to any host it may), to one that "doesn't exist".
    site.redirectStartTo = `http://localhost:${new URL(site.origin).port}/docs`;
    const check = websiteSource.connect(site.url, { deadline: Date.now() + 60_000 });
    await expect(check.checkCredential()).rejects.toMatchObject({ status: 404, message: "127.0.0.1 sends visitors to localhost, which can't be found." });
  } finally {
    vi.mocked(guard.checkWebhookUrl).mockImplementation(real.checkWebhookUrl);
    await site.close();
  }
});

// A backtracking regex on each of these hostile inputs wouldn't end within the test's time limit.
test("a robots.txt line padded with a long run of spaces is read at once", () => {
  const rules = robotsRules(`User-agent: *\nDisallow: /x${" ".repeat(200_000)}x\nDisallow: /private # closed\nCrawl-delay : 1`);
  expect(rules.allowed("/private/a")).toBe(false);
  expect(rules.allowed("/x")).toBe(true);
  expect(rules.delayMs).toBe(1000);
});

test("a sitemap's addresses: CDATA, spaces and &amp; handled, and a hostile one without its closing tag read at once", () => {
  expect(sitemapLocs("<urlset><url><LOC> https://a.test/x?a=1&amp;b=2 </LOC></url><url><loc><![CDATA[ https://a.test/y ]]></loc></url><url><loc>not an address</loc></url></urlset>")).toEqual([
    "https://a.test/x?a=1&b=2",
    "https://a.test/y",
  ]);
  expect(sitemapLocs(`<loc>${" ".repeat(200_000)}x`.repeat(5))).toEqual([]);
});

test("a page's title, and a hostile page of unclosed title tags read at once", () => {
  expect(pageTitle('<html><head><TITLE lang="en"> Acme Help </TITLE></head></html>')).toBe("Acme Help");
  expect(pageTitle("<title".repeat(100_000))).toBe("");
});

test("trailing slashes trimmed, and a long run of slashes inside a path read at once", () => {
  expect(withoutTrailingSlashes("/docs///")).toBe("/docs");
  expect(pageId(`https://a.test/${"/".repeat(200_000)}a`)).toBe(`https://a.test/${"/".repeat(200_000)}a`);
});

test("an address segment with a malformed escape is titled as it is", () => {
  expect(fromSlug("100%-uptime")).toBe("100% uptime");
  expect(fromSlug("getting-started")).toBe("Getting started");
});

test("robots.txt's groups: every one naming Tuti exactly, merged; else every * group, merged", () => {
  const stars = robotsRules("User-agent: *\nDisallow: /admin\n\nUser-agent: *\nDisallow: /docs/internal\nCrawl-delay: 3");
  expect(stars.allowed("/admin/x")).toBe(false);
  expect(stars.allowed("/docs/internal/x")).toBe(false);
  expect(stars.allowed("/docs/public")).toBe(true);
  expect(stars.delayMs).toBe(3000);

  // A token that's only part of Tuti's ("t", "import", empty) isn't Tuti's group.
  const partial = robotsRules("User-agent: import\nUser-agent: t\nAllow: /\n\nUser-agent: *\nDisallow: /docs/internal");
  expect(partial.allowed("/docs/internal/x")).toBe(false);

  const named = robotsRules("User-agent: Tuti-Import\nDisallow: /a\n\nUser-agent: *\nDisallow: /\n\nUser-agent: tuti-import\nDisallow: /b");
  expect(named.allowed("/a")).toBe(false);
  expect(named.allowed("/b")).toBe(false);
  expect(named.allowed("/c")).toBe(true);
});

test("text whose lowercase is longer (a Turkish İ) doesn't shift where a title or an address is cut", () => {
  expect(pageTitle("<head><title>İstanbul İçin Yardım</title></head>")).toBe("İstanbul İçin Yardım");
  expect(sitemapLocs("<urlset><!-- İİ --><url><image:title>İzmir</image:title><loc>https://acme.test/docs/x</loc></url></urlset>")).toEqual(["https://acme.test/docs/x"]);
});
