import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { proxy } from "./proxy";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_URL", "https://tuti.example");
  vi.stubEnv("PORTAL_URL_TEMPLATE", "https://{project}.tuti.example");
});
afterEach(() => vi.unstubAllEnvs());

const request = (host: string, path: string) =>
  new NextRequest(`http://${host}${path}`, { headers: { host } });

test("health checks pass on any host, e.g. from inside the container", () => {
  expect(proxy(request("localhost:3000", "/api/health")).status).toBe(200);
});

test("other paths on unknown hosts are still 404", () => {
  expect(proxy(request("localhost:3000", "/")).status).toBe(404);
  expect(proxy(request("localhost:3000", "/api/auth/get-session")).status).toBe(404);
});

test("other sites may frame a portal's /widget, and no other page", () => {
  const framing = (host: string, path: string) => proxy(request(host, path)).headers.get("content-security-policy");
  expect(framing("acme.tuti.example", "/widget")).toBeNull();
  expect(framing("acme.tuti.example", "/b/ideas")).toBe("frame-ancestors 'none'");
  expect(framing("acme.tuti.example", "/sign-in")).toBe("frame-ancestors 'none'");
  expect(framing("tuti.example", "/widget")).toBe("frame-ancestors 'none'");
  expect(framing("tuti.example", "/app/acme")).toBe("frame-ancestors 'none'");
});

test("an article's .md URL is served by its Markdown route", () => {
  const rewrite = (path: string) => proxy(request("acme.tuti.example", path)).headers.get("x-middleware-rewrite");
  expect(rewrite("/help/inviting-your-team.md")).toBe("http://acme.tuti.example/portal/acme/help/inviting-your-team/md");
  expect(rewrite("/help/inviting-your-team")).toBe("http://acme.tuti.example/portal/acme/help/inviting-your-team");
  expect(rewrite("/llms.txt")).toBe("http://acme.tuti.example/portal/acme/llms.txt");
});
