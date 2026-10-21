import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { proxy } from "./proxy";

// Offline: every portal is public here (private portals: proxy.db.test.ts).
vi.mock("@/server/portal-access", () => ({ portalVisitor: async () => "public" }));
// No portal is under a path of a site here (that's site-mount.db.test.ts).
vi.mock("@/server/custom-domains", async (original) => ({ ...(await original<typeof import("@/server/custom-domains")>()), siteMount: async () => null }));

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

test("other sites may frame a portal's /widget, and no other page", async () => {
  const framing = async (host: string, path: string) => (await proxy(request(host, path))).headers.get("content-security-policy");
  expect(await framing("acme.tuti.example", "/widget")).toBeNull();
  expect(await framing("acme.tuti.example", "/feedback/ideas")).toBe("frame-ancestors 'none'");
  expect(await framing("acme.tuti.example", "/sign-in")).toBe("frame-ancestors 'none'");
  expect(await framing("tuti.example", "/widget")).toBe("frame-ancestors 'none'");
  expect(await framing("tuti.example", "/app/acme")).toBe("frame-ancestors 'none'");
});

test("an article's .md URL is served by its Markdown route", async () => {
  const rewrite = async (path: string) => (await proxy(request("acme.tuti.example", path))).headers.get("x-middleware-rewrite");
  expect(await rewrite("/docs/inviting-your-team.md")).toBe("http://acme.tuti.example/portal/acme/docs/inviting-your-team/md");
  expect(await rewrite("/docs/inviting-your-team")).toBe("http://acme.tuti.example/portal/acme/docs/inviting-your-team");
  expect(await rewrite("/llms.txt")).toBe("http://acme.tuti.example/portal/acme/llms.txt");
});

test("Tuti's own portal on the app's domain: its parts' paths, not the app's own pages or the API reference", async () => {
  const rewrite = async (path: string) => (await proxy(request("tuti.example", path))).headers.get("x-middleware-rewrite");
  // Off unless a project is named.
  expect(await rewrite("/docs/getting-started")).toBeNull();
  vi.stubEnv("APP_PORTAL_PROJECT", "acme");
  expect(await rewrite("/docs/getting-started")).toBe("http://tuti.example/portal/acme/docs/getting-started");
  expect(await rewrite("/docs/getting-started.md")).toBe("http://tuti.example/portal/acme/docs/getting-started/md");
  expect(await rewrite("/docs")).toBe("http://tuti.example/portal/acme/docs");
  expect(await rewrite("/feedback/ideas")).toBe("http://tuti.example/portal/acme/feedback/ideas");
  expect(await rewrite("/roadmap")).toBe("http://tuti.example/portal/acme/roadmap");
  expect(await rewrite("/changelog/rss.xml")).toBe("http://tuti.example/portal/acme/changelog/rss.xml");
  expect(await rewrite("/llms.txt")).toBe("http://tuti.example/portal/acme/llms.txt");
  for (const path of ["/", "/docs/api", "/sign-in", "/app/acme", "/feedbackx", "/widget", "/sso", "/account"]) {
    expect(await rewrite(path)).toBeNull();
  }
});
