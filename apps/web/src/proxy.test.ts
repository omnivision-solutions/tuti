import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { proxy } from "./proxy";

// Offline: every portal is public here (private portals: proxy.db.test.ts).
vi.mock("@/server/portal-redirects", () => ({ redirectFor: async () => null }));
vi.mock("@/server/portal-access", () => ({ portalVisitor: async () => "public", previewTokenFor: async () => false, PREVIEW_READER_COOKIE: "tuti_preview_reader" }));
// /docs/billing is an article's page; any other /docs/<slug>, a tab's or collection's (see findable.db.test.ts).
vi.mock("@/server/docs-queries", () => ({ isArticleSlug: async (_project: string, slug: string) => slug === "billing" }));
// Nobody's signed in either (loading sessions loads the auth config, which needs a server's settings).
vi.mock("@/server/session", () => ({}));
// No portal is under a path of a site, or has an address of its own, here (see site-mount.db.test.ts).
vi.mock("@/server/custom-domains", async (original) => {
  const { portalUrl } = await import("@/lib/hosts");
  return { ...(await original<typeof import("@/server/custom-domains")>()), siteMount: async () => null, portalAddress: async (slug: string) => portalUrl(slug) };
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_URL", "https://tuti.example");
  vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.tuti.example");
});
afterEach(() => vi.unstubAllEnvs());

const request = (host: string, path: string) =>
  new NextRequest(`http://${host}${path}`, { headers: { host } });

test("health checks pass on any host, e.g. from inside the container", async () => {
  expect((await proxy(request("localhost:3000", "/api/health"))).status).toBe(200);
});

test("other paths on unknown hosts are still 404", async () => {
  expect((await proxy(request("localhost:3000", "/"))).status).toBe(404);
  expect((await proxy(request("localhost:3000", "/api/auth/get-session"))).status).toBe(404);
});

test("the API reference is the app's own page: a portal's /api/docs is the portal's (its not-found page), not Tuti's", async () => {
  expect((await proxy(request("acme.tuti.example", "/api/docs"))).headers.get("x-middleware-rewrite")).toBe("http://acme.tuti.example/portal/acme/api/docs");
  expect((await proxy(request("acme.tuti.example", "/api/v1/posts"))).headers.get("x-middleware-rewrite")).toBeNull();
});

test("other sites may frame a portal's /widget, the app its other pages (Customize's preview), and nobody the app", async () => {
  const framing = async (host: string, path: string) => (await proxy(request(host, path))).headers.get("content-security-policy");
  expect(await framing("acme.tuti.example", "/widget")).toBeNull();
  expect(await framing("acme.tuti.example", "/feedback/ideas")).toBe("frame-ancestors https://tuti.example");
  expect(await framing("acme.tuti.example", "/sign-in")).toBe("frame-ancestors https://tuti.example");
  expect((await proxy(request("acme.tuti.example", "/feedback/ideas"))).headers.get("x-frame-options")).toBeNull();
  expect(await framing("tuti.example", "/widget")).toBe("frame-ancestors 'none'");
  expect(await framing("tuti.example", "/app/acme")).toBe("frame-ancestors 'none'");
});

test("an article's .md URL is served by its Markdown route", async () => {
  const rewrite = async (path: string) => (await proxy(request("acme.tuti.example", path))).headers.get("x-middleware-rewrite");
  expect(await rewrite("/docs/inviting-your-team.md")).toBe("http://acme.tuti.example/portal/acme/docs/inviting-your-team/md");
  expect(await rewrite("/docs/inviting-your-team")).toBe("http://acme.tuti.example/portal/acme/docs/inviting-your-team");
  expect(await rewrite("/llms.txt")).toBe("http://acme.tuti.example/portal/acme/llms.txt");
});

test("a post's .md URL, or its page asked for as Markdown, is served by its Markdown route; browsers get the page", async () => {
  const served = async (accept: string | null, path: string) => {
    const response = await proxy(new NextRequest(`http://acme.tuti.example${path}`, { headers: { host: "acme.tuti.example", ...(accept && { accept }) } }));
    return [response.headers.get("x-middleware-rewrite")?.replace("http://acme.tuti.example/portal/acme", ""), response.headers.get("vary")];
  };
  expect(await served(null, "/feedback/ideas/dark-mode-1.md")).toEqual(["/feedback/ideas/dark-mode-1/md", null]);
  expect(await served("text/markdown", "/feedback/ideas/dark-mode-1")).toEqual(["/feedback/ideas/dark-mode-1/md", "Accept"]);
  const browser = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  expect(await served(browser, "/feedback/ideas/dark-mode-1")).toEqual(["/feedback/ideas/dark-mode-1", "Accept"]);
  // A board's page has no Markdown.
  expect(await served("text/markdown", "/feedback/ideas")).toEqual(["/feedback/ideas", null]);
});

