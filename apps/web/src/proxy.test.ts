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
