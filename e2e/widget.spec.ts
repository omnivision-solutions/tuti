import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, type Locator, type Page, type Route, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, postFeedback, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";
import { modelRequests, nextModelReply } from "./model";
import { similar } from "./openai";

/** An HS256 SSO token, as a customer's app signs it (see docs/sso.md). */
function ssoToken(secret: string, claims: Record<string, unknown>) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iat: now, exp: now + 60, jti: randomUUID(), ...claims })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

// A customer's site: /<project> is a page with that project's widget script tag. With the
// project's SSO secret in `ssoSecrets`, its page signs its user in: TutiSettings.identify
// fetches a fresh token from /token/<project>, like a customer's own server would make one.
// `?hide-launcher` adds data-hide-launcher to the script tag, `?display=sidebar` (or inline)
// data-display, and each `?inline=<tab>` an inline mount at that tab (`?inline=`: the default).
const ssoSecrets = new Map<string, string>();

/** Escape closes the panel once it's hydrated, which may be a moment after what it shows is visible. */
async function closeWithEscape(page: Page, panel: Locator) {
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden({ timeout: 1_000 });
  }).toPass();
}

/** The email the customer's app gives for its signed-in user, per project. */
const samEmail = (project: string) => `e2e-sam-${project}@example.com`;
let site: Server;
test.beforeAll(async () => {
  site = createServer((request, response) => {
    const url = new URL(request.url!, "http://site");
    const path = url.pathname.slice(1);
    const word = (value: string) => value.replace(/[^a-z-]/g, "");
    const display = url.searchParams.get("display");
    const scriptAttributes = (url.searchParams.has("hide-launcher") ? " data-hide-launcher" : "") + (display ? ` data-display="${word(display)}"` : "");
    const inline = url.searchParams
      .getAll("inline")
      .map((tab) => `<div data-tuti-inline="${word(tab)}" style="max-width: 480px"></div>`)
      .join("");
    if (path.startsWith("token/")) {
      response.setHeader("content-type", "text/plain");
      const project = path.slice("token/".length);
      response.end(ssoToken(ssoSecrets.get(project)!, { sub: "app-user-7", name: "Sam from Acme", email: samEmail(project) }));
      return;
    }
    const identify = ssoSecrets.has(path)
      ? `<script>window.TutiSettings = { identify: () => fetch("/token/${path}").then((r) => r.text()) };</script>`
      : "";
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>Customer site</title><h1>Customer site</h1>${inline}${identify}
      <script src="${APP_URL}/widget.js" data-project="${path}"${scriptAttributes} async></script>`);
  });
  await new Promise<void>((resolve) => site.listen(0, resolve));
});
test.afterAll(() => site.close());
const sitePage = (host: string, slug: string) => `http://${host}:${(site.address() as AddressInfo).port}/${slug}`;

test("a customer's site shows the widget: feedback and what's new", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // The team publishes a changelog entry with an API key.
  await owner.goto(`/app/${slug}/settings/developers`);
  await owner.getByRole("textbox", { name: "Key name" }).fill("Widget test");
  await owner.getByRole("combobox", { name: "What the key can do" }).click();
  await owner.getByRole("option", { name: "Read and write" }).click();
  await owner.getByRole("button", { name: "Create key" }).click();
  const shown = owner.getByRole("alert").filter({ hasText: "Copy the key for Widget test now" });
  const key = (await shown.locator("code").first().innerText()).trim();
  const api = (path: string, body: object) =>
    fetch(`${APP_URL}/api/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await api("/changelog", { title: "Dark mode is here", body: "Switch themes from your profile menu.", tags: ["new"] })).ok).toBe(true);
  expect((await api("/changelog/1/publish", {})).ok).toBe(true);
  // Ten quiet entries after it: the announcement still shows in What's new (it's what the dot is about).
  for (let n = 2; n <= 11; n++) {
    expect((await api("/changelog", { title: `Quiet fix ${n}`, body: "Small things." })).ok).toBe(true);
    expect((await api(`/changelog/${n}/publish`, { announce: false })).ok).toBe(true);
  }

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");

  // On another site the portal's cookies aren't sent, so the widget asks to sign in (in a new tab).
  await ada.goto(sitePage("customer.localhost", slug));
  const launcher = ada.getByRole("button", { name: "Feedback" });
  // The entry was announced, and this browser hasn't seen it: the button says so.
  await expect(launcher).toHaveAccessibleName("Feedback, new updates");
  await checkpoint(ada, "widget-new-updates");
  await launcher.click();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  const widget = ada.frameLocator('iframe[title="Feedback"]');
  // It opens at Home: a way into each part.
  await expect(widget.getByText("How can we help?")).toBeVisible();
  // The tabs at the bottom (no Messages or Docs: the inbox is off and there are no articles), then the badge.
  await expect(widget.getByRole("navigation", { name: "Widget" }).getByRole("link")).toHaveText(["Home", "Feedback", "What's new"]);
  await expect(widget.getByRole("link", { name: /Powered by/ })).toHaveAttribute("href", "https://tuti.so");
  await expect(widget.getByRole("link", { name: /Latest update/ })).toContainText("Quiet fix 11");
  await checkpoint(ada, "widget-home");
  await widget.getByRole("link", { name: /Share an idea/ }).click();
  const signIn = widget.getByRole("link", { name: "Sign in to post feedback" });
  await expect(signIn).toHaveAttribute("target", "_blank");
  await checkpoint(ada, "widget-signed-out");

  await widget.getByRole("link", { name: "What's new" }).click();
  await expect(widget.getByRole("heading", { name: "Dark mode is here" })).toBeVisible();
  await expect(widget.getByRole("link", { name: "Dark mode is here" })).toHaveAttribute("target", "_blank");
  await expect(widget.getByText("Switch themes from your profile menu.")).toBeVisible();
  await checkpoint(ada, "widget-whats-new");
  // Seen now, here and after a reload.
  await expect(launcher).toHaveAccessibleName("Feedback");
  await ada.reload();
  await expect(launcher).toHaveAccessibleName("Feedback");
  await launcher.click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(widget.getByRole("link", { name: "Sign in to post feedback" })).toBeVisible();

  // Escape closes it and gives focus back to the button.
  await closeWithEscape(ada, ada.locator("#tuti-widget"));
  await expect(launcher).toBeFocused();

  // On the portal's own site (another port of the same host) the session comes along:
  // post, with suggestions while typing.
  await ada.goto(sitePage(`${slug}.localhost`, slug));
  await ada.getByRole("button", { name: "Feedback" }).click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await widget.getByLabel("Title").fill("Dark mode");
  const suggestions = widget.getByRole("status").filter({ hasText: "Already posted? Vote on it instead:" });
  await expect(suggestions.getByRole("link", { name: /Dark mode/ })).toHaveAttribute("target", "_blank");
  await checkpoint(ada, "widget-similar-while-typing");
  await widget.getByLabel("Title").fill("Export to CSV");
  await widget.getByRole("button", { name: "Submit post" }).click();
  await expect(widget.getByText("Feedback posted")).toBeVisible();
  await checkpoint(ada, "widget-posted");

  await widget.getByRole("button", { name: "Close" }).click();
  await expect(ada.locator("#tuti-widget")).toBeHidden();
  await ada.goto("/feedback/feature-requests");
  await expect(ada.getByRole("link", { name: "Export to CSV" })).toBeVisible();

  // Signed in on the portal, the announcement is new to her (what a browser saw on another
  // site isn't hers): Changelog says so until she's looked, then on every device.
  const changelogTab = ada.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: /^Changelog/ });
  await expect(changelogTab).toContainText("New");
  await checkpoint(ada, "portal-changelog-new");
  // On the changelog itself it isn't new any more, even before her visit is recorded (held here).
  let releaseSeen = () => {};
  let seenHeld = () => {};
  const held = new Promise<void>((resolve) => (seenHeld = resolve));
  await ada.route("**/changelog", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise<void>((resolve) => {
        releaseSeen = resolve;
        seenHeld();
      });
    }
    await route.continue();
  });
  await changelogTab.click();
  await expect(ada.getByRole("article", { name: "Dark mode is here" })).toBeVisible();
  await expect(changelogTab).toHaveText("Changelog");
  // Released only once it's actually held (the page may render before it sends the request).
  await held;
  const recorded = ada.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/changelog"));
  releaseSeen();
  await recorded;
  await ada.unroute("**/changelog");
  const otherDevice = await (await browser.newContext({ storageState: await ada.context().storageState() })).newPage();
  await otherDevice.goto(`${portalUrl(slug)}/roadmap`);
  await expect(otherDevice.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: /^Changelog/ })).toHaveText("Changelog");
  await otherDevice.context().close();

  // Other sites may frame the widget; the app, the portal's other pages (Customize's preview).
  const framing = async (path: string) => (await ada.request.get(path)).headers()["content-security-policy"];
  expect(await framing("/widget")).toBeUndefined();
  expect(await framing("/feedback/feature-requests")).toBe(`frame-ancestors ${new URL(APP_URL).origin}`);
});

test("a customer's site signs its users in to the widget with SSO, and they post from it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText();
  ssoSecrets.set(slug, secret);

  // A visitor of the customer's site, not signed in to Tuti at all.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(widget.getByText("Posting as Sam from Acme")).toBeVisible();
  await widget.getByLabel("Title").fill("Calendar sync");
  await checkpoint(visitor, "widget-signed-in-with-sso");
  await widget.getByRole("button", { name: "Submit post" }).click();
  await expect(widget.getByText("Feedback posted")).toBeVisible();

  // The post is Sam's, on the portal.
  await owner.goto(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(owner.getByRole("link", { name: "Calendar sync" })).toBeVisible();
  await expect(owner.getByText("Sam from Acme")).toBeVisible();

  // Then the site's next token doesn't check out (someone else, an expired one): nobody's posting,
  // not Sam still. Another part of the panel asks for it, as the docs' assistant does when opened.
  await visitor.route("**/token/**", (route) => route.fulfill({ contentType: "text/plain", body: "not-a-token" }));
  const asked = visitor.waitForResponse((response) => response.request().method() === "POST" && !!response.request().headers()["next-action"]);
  // The panel's "ready for a token" message (WIDGET_READY_MESSAGE).
  await visitor.frames().find((frame) => frame.url().includes("/widget"))!.evaluate(() => window.parent.postMessage({ type: "tuti:ready" }, "*"));
  await asked;
  await expect(widget.getByText("Couldn't sign you in")).toBeVisible();
  await expect(widget.getByText("Posting as Sam from Acme")).toHaveCount(0);

  // Two at once: Sam's token, then one that doesn't check out, Sam's slower to trade. They're traded
  // in turn (Next.js sends a page's server actions one at a time), so the newest has the last word:
  // nobody, not Sam.
  const panel = visitor.frames().find((frame) => frame.url().includes("/widget"))!;
  type Counted = { identified: number };
  await panel.evaluate(() => {
    (window as unknown as Counted).identified = 0;
    window.addEventListener("message", (event) => {
      if ((event.data as { type?: unknown } | null)?.type === "tuti:identify") {
        (window as unknown as Counted).identified += 1;
      }
    });
  });
  let tokens = 0;
  await visitor.unroute("**/token/**");
  await visitor.route("**/token/**", (route) => {
    tokens += 1;
    const body = tokens === 1 ? ssoToken(secret, { sub: "app-user-7", name: "Sam from Acme", email: samEmail(slug) }) : "not-a-token";
    return route.fulfill({ contentType: "text/plain", body });
  });
  const isExchange = (request: { method(): string; headers(): Record<string, string> }) => request.method() === "POST" && !!request.headers()["next-action"];
  let releaseSam!: () => void;
  const samReleased = new Promise<void>((resolve) => (releaseSam = resolve));
  let exchanges = 0;
  let answered = 0;
  visitor.on("response", (response) => isExchange(response.request()) && (answered += 1));
  await visitor.route(
    (url) => url.pathname === "/widget",
    async (route) => {
      if (isExchange(route.request()) && ++exchanges === 1) {
        await samReleased;
      }
      await route.continue();
    },
  );
  const samAsked = visitor.waitForRequest(isExchange);
  await panel.evaluate(() => window.parent.postMessage({ type: "tuti:ready" }, "*"));
  await samAsked;
  await panel.evaluate(() => window.parent.postMessage({ type: "tuti:ready" }, "*"));
  await panel.waitForFunction(() => (window as unknown as Counted).identified >= 2);
  releaseSam();
  await expect.poll(() => answered).toBeGreaterThanOrEqual(2);
  await expect(widget.getByText("Couldn't sign you in")).toBeVisible();
  await expect(widget.getByText("Posting as Sam from Acme")).toHaveCount(0);
});

test("a private portal's widget asks visitors to sign in; people the customer's site signs in see it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText();
  await owner.goto(`/app/${slug}/settings`);
  await owner.getByRole("combobox", { name: "Portal access" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("Portal is now private")).toBeVisible();

  // The customer's site doesn't sign this visitor in: the panel shows nothing of the portal.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  await expect(widget.getByText("Sign in to see this.", { exact: false })).toBeVisible();
  await expect(widget.getByRole("link", { name: "What's new" })).toHaveCount(0);
  await checkpoint(visitor, "widget-private-signed-out");

  // Once it signs them in (Tuti.identify), the panel shows the portal, on every tab.
  ssoSecrets.set(slug, secret);
  await visitor.reload();
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(widget.getByText("Posting as Sam from Acme")).toBeVisible();
  await widget.getByRole("link", { name: "What's new" }).click();
  await expect(widget.getByText("Nothing new yet")).toBeVisible();
  await checkpoint(visitor, "widget-private-signed-in-with-sso");

  // Then the site's next token doesn't check out (someone else, an expired one): nobody's signed in,
  // not Sam still. Another part of the panel asks for it, as the docs' assistant does when opened.
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(widget.getByText("Posting as Sam from Acme")).toBeVisible();
  await visitor.route("**/token/**", (route) => route.fulfill({ contentType: "text/plain", body: "not-a-token" }));
  const asked = visitor.waitForResponse((response) => response.request().method() === "POST" && !!response.request().headers()["next-action"]);
  await visitor.frames().find((frame) => frame.url().includes("/widget"))!.evaluate(() => window.parent.postMessage({ type: "tuti:ready" }, "*"));
  await asked;
  // The panel's pages don't show the private portal to them any more.
  await expect(widget.getByText("Sign in to see this.", { exact: false })).toBeVisible();
  await expect(widget.getByText("Posting as Sam from Acme")).toHaveCount(0);
});

test("someone a customer's site signs in sees what's new on one device, and it isn't new on their others", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  ssoSecrets.set(slug, await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText());
  await owner.goto(`/app/${slug}/settings/developers`);
  await owner.getByRole("textbox", { name: "Key name" }).fill("Widget seen test");
  await owner.getByRole("combobox", { name: "What the key can do" }).click();
  await owner.getByRole("option", { name: "Read and write" }).click();
  await owner.getByRole("button", { name: "Create key" }).click();
  const key = (await owner.getByRole("alert").filter({ hasText: "Copy the key for Widget seen test now" }).locator("code").first().innerText()).trim();
  const api = async (path: string, body: object) => {
    const response = await fetch(`${APP_URL}/api/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
  };
  await api("/changelog", { title: "Calendar sync is here", body: "Your events, both ways." });
  await api("/changelog/1/publish", {});

  // Sam (signed in by the customer's site) on their phone: new, until they look.
  const site = sitePage("customer.localhost", slug);
  const phone = await (await browser.newContext()).newPage();
  await phone.goto(site);
  const launcher = phone.getByRole("button", { name: "Feedback" });
  await expect(launcher).toHaveAttribute("aria-label", "Feedback, new updates");
  await checkpoint(phone, "widget-new-for-signed-in-user");
  await launcher.click();
  const widget = phone.frameLocator('iframe[title="Feedback"]');
  await widget.getByRole("link", { name: "What's new" }).click();
  await expect(widget.getByRole("heading", { name: "Calendar sync is here" })).toBeVisible();
  await expect(launcher).toHaveAttribute("aria-label", "Feedback");
  await checkpoint(phone, "widget-whats-new-seen");

  // On their laptop (another browser, nothing in its storage) it isn't new. It's recorded as
  // the panel shows it, so that may take a moment.
  const laptop = await (await browser.newContext()).newPage();
  await expect(async () => {
    await laptop.goto(site);
    await expect(laptop.getByRole("button", { name: "Feedback" })).toHaveAttribute("aria-label", "Feedback", { timeout: 5_000 });
  }).toPass();
  await checkpoint(laptop, "widget-seen-on-another-device");
  await phone.context().close();
  await laptop.context().close();
});

test("a customer's site shows its docs in the widget: search, read, and open an article from the page", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/developers`);
  await owner.getByRole("textbox", { name: "Key name" }).fill("Widget help test");
  await owner.getByRole("combobox", { name: "What the key can do" }).click();
  await owner.getByRole("option", { name: "Read and write" }).click();
  await owner.getByRole("button", { name: "Create key" }).click();
  const shown = owner.getByRole("alert").filter({ hasText: "Copy the key for Widget help test now" });
  const key = (await shown.locator("code").first().innerText()).trim();
  const api = async (path: string, body: object) => {
    const response = await fetch(`${APP_URL}/api/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as { slug: string };
  };

  // No published articles yet: no Docs tab.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  const launcher = visitor.getByRole("button", { name: "Feedback" });
  await launcher.click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  const tabs = widget.getByRole("navigation", { name: "Widget" });
  await expect(tabs.getByRole("link", { name: "What's new" })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Docs" })).toHaveCount(0);

  // The team publishes two articles, one in a collection.
  const collection = await api("/collections", { name: "Getting started", description: "The basics, in five minutes.", icon: "rocket" });
  const text = (value: string) => ({ type: "text", text: value });
  const content = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text("Who can invite")] },
      { type: "paragraph", content: [text("Owners and admins send invites from the Team page.")] },
    ],
  };
  const inviting = await api("/articles", { title: "Inviting your team", content, collection: collection.slug });
  await api(`/articles/${inviting.slug}/publish`, {});
  const exporting = await api("/articles", { title: "Exporting your data", body: "Download a CSV of every post from the board's menu." });
  await api(`/articles/${exporting.slug}/publish`, {});

  // Now Home searches the docs: its box opens the Docs tab with the results.
  await visitor.reload();
  await launcher.click();
  await widget.getByRole("searchbox", { name: "Search for help" }).fill("export");
  await widget.getByRole("searchbox", { name: "Search for help" }).press("Enter");
  await expect(widget.getByRole("list", { name: "Search results" }).getByRole("link", { name: "Exporting your data" })).toBeVisible();

  // And it has a Docs tab: the collections (each opens its own list) and the articles in none.
  await tabs.getByRole("link", { name: "Docs" }).click();
  const collections = widget.getByRole("list", { name: "Collections" });
  await expect(collections).toContainText("The basics, in five minutes.");
  // With its icon, drawn on the server.
  await expect(collections.getByRole("listitem").filter({ hasText: "Getting started" }).locator("svg.lucide-rocket")).toBeVisible();
  await expect(widget.getByRole("region", { name: "More articles" }).getByRole("link", { name: "Exporting your data" })).toBeVisible();
  await checkpoint(visitor, "widget-docs");
  await collections.getByRole("link", { name: "Getting started" }).click();
  await expect(widget.getByRole("heading", { name: "Getting started", level: 2 })).toBeVisible();
  await widget.getByRole("link", { name: "Inviting your team" }).click();
  // Back from an article: to the collection it was opened from.
  await widget.getByRole("article", { name: "Inviting your team" }).getByRole("link", { name: "Getting started" }).click();
  await widget.getByRole("link", { name: "All articles" }).click();
  await expect(collections).toBeVisible();

  // Search: results come as the visitor types, with no button to press. Cleared, the docs are back.
  const search = widget.getByRole("searchbox", { name: "Search the docs" });
  await expect(widget.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);
  await search.pressSequentially("invi");
  const results = widget.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await expect(results.getByRole("link", { name: "Exporting your data" })).toHaveCount(0);
  await expect(collections).toBeHidden();
  await checkpoint(visitor, "widget-docs-search");
  await search.fill("");
  await expect(collections).toBeVisible();
  await expect(results).toBeHidden();
  await search.pressSequentially("billing");
  await expect(widget.getByText("No articles match “billing”", { exact: true })).toBeVisible();
  const panelUrl = () => visitor.frames().find((frame) => frame.url().includes("/widget"))?.url();
  // Enter searches at its own address, as without the page's script, and that counts it. Pressed while
  // the search as they typed is still on its way, which comes back before the page does, it isn't
  // counted again when they leave the tab.
  let searchSent!: () => void;
  const sent = new Promise<void>((resolve) => (searchSent = resolve));
  let releaseSearch!: () => void;
  const released = new Promise<void>((resolve) => (releaseSearch = resolve));
  let searchAnswered!: () => void;
  const answered = new Promise<void>((resolve) => (searchAnswered = resolve));
  const panelPages = (url: URL) => url.pathname === "/widget";
  const holdSearch = async (route: Route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes('"refunds"')) {
      searchSent();
      await released;
      await route.fulfill({ response: await route.fetch() });
      searchAnswered();
      return;
    }
    if (request.method() === "GET" && new URL(request.url()).searchParams.get("q") === "refunds") {
      await answered;
    }
    await route.continue();
  };
  await visitor.route(panelPages, holdSearch);
  await search.fill("refunds");
  await sent;
  await search.press("Enter");
  releaseSearch();
  await expect.poll(panelUrl).toContain("q=refunds");
  await visitor.unroute(panelPages, holdSearch);
  await expect(widget.getByText("No articles match “refunds”", { exact: true })).toBeVisible();
  await tabs.getByRole("link", { name: "What's new" }).click();
  await tabs.getByRole("link", { name: "Docs" }).click();
  await expect(collections).toBeVisible();
  // What they type before the panel gets to a search's address stays.
  await search.pressSequentially("billing");
  await search.press("Enter");
  await search.fill("invite");
  await expect.poll(panelUrl).toContain("q=billing");
  await expect(search).toHaveValue("invite");
  // Read a result, and go back to the results.
  await results.getByRole("link", { name: "Inviting your team" }).click();
  const article = widget.getByRole("article", { name: "Inviting your team" });
  await expect(article.getByRole("heading", { name: "Who can invite", level: 2 })).toBeVisible();
  await expect(article.getByText("Owners and admins send invites from the Team page.")).toBeVisible();
  await expect(article.getByText("Getting started")).toBeVisible();
  const newTab = article.getByRole("link", { name: "Open in new tab" });
  await expect(newTab).toHaveAttribute("target", "_blank");
  await expect(newTab).toHaveAttribute("href", `/docs/${inviting.slug}`);
  await checkpoint(visitor, "widget-docs-article");
  await article.getByRole("link", { name: "Search results" }).click();
  await expect(results.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await expect(search).toHaveValue("invite");
  // The team's insights count what they searched for: "export" (from Home), "refunds" and "billing" (Enter),
  // "invite" (typed, then a result opened) and its results again (going back); not what they typed on the way.
  await owner.goto(`/app/${slug}/docs/insights`);
  await expect(async () => {
    await owner.reload();
    await expect(owner.getByText(/ 5 searches, 2 failed searches\./)).toBeVisible({ timeout: 2_000 });
  }).toPass();

  // The customer's page opens the widget at an article (say, from a contextual help button).
  await visitor.keyboard.press("Escape");
  await expect(visitor.locator("#tuti-widget")).toBeHidden();
  await visitor.evaluate(
    (article) => (window as unknown as { Tuti: { open(options: { article: string }): void } }).Tuti.open({ article }),
    exporting.slug,
  );
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  await expect(widget.getByRole("heading", { name: "Exporting your data", level: 1 })).toBeVisible();
  await expect(widget.getByText("Download a CSV of every post from the board's menu.")).toBeVisible();
  await checkpoint(visitor, "widget-docs-opened-at-article");
  await widget.getByRole("link", { name: "All articles" }).click();
  await expect(widget.getByRole("list", { name: "Collections" }).getByRole("link", { name: "Getting started" })).toBeVisible();
});

