import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { proxy } from "./proxy";

// Offline: every portal is public here (private portals: proxy.db.test.ts).
vi.mock("@/server/portal-access", () => ({ portalVisitor: async () => "public", previewTokenFor: async () => false, PREVIEW_READER_COOKIE: "tuti_preview_reader" }));
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

test("“Preview as a reader”: only a portal page's own ?preview=signed-out asks for it, never a header the request sends", async () => {
  const preview = async (path: string, headers: Record<string, string> = {}) =>
    (await proxy(new NextRequest(`http://acme.tuti.example${path}`, { headers: { host: "acme.tuti.example", ...headers } }))).headers.get(
      "x-middleware-request-x-tuti-preview",
    );
  expect(await preview("/docs/billing?preview=signed-out")).toBe("signed-out");
  expect(await preview("/docs/billing")).toBe("");
  expect(await preview("/docs/billing?preview=yes", { "x-tuti-preview": "signed-out" })).toBe("");
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
  for (const path of ["/", "/docs/api", "/sign-in", "/app/acme", "/helpx", "/feedback/ideas", "/widget"]) {
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
