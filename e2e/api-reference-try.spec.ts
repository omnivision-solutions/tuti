import { randomUUID } from "node:crypto";

import { type ApiFake, startApiFake } from "@tuti/testkit";

import type { Locator } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

/** Two local APIs: one that lets browsers call it (CORS), one that doesn't, which Tuti calls instead. */
let open: ApiFake;
let closed: ApiFake;
test.beforeAll(async () => {
  [open, closed] = await Promise.all([startApiFake({ cors: true }), startApiFake({ cors: false })]);
});
test.afterAll(async () => {
  await Promise.all([open.close(), closed.close()]);
});

/** `site`: the portal's own origin, where a server of the spec's is too (an API on the same site as its help center). */
const spec = (site = "https://site.example") => `
openapi: 3.1.0
info: { title: Acme API, version: "1" }
servers:
  - { url: "${open.origin}/v1", description: Production }
  - { url: "${closed.origin}/v1", description: Legacy }
  - { url: "https://api.unverified.example/v1", description: Elsewhere }
  - { url: "${site}/fake/v1", description: Same site }
components:
  securitySchemes:
    key: { type: http, scheme: bearer }
    session: { type: apiKey, in: cookie, name: session }
    query: { type: apiKey, in: query, name: api_key }
security: [{ key: [] }]
paths:
  /posts:
    post:
      tags: [Posts]
      summary: Create a post
      parameters:
        - { name: board, in: query, schema: { type: string }, example: ideas }
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, properties: { title: { type: string } } }
            example: { title: Dark mode for the editor }
      responses: { "201": { description: The new post } }
  /posts/{id}:
    get:
      tags: [Posts]
      summary: Get a post
      parameters: [{ name: id, in: path, required: true, schema: { type: integer }, example: 7 }]
      responses: { "201": { description: The post } }
  /posts/{id}/archive:
    post:
      tags: [Posts]
      summary: Archive a post
      security: [{ query: [] }]
      parameters: [{ name: id, in: path, required: true, schema: { type: integer }, example: 7 }]
      responses: { "201": { description: Archived } }
  /stall:
    get:
      tags: [Posts]
      summary: Wait forever
      responses: { "201": { description: Never } }
  /large:
    get:
      tags: [Posts]
      summary: A large answer
      parameters: [{ name: size, in: query, schema: { type: integer }, example: 2500000 }]
      responses: { "201": { description: Text } }
  /ping:
    get:
      tags: [Posts]
      summary: Ping
      security: []
      responses: { "201": { description: Pong } }
  /me:
    get:
      tags: [Posts]
      summary: Who am I
      security: [{ session: [] }]
      responses: { "201": { description: You } }
`;

/** Picks a server in the console's menu (the shared Select: its options open outside the dialog). */
async function pickServer(panel: Locator, label: string) {
  await panel.getByRole("combobox", { name: "Server" }).click();
  await panel.page().getByRole("option", { name: label }).click();
}