test("a visitor asks the docs' AI in the widget's assistant: an answer with its source, asking a person after a thumbs-down, a follow-up, or “I don't know” and posting it from the widget", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  // SSO, so the customer's site signs its visitor in to the widget's Feedback tab.
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  ssoSecrets.set(slug, await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText());
  await owner.goto(`/app/${slug}/settings/developers`);
  await owner.getByRole("textbox", { name: "Key name" }).fill("Widget answers test");
  await owner.getByRole("combobox", { name: "What the key can do" }).click();
  await owner.getByRole("option", { name: "Read and write" }).click();
  await owner.getByRole("button", { name: "Create key" }).click();
  const shown = owner.getByRole("alert").filter({ hasText: "Copy the key for Widget answers test now" });
  const key = (await shown.locator("code").first().innerText()).trim();
  const api = async (path: string, body: object) => {
    const response = await fetch(`${APP_URL}/api/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as { slug: string };
  };
  // A published article whose only section is close to the visitor's question.
  const question = `How do I add a colleague to Acme ${slug}?`;
  const body = "Owners and admins send invites from the Team page.";
  await similar(question, `Inviting your team\n\n${body}`, 0.8);
  const article = await api("/articles", { title: "Inviting your team", body });
  await api(`/articles/${article.slug}/publish`, {});
  // "Ask a person" sends to a support email the team confirmed.
  const support = `e2e-support-${slug}@example.com`;
  const set = await fetch(`${APP_URL}/api/v1/assistant`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ supportEmail: support }),
  });
  expect(set.ok).toBe(true);
  await owner.goto(linkIn(await latestEmailTo(support), `${APP_URL}/support-email?`));
  await owner.getByRole("button", { name: "Confirm" }).click();
  await expect(owner.getByText(`now come to ${support}`)).toBeVisible();

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Docs" }).click();
  const search = widget.getByRole("searchbox", { name: "Search the docs" });
  await search.fill(question);
  await search.press("Enter");
  // Asked from the search, in the assistant, which takes the panel.
  await nextModelReply(JSON.stringify({ answer: "Owners and admins send invites from the Team page.", sources: ["s1"] }), question);
  await widget.getByRole("button", { name: `Ask AI: ${question}` }).click();
  const assistant = widget.getByRole("dialog", { name: "Assistant" });
  const ai = assistant.getByRole("log", { name: "Conversation" });
  await expect(ai.getByText("Owners and admins send invites from the Team page.")).toBeVisible();
  // Sources open in the panel's Docs tab.
  const source = ai.getByRole("list", { name: "Sources" }).getByRole("link", { name: "Inviting your team" });
  await expect(source).toHaveAttribute("href", `/widget?tab=docs&article=${article.slug}`);
  await expect(source).not.toHaveAttribute("target");
  await checkpoint(visitor, "widget-docs-ai-answer");
  await ai.getByRole("button", { name: "Not helpful" }).click();
  await expect(ai.getByText("Thanks for letting us know.")).toBeVisible();

  // Not helpful: they ask a person. The customer's site is slow to sign them in, and they type an
  // address before it does: the email it signs them in with doesn't replace what they typed.
  const typed = `e2e-typed-${slug}@example.com`;
  let tokenAsked!: () => void;
  const asked = new Promise<void>((resolve) => (tokenAsked = resolve));
  let releaseToken!: () => void;
  const released = new Promise<void>((resolve) => (releaseToken = resolve));
  await visitor.route("**/token/**", async (route) => {
    tokenAsked();
    await released;
    await route.continue();
  });
  await ai.getByRole("button", { name: "Ask a person" }).click();
  const form = ai.getByRole("form", { name: "Ask a person" });
  await asked;
  await form.getByLabel("Your email").fill(typed);
  // The panel trades the token (a server action) once the page hands it over.
  const signedIn = visitor.waitForResponse((response) => response.request().method() === "POST" && !!response.request().headers()["next-action"]);
  releaseToken();
  await signedIn;
  await visitor.unroute("**/token/**");
  await expect(form.getByLabel("Your email")).toHaveValue(typed);
  await form.getByLabel("Anything to add? (optional)").fill("I'm on the free plan.");
  await checkpoint(visitor, "widget-docs-ask-a-person");
  await nextModelReply("They want to add a colleague on the free plan.", question);
  const before = countEmailsTo(support);
  await form.getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByText("We've passed this to the team; they'll reply by email.")).toBeVisible();
  await checkpoint(visitor, "widget-docs-asked-a-person");
  const sent = await latestEmailTo(support, { after: before });
  expect(sent.replyTo).toBe(typed);
  expect(sent.text).toContain("They want to add a colleague on the free plan.");
  expect(sent.text).toContain("Owners and admins send invites from the Team page.");
  expect(sent.text).toContain("marked not helpful");
  // The visitor is known by a cookie the browser keeps for this site's widget (partitioned), as Lax ones aren't kept in a frame.
  expect((await visitor.context().cookies(portalUrl(slug))).map((cookie) => cookie.name)).toContain("tuti_reader");

  // A follow-up, in the panel: the AI gets the conversation so far.
  const followUp = `Can members do it too ${slug}?`;
  await similar(`${question}\n${followUp}`, `Inviting your team\n\n${body}`, 0.8);
  await nextModelReply(JSON.stringify({ answer: "Only owners and admins can send invites.", sources: ["s1"] }), followUp);
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).fill(followUp);
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(ai.getByText("Only owners and admins can send invites.")).toBeVisible();
  const followed = (await modelRequests()).find((request) => request.user.includes(followUp))!;
  expect(followed.user).toContain('"earlierInConversation"');
  await checkpoint(visitor, "widget-docs-ai-follow-up");

  // A source opens the article in the panel; "Ask AI" there opens the conversation again.
  await source.first().click();
  await expect(widget.getByRole("heading", { name: "Inviting your team", level: 1 })).toBeVisible();
  await expect(assistant).toBeHidden();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Docs" }).click();
  await widget.getByRole("button", { name: "Ask AI", exact: true }).click();
  await expect(ai.getByText("Only owners and admins can send invites.")).toBeVisible();

  // Something the docs don't cover: "I don't know", and posting it from the widget's own Feedback tab.
  const unrelated = "Can I pay with crypto?";
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).fill(unrelated);
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(ai.getByText("I don't know")).toBeVisible();
  await checkpoint(visitor, "widget-docs-ai-no-answer");
  // Asking a person here starts with the email the customer's site signed them in with.
  await ai.getByRole("button", { name: "Ask a person" }).last().click();
  await expect(ai.getByRole("form", { name: "Ask a person" }).getByLabel("Your email")).toHaveValue(samEmail(slug));
  await ai.getByRole("button", { name: "Cancel" }).click();
  await ai.getByRole("link", { name: "Post this as feedback" }).click();
  await expect(widget.getByText("Posting as Sam from Acme")).toBeVisible();
  await expect(widget.getByLabel("Title")).toHaveValue(unrelated);
  await expect(assistant).toBeHidden();
  await checkpoint(visitor, "widget-docs-ai-post-as-feedback");
  await widget.getByRole("button", { name: "Submit post" }).click();
  await expect(widget.getByText("Feedback posted")).toBeVisible();
  await owner.goto(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(owner.getByRole("link", { name: unrelated })).toBeVisible();

  // Someone else signs in to the customer's site in the same tab: the assistant is theirs, empty.
  // The conversation is kept per person the site signs in, not per tab or browser.
  const openAssistant = async () => {
    await visitor.reload();
    await visitor.getByRole("button", { name: "Feedback" }).click();
    await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Docs" }).click();
    // Opening it asks the site who's signed in, which the panel trades for a widget token.
    const signedIn = visitor.waitForResponse((response) => response.request().method() === "POST" && !!response.request().headers()["next-action"]);
    await widget.getByRole("button", { name: "Ask AI", exact: true }).click();
    await signedIn;
  };
  await visitor.route("**/token/**", (route) =>
    route.fulfill({ contentType: "text/plain", body: ssoToken(ssoSecrets.get(slug)!, { sub: "app-user-8", name: "Kim from Acme", email: `e2e-kim-${slug}@example.com` }) }),
  );
  await openAssistant();
  await expect(assistant).toBeVisible();
  await expect(ai.getByText("Only owners and admins can send invites.")).toHaveCount(0);
  await expect(ai.getByText(unrelated)).toHaveCount(0);
  // Sam again: theirs is still there.
  await visitor.unroute("**/token/**");
  await openAssistant();
  await expect(ai.getByText("Only owners and admins can send invites.")).toBeVisible();

  // Sam's follow-up comes back as no longer theirs (a new reader cookie) and is asked afresh, and
  // the site signs in Kim meanwhile: Kim's conversation doesn't get Sam's question.
  await visitor.context().clearCookies({ name: "tuti_reader" });
  const isAction = (request: { method(): string; headers(): Record<string, string> }) => request.method() === "POST" && !!request.headers()["next-action"];
  let answered = 0;
  visitor.on("response", (response) => isAction(response.request()) && (answered += 1));
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
  let actions = 0;
  const widgetPage = (url: URL) => url.pathname === "/widget";
  await visitor.route(widgetPage, async (route) => {
    if (isAction(route.request()) && ++actions === 1) {
      await firstReleased;
    }
    await route.continue();
  });
  // Nothing in the docs is about it: "I don't know", without asking the model.
  const guests = "Can I invite guests?";
  const firstAsked = visitor.waitForRequest(isAction);
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).fill(guests);
  await assistant.getByRole("button", { name: "Send" }).click();
  await firstAsked;
  const panel = visitor.frames().find((frame) => frame.url().includes("/widget"))!;
  type Counted = { identified: number };
  await panel.evaluate(() => {
    (window as unknown as Counted).identified = 0;
    window.addEventListener("message", (event) => {
      if ((event.data as { type?: unknown } | null)?.type === "tuti:identify") {
        (window as unknown as Counted).identified += 1;
      }
    });
  });
  await visitor.route("**/token/**", (route) =>
    route.fulfill({ contentType: "text/plain", body: ssoToken(ssoSecrets.get(slug)!, { sub: "app-user-8", name: "Kim from Acme", email: `e2e-kim-${slug}@example.com` }) }),
  );
  // The panel's "ready for a token" message (WIDGET_READY_MESSAGE).
  await panel.evaluate(() => window.parent.postMessage({ type: "tuti:ready" }, "*"));
  await panel.waitForFunction(() => (window as unknown as Counted).identified >= 1);
  releaseFirst();
  // The question, Kim's sign-in, the question asked afresh; then one of Kim's own, which is answered
  // after it (a page's server actions go one at a time), so by then Sam's has been and gone.
  await expect.poll(() => answered).toBeGreaterThanOrEqual(3);
  const kims = "Is there a mobile app?";
  // Kim's is empty: a first question, not a follow-up.
  await assistant.getByRole("textbox", { name: "Ask a question" }).fill(kims);
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(ai.getByText("I don't know")).toHaveCount(1);
  await expect(ai.getByText(kims)).toBeVisible();
  await expect(ai.getByText("Only owners and admins can send invites.")).toHaveCount(0);
  await expect(ai.getByText(guests)).toHaveCount(0);

  // Asked before the site has said who's signed in, a follow-up that comes back as no longer theirs is
  // asked afresh while the sign-in lands: its answer still comes, in the conversation it moved to.
  await visitor.unroute(widgetPage);
  let releaseSignIn!: () => void;
  const signInReleased = new Promise<void>((resolve) => (releaseSignIn = resolve));
  await visitor.unroute("**/token/**");
  await visitor.route("**/token/**", async (route) => {
    await signInReleased;
    await route.fulfill({ contentType: "text/plain", body: ssoToken(ssoSecrets.get(slug)!, { sub: "app-user-7", name: "Sam from Acme", email: samEmail(slug) }) });
  });
  await visitor.reload();
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Docs" }).click();
  await widget.getByRole("button", { name: "Ask AI", exact: true }).click();
  const invoice = "Can I pay by invoice?";
  await assistant.getByRole("textbox", { name: "Ask a question" }).fill(invoice);
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(ai.getByText("I don't know")).toBeVisible();
  await visitor.context().clearCookies({ name: "tuti_reader" });
  let releaseAsk!: () => void;
  const askReleased = new Promise<void>((resolve) => (releaseAsk = resolve));
  let asks = 0;
  await visitor.route(widgetPage, async (route) => {
    if (isAction(route.request()) && ++asks === 1) {
      await askReleased;
    }
    await route.continue();
  });
  const reloaded = visitor.frames().find((frame) => frame.url().includes("/widget"))!;
  await reloaded.evaluate(() => {
    (window as unknown as Counted).identified = 0;
    window.addEventListener("message", (event) => {
      if ((event.data as { type?: unknown } | null)?.type === "tuti:identify") {
        (window as unknown as Counted).identified += 1;
      }
    });
  });
  const euros = "What about in euros?";
  const held = visitor.waitForRequest(isAction);
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).fill(euros);
  await assistant.getByRole("button", { name: "Send" }).click();
  await held;
  releaseSignIn();
  await reloaded.waitForFunction(() => (window as unknown as Counted).identified >= 1);
  releaseAsk();
  await expect(ai.getByText(euros)).toBeVisible();
  await expect(ai.getByText("I don't know")).toHaveCount(1);
  await expect(ai.getByText("Thinking…")).toHaveCount(0);
  await expect(ai.getByText(invoice)).toHaveCount(0);

  // What an earlier reader asked in this tab before anyone was signed in isn't handed to whoever the
  // site signs in next: only what was asked on the page while it was signing them in.
  await visitor.unroute(widgetPage);
  await visitor.unroute("**/token/**");
  // Nobody signed in on the site (no token).
  await visitor.route("**/token/**", (route) => route.fulfill({ contentType: "text/plain", body: "" }));
  await visitor.reload();
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Docs" }).click();
  await widget.getByRole("button", { name: "Ask AI", exact: true }).click();
  const earlier = "Do you have a status page?";
  await assistant.getByRole("textbox", { name: "Ask a question" }).fill(earlier);
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(ai.getByText("I don't know")).toHaveCount(1);
  // Then Sam, the site slow to sign them in.
  let releaseSam!: () => void;
  const samReleased = new Promise<void>((resolve) => (releaseSam = resolve));
  await visitor.unroute("**/token/**");
  await visitor.route("**/token/**", async (route) => {
    await samReleased;
    await route.fulfill({ contentType: "text/plain", body: ssoToken(ssoSecrets.get(slug)!, { sub: "app-user-7", name: "Sam from Acme", email: samEmail(slug) }) });
  });
  await visitor.reload();
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Docs" }).click();
  await widget.getByRole("button", { name: "Ask AI", exact: true }).click();
  await expect(ai.getByText(earlier)).toBeVisible();
  const later = "Do you have an API?";
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).fill(later);
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(ai.getByText("I don't know")).toHaveCount(2);
  const signedInSam = visitor.waitForResponse((response) => isAction(response.request()));
  releaseSam();
  await signedInSam;
  // Once it's Sam's, nothing's left as nobody's.
  const panelNow = visitor.frames().find((frame) => frame.url().includes("/widget"))!;
  await expect.poll(() => panelNow.evaluate((key) => window.sessionStorage.getItem(key), `tuti:docs-assistant:${slug}:anonymous`)).toBeNull();
  await expect(ai.getByText(later)).toBeVisible();
  await expect(ai.getByText(earlier)).toHaveCount(0);
  // Added to Sam's own conversation in this tab, not in place of it.
  await expect(ai.getByText(euros)).toBeVisible();

  // And again on the same page: the site's next token doesn't check out, a question's asked as
  // nobody, then Sam's signed in again. That question is Sam's, and again nothing's left as nobody's.
  await visitor.unroute("**/token/**");
  await visitor.route("**/token/**", (route) => route.fulfill({ contentType: "text/plain", body: "not-a-token" }));
  const signedOut = visitor.waitForResponse((response) => isAction(response.request()));
  await panelNow.evaluate(() => window.parent.postMessage({ type: "tuti:ready" }, "*"));
  await signedOut;
  await expect(ai.getByText(later)).toHaveCount(0);
  const meanwhile = "Is there a free trial?";
  await assistant.getByRole("textbox", { name: "Ask a question" }).fill(meanwhile);
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(ai.getByText("I don't know")).toHaveCount(1);
  await visitor.unroute("**/token/**");
  await visitor.route("**/token/**", (route) =>
    route.fulfill({ contentType: "text/plain", body: ssoToken(ssoSecrets.get(slug)!, { sub: "app-user-7", name: "Sam from Acme", email: samEmail(slug) }) }),
  );
  const samAgain = visitor.waitForResponse((response) => isAction(response.request()));
  await panelNow.evaluate(() => window.parent.postMessage({ type: "tuti:ready" }, "*"));
  await samAgain;
  await expect(ai.getByText(later)).toBeVisible();
  await expect(ai.getByText(meanwhile)).toBeVisible();
  await expect.poll(() => panelNow.evaluate((key) => window.sessionStorage.getItem(key), `tuti:docs-assistant:${slug}:anonymous`)).toBeNull();
});

type TutiSdk ={ open(options?: object): void; close(): void; on(name: string, callback: (unseen: boolean) => void): void };

test("the team sets up the launcher; a customer's site shows it, opens articles from its help links and from its own button", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/developers`);
  await owner.getByRole("textbox", { name: "Key name" }).fill("Widget launcher test");
  await owner.getByRole("combobox", { name: "What the key can do" }).click();
  await owner.getByRole("option", { name: "Read and write" }).click();
  await owner.getByRole("button", { name: "Create key" }).click();
  const shown = owner.getByRole("alert").filter({ hasText: "Copy the key for Widget launcher test now" });
  const key = (await shown.locator("code").first().innerText()).trim();
  const api = async (path: string, body: object) => {
    const response = await fetch(`${APP_URL}/api/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as { slug: string };
  };
  const article = await api("/articles", { title: "Exporting your data", body: "Download a CSV of every post from the board's menu." });
  await api(`/articles/${article.slug}/publish`, {});

  // Customize → Widget: a name, a colour, the left corner, an icon and a quick link (https only), beside the widget open on a stand-in for the site.
  await owner.goto(`/app/${slug}/customize/widget`);
  await expect(owner.frameLocator('iframe[title="Widget panel preview"]').getByRole("link", { name: "Feedback", exact: true })).toBeVisible();
  const previewLauncher = (name: string) => owner.getByRole("figure", { name: "Widget preview" }).getByRole("img", { name: `Launcher: ${name}` });
  await expect(previewLauncher("Feedback")).toBeVisible();
  await owner.getByLabel("Button name").fill("Help & ideas");
  await owner.getByLabel("Colour", { exact: true }).fill("#5b21b6");
  await owner.getByLabel("Bottom left").check();
  await owner.getByText("Megaphone", { exact: true }).click();
  await owner.getByRole("button", { name: "Add link" }).click();
  await owner.getByLabel("Link 1 label").fill("Status");
  await owner.getByLabel("Link 1 URL").fill("http://status.example.com");
  await owner.getByRole("button", { name: "Add link" }).click();
  await owner.getByLabel("Link 2 label").fill("Averyverylongquicklinklabelwithnospaces1");
  await owner.getByLabel("Link 2 URL").fill("https://example.com/long");
  // The launcher in the preview changes as it's set: a round button with the megaphone.
  await expect(previewLauncher("Help & ideas").locator("path")).toHaveCount(3);
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Links need a full https:// address")).toBeVisible();
  await owner.getByLabel("Link 1 URL").fill("https://status.example.com");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await expect(owner.frameLocator('iframe[title="Widget panel preview"]').getByRole("link", { name: "Status" })).toBeVisible();
  // Saved, the launcher in the preview is the new one.
  await expect(previewLauncher("Help & ideas").locator("path")).toHaveCount(3);
  await checkpoint(owner, "widget-settings");
  await owner.reload();
  await expect(owner.getByLabel("Button name")).toHaveValue("Help & ideas");
  await expect(owner.getByRole("radio", { name: "Megaphone" })).toBeChecked();
  await expect(owner.getByLabel("Link 1 URL")).toHaveValue("https://status.example.com");

  // On the customer's site: the team's launcher, a round button with their icon, named for screen readers and its tooltip; and the quick link at the top of the panel.
  const visitor = await (await browser.newContext()).newPage();
  const site = sitePage("customer.localhost", slug);
  await visitor.goto(site);
  const launcher = visitor.getByRole("button", { name: "Help & ideas" });
  await expect(launcher).toHaveCSS("background-color", "rgb(91, 33, 182)");
  await expect(launcher).toHaveCSS("left", "20px");
  await expect(launcher).toHaveCSS("width", "56px");
  await expect(launcher).toHaveAttribute("title", "Help & ideas");
  await expect(launcher.locator("path").first()).toHaveAttribute("d", /^M11 6a13 13/);
  await checkpoint(visitor, "widget-custom-launcher");
  await launcher.click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  const status = widget.getByRole("navigation", { name: "Quick links" }).getByRole("link", { name: "Status" });
  await expect(status).toHaveAttribute("href", "https://status.example.com");
  await expect(status).toHaveAttribute("target", "_blank");
  await checkpoint(visitor, "widget-quick-links");
  // In a narrow panel a long label wraps, its icon inside the panel.
  await visitor.setViewportSize({ width: 360, height: 720 });
  const icon = widget.getByRole("link", { name: /Averyverylong/ }).locator("svg");
  const panel = (await visitor.locator("#tuti-widget").boundingBox())!;
  expect((await icon.boundingBox())!.x + (await icon.boundingBox())!.width).toBeLessThanOrEqual(panel.x + panel.width);
  await visitor.setViewportSize({ width: 1280, height: 720 });
  await closeWithEscape(visitor, visitor.locator("#tuti-widget"));

  // A contextual help link the page adds later opens its article in the panel, not a new page.
  await visitor.evaluate((article) => {
    const link = document.createElement("a");
    link.href = "/elsewhere";
    link.textContent = "How do exports work?";
    link.dataset.tutiArticle = article;
    document.body.append(link);
  }, article.slug);
  await visitor.getByRole("link", { name: "How do exports work?" }).click();
  await expect(widget.getByRole("heading", { name: "Exporting your data", level: 1 })).toBeVisible();
  expect(visitor.url()).toBe(site);
  await checkpoint(visitor, "widget-contextual-help");

  // With data-hide-launcher, the page's own button opens the panel (at What's new) and closes it.
  await visitor.goto(`${site}?hide-launcher`);
  await visitor.waitForFunction(() => "Tuti" in window);
  // The status is known once the settings are read, which is when the launcher would appear.
  const unseen = await visitor.evaluate(
    () => new Promise((resolve) => (window as unknown as { Tuti: TutiSdk }).Tuti.on("unseen", resolve)),
  );
  expect(unseen).toBe(false);
  await expect(visitor.getByRole("button", { name: "Help & ideas" })).toHaveCount(0);
  await visitor.evaluate(() => {
    const button = document.createElement("button");
    button.textContent = "Our feedback button";
    button.onclick = () => (window as unknown as { Tuti: TutiSdk }).Tuti.open({ tab: "whats-new" });
    document.body.append(button);
  });
  await visitor.getByRole("button", { name: "Our feedback button" }).click();
  await expect(widget.getByText("Nothing new yet")).toBeVisible();
  await checkpoint(visitor, "widget-own-button");
  await visitor.evaluate(() => (window as unknown as { Tuti: TutiSdk }).Tuti.close());
  await expect(visitor.locator("#tuti-widget")).toBeHidden();
  await expect(visitor.getByRole("button", { name: "Our feedback button" })).toBeFocused();
});

test("a customer's site shows the widget inline in its page, and as a sidebar", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const site = sitePage("customer.localhost", slug);
  const visitor = await (await browser.newContext()).newPage();

  // Inline: two mounts, each with its own panel at its tab, no launcher and nothing to close.
  await visitor.goto(`${site}?display=inline&inline=&inline=whats-new`);
  const frames = visitor.locator("[data-tuti-inline] iframe");
  await expect(frames).toHaveCount(2);
  const home = frames.nth(0).contentFrame();
  const whatsNew = frames.nth(1).contentFrame();
  await expect(home.getByText("How can we help?")).toBeVisible();
  await expect(whatsNew.getByText("Nothing new yet")).toBeVisible();
  await visitor.waitForFunction(() => "Tuti" in window);
  await expect(visitor.getByRole("button", { name: "Feedback" })).toHaveCount(0);
  expect((await frames.nth(0).boundingBox())!.height).toBeGreaterThanOrEqual(500);
  await checkpoint(visitor, "widget-inline");
  for (const frame of [home, whatsNew]) {
    await expect(frame.getByRole("link", { name: "What's new" })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Close" })).toHaveCount(0);
  }
  // Still none after moving to another tab inside the panel.
  await home.getByRole("link", { name: "What's new" }).click();
  await expect(home.getByText("Nothing new yet")).toBeVisible();
  await expect(home.getByRole("button", { name: "Close" })).toHaveCount(0);

  // Sidebar: the launcher opens a full-height drawer; Escape closes it, back to the button.
  await visitor.goto(`${site}?display=sidebar`);
  const launcher = visitor.getByRole("button", { name: "Feedback" });
  await launcher.click();
  const drawer = visitor.locator("#tuti-widget");
  const sidebar = drawer.locator("iframe").contentFrame();
  await expect(sidebar.getByText("How can we help?")).toBeVisible();
  const viewport = visitor.viewportSize()!;
  expect(await drawer.boundingBox()).toEqual({ x: viewport.width - 400, y: 0, width: 400, height: viewport.height });
  await checkpoint(visitor, "widget-sidebar");
  await closeWithEscape(visitor, drawer);
  await expect(launcher).toBeFocused();

  // On a narrow screen, over a backdrop that closes it; the close button does too.
  await visitor.setViewportSize({ width: 600, height: 800 });
  await launcher.click();
  await expect(sidebar.getByText("How can we help?")).toBeVisible();
  await checkpoint(visitor, "widget-sidebar-narrow", { fullPage: false });
  await visitor.mouse.click(100, 400);
  await expect(drawer).toBeHidden();
  await expect(launcher).toBeFocused();
  await launcher.click();
  await sidebar.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();
});

test("with the support inbox on, someone the page signs in messages the team from the widget and sees the reply", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  ssoSecrets.set(slug, await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText());

  // No Messages until the team turns the inbox on.
  const before = await (await browser.newContext()).newPage();
  await before.goto(sitePage("customer.localhost", slug));
  await before.getByRole("button", { name: "Feedback" }).click();
  await before.frameLocator('iframe[title="Feedback"]').getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(before.frameLocator('iframe[title="Feedback"]').getByText("Posting as Sam from Acme")).toBeVisible();
  await expect(before.frameLocator('iframe[title="Feedback"]').getByRole("link", { name: "Messages" })).toHaveCount(0);

  await owner.goto(`/app/${slug}/settings`);
  await owner.getByRole("link", { name: "Support" }).click();
  await owner.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(owner.getByText("Messages on")).toBeVisible();

  // Sam writes to the team (in a new browser: the script reads whether the inbox is on once a minute at most).
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  // Home's way in, then the tab.
  await widget.getByRole("link", { name: /Send us a message/ }).click();
  await expect(widget.getByText("No messages yet")).toBeVisible();
  await widget.getByRole("button", { name: "New message" }).click();
  await widget.getByRole("textbox", { name: "Message" }).fill("How do I export my data?");
  // With a screenshot: it uploads as it's attached, and goes with the message.
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await widget.locator('input[type="file"]').setInputFiles({ name: "screenshot.png", mimeType: "image/png", buffer: pixel });
  await expect(widget.getByRole("list", { name: "Files to send" })).toContainText(/screenshot\.png\s*1 KB/);
  await widget.getByRole("button", { name: "Send" }).click();
  await expect(widget.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(1);
  await expect(widget.getByRole("list", { name: "Messages" })).toContainText("You");
  await expect(widget.getByRole("img", { name: "screenshot.png" })).toBeVisible();

  // It's in the team's inbox, from the widget; they reply.
  await owner.goto(`/app/${slug}/inbox`);
  await owner.getByRole("link", { name: "How do I export my data?" }).click();
  await expect(owner.getByRole("img", { name: "screenshot.png" })).toBeVisible();
  await expect(owner.getByText(/Sam from Acme \(e2e-sam-.*\) · started from the widget/)).toBeVisible();
  // Sam has the widget open: they're online.
  await expect(owner.getByText("Online", { exact: true })).toBeVisible();
  await owner.getByRole("textbox", { name: "Reply" }).fill("Settings → Export, then Download.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(2);

  // The reply shows in the open widget as it's sent (live: well before its 10-second fallback check).
  const messages = widget.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(messages).toHaveCount(2, { timeout: 4_000 });
  await expect(messages.last()).toContainText("Olive Owner");
  await expect(messages.last()).toContainText("Settings → Export, then Download.");
  await checkpoint(visitor, "widget-messages");

  // And Sam's answer shows on the team's open page without reloading it.
  await widget.getByRole("textbox", { name: "Reply" }).fill("Perfect, found it.");
  await widget.getByRole("button", { name: "Send" }).click();
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(3, { timeout: 4_000 });
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Open");

  // Another reply while the panel's closed: the launcher's dot, until it's seen.
  await closeWithEscape(visitor, visitor.locator("#tuti-widget"));
  await owner.getByRole("textbox", { name: "Reply" }).fill("Did that work?");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(4);
  await visitor.reload();
  await expect(visitor.getByRole("button", { name: "Feedback, new updates" })).toBeVisible();
  await visitor.getByRole("button", { name: "Feedback, new updates" }).click();
  await widget.getByRole("link", { name: "Messages" }).click();
  await expect(widget.getByRole("list", { name: "Conversations" }).getByText("New reply")).toBeAttached();
  await widget.getByRole("button", { name: /How do I export my data\?/ }).click();
  await expect(messages).toHaveCount(4);
  await expect(visitor.getByRole("button", { name: "Feedback", exact: true })).toBeAttached();

  // The page signs someone else in, but the widget can't reach Tuti to trade their token: nobody's
  // signed in, not Sam, whose messages go.
  await visitor.route("**/*", (route) => (route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await visitor.evaluate(() => (window as unknown as { Tuti: { identify(getToken: () => string): void } }).Tuti.identify(() => "someone-else"));
  await expect(widget.getByText("Leave your email so the team can get back to you.")).toBeVisible();
  await expect(widget.getByText("Couldn't sign you in")).toBeVisible();
  await expect(messages).toHaveCount(0);
});

test("signed out, a visitor leaves their email to message the team, and their browser keeps the conversation", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(owner.getByText("Messages on")).toBeVisible();
  // Someone the team's app already told Tuti about.
  const kim = `e2e-kim-${slug}@example.com`;
  const api = await apiFor(owner, slug);
  await api("/users", { users: [{ id: "kim-1", name: "Kim Lee", email: kim }] });

  // A visitor of the customer's site (it signs nobody in) writes, giving their email.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  await widget.getByRole("link", { name: "Messages" }).click();
  await expect(widget.getByText("Leave your email so the team can get back to you.")).toBeVisible();
  await widget.getByRole("textbox", { name: "Your email" }).fill(kim);
  await widget.getByRole("textbox", { name: "Message" }).fill("Is there a nonprofit discount?");
  await checkpoint(visitor, "widget-signed-out-message");
  await widget.getByRole("button", { name: "Send" }).click();
  const messages = widget.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(messages).toHaveCount(1);

  // The team sees an address that isn't verified, and only a hint of who it may be.
  await owner.goto(`/app/${slug}/inbox`);
  await owner.getByRole("link", { name: "Is there a nonprofit discount?" }).click();
  const about = owner.getByRole("complementary", { name: "About them" });
  await expect(about).toContainText(`${kim} (not verified)`);
  await expect(about).toContainText("Maybe Kim Lee (not signed in), id kim-1");
  await owner.getByRole("textbox", { name: "Reply" }).fill("Yes: 50% off for registered charities.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(2);

  await expect(messages).toHaveCount(2, { timeout: 15_000 });
  await expect(messages.last()).toContainText("Yes: 50% off for registered charities.");

  // Back later in the same browser: their conversation is still there. But not before the page says
  // who's here (this time its sign-in never answers, so after 3 seconds): someone it's about to sign in
  // mustn't write as the visitor and lose sight of it.
  await visitor.context().addInitScript(() => {
    (window as unknown as { TutiSettings: unknown }).TutiSettings = { identify: () => new Promise(() => {}) };
  });
  await visitor.reload();
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await widget.getByRole("link", { name: "Messages" }).click();
  await expect(widget.getByText("Loading…")).toBeVisible();
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText("Is there a nonprofit discount?");
  // The page signs someone in after all, later than that: while their token's traded, the visitor
  // can't send (here Tuti never answers, so it stays that way), and what they'd typed stays.
  await widget.getByRole("button", { name: /Is there a nonprofit discount\?/ }).click();
  await widget.getByRole("textbox", { name: "Reply" }).fill("And for schools?");
  await visitor.route("**/*", (route) => (route.request().headers()["next-action"] ? undefined : route.fallback()));
  await visitor.evaluate(() => (window as unknown as { Tuti: { identify(getToken: () => string): void } }).Tuti.identify(() => "late-token"));
  await expect(widget.getByText("Loading…")).toBeVisible();
  await expect(widget.getByRole("textbox", { name: "Reply" })).toBeDisabled();
  await expect(widget.getByRole("textbox", { name: "Reply" })).toHaveValue("And for schools?");

  // Another browser has none of it.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(sitePage("customer.localhost", slug));
  await stranger.getByRole("button", { name: "Feedback" }).click();
  await stranger.frameLocator('iframe[title="Feedback"]').getByRole("link", { name: "Messages" }).click();
  await expect(stranger.frameLocator('iframe[title="Feedback"]').getByRole("textbox", { name: "Your email" })).toBeVisible();
  await expect(stranger.frameLocator('iframe[title="Feedback"]').getByRole("list", { name: "Conversations" })).toHaveCount(0);

  // A browser whose storage refuses writes still opens the conversation they start (for this visit).
  const blockedContext = await browser.newContext();
  await blockedContext.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Blocked", "SecurityError");
    };
  });
  const blocked = await blockedContext.newPage();
  await blocked.goto(sitePage("customer.localhost", slug));
  await blocked.getByRole("button", { name: "Feedback" }).click();
  const blockedWidget = blocked.frameLocator('iframe[title="Feedback"]');
  await blockedWidget.getByRole("link", { name: "Messages" }).click();
  await blockedWidget.getByRole("textbox", { name: "Your email" }).fill(`e2e-blocked-${slug}@example.com`);
  await blockedWidget.getByRole("textbox", { name: "Message" }).fill("Storage is off here");
  await blockedWidget.getByRole("button", { name: "Send" }).click();
  await expect(blockedWidget.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(1);
});


test("with the support inbox on, “Ask a person” in the widget starts a conversation the visitor finds in Messages", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  // An article close to the visitor's question, and the inbox on (no support email needed).
  const question = `How do I add a colleague to Acme ${slug}?`;
  const body = "Owners and admins send invites from the Team page.";
  await similar(question, `Inviting your team\n\n${body}`, 0.8);
  const article = await api("/articles", { title: "Inviting your team", body });
  await api(`/articles/${article.slug}/publish`, {});
  await api("/support", { inbox: true }, "PATCH");

  // A signed-out visitor asks the docs' AI; the answer doesn't help.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Docs" }).click();
  const search = widget.getByRole("searchbox", { name: "Search the docs" });
  await search.fill(question);
  await search.press("Enter");
  await nextModelReply(JSON.stringify({ answer: "Owners and admins send invites from the Team page.", sources: ["s1"] }), question);
  await widget.getByRole("button", { name: `Ask AI: ${question}` }).click();
  const ai = widget.getByRole("dialog", { name: "Assistant" }).getByRole("log", { name: "Conversation" });
  await expect(ai.getByText("Owners and admins send invites from the Team page.")).toBeVisible();
  await ai.getByRole("button", { name: "Not helpful" }).click();

  // They ask a person: it goes to the team's inbox, and the reply will be in Messages.
  await ai.getByRole("button", { name: "Ask a person" }).click();
  const form = ai.getByRole("form", { name: "Ask a person" });
  await expect(form).toContainText("They'll reply in Messages.");
  await form.getByRole("textbox", { name: "Your email" }).fill(`e2e-asker-${slug}@example.com`);
  await form.getByRole("textbox", { name: "Anything to add? (optional)" }).fill("I'm not an admin.");
  await nextModelReply("They want to invite a colleague but aren't an admin.", "not an admin");
  await form.getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByText("We've passed this to the team. Their reply will show in Messages.")).toBeVisible();
  await ai.getByRole("link", { name: "Open Messages" }).click();
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText(question);

  // The team sees the question, the AI's answer and, for them only, the AI's summary.
  await owner.goto(`/app/${slug}/inbox`);
  await owner.getByRole("link", { name: question }).click();
  await expect(owner.getByText(/started from an AI answer/)).toBeVisible();
  const messages = owner.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(messages).toHaveCount(3);
  await expect(messages.nth(0)).toContainText("I'm not an admin.");
  await expect(messages.nth(1)).toContainText("Owners and admins send invites from the Team page.");
  await expect(messages.nth(2)).toContainText("Note · AI");
  await expect(messages.nth(2)).toContainText("Summary: They want to invite a colleague but aren't an admin.");
  await checkpoint(owner, "escalated-conversation");

  // In the widget, the note isn't there.
  await widget.getByRole("button", { name: question }).click();
  await expect(widget.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(2);
});
