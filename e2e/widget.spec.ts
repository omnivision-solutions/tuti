import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { spendCredits } from "./credits";
import { APP_URL, portalUrl, SUPPORT_EMAIL_DOMAIN } from "./env";
import { apiFor, createProject, newPerson, png, postFeedback, signUp } from "./helpers";
import { rawEmail, receive } from "./inbound";
import { latestEmailTo, linkIn } from "./mail";
import { heldModelReply, modelRequests, nextModelReply, releaseModelReply } from "./model";
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
// data-display, `?theme=dark` (or light, auto) data-theme, and each `?inline=<tab>` an inline mount at that tab (`?inline=`: the default).
const ssoSecrets = new Map<string, string>();

/** Escape closes the panel once it's hydrated, which may be a moment after what it shows is visible. */
async function closeWithEscape(page: Page, panel: Locator) {
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden({ timeout: 1_000 });
  }).toPass();
}

/**
 * Counts, from now, the widget script's answers to the panel's "what had they seen?" that arrive while the panel
 * shows `view` (Home's "2 new", What's new's unread marks), so a journey can wait for that view's own answer before
 * saying something isn't marked: not another view's, nor text the server rendered before any answer came. In the
 * panel's page now and any it loads next (a link clicked before the page is hydrated loads a new one).
 */
