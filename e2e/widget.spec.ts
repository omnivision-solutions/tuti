import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";
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
  await ada.getByLabel("Title").fill("Dark mode");
  await ada.getByRole("button", { name: "Submit feedback" }).click();
  await expect(ada.getByRole("link", { name: "Dark mode" })).toBeVisible();

  // On another site the portal's cookies aren't sent, so the widget asks to sign in (in a new tab).
  await ada.goto(sitePage("customer.localhost", slug));
  const launcher = ada.getByRole("button", { name: "Feedback" });
  // The entry was announced, and this browser hasn't seen it: the button says so.
  await expect(launcher).toHaveAccessibleName("Feedback, new updates");
  await checkpoint(ada, "widget-new-updates");
  await launcher.click();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  const widget = ada.frameLocator('iframe[title="Feedback"]');
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
  await expect(widget.getByRole("link", { name: "Sign in to post feedback" })).toBeVisible();

  // Escape closes it and gives focus back to the button.
  await closeWithEscape(ada, ada.locator("#tuti-widget"));
  await expect(launcher).toBeFocused();

  // On the portal's own site (another port of the same host) the session comes along:
  // post, with suggestions while typing.
  await ada.goto(sitePage(`${slug}.localhost`, slug));
  await ada.getByRole("button", { name: "Feedback" }).click();
  await widget.getByLabel("Title").fill("Dark mode");
  const suggestions = widget.getByRole("status").filter({ hasText: "Already posted? Vote on it instead:" });
  await expect(suggestions.getByRole("link", { name: /Dark mode/ })).toHaveAttribute("target", "_blank");
  await checkpoint(ada, "widget-similar-while-typing");
  await widget.getByLabel("Title").fill("Export to CSV");
  await widget.getByRole("button", { name: "Submit feedback" }).click();
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
  await expect(widget.getByText("Posting as Sam from Acme")).toBeVisible();
  await widget.getByLabel("Title").fill("Calendar sync");
  await checkpoint(visitor, "widget-signed-in-with-sso");
  await widget.getByRole("button", { name: "Submit feedback" }).click();
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
  await expect(widget.getByText("Posting as Sam from Acme")).toBeVisible();
  await widget.getByRole("link", { name: "What's new" }).click();
  await expect(widget.getByText("Nothing new yet")).toBeVisible();
  await checkpoint(visitor, "widget-private-signed-in-with-sso");

  // Then the site's next token doesn't check out (someone else, an expired one): nobody's signed in,
  // not Sam still. Another part of the panel asks for it, as the docs' assistant does when opened.
  await widget.getByRole("link", { name: "Feedback" }).click();
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

  // Now the widget has a Docs tab: the collections (each opens its own list) and the articles in none.
  await visitor.reload();
  await launcher.click();
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

  // Search, read a result, and go back to the results.
  const search = widget.getByRole("searchbox", { name: "Search the docs" });
  await search.fill("invite");
  await widget.getByRole("button", { name: "Search" }).click();
  const results = widget.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await expect(results.getByRole("link", { name: "Exporting your data" })).toHaveCount(0);
  await checkpoint(visitor, "widget-docs-search");
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
  await widget.getByRole("button", { name: "Submit feedback" }).click();
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

  // Customize → Widget: a label, a colour, the left corner and a quick link (https only), beside the widget open on a stand-in for the site.
  await owner.goto(`/app/${slug}/customize/widget`);
  await expect(owner.frameLocator('iframe[title="Widget panel preview"]').getByRole("link", { name: "Feedback", exact: true })).toBeVisible();
  await owner.getByLabel("Button label").fill("Help & ideas");
  await owner.getByLabel("Colour", { exact: true }).fill("#5b21b6");
  await owner.getByLabel("Bottom left").check();
  await owner.getByRole("button", { name: "Add link" }).click();
  await owner.getByLabel("Link 1 label").fill("Status");
  await owner.getByLabel("Link 1 URL").fill("http://status.example.com");
  // The launcher in the preview changes as it's set.
  await expect(owner.getByRole("figure", { name: "Widget preview" }).getByText("Help & ideas", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Links need a full https:// address")).toBeVisible();
  await owner.getByLabel("Link 1 URL").fill("https://status.example.com");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await expect(owner.frameLocator('iframe[title="Widget panel preview"]').getByRole("link", { name: "Status" })).toBeVisible();
  // Saved, the launcher in the preview is the new one.
  await expect(owner.getByRole("figure", { name: "Widget preview" }).getByText("Help & ideas", { exact: true })).toBeVisible();
  await checkpoint(owner, "widget-settings");
  await owner.reload();
  await expect(owner.getByLabel("Button label")).toHaveValue("Help & ideas");
  await expect(owner.getByLabel("Link 1 URL")).toHaveValue("https://status.example.com");

  // On the customer's site: the team's launcher, and the quick link at the top of the panel.
  const visitor = await (await browser.newContext()).newPage();
  const site = sitePage("customer.localhost", slug);
  await visitor.goto(site);
  const launcher = visitor.getByRole("button", { name: "Help & ideas" });
  await expect(launcher).toHaveCSS("background-color", "rgb(91, 33, 182)");
  await expect(launcher).toHaveCSS("left", "20px");
  await checkpoint(visitor, "widget-custom-launcher");
  await launcher.click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  const status = widget.getByRole("navigation", { name: "Quick links" }).getByRole("link", { name: "Status" });
  await expect(status).toHaveAttribute("href", "https://status.example.com");
  await expect(status).toHaveAttribute("target", "_blank");
  await checkpoint(visitor, "widget-quick-links");
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
  const feedback = frames.nth(0).contentFrame();
  const whatsNew = frames.nth(1).contentFrame();
  await expect(feedback.getByRole("link", { name: "Sign in to post feedback" })).toBeVisible();
  await expect(whatsNew.getByText("Nothing new yet")).toBeVisible();
  await visitor.waitForFunction(() => "Tuti" in window);
  await expect(visitor.getByRole("button", { name: "Feedback" })).toHaveCount(0);
  expect((await frames.nth(0).boundingBox())!.height).toBeGreaterThanOrEqual(500);
  await checkpoint(visitor, "widget-inline");
  for (const frame of [feedback, whatsNew]) {
    await expect(frame.getByRole("link", { name: "What's new" })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Close" })).toHaveCount(0);
  }
  // Still none after moving to another tab inside the panel.
  await feedback.getByRole("link", { name: "What's new" }).click();
  await expect(feedback.getByText("Nothing new yet")).toBeVisible();
  await expect(feedback.getByRole("button", { name: "Close" })).toHaveCount(0);

  // Sidebar: the launcher opens a full-height drawer; Escape closes it, back to the button.
  await visitor.goto(`${site}?display=sidebar`);
  const launcher = visitor.getByRole("button", { name: "Feedback" });
  await launcher.click();
  const drawer = visitor.locator("#tuti-widget");
  const sidebar = drawer.locator("iframe").contentFrame();
  await expect(sidebar.getByRole("link", { name: "Sign in to post feedback" })).toBeVisible();
  const viewport = visitor.viewportSize()!;
  expect(await drawer.boundingBox()).toEqual({ x: viewport.width - 400, y: 0, width: 400, height: viewport.height });
  await checkpoint(visitor, "widget-sidebar");
  await closeWithEscape(visitor, drawer);
  await expect(launcher).toBeFocused();

  // On a narrow screen, over a backdrop that closes it; the close button does too.
  await visitor.setViewportSize({ width: 600, height: 800 });
  await launcher.click();
  await expect(sidebar.getByRole("link", { name: "Sign in to post feedback" })).toBeVisible();
  await checkpoint(visitor, "widget-sidebar-narrow", { fullPage: false });
  await visitor.mouse.click(100, 400);
  await expect(drawer).toBeHidden();
  await expect(launcher).toBeFocused();
  await launcher.click();
  await sidebar.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();
});
