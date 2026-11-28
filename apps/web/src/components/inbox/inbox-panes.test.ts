import { expect, test, vi } from "vitest";

// Loading the list loads the app's auth, which reads its addresses: placeholders (unit tests have none).
vi.hoisted(() => {
  process.env.APP_URL = "http://tuti.localhost:3100";
  process.env.PORTAL_URL_TEMPLATE = "http://{project}.localhost:3100";
  process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long";
});

import { MAX_INBOX_PAGES } from "@/server/operations/inbox";

import { inboxPages } from "./inbox-panes";

// inbox.list takes at most MAX_INBOX_PAGES: a longer `?page=` loads that many rather than failing the page.
test("a ?page= is a count of pages, at most as many as inbox.list loads", () => {
  expect([undefined, "x", "0", "1.5", "3"].map(inboxPages)).toEqual([1, 1, 1, 1, 3]);
  expect(inboxPages("100000")).toBe(MAX_INBOX_PAGES);
});