test("a reader tries an operation with their key: from the browser, and through Tuti when the API doesn't allow browsers", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/api-references", { name: "Reference", spec: spec(portalUrl(slug)) });

  // Not newPerson: the headers it adds to every request (Playwright's extraHTTPHeaders) make the browser ask the API
  // first about every request, as a reader's browser wouldn't for a plain POST.
  const reader = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto("/docs/reference/create-a-post");
  await reader.getByRole("button", { name: "Try it" }).click();
  const panel = reader.getByRole("dialog", { name: "Try it" });
  // Prefilled from the examples: the query parameter and the body.
  await expect(panel.getByLabel("board")).toHaveValue("ideas");
  await expect(panel.getByRole("textbox", { name: "Body" })).toHaveValue(/"title": "Dark mode for the editor"/);
  await expect(panel.getByText("Kept in this tab only.")).toBeVisible();
  await panel.getByLabel("Bearer token").fill("sk_test_123");
  // A cookie the browser holds for the API's site: the request carries none of the reader's own.
  await reader.context().addCookies([{ name: "reader", value: "theirs", url: open.origin }]);
  await panel.getByRole("button", { name: "Send", exact: true }).click();

  const response = panel.getByRole("region", { name: "Response" });
  await expect(response.getByText("201 Created")).toBeVisible();
  await expect(response.getByText('"path": "/v1/posts"')).toBeVisible();
  await expect(response.getByText(/Sent through Tuti/)).toHaveCount(0);
  // Straight from the browser, with the key.
  expect(open.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/posts", query: "?board=ideas", headers: { authorization: "Bearer sk_test_123" } });
  // Nothing of the reader's: no cookie, and no referrer (the page they're on).
  expect(open.requests.at(-1)!.headers.cookie).toBeUndefined();
  expect(open.requests.at(-1)!.headers.referer).toBeUndefined();
  await checkpoint(reader, "console-desktop", { fullPage: false });

  // An API on the portal's own site: a browser would send the reader's cookies for it (their session there), but the
  // console sends none. (Routed here: the portal has no such API.)
  await reader.context().addCookies([{ name: "session", value: "theirs", url: portalUrl(slug) }]);
  let sameSiteCookie: string | null | undefined;
  await reader.route(`${portalUrl(slug)}/fake/**`, async (route) => {
    sameSiteCookie = await route.request().headerValue("cookie");
    await route.fulfill({ status: 201, json: { ok: true } });
  });
  await pickServer(panel, `Same site (${portalUrl(slug)}/fake/v1)`);
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(response.getByText("201 Created")).toBeVisible();
  expect(sameSiteCookie).toBeNull();
  // Off again: while any route is on, Playwright handles the browser's preflights itself, which later steps rely on.
  await reader.unroute(`${portalUrl(slug)}/fake/**`);

  // An API that doesn't let browsers call it. A POST isn't sent again by itself (the API may have run it): the reader
  // sends it through Tuti, which says so.
  await pickServer(panel, `Legacy (${closed.origin}/v1)`);
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(response.getByText(/It may have run the request/)).toBeVisible();
  // (This one the browser asked about first, and was refused: it never went.)
  expect(closed.requests).toHaveLength(0);
  await response.getByRole("button", { name: "Send through Tuti" }).click();
  await expect(response.getByText("Sent through Tuti, since the API doesn't allow browser requests.")).toBeVisible();
  // The button went with the answer it was in: the keyboard is on Send.
  await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeFocused();
  await expect(response.getByText("201 Created")).toBeVisible();
  expect(closed.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/posts", headers: { authorization: "Bearer sk_test_123", "user-agent": "Tuti-Try-It/1" } });
  // None of the reader's own cookies went on.
  expect(closed.requests.at(-1)!.headers.cookie).toBeUndefined();
  expect(closed.requests).toHaveLength(1);
  await checkpoint(reader, "console-through-tuti", { fullPage: false });

  // Copy as cURL: the request as filled in.
  await reader.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel.getByRole("button", { name: "Copy as cURL" }).click();
  await expect.poll(() => reader.evaluate(() => navigator.clipboard.readText())).toContain(`curl '${closed.origin}/v1/posts?board=ideas'`);
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toContain("Authorization: Bearer sk_test_123");
  await expect(reader.getByText("Copied", { exact: true })).toBeVisible();
  // Where there's no clipboard (a portal over plain http): it says so, rather than nothing.
  await reader.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await panel.getByRole("button", { name: "Copy as cURL" }).click();
  await expect(reader.getByText("Couldn't copy it. Your browser may not allow it here.")).toBeVisible();

  // Closed and opened again: the key, what was typed and the last answer are still there.
  await panel.getByRole("textbox", { name: "Body" }).fill('{"title": "Edited"}');
  await reader.keyboard.press("Escape");
  await reader.getByRole("button", { name: "Try it" }).click();
  await expect(panel.getByLabel("Bearer token")).toHaveValue("sk_test_123");
  await expect(panel.getByRole("textbox", { name: "Body" })).toHaveValue('{"title": "Edited"}');
  await expect(response.getByText("201 Created")).toBeVisible();

  // Another operation, by the tree: its own console, with its own example and servers, not the last one's.
  await reader.keyboard.press("Escape");
  await reader.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Get a post GET", exact: true }).click();
  await expect(reader.getByRole("heading", { name: "Get a post", level: 1 })).toBeVisible();
  await reader.getByRole("button", { name: "Try it" }).click();
  await expect(panel.getByLabel("id")).toHaveValue("7");
  await expect(panel.getByLabel("board")).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "Body" })).toHaveCount(0);
  await expect(panel.getByRole("combobox", { name: "Server" })).toHaveText(/^Production/);
  await expect(panel.getByRole("region", { name: "Response" })).toHaveCount(0);

  // A request the browser sends without asking the API first (a POST with its key in the query, no body) reached the
  // API though its answer can't be read: it isn't sent again unless the reader asks.
  await reader.keyboard.press("Escape");
  await reader.goto("/docs/reference/archive-a-post");
  await reader.getByRole("button", { name: "Try it" }).click();
  const archive = reader.getByRole("dialog", { name: "Try it" });
  await archive.getByLabel("API key (api_key query parameter)").fill("sk_query_1");
  // Hidden in the address shown.
  await expect(archive.getByText(/\/v1\/posts\/7\/archive\?api_key=\*\*\*\*$/)).toBeVisible();
  await pickServer(archive, `Legacy (${closed.origin}/v1)`);
  const before = closed.requests.length;
  await archive.getByRole("button", { name: "Send", exact: true }).click();
  await expect(archive.getByRole("region", { name: "Response" }).getByText(/It may have run the request/)).toBeVisible();
  expect(closed.requests.length).toBe(before + 1);
  await archive.getByRole("button", { name: "Send through Tuti" }).click();
  await expect(archive.getByRole("region", { name: "Response" }).getByText("201 Created")).toBeVisible();
  expect(closed.requests.length).toBe(before + 2);
  expect(closed.requests.at(-1)).toMatchObject({ path: "/v1/posts/7/archive", query: "?api_key=sk_query_1" });

  // A GET only reads: refused, it goes through Tuti by itself.
  await reader.keyboard.press("Escape");
  await reader.goto("/docs/reference/get-a-post");
  await reader.getByRole("button", { name: "Try it" }).click();
  const get = reader.getByRole("dialog", { name: "Try it" });
  await pickServer(get, `Legacy (${closed.origin}/v1)`);
  await get.getByRole("button", { name: "Send", exact: true }).click();
  await expect(get.getByRole("region", { name: "Response" }).getByText("Sent through Tuti, since the API doesn't allow browser requests.")).toBeVisible();
  expect(closed.requests.at(-1)).toMatchObject({ method: "GET", path: "/v1/posts/7", headers: { authorization: "Bearer sk_test_123" } });
  // A server off the help center's sites: Tuti refuses it, and says why; nothing says it was sent.
  // Offline: the browser's request to it fails as an unknown host's would, without looking it up.
  await reader.route("https://api.unverified.example/**", (route) => route.abort("namenotresolved"));
  await pickServer(get, "Elsewhere (https://api.unverified.example/v1)");
  await get.getByRole("button", { name: "Send", exact: true }).click();
  const refused = get.getByRole("region", { name: "Response" });
  await expect(refused.getByText("Tuti sends requests only to this help center's own sites, and api.unverified.example isn't one")).toBeVisible();
  await expect(refused.getByText(/Sent through Tuti/)).toHaveCount(0);

  // A key in a cookie goes through Tuti from the start: a browser sends no cookie it's given to another site.
  await reader.keyboard.press("Escape");
  await reader.goto("/docs/reference/who-am-i");
  await reader.getByRole("button", { name: "Try it" }).click();
  const me = reader.getByRole("dialog", { name: "Try it" });
  await me.getByLabel("API key (session cookie)").fill("abc");
  // Something in front of Tuti answering with a page of its own (a 502): its status, not "couldn't reach".
  await reader.route("**/docs/reference/who-am-i/try", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }));
  await me.getByRole("button", { name: "Send", exact: true }).click();
  await expect(me.getByRole("region", { name: "Response" }).getByText(/^Tuti couldn't send it: it answered 502/)).toBeVisible();
  await reader.unroute("**/docs/reference/who-am-i/try");
  await me.getByRole("button", { name: "Send", exact: true }).click();
  await expect(me.getByRole("region", { name: "Response" }).getByText("Sent through Tuti, since browsers don't send cookies to another site.")).toBeVisible();
  expect(open.requests.at(-1)).toMatchObject({ path: "/v1/me", headers: { cookie: "session=abc" } });

  // An answer over 2 MB: read as it comes, cut at 2 MB, and said so.
  await reader.keyboard.press("Escape");
  await reader.goto("/docs/reference/a-large-answer");
  await reader.getByRole("button", { name: "Try it" }).click();
  const large = reader.getByRole("dialog", { name: "Try it" }).getByRole("region", { name: "Response" });
  await reader.getByRole("dialog", { name: "Try it" }).getByRole("button", { name: "Send", exact: true }).click();
  await expect(large.getByText("Showing the first 2 MB.")).toBeVisible();
  await expect(large.getByText("2.0 MB", { exact: true })).toBeVisible();

  // A request still on its way when the console closes is still on its way when it opens again, and stops at 15
  // seconds (on the page's clock, run forward: no test waits for them).
  await reader.keyboard.press("Escape");
  const t0 = new Date("2026-11-18T12:00:00Z");
  await reader.clock.install({ time: t0 });
  await reader.goto("/docs/reference/wait-forever");
  await reader.getByRole("button", { name: "Try it" }).click();
  const waiting = reader.getByRole("dialog", { name: "Try it" });
  await expect(waiting.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  // Paused: only runFor moves it, however long the steps take. The sheet's closing and opening wait on the page's
  // timers, so each gets half a second of it, counted in the 15.
  await reader.clock.pauseAt(new Date(t0.getTime() + 60 * 60_000));
  await waiting.getByRole("button", { name: "Send", exact: true }).click();
  await expect(waiting.getByRole("button", { name: "Sending…" })).toBeDisabled();
  await reader.keyboard.press("Escape");
  await reader.clock.runFor(500);
  await expect(waiting).toHaveCount(0);
  await reader.getByRole("button", { name: "Try it" }).click();
  await reader.clock.runFor(500);
  await expect(waiting.getByRole("button", { name: "Sending…" })).toBeDisabled();
  await reader.clock.runFor(13_000);
  await expect(waiting.getByRole("button", { name: "Sending…" })).toBeDisabled();
  await reader.clock.runFor(1_000);
  await expect(waiting.getByRole("region", { name: "Response" }).getByText("The API didn't answer within 15 seconds")).toBeVisible();
  await expect(waiting.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

  // Through Tuti, the request has a clock of its own from when it starts: Tuti gives the API its 15 seconds.
  await reader.clock.resume();
  await reader.goto("/docs/reference/get-a-post");
  await reader.getByRole("button", { name: "Try it" }).click();
  const slow = reader.getByRole("dialog", { name: "Try it" });
  await pickServer(slow, `Legacy (${closed.origin}/v1)`);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const atTuti = new Promise<void>((resolve) => (reached = resolve));
  await reader.route("**/docs/reference/get-a-post/try", async (route) => {
    reached();
    await held;
    await route.fulfill({ json: { status: 200, statusText: "OK", headers: [], body: "{}", size: 2, cut: false, ms: 16_000 } });
  });
  // Paused again (an hour on, before anything is sent): only runFor moves it from here.
  await reader.clock.pauseAt(new Date(t0.getTime() + 2 * 60 * 60_000));
  await slow.getByRole("button", { name: "Send", exact: true }).click();
  // Once the browser's own attempt has been refused and the request is on its way through Tuti: the clock moves then.
  await atTuti;
  await reader.clock.runFor(16_000);
  await expect(slow.getByRole("button", { name: "Sending…" })).toBeDisabled();
  release();
  await expect(slow.getByRole("region", { name: "Response" }).getByText("200 OK")).toBeVisible();
  await reader.unroute("**/docs/reference/get-a-post/try");
  await reader.clock.resume();

  // Leaving an operation stops what its console was sending: a request the API never answers, held, isn't sent
  // through Tuti when it fails after the reader has moved on.
  await reader.goto("/docs/reference/ping");
  let releasePing!: () => void;
  const pingHeld = new Promise<void>((resolve) => (releasePing = resolve));
  let pingReached!: () => void;
  const atPing = new Promise<void>((resolve) => (pingReached = resolve));
  let pingStopped = false;
  const tries: string[] = [];
  reader.on("request", (request) => request.url().endsWith("/try") && tries.push(request.url()));
  reader.on("requestfailed", (request) => request.url().endsWith("/v1/ping") && (pingStopped = true));
  await reader.route(`${open.origin}/v1/ping`, async (route) => {
    pingReached();
    await pingHeld;
    await route.abort("failed").catch(() => {});
  });
  await reader.getByRole("button", { name: "Try it" }).click();
  await reader.getByRole("dialog", { name: "Try it" }).getByRole("button", { name: "Send", exact: true }).click();
  await atPing;
  await reader.keyboard.press("Escape");
  await reader.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Get a post GET", exact: true }).click();
  await expect(reader.getByRole("heading", { name: "Get a post", level: 1 })).toBeVisible();
  // The page let it go as it left: the browser cancelled it.
  await expect.poll(() => pingStopped).toBe(true);
  releasePing();
  expect(tries).toEqual([]);

  // On a phone, a sheet from the bottom that fits the width.
  await reader.goto("/docs/reference/create-a-post");
  await reader.getByRole("button", { name: "Try it" }).click();
  await reader.setViewportSize({ width: 390, height: 844 });
  await expect(reader.getByRole("dialog", { name: "Try it" })).toBeVisible();
  expect(await reader.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(reader, "console-phone", { fullPage: false });
});

test("no Try it where there's nowhere to send a request", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Servers without a host, and no base address set.
  await api("/api-references", { name: "Reference", spec: spec().replace(/url: "[^"]+"/g, 'url: "/v1"') });
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/docs/reference/create-a-post");
  await expect(reader.getByRole("heading", { name: "Create a post", level: 1 })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Try it" })).toHaveCount(0);
});