const counting = new WeakSet<Page>();
async function seenAnswers(page: Page, view: "home" | "whats-new") {
  type Counted = { seenAnswers: string[]; seenCounting?: boolean };
  const count = () => {
    const counted = window as unknown as Counted;
    if (!counted.seenCounting) {
      counted.seenCounting = true;
      counted.seenAnswers = [];
      addEventListener("message", (event) => {
        if (event.data?.type === "tuti:seen-before") counted.seenAnswers.push(location.search.includes("tab=whats-new") ? "whats-new" : "home");
      });
    }
  };
  if (!counting.has(page)) {
    counting.add(page);
    await page.addInitScript(count);
  }
  const frame = () => page.frames().find((frame) => new URL(frame.url()).pathname === "/widget")!;
  await frame().evaluate(count);
  await frame().evaluate(() => void ((window as unknown as Counted).seenAnswers = []));
  return () => frame().evaluate((view) => (window as unknown as Counted).seenAnswers.filter((answer) => answer === view).length, view);
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
    const theme = url.searchParams.get("theme");
    const scriptAttributes =
      (url.searchParams.has("hide-launcher") ? " data-hide-launcher" : "") +
      (display ? ` data-display="${word(display)}"` : "") +
      (theme ? ` data-theme="${word(theme)}"` : "");
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

type Sent = { method(): string; headers(): Record<string, string>; postData(): string | null };
/**
 * The panel trading `token` for a sign-in (a server action carrying it): not its other server actions, such as its
 * lists reloading for whoever's signed in now, which can still be on their way from a step before.
 */
const trades = (token: string) => (request: Sent) =>
  request.method() === "POST" && !!request.headers()["next-action"] && !!request.postData()?.includes(token);

test("a customer's site shows the widget: feedback and what's new", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
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
  // An earlier announcement, then the latest.
  expect((await api("/changelog", { title: "Faster search", body: "Results as you type." })).ok).toBe(true);
  expect((await api("/changelog/1/publish", {})).ok).toBe(true);
  // Long enough to be cut to two lines on its card.
  const darkModeBody = `Switch themes from your profile menu. ${"Every screen follows your system's setting until you pick one. ".repeat(6)}`;
  expect((await api("/changelog", { title: "Dark mode is here", body: darkModeBody, tags: ["new"] })).ok).toBe(true);
  // With a cover, uploaded in the team's editor.
  await owner.goto(`/app/${slug}/changelog/2`);
  const scratch = await owner.context().newPage();
  await scratch.setContent('<div id="cover" style="width:1200px;height:600px;background:#1d4ed8"></div>');
  const coverPicture = await scratch.locator("#cover").screenshot();
  await scratch.close();
  const sidebar = owner.getByRole("complementary", { name: "Entry settings" });
  await sidebar.getByLabel("Cover image", { exact: true }).setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: coverPicture });
  await expect(sidebar.getByRole("img", { name: "Cover image preview" })).toBeVisible();
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByText("Saved", { exact: true })).toBeVisible();
  expect((await api("/changelog/2/publish", {})).ok).toBe(true);
  // Ten quiet entries after it: the announcements still show in What's new (they're what the dot is about).
  for (let n = 3; n <= 12; n++) {
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
  // The tabs at the bottom (no Help center or Messages: there are no articles and the inbox is off), then the badge.
  const tabs = widget.getByRole("navigation", { name: "Widget" });
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Feedback"]);
  await expect(widget.getByRole("link", { name: /Powered by/ })).toHaveAttribute("href", "https://tuti.so");
  // What's new isn't a tab: Home's card, with the latest update and how many are new to this browser
  // (the announcement; quiet ones aren't news), opens it.
  const whatsNewCard = widget.getByRole("link", { name: /^What's new/ });
  await expect(whatsNewCard).toContainText("Quiet fix 12");
  await expect(whatsNewCard).toContainText("2 new");
  await checkpoint(ada, "widget-home");
  // Feedback: anyone may read the trending ideas; voting and posting sign in on the portal, in a new tab.
  await tabs.getByRole("link", { name: "Feedback" }).click();
  const ideas = widget.getByRole("region", { name: "Ideas" });
  await expect(ideas.getByRole("link", { name: "Dark mode" })).toHaveAttribute("target", "_blank");
  await expect(ideas.getByRole("link", { name: "Sign in to vote (1 vote)" })).toHaveAttribute("target", "_blank");
  await checkpoint(ada, "widget-feedback-signed-out");
  // Typing an idea shows the similar ones, to vote on instead.
  await widget.getByLabel("Title").fill("Dark mode");
  const similarIdeas = widget.getByRole("status").filter({ hasText: "Already posted? Vote on it instead:" });
  await expect(similarIdeas.getByRole("link", { name: "Sign in to vote (1 vote)" })).toBeVisible();
  await checkpoint(ada, "widget-feedback-similar-signed-out");
  await ada.emulateMedia({ colorScheme: "dark" });
  await checkpoint(ada, "widget-feedback-similar-signed-out-dark");
  await ada.emulateMedia({ colorScheme: "light" });
  // Posting comes back to the board on the portal, with the title typed.
  const [boardTab] = await Promise.all([ada.waitForEvent("popup"), widget.getByRole("button", { name: "Sign in to post" }).click()]);
  await boardTab.waitForURL(/\/sign-in\?/);
  const params = new URL(boardTab.url()).searchParams;
  expect([params.get("next"), params.get("title")]).toEqual(["/feedback/feature-requests", "Dark mode"]);
  await boardTab.close();

  // Someone not signed in votes: signing in, in the new tab, opens the idea, where the vote counts; the panel shows it.
  const bea = await signUp(browser, portalUrl(slug), "Bea");
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const visitorPanel = visitor.frameLocator('iframe[title="Feedback"]');
  const visitorIdeas = visitorPanel.getByRole("region", { name: "Ideas" });
  await visitorPanel.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  const [ideaTab] = await Promise.all([visitor.waitForEvent("popup"), visitorIdeas.getByRole("link", { name: "Sign in to vote (1 vote)" }).click()]);
  // Its script loaded, so the form signs in rather than sending itself as a page's address.
  await ideaTab.waitForLoadState("load");
  await ideaTab.getByLabel("Email").fill(bea.email);
  await ideaTab.getByRole("button", { name: "Use a password instead" }).click();
  await ideaTab.getByLabel("Password").fill("correct horse battery staple");
  await ideaTab.getByRole("button", { name: "Sign in", exact: true }).click();
  await ideaTab.getByRole("button", { name: "Upvote (1 vote)" }).click();
  await expect(ideaTab.getByRole("button", { name: "Remove vote (2 votes)" })).toBeVisible();
  await visitor.reload();
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await visitorPanel.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(visitorIdeas.getByRole("link", { name: "Sign in to vote (2 votes)" })).toBeVisible();
  await checkpoint(visitor, "widget-feedback-vote-counted");
  await visitor.emulateMedia({ colorScheme: "dark" });
  await checkpoint(visitor, "widget-feedback-vote-counted-dark");
  await Promise.all([visitor.context().close(), bea.context().close()]);

  await tabs.getByRole("link", { name: "Home" }).click();
  await whatsNewCard.click();
  // A card per update: the date, its tag, the title, the cover and two lines of it; the announcement unread.
  const darkMode = widget.getByRole("article", { name: "Dark mode is here" });
  await expect(darkMode.getByText("Unread")).toBeAttached();
  await expect(darkMode.getByText("New", { exact: true })).toBeVisible();
  const cover = darkMode.getByRole("img", { name: "Dark mode is here" });
  // Below the ten quiet ones: scrolled to, so its lazy image loads (and the screenshots show it).
  await cover.scrollIntoViewIfNeeded();
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  const excerpt = darkMode.getByText(/^Switch themes from your profile menu\./);
  await expect(excerpt).toBeVisible();
  const lines = await excerpt.evaluate((p) => ({ height: p.clientHeight, full: p.scrollHeight, line: parseFloat(getComputedStyle(p).lineHeight) }));
  expect(lines.height).toBeCloseTo(2 * lines.line, 0);
  expect(lines.full).toBeGreaterThan(lines.height);
  // Both announcements are listed and unread (the earlier one after the ten quiet ones), and quiet ones aren't news.
  await expect(widget.getByRole("article", { name: "Faster search" }).getByText("Unread")).toBeAttached();
  const quiet = widget.getByRole("article", { name: "Quiet fix 12" });
  await expect(quiet).toBeVisible();
  await expect(quiet.getByText("Unread")).toHaveCount(0);
  // Inside Home: its tab stays lit, with the way back.
  await expect(widget.getByText("What's new", { exact: true })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "true");
  const backHome = widget.locator("[data-widget-scroll]").getByRole("link", { name: "Home", exact: true });
  await checkpoint(ada, "widget-whats-new");
  // Seen now, here and after a reload.
  await expect(launcher).toHaveAccessibleName("Feedback");
  // Read more opens it in the panel, the way back to the list above it.
  await darkMode.getByRole("link", { name: "Read more about Dark mode is here" }).click();
  await expect(widget.getByRole("heading", { level: 1, name: "Dark mode is here" })).toBeVisible();
  // At its top, though the list was scrolled down to it.
  await expect(widget.getByRole("link", { name: "What's new", exact: true })).toBeInViewport();
  await expect(widget.getByText("Every screen follows your system's setting until you pick one.").first()).toBeVisible();
  await checkpoint(ada, "widget-whats-new-entry");
  await ada.emulateMedia({ colorScheme: "dark" });
  await checkpoint(ada, "widget-whats-new-entry-dark");
  await ada.emulateMedia({ colorScheme: "light" });
  // Not unread any more, once the widget's script has said what this browser has seen.
  const answers = await seenAnswers(ada, "whats-new");
  await widget.getByRole("link", { name: "What's new", exact: true }).click();
  await expect(darkMode).toBeVisible();
  await expect.poll(answers).toBeGreaterThan(0);
  await expect(darkMode.getByText("Unread")).toHaveCount(0);
  // Home and the list, dark and on a phone.
  await ada.emulateMedia({ colorScheme: "dark" });
  await checkpoint(ada, "widget-whats-new-dark");
  const answered = await seenAnswers(ada, "home");
  await backHome.click();
  await expect(widget.getByText("How can we help?")).toBeVisible();
  await expect.poll(answered).toBeGreaterThan(0);
  await expect(whatsNewCard).not.toContainText(/\d+ new/);
  await checkpoint(ada, "widget-home-dark");
  await ada.setViewportSize({ width: 390, height: 844 });
  await checkpoint(ada, "widget-home-phone-dark");
  await ada.emulateMedia({ colorScheme: "light" });
  await checkpoint(ada, "widget-home-phone");
  // Each view starts at its top: on a short screen, Home scrolled down, then What's new.
  await ada.setViewportSize({ width: 390, height: 400 });
  const scroller = widget.locator("[data-widget-scroll]");
  const scrolledBy = await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrolledBy).toBeGreaterThan(0);
  await whatsNewCard.click();
  await expect(widget.getByRole("heading", { name: "Dark mode is here" })).toBeAttached();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(backHome).toBeInViewport();
  await ada.setViewportSize({ width: 390, height: 844 });
  await expect(widget.getByRole("heading", { name: "Dark mode is here" })).toBeVisible();
  await checkpoint(ada, "widget-whats-new-phone");
  await ada.emulateMedia({ colorScheme: "dark" });
  await checkpoint(ada, "widget-whats-new-phone-dark");
  await ada.emulateMedia({ colorScheme: "light" });
  await ada.setViewportSize({ width: 1280, height: 720 });
  await ada.reload();
  await expect(launcher).toHaveAccessibleName("Feedback");
  await launcher.click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(widget.getByRole("button", { name: "Sign in to post" })).toBeVisible();

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
  // Mine: what she posted and voted for.
  await widget.getByRole("button", { name: "Mine" }).click();
  await expect(ideas.getByRole("link")).toHaveText(["Export to CSV", "Dark mode"]);
  // Each with where it stands.
  await expect(ideas.getByRole("listitem").first()).toContainText("Open");
  await checkpoint(ada, "widget-feedback-mine");
  await ada.emulateMedia({ colorScheme: "dark" });
  await checkpoint(ada, "widget-feedback-mine-dark");
  await ada.emulateMedia({ colorScheme: "light" });

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
  // His vote on it (an author's), which he takes back from the list; Mine still has it, as his.
  const ideas = widget.getByRole("region", { name: "Ideas" });
  await ideas.getByRole("button", { name: "Remove vote (1 vote)" }).click();
  await expect(ideas.getByRole("button", { name: "Upvote (0 votes)" })).toBeVisible();
  // The similar ideas as he types say so too.
  await widget.getByLabel("Title").fill("Calendar sync");
  const similarIdeas = widget.getByRole("status").filter({ hasText: "Already posted? Vote on it instead:" });
  await expect(similarIdeas.getByRole("button", { name: "Upvote (0 votes)" })).toBeVisible();
  // He votes there, and the list says so. Mine (held a moment) shows nothing until it comes, not the
  // trending list, and coming doesn't undo the vote on screen.
  await similarIdeas.getByRole("button", { name: "Upvote (0 votes)" }).click();
  await expect(similarIdeas.getByRole("button", { name: "Remove vote (1 vote)" })).toBeVisible();
  await expect(ideas.getByRole("button", { name: "Remove vote (1 vote)" })).toBeVisible();
  let releaseMine!: () => void;
  const mineHeld = new Promise<void>((resolve) => (releaseMine = resolve));
  const panelActions = (url: URL) => url.pathname === "/widget";
  await visitor.route(panelActions, async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await mineHeld;
    }
    await route.continue();
  });
  await widget.getByRole("button", { name: "Mine" }).click();
  await expect(ideas).toHaveAttribute("aria-busy", "true");
  await expect(ideas.getByRole("link")).toHaveCount(0);
  await checkpoint(visitor, "widget-feedback-mine-loading");
  releaseMine();
  await expect(ideas.getByRole("link")).toHaveText(["Calendar sync"]);
  await visitor.unroute(panelActions);
  await expect(similarIdeas.getByRole("button", { name: "Remove vote (1 vote)" })).toBeVisible();
  await checkpoint(visitor, "widget-feedback-mine-with-sso");

  // The page signs someone else in: nothing of Sam's shows for them, and the similar ideas are looked for again, as theirs.
  type Identify = { Tuti: { identify(getToken: () => Promise<string>): void } };
  await visitor.route("**/token/**", (route) =>
    route.fulfill({ contentType: "text/plain", body: ssoToken(secret, { sub: "app-user-8", name: "Kim from Acme", email: `e2e-kim-${slug}@example.com` }) }),
  );
  await visitor.evaluate((slug) => (window as unknown as Identify).Tuti.identify(() => fetch(`/token/${slug}`).then((r) => r.text())), slug);
  await expect(widget.getByText("Posting as Kim from Acme")).toBeVisible();
  await expect(ideas.getByText("Nothing of yours yet")).toBeVisible();
  await expect(similarIdeas.getByRole("button", { name: "Upvote (1 vote)" })).toBeVisible();
  await widget.getByRole("button", { name: "Trending" }).click();
  await expect(ideas.getByRole("button", { name: "Upvote (1 vote)" })).toBeVisible();
  await visitor.unroute("**/token/**");

  // Someone votes on the portal meanwhile: the similar ideas' newer answer shows, in both lists.
  const bea = await signUp(browser, portalUrl(slug), "Bea");
  await bea.goto("/feedback/feature-requests");
  await bea.getByRole("button", { name: "Upvote (1 vote)" }).click();
  // Saved once it's enabled again (the count changes at once): closing before then can drop the vote.
  await expect(bea.getByRole("button", { name: "Remove vote (2 votes)" })).toBeEnabled();
  await bea.context().close();
  await widget.getByLabel("Title").fill("Calendar");
  await widget.getByLabel("Title").fill("Calendar sync");
  await expect(similarIdeas.getByRole("button", { name: "Upvote (2 votes)" })).toBeVisible();
  await expect(ideas.getByRole("button", { name: "Upvote (2 votes)" })).toBeVisible();

  // A list that can't load says so, rather than looking empty.
  const failing = (url: URL) => url.pathname === "/widget";
  await visitor.route(failing, (route) =>
    route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue(),
  );
  await widget.getByRole("button", { name: "Mine" }).click();
  await expect(ideas.getByText("Couldn't load the ideas")).toBeVisible();
  await visitor.unroute(failing);

  // The post is Sam's, on the portal.
  await owner.goto(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(owner.getByRole("link", { name: "Calendar sync" })).toBeVisible();
  await expect(owner.getByText("Sam from Acme")).toBeVisible();

  // Then the site's next token doesn't check out (someone else, an expired one): nobody's posting,
  // not Sam still. Another part of the panel asks for it, as the docs' assistant does when opened.
  await visitor.route("**/token/**", (route) => route.fulfill({ contentType: "text/plain", body: "not-a-token" }));
  const asked = visitor.waitForResponse((response) => trades("not-a-token")(response.request()));
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
  const samToken = ssoToken(secret, { sub: "app-user-7", name: "Sam from Acme", email: samEmail(slug) });
  await visitor.unroute("**/token/**");
  await visitor.route("**/token/**", (route) => {
    tokens += 1;
    return route.fulfill({ contentType: "text/plain", body: tokens === 1 ? samToken : "not-a-token" });
  });
  const isSam = trades(samToken);
  const isExchange = (request: Sent) => isSam(request) || trades("not-a-token")(request);
  let releaseSam!: () => void;
  const samReleased = new Promise<void>((resolve) => (releaseSam = resolve));
  let answered = 0;
  visitor.on("response", (response) => isExchange(response.request()) && (answered += 1));
  await visitor.route(
    (url) => url.pathname === "/widget",
    async (route) => {
      if (isSam(route.request())) {
        await samReleased;
      }
      await route.continue();
    },
  );
  const samAsked = visitor.waitForRequest(isSam);
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
  // An announcement: new to whoever may read the portal, and nobody else hears of it.
  const api = await apiFor(owner, slug);
  await api("/changelog", { title: "Calendar sync is here", body: "Your events, both ways." });
  await api("/changelog/1/publish", {});
  await owner.goto(`/app/${slug}/settings/access`);
  await owner.getByRole("combobox", { name: "Portal access" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("Portal is now private")).toBeVisible();

  // The customer's site doesn't sign this visitor in: the panel shows nothing of the portal.
  const visitor = await (await browser.newContext()).newPage();
  const latest = visitor.waitForResponse((response) => response.url().includes("/api/widget/latest"));
  await visitor.goto(sitePage("customer.localhost", slug));
  await latest;
  await expect(visitor.getByRole("button", { name: "Feedback" })).toHaveAccessibleName("Feedback");
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  await expect(widget.getByText("Sign in to see this.", { exact: false })).toBeVisible();
  await expect(widget.getByRole("navigation", { name: "Widget" })).toHaveCount(0);
  await checkpoint(visitor, "widget-private-signed-out");

  // Once it signs them in (Tuti.identify), the panel shows the portal, on every tab.
  // The launcher's dot and Home's "1 new" say there's an update they haven't seen.
  ssoSecrets.set(slug, secret);
  await visitor.reload();
  await expect(visitor.getByRole("button", { name: /^Feedback/ })).toHaveAccessibleName("Feedback, new updates");
  await visitor.getByRole("button", { name: /^Feedback/ }).click();
  await expect(widget.getByRole("link", { name: /What's new/ })).toContainText("1 new");
  await checkpoint(visitor, "widget-private-whats-new");
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(widget.getByText("Posting as Sam from Acme")).toBeVisible();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Home" }).click();
  await expect(widget.getByText("How can we help?")).toBeVisible();
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
  await expect(widget.getByRole("link", { name: /^What's new/ })).toContainText("1 new");
  await widget.getByRole("link", { name: /^What's new/ }).click();
  await expect(widget.getByRole("article", { name: "Calendar sync is here" }).getByText("Unread")).toBeAttached();
  await expect(launcher).toHaveAttribute("aria-label", "Feedback");
  await checkpoint(phone, "widget-whats-new-seen");

  // On their laptop (another browser, nothing in its storage) it isn't new. It's recorded as
  // the panel shows it, so that may take a moment.
  const laptop = await (await browser.newContext()).newPage();
  await expect(async () => {
    await laptop.goto(site);
    await expect(laptop.getByRole("button", { name: "Feedback" })).toHaveAttribute("aria-label", "Feedback", { timeout: 5_000 });
  }).toPass();
  // Nor in its panel: Home counts nothing new, and the update isn't unread.
  await laptop.getByRole("button", { name: "Feedback" }).click();
  const laptopWidget = laptop.frameLocator('iframe[title="Feedback"]');
  await expect(laptopWidget.getByText("How can we help?")).toBeVisible();
  // Counting What's new's own answer: Home's (asked as it hydrates) says nothing about the list.
  const answered = await seenAnswers(laptop, "whats-new");
  await laptopWidget.getByRole("link", { name: /^What's new/ }).click();
  await expect(laptopWidget.getByRole("article", { name: "Calendar sync is here" })).toBeVisible();
  await expect.poll(answered).toBeGreaterThan(0);
  await expect(laptopWidget.getByRole("article", { name: "Calendar sync is here" }).getByText("Unread")).toHaveCount(0);
  await checkpoint(laptop, "widget-seen-on-another-device");
  await phone.context().close();
  await laptop.context().close();
});

test("the portal shows the project's own widget, until the team turns it off in Customize → Widget", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // On by default: the launcher on the portal's pages opens the panel. Its script tag is in the page as sent.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/");
  const script = visitor.locator('script[src*="/widget.js"][data-on-portal]');
  await expect(script).toHaveCount(1);
  const launcher = visitor.getByRole("button", { name: "Feedback" });
  await launcher.click();
  await expect(visitor.frameLocator('iframe[title="Feedback"]').getByRole("navigation", { name: "Widget" })).toBeVisible();
  await checkpoint(visitor, "portal-widget-open");
  // The portal's Ask AI is the widget's assistant: the panel opens with it (its box ready to type in), already open or not.
  const api = await apiFor(owner, slug);
  const article = await api("/articles", { title: "Getting started", body: "Install the app." });
  await api(`/articles/${article.slug}/publish`, {});
  await visitor.goto(`/docs/${article.slug}`);
  // `back`: where closing the panel gives focus (what opened it: the header's search, or the launcher when it was open already).
  const askAI = async (back = visitor.getByRole("banner").getByRole("button", { name: /^Search or ask AI/ })) => {
    await visitor.getByRole("banner").getByRole("button", { name: /^Search or ask AI/ }).click();
    await visitor.getByRole("dialog", { name: "Search or ask AI" }).getByRole("button", { name: "Open the assistant" }).click();
    const assistant = visitor.frameLocator('iframe[title="Feedback"]').getByRole("dialog", { name: "Assistant" });
    await expect(assistant.getByRole("textbox", { name: "Ask a question" })).toBeFocused();
    await assistant.getByRole("button", { name: "Close the assistant" }).click();
    await expect(assistant).toBeHidden();
    // Closed, the panel gives focus back (from the search dialog, gone by then, to the header's search).
    await visitor.keyboard.press("Escape");
    await expect(visitor.locator("#tuti-widget")).toBeHidden();
    await expect(back).toBeFocused();
  };
  await askAI();
  await visitor.reload();
  await launcher.click();
  await askAI(launcher);
  // On phones the page ends clear of the launcher (5.5rem); wider, it doesn't need to.
  await visitor.setViewportSize({ width: 390, height: 844 });
  await expect(visitor.locator("body")).toHaveCSS("padding-bottom", "88px");
  // There, an open panel is the whole screen, over the launcher: its tabs at the bottom right take taps.
  await visitor.reload();
  await launcher.click();
  const phonePanel = visitor.frameLocator('iframe[title="Feedback"]');
  await phonePanel.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(phonePanel.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  await visitor.reload();
  await visitor.setViewportSize({ width: 1280, height: 720 });
  await expect(visitor.locator("body")).toHaveCSS("padding-bottom", "0px");

  // Turned off, the portal has no launcher.
  await owner.goto(`/app/${slug}/customize/widget`);
  const onPortal = owner.getByRole("switch", { name: "Show on your portal" });
  await expect(onPortal).toBeChecked();
  await expect(owner.getByText("The launcher on every page of your portal too, opening the same panel as on your site.")).toBeVisible();
  await onPortal.scrollIntoViewIfNeeded();
  await checkpoint(owner, "customize-widget-on-portal", { fullPage: false });
  await onPortal.click();
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByRole("banner")).toBeVisible();
  await expect(launcher).toHaveCount(0);
  // Its script stays, without the launcher, for Ask AI; on phones the page needs no room for one.
  await expect(script).toHaveAttribute("data-hide-launcher", "");
  await askAI();
  await visitor.setViewportSize({ width: 390, height: 844 });
  await expect(visitor.locator("body")).toHaveCSS("padding-bottom", "0px");
  await visitor.setViewportSize({ width: 1280, height: 720 });

  // Back on. Signing out on the portal (a client navigation) loads the page afresh: the launcher and panel the loader added
  // for the signed-in reader don't stay for whoever's next.
  await api("/widget", { onPortal: true }, "PATCH");
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/");
  await ada.getByRole("button", { name: "Feedback" }).click();
  await expect(ada.locator("#tuti-widget")).toBeVisible();
  await ada.evaluate(() => Object.assign(window, { beforeSignOut: true }));
  await ada.getByRole("button", { name: "Account" }).click();
  await ada.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(ada.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect.poll(() => ada.evaluate(() => "beforeSignOut" in window)).toBe(false);
  await expect(ada.locator("#tuti-widget")).toBeHidden();

  // On a private portal: its sign-in page shows nothing of it to someone who may not read it, the widget included.
  await owner.goto(`/app/${slug}/settings/access`);
  await owner.getByRole("combobox", { name: "Portal access" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("Portal is now private")).toBeVisible();
  const outsider = await newPerson(browser, portalUrl(slug));
  await outsider.goto("/sign-in");
  await expect(outsider.getByRole("banner")).toBeVisible();
  await expect(outsider.locator("script[data-on-portal]")).toHaveCount(0);
  // A reader signed in there gets it; signing out lands on that sign-in page without it.
  const email = `e2e-${randomUUID()}@example.com`;
  await api("/portal/readers", { emails: [email], notify: false });
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/sign-in");
  await reader.getByLabel("Email").fill(email);
  await reader.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(reader.getByText("Check your email")).toBeVisible();
  await reader.goto(linkIn(await latestEmailTo(email), `${portalUrl(slug)}/sign-in/link?`));
  await reader.getByRole("main").getByRole("button", { name: "Sign in" }).click();
  await expect(reader.getByRole("button", { name: "Account" })).toBeVisible();
  const readerLauncher = reader.locator('body > button[aria-controls="tuti-widget"]');
  await expect(readerLauncher).toBeVisible();
  await reader.getByRole("button", { name: "Account" }).click();
  await reader.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(reader.getByText("Acme is private. Sign in to see it.")).toBeVisible();
  await expect(reader.locator("script[data-on-portal]")).toHaveCount(0);
  await expect(readerLauncher).toHaveCount(0);
});

test("a new message in the widget's Messages gets the AI's answer first, with Ask a person; turned off, it goes to the team", async ({ browser }, testInfo) => {
  // The AI's 20-second timeout is waited out once.
  test.setTimeout(150_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const question = `How do I add a colleague to Acme ${slug}?`;
  const body = "Owners and admins send invites from the Team page.";
  await similar(question, `Inviting your team\n\n${body}`, 0.8);
  const fourth = `How do I remove a colleague from Acme ${slug}?`;
  await similar(fourth, `Inviting your team\n\n${body}`, 0.8);
  await api("/support", { inbox: true }, "PATCH");

  // Nothing yet for the AI to answer from (sample articles are never embedded; a hidden one isn't read): a message goes
  // straight to the team, with the email box it needs.
  await owner.goto(`/app/${slug}`);
  await owner.getByRole("button", { name: "Add sample content" }).click();
  await expect(owner.getByText(/^Here to try things with, labelled Sample/)).toBeVisible();
  const hidden = await api("/articles", { title: "Internal notes", body: "Not for readers.", listing: "hidden" });
  await api(`/articles/${hidden.slug}/publish`, {});
  const early = await (await browser.newContext()).newPage();
  await early.goto(sitePage("customer.localhost", slug));
  await early.getByRole("button", { name: "Feedback" }).click();
  const earlyWidget = early.frameLocator('iframe[title="Feedback"]');
  await earlyWidget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Messages" }).click();
  await earlyWidget.getByRole("textbox", { name: "Your email" }).fill(`e2e-early-${slug}@example.com`);
  await earlyWidget.getByRole("textbox", { name: "Message" }).fill("Is there a phone number?");
  await earlyWidget.getByRole("button", { name: "Send" }).click();
  await expect(earlyWidget.getByRole("list", { name: "Messages" })).toContainText("Is there a phone number?");
  await expect(earlyWidget.getByRole("dialog", { name: "Assistant" })).toHaveCount(0);

  // AI only (no page, in no list): still something for the AI to answer from.
  const article = await api("/articles", { title: "Inviting your team", body, listing: "ai_only" });
  await api(`/articles/${article.slug}/publish`, {});

  // A visitor writes in Messages: the AI answers from the docs first, with Ask a person right there (no thumbs-down needed).
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Messages" }).click();
  await expect(widget.getByText("Ask anything: you'll get an answer right away, and a person if you need one.")).toBeVisible();
  await expect(widget.getByRole("textbox", { name: "Your email" })).toHaveCount(0);
  // A question, so no longer than one (without an email box, a longer message couldn't go to the team).
  await expect(widget.getByRole("textbox", { name: "Message" })).toHaveAttribute("maxlength", "300");
  await nextModelReply(JSON.stringify({ answer: "Owners and admins send invites from the Team page.", sources: ["s1"] }), question);
  await widget.getByRole("textbox", { name: "Message" }).fill(question);
  await widget.getByRole("button", { name: "Send" }).click();
  const ai = widget.getByRole("dialog", { name: "Assistant" }).getByRole("log", { name: "Conversation" });
  await expect(ai.getByText("Owners and admins send invites from the Team page.")).toBeVisible();
  await expect(ai.getByRole("button", { name: "Ask a person" })).toBeVisible();
  await checkpoint(visitor, "widget-messages-ai-first");

  // Asking a person starts the conversation, with the question and the AI's answer.
  await ai.getByRole("button", { name: "Ask a person" }).click();
  const form = ai.getByRole("form", { name: "Ask a person" });
  await form.getByRole("textbox", { name: "Your email" }).fill(`e2e-asker-${slug}@example.com`);
  await nextModelReply("They want to invite a colleague.", question);
  await form.getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByText("We've passed this to the team. Their reply will show in Messages.")).toBeVisible();
  await ai.getByRole("link", { name: "Open Messages" }).click();
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText(question);
  const close = widget.getByRole("button", { name: "Close the assistant" });
  // Messages' own Send (the assistant has one too).
  const send = widget.locator("form").filter({ has: widget.getByRole("textbox", { name: "Message" }) }).getByRole("button", { name: "Send" });

  // Their next message, a question of its own (not a follow-up to the first): Ask a person starts with the email they gave.
  // (Nothing in the docs is close to it: "I don't know", with Ask a person too.)
  const second = `Can I invite people in bulk to Acme ${slug}?`;
  await widget.getByRole("button", { name: "New message" }).click();
  // They correct their address in the box: Ask a person starts with that one.
  const corrected = `e2e-corrected-${slug}@example.com`;
  await widget.getByRole("textbox", { name: "Your email" }).fill(corrected);
  await widget.getByRole("textbox", { name: "Message" }).fill(second);
  await send.click();
  await expect(ai.getByText(second)).toBeVisible();
  await expect(ai.getByText("I don't know")).toBeVisible();
  await ai.getByRole("button", { name: "Ask a person" }).last().click();
  await expect(ai.getByRole("form", { name: "Ask a person" }).getByRole("textbox", { name: "Your email" })).toHaveValue(corrected);
  await nextModelReply("They want to invite people in bulk.", second);
  await ai.getByRole("form", { name: "Ask a person" }).getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByText("We've passed this to the team. Their reply will show in Messages.").last()).toBeVisible();
  // A follow-up asked in the assistant's own box doesn't change what focus goes back to.
  await widget.getByRole("dialog", { name: "Assistant" }).getByRole("textbox", { name: "Ask a follow-up" }).fill("And on mobile?");
  await widget.getByRole("dialog", { name: "Assistant" }).getByRole("textbox", { name: "Ask a follow-up" }).press("Enter");
  await expect(ai.getByText("I don't know")).toHaveCount(2);
  await close.click();
  // Its Send went with the form (sending went back to the list): focus goes to New message there.
  await expect(widget.getByRole("button", { name: "New message" })).toBeFocused();

  // Asking the AI fails (here, the request is cut off): Ask a person still reaches the team, with the message as it was.
  const third = `Do you have an API for Acme ${slug}?`;
  let cut = false;
  await visitor.route("**/widget**", async (route) => {
    // Only asking the AI the third question (a server action with it in its body), not the panel's own requests meanwhile.
    if (!cut && route.request().method() === "POST" && route.request().postData()?.includes(third)) {
      cut = true;
      await route.abort();
    } else {
      await route.fallback();
    }
  });
  // Behind the assistant, Messages went back to their list.
  await expect(widget.getByRole("list", { name: "Conversations" })).toBeVisible();
  await widget.getByRole("button", { name: "New message" }).click();
  await widget.getByRole("textbox", { name: "Message" }).fill(third);
  await send.click();
  await expect(ai.getByRole("button", { name: "Try again" })).toBeVisible();
  await ai.getByRole("button", { name: "Ask a person" }).last().click();
  const direct = ai.getByRole("form", { name: "Ask a person" });
  // No answer of the AI's to pass on: the form says only the question goes.
  await expect(direct).toContainText("We'll pass your question to the team. They'll reply in Messages.");
  await expect(direct.getByRole("textbox", { name: "Your email" })).toHaveValue(corrected);
  await direct.getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByText("We've passed this to the team. Their reply will show in Messages.")).toHaveCount(3);
  // Passed to the team, it isn't asked again (that would be a second way to the team for it).
  await expect(ai.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await visitor.unroute("**/widget**");
  // (The first question, passed to the team before, still says so: the latest.)
  await ai.getByRole("link", { name: "Open Messages" }).last().click();
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText(third);

  // The AI couldn't answer in time (its reply held past the timeout): Ask a person passes it on, and Try again goes.
  const late = `late-${slug}`;
  await heldModelReply(JSON.stringify({ answer: "Too late.", sources: ["s1"] }), fourth, late);
  await widget.getByRole("button", { name: "New message" }).click();
  await widget.getByRole("textbox", { name: "Message" }).fill(fourth);
  await send.click();
  await expect(ai.getByText("The AI couldn't answer just now.")).toBeVisible({ timeout: 40_000 });
  await releaseModelReply(late);
  await ai.getByRole("button", { name: "Ask a person" }).last().click();
  await nextModelReply("They want to remove a colleague.", fourth);
  await ai.getByRole("form", { name: "Ask a person" }).getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByText("We've passed this to the team. Their reply will show in Messages.")).toHaveCount(4);
  await expect(ai.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await close.click();
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText(fourth);

  // Longer than a question, a message goes straight to the team.
  const long = `Here is everything about our setup. ${"We run Acme across three offices with shared calendars. ".repeat(6)}`;
  await widget.getByRole("button", { name: "New message" }).click();
  await widget.getByRole("textbox", { name: "Message" }).fill(long);
  await send.click();
  await expect(widget.getByRole("list", { name: "Messages" })).toContainText("Here is everything about our setup.");
  await expect(widget.getByRole("dialog", { name: "Assistant" })).toHaveCount(0);

  // Turned off in Customize → Widget, a new message goes straight to the team.
  await owner.goto(`/app/${slug}/customize/widget`);
  const aiFirst = owner.getByRole("switch", { name: "Answer with AI first" });
  await expect(aiFirst).toBeChecked();
  await aiFirst.scrollIntoViewIfNeeded();
  await checkpoint(owner, "customize-widget-ai-first", { fullPage: false });
  await aiFirst.click();
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await visitor.reload();
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Messages" }).click();
  await widget.getByRole("button", { name: "New message" }).click();
  await widget.getByRole("textbox", { name: "Message" }).fill("Can I pay by invoice?");
  await send.click();
  await expect(widget.getByRole("list", { name: "Messages" })).toContainText("Can I pay by invoice?");
  await expect(widget.getByRole("dialog", { name: "Assistant" })).toHaveCount(0);

  // On, with Messages hidden (no Ask a person) but opened by the page's own code: a message goes to the team, not to an
  // assistant that couldn't pass it on.
  await api("/widget", { aiFirst: true, hidden: ["messages"] }, "PATCH");
  await visitor.reload();
  await visitor.evaluate(() => (window as unknown as { Tuti: { open: (options: object) => void } }).Tuti.open({ tab: "messages" }));
  await widget.getByRole("button", { name: "New message" }).click();
  // (Another address: this one has had the hour's emails it may get, a conversation each.)
  await widget.getByRole("textbox", { name: "Your email" }).fill(`e2e-status-${slug}@example.com`);
  await widget.getByRole("textbox", { name: "Message" }).fill("Do you have a status page?");
  await send.click();
  await expect(widget.getByRole("list", { name: "Messages" })).toContainText("Do you have a status page?");
  await expect(widget.getByRole("dialog", { name: "Assistant" })).toHaveCount(0);

  // On, with Messages shown, but the project is out of AI credits (its AI paused): a message goes to the team, not to an
  // assistant that would only say it's unavailable.
  await api("/widget", { hidden: [] }, "PATCH");
  await spendCredits(slug);
  await visitor.reload();
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Messages" }).click();
  await widget.getByRole("button", { name: "New message" }).click();
  await widget.getByRole("textbox", { name: "Your email" }).fill(`e2e-paused-${slug}@example.com`);
  await widget.getByRole("textbox", { name: "Message" }).fill("Can I change my plan?");
  await send.click();
  await expect(widget.getByRole("list", { name: "Messages" })).toContainText("Can I change my plan?");
  await expect(widget.getByRole("dialog", { name: "Assistant" })).toHaveCount(0);

  // The team's conversation for the second question is that question's own: the first isn't in it.
  await owner.goto(`/app/${slug}/inbox`);
  await owner.getByRole("main").getByRole("listitem").filter({ hasText: second }).getByRole("link").click();
  await expect(owner.getByRole("list", { name: "Messages" })).toContainText(second);
  await expect(owner.getByRole("list", { name: "Messages" })).not.toContainText(question);
});

test("someone signed in on the portal opens What's new in its widget: what's new to them stays marked while their visit is recorded", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/changelog", { title: "Calendar sync is here", body: "Your events, both ways." });
  await api("/changelog/1/publish", {});

  // On the portal's own site, its session comes along to the panel.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto(sitePage(`${slug}.localhost`, slug));
  await ada.getByRole("button", { name: "Feedback, new updates" }).click();
  const widget = ada.frameLocator('iframe[title="Feedback"]');
  await widget.getByRole("link", { name: /^What's new/ }).click();
  const unread = widget.getByRole("article", { name: "Calendar sync is here" }).getByText("Unread");
  await expect(unread).toBeAttached();
  // Her visit is recorded on the server once What's new shows, which refreshes the panel: the list is rendered again
  // with the time she has now seen up to. Still unread for the rest of this visit: that time is stored, not shown.
  await expect(widget.locator("[data-seen]")).toHaveAttribute("data-seen", /^\d{4}-/);
  await expect(unread).toHaveCount(1);
  await checkpoint(ada, "widget-whats-new-portal-session");
  // A link to an update that isn't there (taken down, or never was): it says so, with the way back to the list.
  await ada.goto(`${portalUrl(slug)}/widget?tab=whats-new&entry=999`);
  await expect(ada.getByText("This update isn't here")).toBeVisible();
  await expect(ada.getByText("It may have been taken down.")).toBeVisible();
  await checkpoint(ada, "widget-whats-new-entry-missing");
  await ada.getByRole("link", { name: "What's new", exact: true }).click();
  await expect(ada.getByRole("article", { name: "Calendar sync is here" })).toBeVisible();
});

test("someone signed in on the portal opens its widget: Home greets them by their first name, unless the page signs someone in", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  const secret = await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText();

  // On the portal's own site, its session comes along to the panel; the page signs nobody in.
  const rita = await signUp(browser, portalUrl(slug), "Rita Reader");
  // Its timers run as usual until the journey moves them on.
  await rita.clock.install();
  await rita.goto(sitePage(`${slug}.localhost`, slug));
  await rita.getByRole("button", { name: "Feedback" }).click();
  const widget = rita.frameLocator('iframe[title="Feedback"]');
  const ritaGreeting = widget.getByText("Hi Rita 👋");
  await expect(ritaGreeting).toBeVisible();
  await checkpoint(rita, "widget-home-portal-reader");
  await rita.emulateMedia({ colorScheme: "dark" });
  await checkpoint(rita, "widget-home-portal-reader-dark");
  await rita.emulateMedia({ colorScheme: "light" });
  await rita.setViewportSize({ width: 390, height: 844 });
  await checkpoint(rita, "widget-home-portal-reader-phone");
  await rita.setViewportSize({ width: 1280, height: 720 });

  // While another tab is open the page signs Sam in, slowly: back on Home, nobody's named until it's done (even
  // once the panel has stopped waiting for its answer), then Sam is.
  ssoSecrets.set(slug, secret);
  const tabs = widget.getByRole("navigation", { name: "Widget" });
  await tabs.getByRole("link", { name: "Feedback" }).click();
  await expect(widget.getByRole("heading", { name: "Suggest an idea" })).toBeVisible();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await rita.route("**/token/**", async (route) => {
    await released;
    await route.fallback();
  });
  type Identify = { Tuti: { identify(getToken: () => Promise<string>): void } };
  await rita.evaluate((slug) => (window as unknown as Identify).Tuti.identify(() => fetch(`/token/${slug}`).then((r) => r.text())), slug);
  await tabs.getByRole("link", { name: "Home" }).click();
  await expect(widget.getByText("Hi there 👋")).toBeVisible();
  await rita.clock.fastForward(5_000);
  await expect(widget.getByText("Hi there 👋")).toBeVisible();
  await expect(ritaGreeting).toHaveCount(0);
  release();
  await expect(widget.getByText("Hi Sam 👋")).toBeVisible();
  await expect(ritaGreeting).toHaveCount(0);
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
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Feedback"]);

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
  await tabs.getByRole("link", { name: "Help center" }).click();
  const collections = widget.getByRole("list", { name: "Collections" });
  await expect(collections).toContainText("The basics, in five minutes.");
  // A card, as on Home, with how many articles are in it.
  await expect(collections.getByRole("link", { name: /Getting started/ })).toContainText("1 article");
  await expect(collections.getByRole("link", { name: /Getting started/ })).toHaveCSS("border-top-style", "solid");
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
  await expect(search).toHaveAttribute("placeholder", "Search docs");
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
  await tabs.getByRole("link", { name: "Home" }).click();
  await tabs.getByRole("link", { name: "Help center" }).click();
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
  // Reporting counts what they searched for: "export" (from Home), "refunds" and "billing" (Enter),
  // "invite" (typed, then a result opened) and its results again (going back); not what they typed on the way.
  await owner.goto(`/app/${slug}/reporting/searches`);
  const stat = (label: string) => owner.getByRole("group", { name: label, exact: true });
  await expect(async () => {
    await owner.reload();
    await expect(stat("Searches")).toContainText("5", { timeout: 2_000 });
    await expect(stat("Found nothing")).toContainText("2", { timeout: 2_000 });
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
  // "Ask a person" starts a conversation in the inbox, so it's on with Messages.
  const set = await fetch(`${APP_URL}/api/v1/support`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ inbox: true }),
  });
  expect(set.ok).toBe(true);

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Help center" }).click();
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
  // address before it does. Once it does, the conversation is theirs: their address replaces it, read-only.
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
  await expect(form.getByLabel("Your email")).toHaveValue(samEmail(slug));
  await expect(form.getByLabel("Your email")).toHaveAttribute("readonly");
  await form.getByLabel("Anything to add? (optional)").fill("I'm on the free plan.");
  await checkpoint(visitor, "widget-docs-ask-a-person");
  await nextModelReply("They want to add a colleague on the free plan.", question);
  await form.getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByText("We've passed this to the team. Their reply will show in Messages.")).toBeVisible();
  await checkpoint(visitor, "widget-docs-asked-a-person");
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
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Help center" }).click();
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
    await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Help center" }).click();
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
  // With Feedback turned off in the widget (Customize → Widget), the assistant doesn't offer to post as feedback.
  const postAsFeedback = ai.getByRole("link", { name: "Post this as feedback" });
  await expect(postAsFeedback).toHaveCount(1);
  const showFeedback = async (shown: boolean) => {
    const response = await fetch(`${APP_URL}/api/v1/widget`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ hidden: shown ? [] : ["feedback"] }),
    });
    expect(response.ok).toBe(true);
  };
  await showFeedback(false);
  await openAssistant();
  await expect(ai.getByText("Only owners and admins can send invites.")).toBeVisible();
  await expect(postAsFeedback).toHaveCount(0);
  await showFeedback(true);

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
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Help center" }).click();
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
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Help center" }).click();
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
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Help center" }).click();
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

  // Customize → Widget: a name, a colour, the left corner, an icon and a quick link (https only), beside a stand-in for the
  // site with the widget open above its launcher, what the team came to see (focus stays on the page).
  await owner.goto(`/app/${slug}/customize/widget`);
  const previewLauncher = (name: string) => owner.getByRole("figure", { name: "Widget preview" }).getByRole("button", { name: `Launcher: ${name}` });
  await expect(previewLauncher("Feedback")).toHaveAttribute("aria-expanded", "true");
  await expect(owner.frameLocator('iframe[title="Widget panel preview"]').getByRole("link", { name: "Feedback", exact: true })).toBeVisible();
  await expect(owner.locator('iframe[title="Widget panel preview"]')).not.toBeFocused();
  await checkpoint(owner, "widget-preview-open");
  // The script tag for the team's site, to copy.
  await owner.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await owner.getByRole("button", { name: "Copy the widget's script tag" }).click();
  await expect(owner.getByText("Copied")).toBeVisible();
  expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(`<script src="${APP_URL}/widget.js" data-project="${slug}" async></script>`);
  await owner.getByLabel("Button name").fill("Help & ideas");
  // The colour as hex beside its swatch, kept in step: #rgb is read as #rrggbb, and what isn't a colour says so.
  const hex = owner.getByLabel("Colour", { exact: true });
  await hex.fill("#abc");
  await expect(owner.getByLabel("Colour picker")).toHaveValue("#aabbcc");
  await hex.blur();
  await expect(hex).toHaveValue("#aabbcc");
  await hex.fill("purple");
  await hex.blur();
  await expect(owner.getByText("Type a hex colour, such as #2563eb.")).toBeVisible();
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await checkpoint(owner, "widget-colour-not-hex");
  // Neither saves (the swatch's last colour would): the browser sends focus back to the field instead. Empty too.
  for (const typed of ["purple", ""]) {
    await hex.fill(typed);
    await owner.getByRole("button", { name: "Save changes" }).click();
    await expect(hex).toBeFocused();
    expect(await hex.evaluate((field) => field.matches(":invalid"))).toBe(true);
  }
  // Back to the default: its button goes, and focus is on the hex it set.
  await owner.getByRole("button", { name: "Use the default green" }).click();
  await expect(hex).toHaveValue("#12804a");
  await expect(hex).toBeFocused();
  await owner.getByLabel("Colour picker").fill("#5b21b6");
  await expect(hex).toHaveValue("#5b21b6");
  await expect(owner.getByText("Type a hex colour, such as #2563eb.")).toHaveCount(0);
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
  const previewLinks = owner.frameLocator('iframe[title="Widget panel preview"]').getByRole("navigation", { name: "Quick links" });
  await expect(previewLinks.getByRole("link")).toHaveText(["Averyverylongquicklinklabelwithnospaces1"]);
  await owner.getByLabel("Link 1 URL").fill("https://status.example.com");
  // The open panel shows the quick links as they're set, before they're saved (https ones, as saving takes).
  await expect(previewLinks.getByRole("link")).toHaveText(["Status", "Averyverylongquicklinklabelwithnospaces1"]);
  // So do Home's greeting and heading, and the parts it shows: Feedback off, its card and tab go.
  const previewPanel = owner.frameLocator('iframe[title="Widget panel preview"]');
  await owner.getByLabel("Greeting").fill("Welcome to Acme");
  await owner.getByLabel("Heading").fill("Questions about Acme?");
  await owner.getByRole("switch", { name: "Feedback", exact: true }).click();
  await expect(previewPanel.getByText("Welcome to Acme")).toBeVisible();
  await expect(previewPanel.getByText("Questions about Acme?")).toBeVisible();
  await expect(previewPanel.getByRole("navigation", { name: "Widget" }).getByRole("link")).toHaveText(["Home", "Help center"]);
  await expect(previewPanel.getByRole("link", { name: /Share an idea/ })).toHaveCount(0);
  await owner.getByLabel("Heading").scrollIntoViewIfNeeded();
  await checkpoint(owner, "widget-home-settings", { fullPage: false });
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await expect(owner.frameLocator('iframe[title="Widget panel preview"]').getByRole("link", { name: "Status" })).toBeVisible();
  // Saved, the launcher in the preview is the new one.
  await expect(previewLauncher("Help & ideas").locator("path")).toHaveCount(3);
  await checkpoint(owner, "widget-settings");
  // The launcher names the panel it opens.
  const panelId = await owner.locator('iframe[title="Widget panel preview"]').getAttribute("id");
  await expect(previewLauncher("Help & ideas")).toHaveAttribute("aria-controls", panelId!);
  // Clicked again, it closes (the panel goes, so nothing runs in it unseen).
  await previewLauncher("Help & ideas").click();
  await expect(owner.locator('iframe[title="Widget panel preview"]')).toHaveCount(0);
  // The panel's own Close closes it too.
  await previewLauncher("Help & ideas").click();
  // Retried with its check: a click before the panel's page is ready does nothing.
  await expect(async () => {
    await owner.frameLocator('iframe[title="Widget panel preview"]').getByRole("button", { name: "Close" }).click({ timeout: 2_000 });
    await expect(owner.locator('iframe[title="Widget panel preview"]')).toHaveCount(0, { timeout: 1_000 });
  }).toPass();
  await expect(previewLauncher("Help & ideas")).toHaveAttribute("aria-expanded", "false");
  await expect(previewLauncher("Help & ideas")).toBeFocused();
  // Opened from the keyboard, focus goes into the panel.
  await owner.keyboard.press("Enter");
  await expect(owner.locator('iframe[title="Widget panel preview"]')).toBeFocused();
  // And Escape there closes it, back on the launcher.
  await expect(async () => {
    await owner.keyboard.press("Escape");
    await expect(owner.locator('iframe[title="Widget panel preview"]')).toHaveCount(0, { timeout: 1_000 });
  }).toPass();
  await expect(previewLauncher("Help & ideas")).toHaveAttribute("aria-expanded", "false");
  await expect(previewLauncher("Help & ideas")).toBeFocused();
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
  // The panel is named after its button, and opens at the team's Home: their words, without Feedback.
  const widget = visitor.frameLocator('iframe[title="Help & ideas"]');
  await expect(widget.getByText("Questions about Acme?")).toBeVisible();
  await expect(widget.getByRole("navigation", { name: "Widget" }).getByRole("link")).toHaveText(["Home", "Help center"]);
  const status = widget.getByRole("navigation", { name: "Quick links" }).getByRole("link", { name: "Status" });
  await expect(status).toHaveAttribute("href", "https://status.example.com");
  await expect(status).toHaveAttribute("target", "_blank");
  await checkpoint(visitor, "widget-quick-links");
  // In a narrow panel a long label wraps, its icon inside the panel.
  await visitor.setViewportSize({ width: 360, height: 720 });
  const icon = widget.getByRole("link", { name: /Averyverylong/ }).locator("svg");
  const panel = (await visitor.locator("#tuti-widget").boundingBox())!;
  expect((await icon.boundingBox())!.x + (await icon.boundingBox())!.width).toBeLessThanOrEqual(panel.x + panel.width);
  // On a phone the panel is the whole screen, over the launcher (its own close button at the top).
  await expect.poll(() => visitor.locator("#tuti-widget").boundingBox()).toEqual({ x: 0, y: 0, width: 360, height: 720 });
  const button = (await launcher.boundingBox())!;
  expect(await visitor.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("#tuti-widget") !== null, [button.x + button.width / 2, button.y + button.height / 2])).toBe(true);
  // Its page is up with its own Close: the loader's stand-in (for a page that never comes) is gone.
  await expect(visitor.locator('#tuti-widget > button[aria-label="Close"]')).toBeHidden();
  await checkpoint(visitor, "widget-phone", { fullPage: false });
  // Wide again: floating above the launcher, on its side.
  await visitor.setViewportSize({ width: 1280, height: 720 });
  await expect(visitor.locator("#tuti-widget")).toHaveCSS("left", "20px");
  await expect(visitor.locator("#tuti-widget")).toHaveCSS("width", "400px");
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
  // What's new isn't a tab any more: the old tab opens Home's list, Home lit.
  await expect(widget.getByText("Nothing new yet")).toBeVisible();
  await expect(widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "true");
  await checkpoint(visitor, "widget-own-button");
  await visitor.evaluate(() => (window as unknown as { Tuti: TutiSdk }).Tuti.close());
  await expect(visitor.locator("#tuti-widget")).toBeHidden();
  await expect(visitor.getByRole("button", { name: "Our feedback button" })).toBeFocused();

  // The team's own icon: uploaded and saved, then removed, which picks the chat bubble again; later saves still work.
  await owner.getByText("Your own", { exact: true }).click();
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await owner.getByLabel("Your icon", { exact: true }).setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: pixel });
  await expect(owner.getByRole("img", { name: "Your icon preview" })).toBeVisible();
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  // From the keyboard: the field hides as it goes, so focus moves to the chat bubble's choice.
  await owner.getByRole("button", { name: "Remove", exact: true }).focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("radio", { name: "Chat" })).toBeChecked();
  await expect(owner.getByRole("radio", { name: "Chat" })).toBeFocused();
  // Each save's answer before the next change (one made meanwhile would count as saved).
  const saved = () => owner.waitForResponse((response) => response.request().method() === "POST" && !!response.request().headers()["next-action"]);
  let answered = saved();
  await owner.getByRole("button", { name: "Save changes" }).click();
  await answered;
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await owner.getByLabel("Colour", { exact: true }).fill("#0f766e");
  answered = saved();
  await owner.getByRole("button", { name: "Save changes" }).click();
  await answered;
  await owner.reload();
  await expect(owner.getByRole("radio", { name: "Chat" })).toBeChecked();
  await expect(owner.getByLabel("Colour", { exact: true })).toHaveValue("#0f766e");
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
    await expect(frame.getByRole("navigation", { name: "Widget" }).getByRole("link")).toHaveText(["Home", "Feedback"]);
    await expect(frame.getByRole("button", { name: "Close" })).toHaveCount(0);
  }
  // Still none after going back to Home from What's new inside the panel.
  await whatsNew.locator("[data-widget-scroll]").getByRole("link", { name: "Home", exact: true }).click();
  await expect(whatsNew.getByText("How can we help?")).toBeVisible();
  await expect(whatsNew.getByRole("button", { name: "Close" })).toHaveCount(0);

  // Sidebar: the launcher opens a full-height drawer; Escape closes it, back to the button.
  await visitor.goto(`${site}?display=sidebar`);
  const launcher = visitor.getByRole("button", { name: "Feedback" });
  await launcher.click();
  const drawer = visitor.locator("#tuti-widget");
  const sidebar = drawer.locator("iframe").contentFrame();
  await expect(sidebar.getByText("How can we help?")).toBeVisible();
  const viewport = visitor.viewportSize()!;
  // Once it has slid in.
  await expect.poll(() => drawer.boundingBox()).toEqual({ x: viewport.width - 400, y: 0, width: 400, height: viewport.height });
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

  // A site with one look picks it (data-theme), whatever the visitor's device says (light here): inline
  // panels, still with nothing to close, and the floating one, on every page they go to.
  await visitor.setViewportSize(viewport);
  await visitor.goto(`${site}?inline=&theme=dark`);
  const themed = visitor.locator("[data-tuti-inline] iframe").contentFrame();
  await expect(themed.getByText("How can we help?")).toBeVisible();
  const html = themed.locator("html");
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(themed.getByRole("button", { name: "Close" })).toHaveCount(0);
  await themed.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(themed.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  await expect(html).toHaveClass(/\bdark\b/);
  // A page it loads as a whole new one (a reload, a form) too, from its first paint: its class as its content
  // is parsed, long before React runs (at the end of the page).
  await visitor.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (document.querySelector("[data-widget-scroll]")) {
        (window as unknown as { firstClass: string }).firstClass = document.documentElement.className;
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const inlineFrame = visitor.frames().find((frame) => frame.name() === "tuti-inline:dark")!;
  await inlineFrame.evaluate(() => location.reload());
  await expect.poll(() => inlineFrame.evaluate(() => (window as unknown as { firstClass?: string }).firstClass ?? "")).toMatch(/\bdark\b/);
  await expect(html).toHaveClass(/\bdark\b/);
  await checkpoint(visitor, "widget-inline-dark");
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const floating = visitor.locator("#tuti-widget iframe").contentFrame();
  await expect(floating.getByText("How can we help?")).toBeVisible();
  await expect(floating.locator("html")).toHaveClass(/\bdark\b/);
  await checkpoint(visitor, "widget-dark");

  // The site switches its own look without a reload (Tuti.setTheme): both panels follow at once, and keep it on the pages after.
  const setTheme = (theme: string) => visitor.evaluate((theme) => (window as unknown as { Tuti: { setTheme(theme: string): void } }).Tuti.setTheme(theme), theme);
  await setTheme("light");
  await expect(floating.locator("html")).not.toHaveClass(/\bdark\b/);
  await expect(html).not.toHaveClass(/\bdark\b/);
  const floatingFeedback = floating.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" });
  await floatingFeedback.click();
  await expect(floatingFeedback).toHaveAttribute("aria-current", "page");
  await expect(floating.locator("html")).not.toHaveClass(/\bdark\b/);
  await checkpoint(visitor, "widget-set-theme-light");
  // A whole new page in it (the panel renames its own frame: the page's renaming the iframe doesn't reach it in Chromium).
  await visitor.evaluate(() => (window as unknown as { Tuti: { open(options: object): void } }).Tuti.open({ tab: "whats-new" }));
  await expect(floating.getByText("Nothing new yet")).toBeVisible();
  await expect(floating.locator("html")).not.toHaveClass(/\bdark\b/);
  // Changed as the panel opens, before its page listens: it asks once it does.
  await visitor.goto(`${site}?theme=dark`);
  await visitor.waitForFunction(() => "Tuti" in window);
  await visitor.evaluate(() => {
    const tuti = (window as unknown as { Tuti: { open(): void; setTheme(theme: string): void } }).Tuti;
    tuti.open();
    tuti.setTheme("light");
  });
  await expect(floating.getByText("How can we help?")).toBeVisible();
  await expect(floating.locator("html")).not.toHaveClass(/\bdark\b/);

  // Where the site picks none, the project's colour scheme (Customize → Branding) wins over the visitor's device (light).
  const api = await apiFor(owner, slug);
  await api("/branding", { colorScheme: "dark" }, "PATCH");
  await visitor.goto(`${site}?inline=`);
  await expect(themed.getByText("How can we help?")).toBeVisible();
  await expect(html).toHaveClass(/\bdark\b/);
  // From its first paint, before React runs (firstClass, from the init script above).
  const projectFrame = visitor.frames().find((frame) => frame.name() === "tuti-inline")!;
  await expect.poll(() => projectFrame.evaluate(() => (window as unknown as { firstClass?: string }).firstClass ?? "")).toMatch(/\bdark\b/);
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await expect(floating.getByText("How can we help?")).toBeVisible();
  await expect(floating.locator("html")).toHaveClass(/\bdark\b/);
  // The site's pick wins over it; auto is the project's again.
  await setTheme("light");
  await expect(floating.locator("html")).not.toHaveClass(/\bdark\b/);
  await setTheme("auto");
  await expect(floating.locator("html")).toHaveClass(/\bdark\b/);
  await expect(html).toHaveClass(/\bdark\b/);
  await checkpoint(visitor, "widget-project-dark");
});

test("with the support inbox on, someone the page signs in messages the team from the widget and sees the reply", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
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

  // Customize → Widget and the Inbox say so, the Inbox with the way to turn it on.
  const off = owner.getByRole("note").filter({ hasText: "Messages in the widget is off, so the widget has no Messages tab." });
  await owner.goto(`/app/${slug}/customize/widget`);
  await expect(off).toBeVisible();
  await checkpoint(owner, "customize-widget-messages-off");
  await owner.goto(`/app/${slug}/inbox`);
  await expect(off).toBeVisible();
  await checkpoint(owner, "inbox-messages-off");
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(off).toBeInViewport();
  await checkpoint(owner, "inbox-messages-off-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await off.getByRole("link", { name: "Turn it on" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/support`);
  await owner.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(owner.getByText("Messages on")).toBeVisible();

  // Sam writes to the team (in a new browser: the script reads whether the inbox is on once a minute at most).
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  await visitor.getByRole("button", { name: "Feedback" }).click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  // Home's way in (no reply time yet, so nothing under it), then the tab.
  await expect(widget.getByRole("link", { name: /Send us a message/ })).not.toContainText(/repl/i);
  await widget.getByRole("link", { name: /Send us a message/ }).click();
  await expect(widget.getByText("No messages yet")).toBeVisible();
  await widget.getByRole("button", { name: "New message" }).click();
  await widget.getByRole("textbox", { name: "Message" }).fill("How do I export my data? (I tried https://example.com/help/export.)");
  // With a screenshot: it uploads as it's attached, and goes with the message.
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await widget.locator('input[type="file"]').setInputFiles({ name: "screenshot.png", mimeType: "image/png", buffer: pixel });
  await expect(widget.getByRole("list", { name: "Files to send" })).toContainText(/screenshot\.png\s*1 KB/);
  await widget.getByRole("button", { name: "Send" }).click();
  await expect(widget.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(1);
  await expect(widget.getByRole("list", { name: "Messages" })).toContainText("You");
  await expect(widget.getByRole("img", { name: "screenshot.png" })).toBeVisible();
  // Its title was made from the message (shown in full below it): two lines at most.
  const title = widget.getByRole("heading", { level: 2, name: "How do I export my data? (I tried https://example.com/help/export.)" });
  expect(await title.evaluate((h) => [getComputedStyle(h).webkitLineClamp, h.clientHeight <= parseFloat(getComputedStyle(h).lineHeight) * 2.5])).toEqual(["2", true]);
  // Where the reply comes: here, and by email if Sam has left (turning Messages on gave the project its support address). No reply time yet.
  const replyWhere = widget.getByText(/^We'll reply here/);
  await expect(replyWhere).toHaveText(`We'll reply here. If you've left, we'll email you at ${samEmail(slug)}.`);
  // Said to screen readers as it appears: a polite live region.
  await expect(replyWhere).toHaveRole("status");
  // The reply box at the bottom of the panel, above its tabs, though there's one short message.
  const replyBox = (await widget.getByRole("textbox", { name: "Reply" }).boundingBox())!;
  const panelTabs = (await widget.getByRole("navigation", { name: "Widget" }).boundingBox())!;
  expect(panelTabs.y - (replyBox.y + replyBox.height)).toBeLessThan(80);
  await checkpoint(visitor, "widget-message-sent");
  await visitor.setViewportSize({ width: 390, height: 844 });
  await checkpoint(visitor, "widget-message-sent-phone");
  await visitor.setViewportSize({ width: 1280, height: 720 });
  await owner.goto(`/app/${slug}/inbox`);
  await expect(off).toHaveCount(0);
  // A row opens by its link (who it's with), found by its subject.
  await owner.getByRole("main").getByRole("listitem").filter({ hasText: "How do I export my data?" }).getByRole("link").click();
  await expect(owner.getByRole("img", { name: "screenshot.png" })).toBeVisible();
  await expect(owner.getByText(/Sam from Acme \(e2e-sam-.*\) · started from the widget/)).toBeVisible();
  // The address in it is a link, opening in a new tab, without the brackets and full stop around it: what customers write isn't vouched for.
  const theirs = owner.getByRole("list", { name: "Messages" }).getByRole("link", { name: "https://example.com/help/export" });
  await expect(theirs).toHaveAttribute("href", "https://example.com/help/export");
  await expect(theirs).toHaveAttribute("target", "_blank");
  await expect(theirs).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
  await checkpoint(owner, "inbox-message-link");
  // Sam has the widget open: they're online.
  await expect(owner.getByText("Online", { exact: true })).toBeVisible();
  await owner.getByRole("textbox", { name: "Reply" }).fill("Settings → Export, then Download: https://example.com/docs/export");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(2);

  // The reply shows in the open widget as it's sent (live: well before its 10-second fallback check).
  const messages = widget.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(messages).toHaveCount(2, { timeout: 4_000 });
  await expect(messages.last()).toContainText("Olive Owner");
  await expect(messages.last()).toContainText("Settings → Export, then Download: https://example.com/docs/export");
  // Answered: no need to say where the reply comes.
  await expect(replyWhere).toHaveCount(0);
  // Its link opens in a new tab.
  const ours = messages.last().getByRole("link", { name: "https://example.com/docs/export" });
  await expect(ours).toHaveAttribute("href", "https://example.com/docs/export");
  await expect(ours).toHaveAttribute("target", "_blank");
  await expect(ours).toHaveAttribute("rel", "noopener noreferrer");
  await checkpoint(visitor, "widget-messages");

  // And Sam's answer shows on the team's open page without reloading it.
  await widget.getByRole("textbox", { name: "Reply" }).fill("Perfect, found it.");
  await widget.getByRole("button", { name: "Send" }).click();
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(3, { timeout: 4_000 });
  // Open again: its status starts the conversation's meta line.
  await expect(owner.locator('[data-slot="page-header"] > p')).toContainText("Open · #");

  // Another reply while the panel's closed: the launcher's dot, until it's seen.
  await closeWithEscape(visitor, visitor.locator("#tuti-widget"));
  await owner.getByRole("textbox", { name: "Reply" }).fill("Did that work?");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(4);
  // And another conversation of Sam's, which the team closed.
  const api = await apiFor(owner, slug);
  await api("/conversations", { user: { id: "app-user-7", name: "Sam from Acme", email: samEmail(slug) }, subject: "Billing question: can we move the whole team to yearly invoices from next month?", body: "Can I pay yearly?" });
  await api("/conversations/2", { status: "closed" }, "PATCH");
  // Screen readers announce a change in a live region already on the page, not one that arrives with its
  // text: every page in the panel notes each status region's text as it's added.
  await visitor.context().addInitScript(() => {
    const added: string[] = [];
    (window as unknown as { statusesAdded: string[] }).statusesAdded = added;
    new MutationObserver((records) => {
      for (const node of records.flatMap((record) => [...record.addedNodes])) {
        if (node instanceof Element) {
          for (const status of [node, ...node.querySelectorAll("*")].filter((el) => el.getAttribute("role") === "status")) {
            added.push(status.textContent ?? "");
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  // Messages loads under a skeleton shaped like its list (its answers held here, from before the page
  // loads: the panel may read it as soon as it opens), the team above it: Olive's face, and no reply line
  // (fewer than five answered, so no time yet). Screen readers are told.
  // Held reads go on as `release` says; reads after it as `reads` says.
  let reads: "hold" | "fail" | "pass" = "hold";
  let release!: (then: "fail" | "pass") => void;
  let released = new Promise<"fail" | "pass">((resolve) => (release = resolve));
  // Whether the list's read has started (so the list, not the wait for the page's answer, is what's loading).
  let listRead = false;
  // Reading the list (and saying they're here) sends [project, { token }]; trading a sign-in, a string.
  const readsList = (body: string | null) => {
    try {
      return typeof (JSON.parse(body ?? "") as unknown[])[1] === "object";
    } catch {
      return false;
    }
  };
  await visitor.route(
    (url) => url.pathname === "/widget",
    async (route) => {
      // Only the list's reads: a held sign-in would hold up the tab's navigation behind it too.
      if (route.request().headers()["next-action"] && readsList(route.request().postData())) {
        listRead = true;
        const then = reads === "hold" ? await released : reads;
        if (then === "fail") {
          await route.abort();
          return;
        }
      }
      await route.fallback();
    },
  );
  await visitor.reload();
  await expect(visitor.getByRole("button", { name: "Feedback, new updates" })).toBeVisible();
  await visitor.getByRole("button", { name: "Feedback, new updates" }).click();
  await widget.getByRole("link", { name: "Messages" }).click();
  const team = widget.getByRole("region", { name: "The team" });
  await expect(team).toContainText("The Acme team");
  // Too few answered conversations for a reply time: no line under the team's name.
  await expect(team).not.toContainText(/repl/i);
  await expect(team.locator('[data-slot="avatar"]')).toHaveCount(1);
  const skeleton = widget.locator("[data-loading-skeleton]");
  await expect(skeleton).toBeVisible();
  await expect(widget.getByRole("status").filter({ hasText: "Loading conversations…" })).toBeAttached();
  const panel = (await (await visitor.locator('iframe[title="Feedback"]').elementHandle())!.contentFrame())!;
  const added = await panel.evaluate(() => (window as unknown as { statusesAdded: string[] }).statusesAdded);
  expect(added).toContain("");
  expect(added).not.toContain("Loading conversations…");
  await expect(widget.getByText("Loading…")).toHaveCount(0);
  await checkpoint(visitor, "widget-messages-loading");
  // The team's card stays as the list comes (their photos don't blink back to initials): marked now, still marked then.
  await expect.poll(() => listRead).toBe(true);
  await team.evaluate((element) => element.setAttribute("data-kept", ""));
  // The list can't be read: not a skeleton for ever, but the error and Try again (New message still there).
  reads = "fail";
  release("fail");
  await expect(widget.getByText("Couldn't load your conversations.").and(widget.locator(":not([role=status])"))).toBeVisible();
  // Screen readers are told too.
  await expect(widget.getByRole("status").filter({ hasText: "Couldn't load your conversations." })).toBeAttached();
  await expect(skeleton).toHaveCount(0);
  await expect(widget.getByText("Loading conversations…")).toHaveCount(0);
  await expect(widget.getByRole("button", { name: "New message" })).toBeVisible();
  await expect(team).toHaveAttribute("data-kept", "");
  await checkpoint(visitor, "widget-messages-failed");
  // Try again from the keyboard, failing before the status speaks (its timers paused, so however long the
  // failure takes): it keeps its focus, and the status region says the failure, is emptied, then says it
  // again, so screen readers hear it again. Everything the region says from here on is recorded.
  const tryAgain = widget.getByRole("button", { name: /^Try(ing)? again/ });
  const status = (text: string) => widget.getByRole("status").filter({ hasText: text });
  await panel.evaluate(() => {
    const region = document.querySelector('[role="region"][aria-label="Messages"] > [role="status"]')!;
    const texts = [region.textContent ?? ""];
    (window as unknown as { statusTexts: string[] }).statusTexts = texts;
    new MutationObserver(() => texts.push(region.textContent ?? "")).observe(region, { childList: true, characterData: true, subtree: true });
  });
  await visitor.clock.pauseAt(Date.now() + 1_000);
  await tryAgain.focus();
  await visitor.keyboard.press("Enter");
  await expect(tryAgain).toHaveAttribute("aria-busy", "false");
  await expect(tryAgain).toHaveText("Try again");
  await visitor.clock.resume();
  await expect
    .poll(() => panel.evaluate(() => (window as unknown as { statusTexts: string[] }).statusTexts))
    .toEqual(["Couldn't load your conversations.", "", "Couldn't load your conversations."]);
  await expect(tryAgain).toBeFocused();
  // Held this time: it keeps its focus while it tries, says so ("Trying again…", busy, the error still
  // there, no skeleton), and screen readers hear it try.
  released = new Promise((resolve) => (release = resolve));
  reads = "hold";
  await visitor.keyboard.press("Enter");
  await expect(tryAgain).toBeFocused();
  await expect(tryAgain).toHaveText("Trying again…");
  await expect(tryAgain).toHaveAttribute("aria-busy", "true");
  await expect(status("Loading conversations…")).toBeAttached();
  await expect(status("Couldn't load your conversations.")).toHaveCount(0);
  await expect(skeleton).toHaveCount(0);
  await checkpoint(visitor, "widget-messages-retrying");
  // It loads: the error and its button go, focus moves to New message, which stays, and the status empties.
  reads = "pass";
  release("pass");
  await expect(widget.getByRole("list", { name: "Conversations" })).toBeVisible();
  await expect(widget.getByRole("button", { name: "New message" })).toBeFocused();
  await expect(tryAgain).toHaveCount(0);
  await expect(status("Loading conversations…")).toHaveCount(0);
  await expect(status("Couldn't load your conversations.")).toHaveCount(0);
  // The same retry while they've gone on to the customer's page: the list loads, and the focus stays on
  // the customer's page. (Back on the page with the list failing again, so the error is there to retry.)
  reads = "fail";
  await visitor.reload();
  await visitor.evaluate(() => document.body.insertAdjacentHTML("afterbegin", '<input aria-label="Site email">'));
  const siteField = visitor.getByRole("textbox", { name: "Site email" });
  await visitor.getByRole("button", { name: /^Feedback/ }).click();
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Messages" }).click();
  await expect(tryAgain).toHaveText("Try again");
  released = new Promise((resolve) => (release = resolve));
  reads = "hold";
  await tryAgain.focus();
  await visitor.keyboard.press("Enter");
  await expect(tryAgain).toHaveText("Trying again…");
  await siteField.focus();
  reads = "pass";
  release("pass");
  await expect(widget.getByRole("list", { name: "Conversations" })).toBeVisible();
  await expect(siteField).toBeFocused();
  await visitor.unroute((url) => url.pathname === "/widget");
  // Their conversations, newest first: the one the team closed; then the team's latest line, that
  // they replied, and the new reply's dot.
  const row = widget.getByRole("list", { name: "Conversations" }).getByRole("listitem");
  await expect(row).toHaveCount(2);
  await expect(row.first()).toContainText("Billing question");
  await expect(row.first()).toContainText(/Closed · /);
  await expect(row.last()).toContainText("How do I export my data?");
  await expect(row.last()).toContainText("Did that work?");
  await expect(row.last()).toContainText(/Replied · /);
  await expect(row.last().getByText("New reply")).toBeAttached();
  await expect(widget.getByText("Couldn't load your conversations.")).toHaveCount(0);
  // The list's corners are only the first row's top and the last row's bottom (each row's hover fills them).
  const corners = (locator: Locator) => locator.evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderBottomLeftRadius]);
  const [firstTop, firstBottom] = await corners(row.first().getByRole("button"));
  const [lastTop, lastBottom] = await corners(row.last().getByRole("button"));
  expect([firstTop !== "0px", firstBottom, lastTop, lastBottom !== "0px"]).toEqual([true, "0px", "0px", true]);
  await checkpoint(visitor, "widget-messages-list");
  await visitor.emulateMedia({ colorScheme: "dark" });
  await checkpoint(visitor, "widget-messages-list-dark");
  await visitor.emulateMedia({ colorScheme: "light" });
  // A subject the team wrote is the conversation's title in full, however many lines it takes.
  await row.first().getByRole("button").click();
  const subject = widget.getByRole("heading", { level: 2, name: "Billing question: can we move the whole team to yearly invoices from next month?" });
  expect(await subject.evaluate((h) => [getComputedStyle(h).webkitLineClamp, h.scrollHeight <= h.clientHeight, h.clientHeight > parseFloat(getComputedStyle(h).lineHeight) * 1.5])).toEqual(["none", true, true]);
  await checkpoint(visitor, "widget-conversation-subject");
  await widget.getByRole("button", { name: "Messages", exact: true }).click();
  await widget.getByRole("button", { name: /How do I export my data\?/ }).click();
  await expect(messages).toHaveCount(4);
  await expect(visitor.getByRole("button", { name: "Feedback", exact: true })).toBeAttached();

  // A long conversation: it follows the newest message, and the reply box stays at the bottom of the
  // panel, where it is when they scroll back up.
  for (let i = 1; i <= 10; i++) {
    await api("/conversations/1/messages", { body: `Step ${i}\n\nwith a few lines\nto make it tall` });
  }
  await expect(messages).toHaveCount(14);
  await expect(messages.last()).toBeInViewport();
  const reply = widget.getByRole("textbox", { name: "Reply" });
  await expect(reply).toBeInViewport();
  await checkpoint(visitor, "widget-messages-long", { fullPage: false });
  const y = (await reply.boundingBox())!.y;
  await messages.first().scrollIntoViewIfNeeded();
  await expect(messages.first()).toBeInViewport();
  await expect(reply).toBeInViewport();
  expect((await reply.boundingBox())!.y).toBe(y);
  await checkpoint(visitor, "widget-messages-scrolled-up", { fullPage: false });

  // The team's next reply has a tall image, which loads after the panel has scrolled to it: the panel
  // follows it. As in Safari, which keeps no place as things above it grow (Chrome's scroll anchoring does).
  const panelFrame = visitor.frames().find((frame) => frame.url().includes("/widget"))!;
  await panelFrame.addStyleTag({ content: "[data-widget-scroll] { overflow-anchor: none }" });
  await visitor.route("**/*", async (route) => {
    if (route.request().resourceType() === "image") {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await route.fallback();
  });
  await owner.goto(`/app/${slug}/inbox/1`);
  await owner.locator('input[type="file"]').setInputFiles({ name: "tall.png", mimeType: "image/png", buffer: png(100, 600) });
  await expect(owner.getByRole("list", { name: "Files to send" })).toContainText("tall.png");
  await owner.getByRole("textbox", { name: "Reply" }).fill("Here's where it is.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(messages).toHaveCount(15);
  await expect(widget.getByRole("img", { name: "tall.png" })).toHaveJSProperty("complete", true);
  // Above the reply box, not under it.
  await expect(async () => {
    const newest = (await messages.last().boundingBox())!;
    expect(newest.y + newest.height).toBeLessThanOrEqual((await reply.boundingBox())!.y);
  }).toPass({ timeout: 5_000 });
  await visitor.unroute("**/*");

  // The page signs someone else in, but the widget can't reach Tuti to trade their token: nobody's
  // signed in, not Sam, whose messages go.
  // Their reply box had the focus: it stays with Messages, not lost to the page.
  await reply.focus();
  await visitor.route("**/*", (route) => (route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await visitor.evaluate(() => (window as unknown as { Tuti: { identify(getToken: () => string): void } }).Tuti.identify(() => "someone-else"));
  await expect(widget.getByText("Leave your email so the team can get back to you.")).toBeVisible();
  await expect(widget.getByRole("region", { name: "Messages" })).toBeFocused();
  await expect(widget.getByText("Couldn't sign you in")).toBeVisible();
  await expect(messages).toHaveCount(0);
});

test("signed out, a visitor leaves their email to message the team, and their browser keeps the conversation", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(owner.getByText("Messages on")).toBeVisible();
  // Turning Messages on gave the project its support address, so the team's replies can be emailed too.
  await expect(owner.getByText(`support@${slug}.${SUPPORT_EMAIL_DOMAIN}`)).toBeVisible();
  await checkpoint(owner, "support-settings-messages-on");
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
  // Where the reply comes: here, or by email to the address they gave once they've left.
  const replyWhere = widget.getByText(/^We'll reply here/);
  await expect(replyWhere).toHaveText(`We'll reply here. If you've left, we'll email you at ${kim}.`);
  await checkpoint(visitor, "widget-message-sent-email");
  // Closed by the team, there's no reply to wait for; open again, there is.
  await api("/conversations/1", { status: "closed" }, "PATCH");
  await expect(replyWhere).toHaveCount(0);
  await api("/conversations/1", { status: "open" }, "PATCH");
  await expect(replyWhere).toBeVisible();

  // The team sees an address that isn't verified, and only a hint of who it may be.
  await owner.goto(`/app/${slug}/inbox`);
  // A row opens by its link (who it's with), found by its subject.
  await owner.getByRole("main").getByRole("listitem").filter({ hasText: "Is there a nonprofit discount?" }).getByRole("link").click();
  const about = owner.getByRole("complementary", { name: "About them" });
  await expect(about).toContainText(`${kim} (not verified)`);
  await expect(about).toContainText("Maybe Kim Lee (not signed in), id kim-1");
  await owner.getByRole("textbox", { name: "Reply" }).fill("Yes: 50% off for registered charities.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(2);

  await expect(messages).toHaveCount(2, { timeout: 15_000 });
  await expect(messages.last()).toContainText("Yes: 50% off for registered charities.");

  // The page says again that it signs nobody in (an app may, whenever its sign-in settles): the visitor
  // carries on writing while the panel acts on it (held here: the sign-out, the one action with no arguments).
  const reply = widget.getByRole("textbox", { name: "Reply" });
  await reply.fill("Thanks!");
  let signOutSent!: () => void;
  const sent = new Promise<void>((resolve) => (signOutSent = resolve));
  let releaseSignOut!: () => void;
  const released = new Promise<void>((resolve) => (releaseSignOut = resolve));
  await visitor.route(
    (url) => url.pathname === "/widget",
    async (route) => {
      if (route.request().headers()["next-action"] && route.request().postData() === "[]") {
        signOutSent();
        await released;
      }
      await route.fallback();
    },
  );
  await visitor.evaluate(() => (window as unknown as { Tuti: { identify(getToken: () => null): void } }).Tuti.identify(() => null));
  await sent;
  await expect(reply).toBeEnabled();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveValue("Thanks!");
  releaseSignOut();
  await widget.getByRole("button", { name: "Send" }).click();
  await expect(messages).toHaveCount(3);

  // Back later in the same browser: their conversation is still there. But not before the page says
  // who's here (this time its sign-in never answers, so after 3 seconds): someone it's about to sign in
  // mustn't write as the visitor and lose sight of it.
  await visitor.context().addInitScript(() => {
    (window as unknown as { TutiSettings: unknown }).TutiSettings = { identify: () => new Promise(() => {}) };
    // Every text a status region says, in order: what screen readers hear.
    const said: string[] = [];
    (window as unknown as { statusSaid: string[] }).statusSaid = said;
    new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        const status = (node instanceof Element ? node : node.parentElement)?.closest('[role="status"]');
        if (status) {
          said.push(status.textContent ?? "");
        }
      }
    }).observe(document, { childList: true, characterData: true, subtree: true });
  });
  // The list takes a moment too (longer than the status waits before it speaks).
  const slowReads = (url: URL) => url.pathname === "/widget";
  await visitor.route(slowReads, async (route) => {
    if (route.request().headers()["next-action"]) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.fallback();
  });
  await visitor.reload();
  await visitor.getByRole("button", { name: "Feedback" }).click();
  await widget.getByRole("link", { name: "Messages" }).click();
  await expect(widget.locator("[data-loading-skeleton]")).toBeVisible();
  await expect(widget.getByRole("status").filter({ hasText: "Loading conversations…" })).toBeAttached();
  await expect(widget.getByRole("textbox")).toHaveCount(0);
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText("Is there a nonprofit discount?");
  // Loading was said once, through the page's answer and the list's loading.
  const panel = (await (await visitor.locator('iframe[title="Feedback"]').elementHandle())!.contentFrame())!;
  const said = await panel.evaluate(() => (window as unknown as { statusSaid: string[] }).statusSaid);
  expect(said.filter((text) => text === "Loading conversations…")).toHaveLength(1);
  await visitor.unroute(slowReads);
  // Theirs is the latest: waiting on the team.
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText("You: Thanks!");
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText(/Waiting for a reply · /);
  // The page signs someone in after all, later than that: while their token's traded, the visitor
  // can't send (here Tuti never answers, so it stays that way), and what they'd typed stays.
  await widget.getByRole("button", { name: /Is there a nonprofit discount\?/ }).click();
  await widget.getByRole("textbox", { name: "Reply" }).fill("And for schools?");
  // Meanwhile they've gone on to the customer's page (its sign-in form): the panel doesn't take the focus back.
  await visitor.evaluate(() => document.body.insertAdjacentHTML("afterbegin", '<input aria-label="Site email">'));
  const siteField = visitor.getByRole("textbox", { name: "Site email" });
  await siteField.focus();
  await visitor.route("**/*", (route) => (route.request().headers()["next-action"] ? undefined : route.fallback()));
  await visitor.evaluate(() => (window as unknown as { Tuti: { identify(getToken: () => string): void } }).Tuti.identify(() => "late-token"));
  await expect(widget.getByText("Signing you in…")).toBeVisible();
  await expect(widget.getByRole("textbox", { name: "Reply" })).toBeDisabled();
  await expect(widget.getByRole("textbox", { name: "Reply" })).toHaveValue("And for schools?");
  await expect(siteField).toBeFocused();

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
  // An article close to the visitor's question, and the inbox on.
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
  // With docs and the inbox on, all four tabs; the docs are the Help center here.
  await expect(widget.getByRole("navigation", { name: "Widget" }).getByRole("link")).toHaveText(["Home", "Feedback", "Help center", "Messages"]);
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Help center" }).click();
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
  // The AI's answer is the latest line, but it isn't the team's reply.
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText("Owners and admins send invites from the Team page.");
  await expect(widget.getByRole("list", { name: "Conversations" })).toContainText(/Waiting for a reply · /);

  // The team sees the question, the AI's answer and, for them only, the AI's summary.
  await owner.goto(`/app/${slug}/inbox`);
  // A row opens by its link (who it's with), found by its subject.
  await owner.getByRole("main").getByRole("listitem").filter({ hasText: question }).getByRole("link").click();
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

test("the widget's Home: help first with suggested articles, a message to the team with when it usually replies, and news of a signed-in visitor's ideas", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/support", { inbox: true }, "PATCH");
  const articles: string[] = [];
  for (const title of ["Inviting your team", "Exporting your data", "Billing", "Webhooks"]) {
    const article = await api("/articles", { title, body: `All about ${title.toLowerCase()}.` });
    await api(`/articles/${article.slug}/publish`, {});
    articles.push(article.slug);
  }
  // What's been read lately, and how the team's been answering (journeys can't wait days for either):
  // the first three articles read 2, 5 and 3 times; five conversations answered in 10 to 50 minutes.
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    for (const [i, views] of [2, 5, 3].entries()) {
      await db.query(
        `INSERT INTO article_view_day ("articleId", day, views) SELECT a.id, (now() AT TIME ZONE 'UTC')::date, $3 FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = $2`,
        [slug, articles[i], views],
      );
    }
    for (const [i, minutes] of [10, 20, 30, 40, 50].entries()) {
      await db.query(
        `WITH c AS (
           INSERT INTO conversation (id, "projectId", number, subject, origin, "updatedAt", "createdAt")
           SELECT gen_random_uuid()::text, id, $2, 'Help', 'WIDGET', now(), now() - interval '1 day' FROM project WHERE slug = $1 RETURNING id, "projectId", "createdAt")
         INSERT INTO conversation_message (id, "projectId", "conversationId", author, channel, body, "createdAt")
         SELECT gen_random_uuid()::text, "projectId", id, 'USER'::"MessageAuthor", 'WIDGET'::"MessageChannel", 'Hi', "createdAt" FROM c
         UNION ALL SELECT gen_random_uuid()::text, "projectId", id, 'TEAM'::"MessageAuthor", 'APP'::"MessageChannel", 'Hello', "createdAt" + make_interval(mins => $3) FROM c`,
        [slug, i + 1, minutes],
      );
    }
  } finally {
    await db.end();
  }

  // A visitor the page doesn't sign in: help first, the most read three suggested, then writing to the team.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(sitePage("customer.localhost", slug));
  const launcher = visitor.getByRole("button", { name: "Feedback" });
  await launcher.click();
  const widget = visitor.frameLocator('iframe[title="Feedback"]');
  const tabs = widget.getByRole("navigation", { name: "Widget" });
  await expect(widget.getByText("Hi there 👋")).toBeVisible();
  const search = widget.getByRole("searchbox", { name: "Search for help" });
  const suggested = widget.getByRole("list", { name: "Suggested articles" });
  await expect(suggested.getByRole("link")).toHaveText(["Exporting your data", "Billing", "Inviting your team"]);
  const message = widget.getByRole("link", { name: /Send us a message/ });
  await expect(message).toContainText("Usually replies in under an hour");
  // The team's faces: Olive's, the only one.
  await expect(message.locator('[data-slot="avatar"]')).toHaveCount(1);
  const top = async (locator: Locator) => (await locator.boundingBox())!.y;
  expect(await top(search)).toBeLessThan(await top(suggested));
  expect(await top(suggested)).toBeLessThan(await top(message));
  await expect(widget.getByRole("region", { name: "Your ideas" })).toHaveCount(0);
  await checkpoint(visitor, "widget-home");
  await visitor.emulateMedia({ colorScheme: "dark" });
  await checkpoint(visitor, "widget-home-dark");
  await visitor.setViewportSize({ width: 390, height: 844 });
  await checkpoint(visitor, "widget-home-phone-dark");
  await visitor.emulateMedia({ colorScheme: "light" });
  await visitor.setViewportSize({ width: 1280, height: 720 });

  // A suggested article opens in the Help center; Home's search shows its results there.
  await suggested.getByRole("link", { name: "Billing" }).click();
  await expect(widget.getByRole("article", { name: "Billing" }).getByText("All about billing.")).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Help center" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Home" }).click();
  await search.fill("webhooks");
  await search.press("Enter");
  await expect(widget.getByRole("list", { name: "Search results" }).getByRole("link", { name: "Webhooks" })).toBeVisible();
  await tabs.getByRole("link", { name: "Home" }).click();
  // And "Send us a message" opens Messages.
  await message.click();
  await expect(tabs.getByRole("link", { name: "Messages" })).toHaveAttribute("aria-current", "page");

  // Someone the page signs in posts an idea; the team plans it.
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  ssoSecrets.set(slug, await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText());
  const sam = await (await browser.newContext()).newPage();
  await sam.goto(sitePage("customer.localhost", slug));
  await sam.getByRole("button", { name: "Feedback" }).click();
  const samWidget = sam.frameLocator('iframe[title="Feedback"]');
  await expect(samWidget.getByText("Hi Sam 👋")).toBeVisible();
  await samWidget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(samWidget.getByText("Posting as Sam from Acme")).toBeVisible();
  await samWidget.getByLabel("Title").fill("Dark mode");
  await samWidget.getByRole("button", { name: "Submit post" }).click();
  await expect(samWidget.getByText("Feedback posted")).toBeVisible();
  await api("/posts/1", { status: "planned" }, "PATCH");

  // Back on Home, Sam is greeted and told; the news opens the idea on the portal.
  await samWidget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Home" }).click();
  await expect(samWidget.getByText("Hi Sam 👋")).toBeVisible();
  const news = samWidget.getByRole("region", { name: "Your ideas" }).getByRole("link", { name: /Dark mode is now Planned/ });
  await expect(news).toBeVisible();
  await expect(news).toHaveAttribute("href", "/feedback/feature-requests/dark-mode-1");
  await expect(news).toHaveAttribute("target", "_blank");
  await expect(samWidget.getByText("Feedback posted")).toBeHidden({ timeout: 10_000 });
  await news.scrollIntoViewIfNeeded();
  await checkpoint(sam, "widget-home-signed-in");
  await sam.emulateMedia({ colorScheme: "dark" });
  await checkpoint(sam, "widget-home-signed-in-dark");
  await sam.setViewportSize({ width: 390, height: 844 });
  await checkpoint(sam, "widget-home-signed-in-phone");
  await sam.emulateMedia({ colorScheme: "light" });
  await sam.setViewportSize({ width: 1280, height: 720 });
  // Feedback's ideas say where they stand once that isn't just open: Dark mode is planned.
  await samWidget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(samWidget.getByText("Posting as Sam from Acme")).toBeVisible();
  const trending = samWidget.getByRole("region", { name: "Ideas", exact: true }).getByRole("listitem").filter({ hasText: "Dark mode" });
  await expect(trending).toContainText("Planned");
  await expect(trending.locator("[data-status-dot]")).toBeVisible();
  await checkpoint(sam, "widget-feedback-status");
  await samWidget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Home" }).click();
  await expect(news).toBeVisible();

  // The page signs Sam out, or someone else in: Home never shows Sam's greeting or ideas after that,
  // not even while the panel acts on it, or while the page is slow to say who's here.
  const greeting = samWidget.getByText("Hi Sam 👋");
  const ideas = samWidget.getByRole("region", { name: "Your ideas" });
  let holding = false;
  const held: (() => void)[] = [];
  await sam.route(
    (url) => url.pathname === "/widget",
    async (route) => {
      if (holding && route.request().method() === "POST" && route.request().headers()["next-action"]) {
        await new Promise<void>((resolve) => held.push(resolve));
      }
      await route.fallback();
    },
  );
  const letGo = () => {
    holding = false;
    held.splice(0).forEach((resolve) => resolve());
  };
  type Identify = { Tuti: { identify(getToken: () => string | null | Promise<string>): void } };
  const signSamIn = () => sam.evaluate((slug) => (window as unknown as Identify).Tuti.identify(() => fetch(`/token/${slug}`).then((r) => r.text())), slug);
  // With Home open.
  holding = true;
  await sam.evaluate(() => (window as unknown as Identify).Tuti.identify(() => null));
  await expect(samWidget.getByText("Hi there 👋")).toBeVisible();
  await expect(greeting).toHaveCount(0);
  await expect(ideas).toHaveCount(0);
  letGo();
  // Signed in again, on Home.
  await signSamIn();
  await expect(greeting).toBeVisible();
  await expect(ideas).toBeVisible();
  // While another tab is open the page signs Sam out, then its app is slow to say who's here: back on
  // Home, Sam isn't shown while it's asked again.
  await samWidget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(samWidget.getByText("Posting as Sam from Acme")).toBeVisible();
  await sam.evaluate(() => (window as unknown as Identify).Tuti.identify(() => null));
  await expect(samWidget.getByRole("button", { name: "Sign in to post" })).toBeVisible();
  await expect(samWidget.getByText("Posting as Sam from Acme")).toHaveCount(0);
  await sam.evaluate(() => (window as unknown as Identify).Tuti.identify(() => new Promise<string>(() => {})));
  await samWidget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Home" }).click();
  await expect(samWidget.getByText("Hi there 👋")).toBeVisible();
  await expect(greeting).toHaveCount(0);
  await expect(ideas).toHaveCount(0);
});

test("someone who emailed the team sees that conversation in the widget's Messages once the customer's site signs them in, and answers it there", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  ssoSecrets.set(slug, await owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" }).locator("code").innerText());
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(owner.getByText("Messages on")).toBeVisible();
  const supportAddress = `support@${slug}.${SUPPORT_EMAIL_DOMAIN}`;
  await expect(owner.getByText(supportAddress).first()).toBeVisible();

  // Sam emails the team before the customer's app has ever signed them in to the widget, and the team answers.
  await receive(supportAddress, rawEmail(`Sam <${samEmail(slug)}>`, "Invoice missing", "Where's my October invoice?"));
  await owner.goto(`/app/${slug}/inbox/1`);
  await owner.getByRole("textbox", { name: "Reply" }).fill("It's under Billing → Invoices.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(2);

  // On the customer's site, which signs Sam in with that address: the emailed conversation is in Messages, unseen.
  const sam = await (await browser.newContext()).newPage();
  await sam.goto(sitePage("customer.localhost", slug));
  await sam.getByRole("button", { name: "Feedback" }).click();
  const widget = sam.frameLocator('iframe[title="Feedback"]');
  await widget.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Messages" }).click();
  const conversations = widget.getByRole("list", { name: "Conversations" });
  await expect(conversations).toContainText("Invoice missing");
  await expect(conversations).toContainText("It's under Billing → Invoices.");
  await checkpoint(sam, "widget-emailed-conversation");

  // Opened: the email and the reply; replies still go to Sam's address.
  await widget.getByRole("button", { name: /Invoice missing/ }).click();
  const messages = widget.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(messages).toHaveCount(2);
  await expect(messages.first()).toContainText("Where's my October invoice?");
  await widget.getByRole("textbox", { name: "Reply" }).fill("Found it, thanks!");
  await widget.getByRole("button", { name: "Send" }).click();
  await expect(messages).toHaveCount(3);
  await expect(widget.getByText(/^We'll reply here/)).toHaveText(`We'll reply here. If you've left, we'll email you at ${samEmail(slug)}.`);
  await checkpoint(sam, "widget-emailed-conversation-answered");

  // The team sees Sam's answer in the same conversation, still with the address, and its reply reaches the open widget live.
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem")).toHaveCount(3, { timeout: 4_000 });
  await expect(owner.getByRole("list", { name: "Messages" }).getByRole("listitem").last()).toContainText("Found it, thanks!");
  await owner.getByRole("textbox", { name: "Reply" }).fill("Glad to help.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(messages).toHaveCount(4, { timeout: 4_000 });
  await checkpoint(owner, "inbox-emailed-conversation-answered-in-widget");
});