test("an article's page asked for as Markdown (an AI agent's Accept header) is served by its Markdown route; browsers get the page", async () => {
  const served = async (accept: string | null, path = "/docs/billing", method = "GET") => {
    const response = await proxy(new NextRequest(`http://acme.tuti.example${path}`, { method, headers: { host: "acme.tuti.example", ...(accept && { accept }) } }));
    return [response.headers.get("x-middleware-rewrite")?.replace("http://acme.tuti.example/portal/acme", ""), response.headers.get("vary")];
  };
  for (const accept of ["text/markdown", "text/markdown, text/html", "text/html;q=0.5, text/markdown", "text/markdown;q=0.9, */*;q=0.8", "TEXT/Markdown"]) {
    expect(await served(accept)).toEqual(["/docs/billing/md", "Accept"]);
  }
  const browser = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  for (const accept of [browser, "*/*", null, "text/html, text/markdown;q=0.9", "text/markdown;q=0", "text/*, text/markdown;q=0.5"]) {
    expect(await served(accept)).toEqual(["/docs/billing", "Accept"]);
  }
  // Only an article's page: not a tab's or collection's, /docs, the .md (already Markdown), nor a form posted to the page.
  expect(await served("text/markdown", "/docs/getting-started")).toEqual(["/docs/getting-started", "Accept"]);
  expect(await served("text/markdown", "/docs")).toEqual(["/docs", null]);
  expect(await served("text/markdown", "/docs/billing.md")).toEqual(["/docs/billing/md", null]);
  expect(await served("text/markdown", "/docs/billing", "POST")).toEqual(["/docs/billing", "Accept"]);
});

test("“Preview as a reader”: only a portal page's own ?preview=signed-out asks for it, never a header the request sends", async () => {
  const preview = async (path: string, headers: Record<string, string> = {}) =>
    (await proxy(new NextRequest(`http://acme.tuti.example${path}`, { headers: { host: "acme.tuti.example", ...headers } }))).headers.get(
      "x-middleware-request-x-tuti-preview",
    );
  expect(await preview("/docs/billing?preview=signed-out")).toBe("signed-out");
  expect(await preview("/docs/billing")).toBe("");
  expect(await preview("/docs/billing?preview=yes", { "x-tuti-preview": "signed-out" })).toBe("");
});

test("Customize's preview: a portal page with its param (kept on the links it follows) or framed, never a header the request sends", async () => {
  const customizing = async (path: string, headers: Record<string, string> = {}) =>
    (await proxy(new NextRequest(`http://acme.tuti.example${path}`, { headers: { host: "acme.tuti.example", ...headers } }))).headers.get(
      "x-middleware-request-x-tuti-customize",
    );
  expect(await customizing("/docs?customize=1")).toBe("1");
  expect(await customizing("/docs", { "sec-fetch-dest": "iframe" })).toBe("1");
  expect(await customizing("/docs")).toBe("");
  expect(await customizing("/docs", { "x-tuti-customize": "1" })).toBe("");
});

test("Tuti's own portal under its path on the app's domain (tuti.example/help/…), and nothing else of the app's", async () => {
  const response = (path: string) => proxy(request("tuti.example", path));
  const rewrite = async (path: string) => (await response(path)).headers.get("x-middleware-rewrite");
  // Off unless a project is named.
  expect(await rewrite("/help/docs")).toBeNull();
  vi.stubEnv("APP_PORTAL_PROJECT", "help");
  expect(await rewrite("/help/docs/getting-started")).toBe("http://tuti.example/portal/help/docs/getting-started");
  expect(await rewrite("/help/docs/getting-started.md")).toBe("http://tuti.example/portal/help/docs/getting-started/md");
  expect(await rewrite("/help")).toBe("http://tuti.example/portal/help");
  expect(await rewrite("/help/feedback/ideas")).toBe("http://tuti.example/portal/help/feedback/ideas");
  expect((await response("/help/roadmap")).headers.get("x-middleware-request-x-tuti-base")).toBe("/help");
  // Its sign-in is the app's own auth API, under the path.
  expect(await rewrite("/help/api/auth/get-session")).toBe("http://tuti.example/api/auth/get-session");
  // The API reference is the app's alone: under the mount it's the help center's path, not Tuti's reference.
  expect(await rewrite("/help/api/docs")).toBe("http://tuti.example/portal/help/api/docs");
  for (const path of ["/", "/api/docs", "/app/auth/sign-in", "/app/acme", "/helpx", "/feedback/ideas", "/widget"]) {
    expect(await rewrite(path)).toBeNull();
  }
  // Its slug may be a reserved one: help.tuti.example is its portal.
  expect(await rewrite("/")).toBeNull();
  expect((await proxy(request("help.tuti.example", "/widget"))).headers.get("x-middleware-rewrite")).toBe("http://help.tuti.example/portal/help/widget");
});

test("Next.js's files are served under /_tuti on every host (a team's site forwards that with its portal)", async () => {
  for (const host of ["tuti.example", "acme.tuti.example", "localhost:3000"]) {
    expect((await proxy(request(host, "/_tuti/_next/static/chunks/app.js"))).headers.get("x-middleware-rewrite")).toBe(`http://${host}/_next/static/chunks/app.js`);
  }
});
