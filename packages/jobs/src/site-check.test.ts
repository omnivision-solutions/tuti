import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { fetchSiteCheck } from "./site-check";

// A site answering 2 KB, on 127.0.0.1 (private addresses allowed, as tests do).
const body = "x".repeat(2048);
const server = createServer((_, response) => response.end(body));
let url = "";
beforeAll(async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("the first kilobyte by default, or as much as the caller asks for", async () => {
  expect(await fetchSiteCheck(url)).toBe(body.slice(0, 1024));
  expect(await fetchSiteCheck(url, 16_384)).toBe(body);
});
