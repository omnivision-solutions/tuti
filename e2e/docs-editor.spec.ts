import pg from "pg";
import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

async function editor(browser: Browser) {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/articles", { title: "Invite your team", body: "Owners send invites from Settings." });
  await team.setViewportSize({ width: 1440, height: 900 });
  return { team, slug, api };
}

/** Exercise queue refresh and dialog teardown on slower clients as well. */
async function throttleQueue(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
}

/** Let the real live stream open at a chosen point, refreshing the confirmed queue. */
async function holdQueueRefresh(page: Page) {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  await page.route("**/api/live?*", async (route) => {
    await held;
    await route.fallback();
  });
  return release;
}

test("the app sidebar folds for saved and new article editors and opens elsewhere", async ({ browser }) => {
  const { team, slug } = await editor(browser);
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  await team.goto(`/app/${slug}/docs`);
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await tree.getByRole("link", { name: "Invite your team" }).click();
  await team.waitForURL(`**/app/${slug}/docs/invite-your-team`);
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await team.locator('[data-slot="sidebar-rail"]').click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await team.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await team.getByRole("button", { name: "Add content" }).click();
  await team.getByRole("menuitem", { name: "New article", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/new`);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/settings/general`);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

test("an article editor keeps Save and Publish visible while its text scrolls", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const { team, slug, api } = await editor(browser);
  await api("/articles/invite-your-team", { body: "Owners send invites from Settings.\n\n".repeat(80) }, "PATCH");
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  await expect(team.getByRole("textbox", { name: "Article", exact: true })).toBeVisible();
  await team.locator(".docs-editor-scroll").evaluate((pane) => pane.scrollTo(0, 700));
  expect(await team.locator(".docs-editor-scroll").evaluate((pane) => pane.scrollTop)).toBeGreaterThanOrEqual(700);
  await expect(team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ })).toBeInViewport();
  await expect(team.getByRole("button", { name: "Publish", exact: true })).toBeInViewport();
  await checkpoint(team, "docs-editor-sticky-actions", { fullPage: false });
});

test("a short window keeps Save and Publish in reach while editing the end of a long article", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const { team, slug, api } = await editor(browser);
  await api("/articles/invite-your-team", { body: "Owners send invites from Settings.\n\n".repeat(80) }, "PATCH");
  await team.setViewportSize({ width: 1024, height: 450 });
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const article = team.getByRole("textbox", { name: "Article", exact: true });
  await article.click();
  await team.keyboard.press("ControlOrMeta+End");
  await team.keyboard.type("Invite the rest of your team.");
  await expect(article.locator("p").last()).toContainText("Invite the rest of your team.");
  expect(await team.locator(".docs-editor-scroll").evaluate((pane) => pane.scrollTop)).toBeGreaterThan(700);
  const save = team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ });
  await expect.soft(save).toBeInViewport();
  await expect.soft(team.getByRole("button", { name: "Publish", exact: true })).toBeInViewport();
  await expect(team.getByRole("toolbar", { name: "Formatting", exact: true })).toBeInViewport();
  await checkpoint(team, "docs-editor-short-window-actions", { fullPage: false });
  await save.click();
  await expect(team.getByText("Saved", { exact: true }).first()).toBeVisible();
  await team.reload();
  await expect(article.locator("p").last()).toContainText("Invite the rest of your team.");
});

test("typing in a phone article editor keeps its title, parent link and Save in the heading", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const { team, slug } = await editor(browser);
  await team.setViewportSize({ width: 390, height: 844 });
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const back = team.locator('[data-slot="docs-page-header"]').getByRole("link", { name: "Docs", exact: true });
  const title = team.getByRole("textbox", { name: "Title", exact: true });
  const article = team.getByRole("textbox", { name: "Article", exact: true });
  const save = team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ });
  await expect(save).toBeInViewport();

  for (const [field, text] of [[title, "Invite your whole team"], [article, "Owners can send invitations from Settings."]] as const) {
    await field.fill(text);
    await expect(field).toBeFocused();
    await expect(save).toBeInViewport();
    await expect(back).toBeInViewport();
    await expect(title).toBeInViewport();
    await expect(title).toHaveValue("Invite your whole team");
  }
  await checkpoint(team, "docs-editor-phone-typing-keeps-context", { fullPage: false });
  // Leaving text entry brings the bottom actions back without navigating away.
  await back.focus();
  await expect(save).toBeInViewport();
});

test("a new article’s collection and pinned formatting survive navigation between collections", async ({ browser }, testInfo) => {
  const { team, slug, api } = await editor(browser);
  for (const name of ["Getting started", "Billing"]) await api("/collections", { name });
  await team.goto(`/app/${slug}/docs/new?collection=getting-started`);
  await expect(team.getByRole("combobox", { name: "In collection", exact: true })).toContainText("Getting started");
  await team.getByRole("navigation", { name: "Docs", exact: true }).getByRole("button", { name: "Add to Billing", exact: true }).click();
  await team.getByRole("menuitem", { name: "New article", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/new?collection=billing`);
  await expect(team.getByRole("combobox", { name: "In collection", exact: true })).toContainText("Billing");
  await expect(team.getByRole("toolbar", { name: "Formatting", exact: true })).toBeInViewport();
  await team.getByRole("textbox", { name: "Title", exact: true }).fill("Your first invoice");
  await team.getByRole("textbox", { name: "Search description", exact: true }).fill("Download and read your invoices.");
  const text = team.getByRole("textbox", { name: "Article", exact: true });
  await text.fill("Open Billing to download it.");
  const style = team.getByRole("combobox", { name: "Text style" });
  await style.click();
  await team.getByRole("option", { name: "Heading", exact: true }).click();
  await expect(text.getByRole("heading", { name: "Open Billing to download it.", level: 2 })).toBeVisible();
  await expect(style).toContainText("Heading");
  await style.click();
  await team.getByRole("option", { name: "Text", exact: true }).click();
  await expect(text.locator("p").first()).toHaveText("Open Billing to download it.");
  await text.locator("p").first().click();
  const list = team.getByRole("toolbar", { name: "Formatting", exact: true }).getByRole("button", { name: "Bulleted list", exact: true });
  await list.click();
  await expect(list).toHaveAttribute("aria-pressed", "true");
  await expect(text.getByRole("listitem")).toHaveText("Open Billing to download it.");
  await list.click();
  await team.getByRole("button", { name: "Save draft", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/your-first-invoice`);
  await expect(team.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Your first invoice");
  await expect(team.locator(".docs-editor-scroll")).not.toContainText("Download and read your invoices.");
  await team.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(team.getByRole("textbox", { name: "Search description" })).toHaveValue("Download and read your invoices.");
  await checkpoints(testInfo)(team, "docs-new-collection-navigation");
});

test("the article text matches the portal's width at 1440px, with and without sections", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const { team, slug, api } = await editor(browser);
  const t = (text: string) => ({ type: "text", text });
  const h2 = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [t(text)] });
  const p = (text: string) => ({ type: "paragraph", content: [t(text)] });
  await api("/articles", { title: "Roles", content: { type: "doc", content: [p("Who can do what."), h2("Owners"), p("Everything."), h2("Members"), p("Their own posts.")] } });
  const text = team.getByRole("textbox", { name: "Article", exact: true });
  for (const [article, rem] of [["invite-your-team", 43], ["roles", 46]] as const) {
    await team.goto(`/app/${slug}/docs/${article}`);
    await expect(text).toBeVisible();
    await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(rem * 16);
    await checkpoint(team, `docs-editor-${article}`);
  }
  await team.getByRole("button", { name: "Hide the docs tree" }).click();
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(46 * 16);
  await checkpoint(team, "docs-editor-tree-folded");

  await team.getByRole("button", { name: "Show the docs tree" }).click();
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  await expect(text).toHaveText("Owners send invites from Settings.");
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(43 * 16);
  const revision = team.locator('#article-form input[name="revision"]');
  const before = await revision.inputValue();
  await text.fill("Owners send invites from Settings.");
  for (const heading of ["Invitations", "Permissions"]) {
    await team.keyboard.press("Enter");
    await team.keyboard.type("/head");
    await team.getByRole("listbox", { name: "Blocks" }).getByRole("option", { name: "Heading", exact: true }).click();
    await team.keyboard.type(heading);
    await team.keyboard.press("Enter");
    await team.keyboard.type("Owners can manage the team.");
  }
  await expect(text.locator("h2")).toHaveCount(2);
  await team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ }).click();
  await expect(team.getByText("Saved", { exact: true }).first()).toBeVisible();
  // Wait for the refreshed article to reach the form: its new sections must not rewrap the open editor.
  await expect(revision).not.toHaveValue(before);
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(43 * 16);
  await checkpoint(team, "docs-editor-saved-width");

  // A different article starts afresh; reopening the saved one now uses its sections too.
  await tree.getByRole("link", { name: "Roles" }).click();
  await team.waitForURL(`**/app/${slug}/docs/roles`);
  await expect(text.locator("h2")).toHaveText(["Owners", "Members"]);
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(46 * 16);
  await tree.getByRole("link", { name: "Invite your team" }).click();
  await team.waitForURL(`**/app/${slug}/docs/invite-your-team`);
  await expect(text.locator("h2")).toHaveText(["Invitations", "Permissions"]);
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(46 * 16);

  // Its old History address now opens the shared side card and returns the width when collapsed.
  const beforeHistory = (await text.boundingBox())!.width;
  await team.goto(`/app/${slug}/docs/invite-your-team/history`);
  await team.waitForURL(`**/app/${slug}/docs/invite-your-team?history`);
  const history = team.getByRole("complementary", { name: "Article tools" });
  await expect(history).toBeVisible();
  await expect(history).toHaveCSS("width", "330px");
  expect((await text.boundingBox())!.width).toBeLessThan(beforeHistory);
  await history.getByRole("button", { name: "Collapse article tools" }).click();
  await expect.poll(async () => (await text.boundingBox())!.width).toBe(beforeHistory);
  await checkpoints(testInfo)(team, "docs-editor-history-width", { fullPage: false });
});

test("the docs tree remembers its fold across reloads and app pages and unfolds again", async ({ browser }) => {
  const { team, slug } = await editor(browser);
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  await team.getByRole("button", { name: "Hide the docs tree" }).click();
  await expect(tree).toBeHidden();
  await team.reload();
  await expect(team.getByRole("textbox", { name: "Article", exact: true })).toBeVisible();
  await expect(tree).toBeHidden();
  // Opening another app page first must also restore the saved fold before navigating back to Docs.
  await team.goto(`/app/${slug}/settings/general`);
  await team.locator('[data-slot="sidebar"][data-state]').getByRole("link", { name: "Docs", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs`);
  await expect(tree).toBeHidden();
  // A fresh marketing document must restore the saved fold when its app link navigates on the client.
  await team.goto("/");
  await team.locator("header").getByRole("link", { name: "Open app", exact: true }).click();
  await team.waitForURL(`**/app/${slug}`);
  // The app entry restores the preference before a Docs page can render, rather than folding after its first paint.
  await expect(team.locator("html")).toHaveAttribute("data-docs-tree-folded", "");
  await team.locator('[data-slot="sidebar"][data-state]').getByRole("link", { name: "Docs", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs`);
  await expect(team.getByRole("button", { name: "Show the docs tree" })).toBeVisible();
  await expect(tree).toBeHidden();
  await team.getByRole("button", { name: "Show the docs tree" }).click();
  await expect(tree).toBeVisible();
  await team.reload();
  await expect(tree).toBeVisible();
  await expect(team.getByRole("button", { name: "Show the docs tree" })).toBeHidden();
});

test("folding and unfolding the docs tree keeps keyboard focus on the button that reverses it", async ({ browser }) => {
  const { team, slug } = await editor(browser);
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const hide = team.getByRole("button", { name: "Hide the docs tree" });
  const show = team.getByRole("button", { name: "Show the docs tree" });
  await hide.focus();
  await team.keyboard.press("Enter");
  await expect.soft(show).toBeFocused();
  await expect(show).toHaveAttribute("aria-expanded", "false");
  // Check the reverse direction even if the first focus assertion failed.
  await show.focus();
  await team.keyboard.press("Space");
  await expect.soft(hide).toBeFocused();
  await expect(hide).toHaveAttribute("aria-expanded", "true");
});


test("article tools collapse into the pinned toolbar and restore without a preview", async ({ browser }, testInfo) => {
  const { team, slug } = await editor(browser);
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const article = team.getByRole("textbox", { name: "Article", exact: true });
  const width = (await article.boundingBox())!.width;
  await team.getByRole("button", { name: "History", exact: true }).click();
  const tools = team.getByRole("complementary", { name: "Article tools" });
  await expect(tools).toBeVisible();
  await expect(tools.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  expect((await article.boundingBox())!.width).toBeLessThan(width);
  await tools.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(tools.getByRole("combobox", { name: "Collection", exact: true })).toBeVisible();
  await tools.getByRole("button", { name: "Collapse article tools" }).click();
  await expect(tools).toBeHidden();
  await expect.poll(async () => (await article.boundingBox())!.width).toBe(width);
  const toolbar = team.getByRole("toolbar", { name: "Article tools" });
  for (const name of ["Settings", "History", "Verify"]) await expect(toolbar.getByRole("button", { name, exact: true })).toBeVisible();
  await toolbar.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(tools.getByRole("heading", { name: "Verify", exact: true })).toBeVisible();
  await expect(team.getByRole("tab", { name: "Preview", exact: true })).toHaveCount(0);
  await expect(team.locator("iframe")).toHaveCount(0);
  await checkpoints(testInfo)(team, "docs-shared-tools");
  await team.setViewportSize({ width: 390, height: 844 });
  const sheet = team.getByRole("dialog", { name: "Verify", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Collapse article tools" }).click();
  await team.getByRole("button", { name: "Browse docs", exact: true }).click();
  const navigation = team.getByRole("dialog", { name: "Docs navigation" });
  await expect(navigation.getByRole("link", { name: "Overview", exact: true })).toBeVisible();
  await navigation.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(team.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
});


test("the overview expands its publish queue and confirms publishing the saved articles", async ({ browser }, testInfo) => {
  const { team, slug, api } = await editor(browser);
  for (const title of ["First steps", "Calendar settings", "Team settings"]) await api("/articles", { title, body: "Open Settings." });
  await team.goto(`/app/${slug}/docs`);
  const queue = team.getByRole("region", { name: /Waiting to publish/ });
  await expect(queue.getByRole("listitem")).toHaveCount(3);
  const more = queue.getByRole("button", { name: "Show 1 more" });
  await more.click();
  await expect(queue.getByRole("listitem")).toHaveCount(4);
  await expect(queue.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  const confirm = team.getByRole("alertdialog", { name: "Publish 4 articles?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(queue.getByRole("listitem")).toHaveCount(4);
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  await confirm.getByRole("button", { name: "Publish all", exact: true }).click();
  await expect(team.getByText("Published 4 articles", { exact: true })).toBeVisible();
  await expect(queue).toContainText("Everything is published.");
  await expect(team.getByRole("region", { name: "At a glance" })).toContainText("4Live articles");
  await checkpoints(testInfo)(team, "docs-published-queue", { fullPage: false });
});

test("publishing a queue row focuses the next article, then the heading when none remain", async ({ browser }) => {
  const { team, slug, api } = await editor(browser);
  await throttleQueue(team);
  await api("/articles", { title: "First steps", body: "Open Settings." });
  await team.goto(`/app/${slug}/docs`);
  const queue = team.getByRole("region", { name: "Waiting to publish" });
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  const firstTitle = await queue.locator("[data-queue-article]").first().innerText();
  const nextTitle = await queue.locator("[data-queue-article]").nth(1).innerText();
  await queue.getByRole("listitem").first().getByRole("button", { name: "Publish", exact: true }).click();
  const confirm = team.getByRole("alertdialog");
  await confirm.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(queue.getByRole("link", { name: firstTitle, exact: true })).toHaveCount(0);
  await expect(queue.getByRole("link", { name: nextTitle, exact: true })).toBeFocused();
  await queue.getByRole("button", { name: "Publish", exact: true }).click();
  await confirm.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(queue).toContainText("Everything is published.");
  await expect(queue.getByRole("heading", { name: "Waiting to publish" })).toBeFocused();
});

test("Publish all reports a deleted draft and publishes the other confirmed articles", async ({ browser }) => {
  const { team, slug, api } = await editor(browser);
  await throttleQueue(team);
  const refresh = await holdQueueRefresh(team);
  for (const title of ["Second steps", "First steps"]) await api("/articles", { title, body: "Open Settings." });
  await team.goto(`/app/${slug}/docs`);
  const queue = team.getByRole("region", { name: "Waiting to publish" });
  await expect(queue.getByRole("listitem").first()).toContainText("First steps");
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  const confirm = team.getByRole("alertdialog", { name: "Publish 3 articles?", exact: true });
  await api("/articles/first-steps", undefined, "DELETE");
  refresh();
  await expect(team.locator('.docs-publish-queue [data-queue-article="first-steps"]')).toHaveCount(0);
  await confirm.getByRole("button", { name: "Publish all", exact: true }).click();
  const summary = team.locator("[data-sonner-toast]").filter({ hasText: "Published 2 articles" });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("First steps: There's no article “first-steps”");
  await expect(team.locator("[data-sonner-toast]")).toHaveCount(1);
  await expect(confirm).toBeHidden();
  await expect(queue).toContainText("Everything is published.");
  await expect(queue.getByRole("heading", { name: "Waiting to publish" })).toBeFocused();
  await expect(team.locator(".docs-live-footer")).toContainText("2 articles live");
});

test("Publish all closes with partial success after a server action loses its connection", async ({ browser }, testInfo) => {
  const { team, slug, api } = await editor(browser);
  await throttleQueue(team);
  for (const title of ["Unreachable draft", "First draft"]) await api("/articles", { title, body: "Open Settings." });
  await team.goto(`/app/${slug}/docs`);
  const queue = team.getByRole("region", { name: "Waiting to publish" });
  await expect(queue.getByRole("listitem").first()).toContainText("First draft");
  let requests = 0;
  await team.route(`**/app/${slug}/docs`, async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"] && ++requests === 2) await route.abort("connectionfailed");
    else await route.fallback();
  });
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  const confirm = team.getByRole("alertdialog", { name: "Publish 3 articles?", exact: true });
  await confirm.getByRole("button", { name: "Publish all", exact: true }).click();
  const summary = team.locator("[data-sonner-toast]").filter({ hasText: "Published 1 article" });
  await expect(summary).toContainText("Unreachable draft: Couldn't reach the server");
  await expect(summary).toContainText("Invite your team: Not attempted: Couldn't reach the server");
  await expect(confirm).toBeHidden();
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  const unattempted = queue.getByRole("listitem").filter({ hasText: "Invite your team" });
  await expect(unattempted.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await expect(queue.getByRole("listitem").filter({ hasText: "Unreachable draft" }).getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await expect(queue.getByRole("button", { name: "Publish all", exact: true })).toBeVisible();
  await expect(queue.getByRole("link", { name: "Review article", exact: true })).toHaveCount(0);
  await expect(queue.getByRole("link", { name: "Unreachable draft", exact: true })).toBeFocused();
  await expect(team.locator(".docs-live-footer")).toContainText("1 article live");
  expect(requests).toBe(2);
  await checkpoints(testInfo)(team, "docs-publish-connection-failure", { fullPage: false });
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  const retry = team.getByRole("alertdialog", { name: "Publish 2 articles?", exact: true });
  await retry.getByRole("button", { name: "Publish all", exact: true }).click();
  await expect(retry).toBeHidden();
  await expect(unattempted).toHaveCount(0);
  await expect(queue.getByRole("listitem")).toHaveCount(0);
  await expect(team.locator(".docs-live-footer")).toContainText("3 articles live");
  expect(requests).toBe(4);
});

test("Publish all stops at the article limit, reports partial success and keeps refused rows publishable", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, CLOUD_URL, "Tess Team");
  await createProject(team, "Acme", slug, cloudPortalUrl);
  const api = await apiFor(team, slug);
  await throttleQueue(team);
  for (const title of ["Last draft", "Limit draft", "First draft"]) await api("/articles", { title, body: "Open Settings." });
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(`INSERT INTO article (id, "projectId", slug, title, "publishedAt", "updatedAt")
      SELECT gen_random_uuid()::text, p.id, 'existing-' || n, 'Existing ' || n, now(), now()
      FROM project p CROSS JOIN generate_series(1, 49) n WHERE p.slug = $1`, [slug]);
  } finally { await db.end(); }
  await team.goto(`/app/${slug}/docs`);
  const queue = team.getByRole("region", { name: "Waiting to publish" });
  await expect(queue.getByRole("listitem").first()).toContainText("First draft");
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  const confirm = team.getByRole("alertdialog", { name: "Publish 3 articles?", exact: true });
  await confirm.getByRole("button", { name: "Publish all", exact: true }).click();
  const summary = team.locator("[data-sonner-toast]").filter({ hasText: "Published 1 article" });
  await expect(summary).toContainText("Limit draft: Your plan publishes up to 50 articles.");
  await expect(summary).toContainText("Last draft: Not attempted: Your plan publishes up to 50 articles.");
  await expect(team.locator("[data-sonner-toast]")).toHaveCount(1);
  await expect(confirm).toBeHidden();
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await expect(queue.getByRole("listitem").filter({ hasText: "Last draft" }).getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await expect(queue.getByRole("listitem").filter({ hasText: "Limit draft" }).getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await expect(queue.getByRole("button", { name: "Publish all", exact: true })).toBeVisible();
  await expect(queue.getByRole("link", { name: "Review article", exact: true })).toHaveCount(0);
  await expect(queue.getByRole("link", { name: "Limit draft", exact: true })).toBeFocused();
  await expect(team.locator(".docs-live-footer")).toContainText("50 articles live");
});


test("the phone Docs sheet keeps app navigation reachable without a breadcrumb bar", async ({ browser }) => {
  const { team, slug } = await editor(browser);
  await team.setViewportSize({ width: 390, height: 844 });
  await team.goto(`/app/${slug}/docs`);
  await expect(team.locator("main > header")).toHaveCount(0);
  await team.getByRole("button", { name: "Browse docs" }).click();
  const docs = team.getByRole("dialog", { name: "Docs navigation" });
  const search = docs.getByRole("button", { name: "Search docs" });
  const close = docs.getByRole("button", { name: "Close", exact: true });
  await expect(search).toBeInViewport();
  await expect(close).toBeInViewport();
  const searchBox = (await search.boundingBox())!;
  const closeBox = (await close.boundingBox())!;
  expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(closeBox.x);
  await docs.getByRole("button", { name: "App navigation" }).click();
  const app = team.getByRole("dialog", { name: "Sidebar" });
  await expect(app).toBeVisible();
  await app.getByRole("link", { name: "Settings", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/settings/general`);
});

test("article tool focus stays in the card when opened, Escape respects writing and menus, and settings restore focus", async ({ browser }, testInfo) => {
  const { team, slug } = await editor(browser);
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  await expect(team.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  const buttons = team.getByRole("toolbar", { name: "Article tools" });
  await buttons.getByRole("button", { name: "Settings", exact: true }).click();
  const card = team.getByRole("complementary", { name: "Article tools" });
  await expect(card.getByRole("heading", { name: "Settings", exact: true })).toBeFocused();
  for (const name of ["Title", "Article"]) {
    const input = team.getByRole("textbox", { name, exact: true });
    await input.focus();
    await team.keyboard.press("Escape");
    await expect(input).toBeFocused();
    await expect(card).toBeVisible();
  }
  const collection = card.getByRole("combobox", { name: "Collection", exact: true });
  await collection.click();
  await expect(team.getByRole("listbox")).toBeVisible();
  await team.keyboard.press("Escape");
  await expect(card).toBeVisible();
  await expect(collection).toBeFocused();
  const description = card.getByRole("textbox", { name: "Search description" });
  await description.fill("A summary for search results.");
  await description.evaluate((field) => field.addEventListener("keydown", (event) => event.preventDefault(), { once: true }));
  await team.keyboard.press("Escape");
  await expect(description).toBeFocused();
  await expect(card).toBeVisible();
  await expect(description).toHaveAccessibleDescription("Shows in search results and link previews.");
  await card.getByRole("button", { name: "Save changes" }).click();
  await expect(team.getByText("Settings saved")).toBeVisible();
  await expect(buttons.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await expect(team.locator(".docs-editor-scroll")).not.toContainText("A summary for search results.");
  await buttons.getByRole("button", { name: "History", exact: true }).click();
  await expect(card.getByRole("heading", { name: "History", exact: true })).toBeFocused();
  await team.keyboard.press("Escape");
  await expect(buttons.getByRole("button", { name: "History", exact: true })).toBeFocused();
  await checkpoints(testInfo)(team, "docs-tools-keyboard-focus", { fullPage: false });
});

test("table and code context controls remain reachable on small laptops and phones", async ({ browser }, testInfo) => {
  const { team, slug } = await editor(browser);
  for (const width of [1100, 390]) {
    await team.setViewportSize({ width, height: 900 });
    await team.goto(`/app/${slug}/docs/invite-your-team`);
    const article = team.getByRole("textbox", { name: "Article", exact: true });
    const formatting = team.getByRole("toolbar", { name: "Formatting", exact: true });
    await article.click();
    await team.keyboard.press("ControlOrMeta+Home");
    await team.keyboard.press("ControlOrMeta+Shift+ArrowRight");
    await expect(team.getByRole("toolbar", { name: "Text selection", exact: true })).toBeVisible();
    await team.keyboard.press("ArrowRight");
    await formatting.locator("summary").filter({ hasText: "Insert" }).click();
    await formatting.locator(".docs-insert-menu").getByRole("button", { name: "Table", exact: true }).click();
    await expect(formatting.getByRole("group", { name: "Table", exact: true })).toBeVisible();
    await formatting.getByRole("button", { name: "Add row", exact: true }).click();
    await expect(article.locator("tr")).toHaveCount(4);
    await formatting.getByRole("button", { name: "Delete table", exact: true }).click();
    await article.click();
    await formatting.locator("summary").filter({ hasText: "Insert" }).click();
    await formatting.locator(".docs-insert-menu").getByRole("button", { name: "Code block", exact: true }).click();
    await expect(formatting.getByRole("group", { name: "Code", exact: true })).toBeVisible();
    await formatting.getByRole("button", { name: "File name", exact: true }).click();
    await expect(team.getByRole("dialog", { name: "Name the code", exact: true })).toBeVisible();
    await team.keyboard.press("Escape");
  }
  await checkpoints(testInfo)(team, "docs-phone-context-tools", { fullPage: false });
});

test("phone tabs have one switcher popover, restore visible focus, and tablet navigation opens the app sidebar", async ({ browser }, testInfo) => {
  const { team, slug, api } = await editor(browser);
  await api("/tabs", { name: "Guides" });
  await team.setViewportSize({ width: 390, height: 844 });
  await team.goto(`/app/${slug}/docs/tabs/guides`);
  await expect(team.locator('[data-slot="docs-page-header"]')).toBeVisible();
  await team.getByRole("button", { name: "Browse docs" }).click();
  const tree = team.getByRole("dialog", { name: "Docs navigation" });
  await tree.locator(".docs-tab-switcher").click();
  await expect(team.getByRole("list", { name: "Tabs", exact: true })).toHaveCount(1);
  await team.getByRole("button", { name: "New tab", exact: true }).click();
  const dialog = team.getByRole("dialog", { name: "New tab", exact: true });
  await expect(dialog).toBeVisible();
  await team.keyboard.press("Escape");
  await expect(tree.locator(".docs-tab-switcher")).toBeFocused();
  await tree.getByRole("link", { name: "Overview", exact: true }).click();
  await team.setViewportSize({ width: 850, height: 900 });
  await team.getByRole("button", { name: "Browse docs" }).click();
  await tree.getByRole("button", { name: "App navigation", exact: true }).click();
  await expect(tree).toBeHidden();
  await expect(team.locator('[data-slot="sidebar"][data-state]')).toHaveAttribute("data-state", "expanded");
  await checkpoints(testInfo)(team, "docs-tablet-app-navigation", { fullPage: false });
});

test("the publish queue leaves unseen Autopilot edits for review and singularises safe publishing", async ({ browser }, testInfo) => {
  const { team, slug, api } = await editor(browser);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(`WITH action AS (
      INSERT INTO code_change_action (id, "articleId", kind, probability, status, payload)
      SELECT gen_random_uuid()::text, a.id, 'ARTICLE_EDIT', 1, 'PENDING', '{}'::jsonb FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = 'invite-your-team' RETURNING id, "articleId"
    ) INSERT INTO article_revision (id, "articleId", title, body, "codeChangeActionId") SELECT gen_random_uuid()::text, "articleId", 'Invite your team', 'Unseen suggested words.', id FROM action`, [slug]);
  } finally { await db.end(); }
  await api("/articles", { title: "First steps", body: "Open Settings." });
  await team.goto(`/app/${slug}/docs`);
  const queue = team.getByRole("region", { name: "Waiting to publish" });
  const blocked = queue.getByRole("listitem").filter({ hasText: "Invite your team" });
  await expect(blocked.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  await expect(blocked.getByRole("link", { name: "Review Autopilot edit", exact: true })).toBeVisible();
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(blocked.getByRole("link", { name: "Review Autopilot edit", exact: true })).toBeVisible();
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  const confirm = team.getByRole("alertdialog", { name: "Publish 1 article?", exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Publish all", exact: true }).click();
  await expect(team.getByText("Published 1 article", { exact: true })).toBeVisible();
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await expect(queue.getByRole("button", { name: "Publish all", exact: true })).toHaveCount(0);
  await expect(team.locator(".docs-live-footer")).toContainText("1 article live");
  await checkpoints(testInfo)(team, "docs-unseen-edits-need-review", { fullPage: false });
});

async function pendingQueueEdit(project: string, article: string) {
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(`WITH action AS (
      INSERT INTO code_change_action (id, "articleId", kind, probability, status, payload)
      SELECT gen_random_uuid()::text, a.id, 'ARTICLE_EDIT', 1, 'PENDING', '{}'::jsonb FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = $2 RETURNING id, "articleId"
    ) INSERT INTO article_revision (id, "articleId", title, body, "codeChangeActionId") SELECT gen_random_uuid()::text, "articleId", 'Suggested edit', 'Unseen suggested words.', id FROM action`, [project, article]);
  } finally { await db.end(); }
}

test("published articles with waiting Autopilot changes stay out of queue publishing", async ({ browser }) => {
  const { team, slug, api } = await editor(browser);
  await api("/articles/invite-your-team/publish", {});
  await api("/articles/invite-your-team", { body: "Unseen suggested words." }, "PATCH");
  await pendingQueueEdit(slug, "invite-your-team");
  await api("/articles", { title: "First steps", body: "Open Settings." });
  await team.goto(`/app/${slug}/docs`);
  const queue = team.getByRole("region", { name: "Waiting to publish" });
  const blocked = queue.getByRole("listitem").filter({ hasText: "Invite your team" });
  await expect(blocked.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  await expect(blocked.getByRole("link", { name: "Review Autopilot edit", exact: true })).toBeVisible();
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(blocked.getByRole("link", { name: "Review Autopilot edit", exact: true })).toBeVisible();
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  const confirm = team.getByRole("alertdialog", { name: "Publish 1 article?", exact: true });
  await confirm.getByRole("button", { name: "Publish all", exact: true }).click();
  await expect(team.getByText("Published 1 article", { exact: true })).toBeVisible();
  await expect(blocked).toBeVisible();
  await expect(queue.getByRole("button", { name: "Publish all", exact: true })).toHaveCount(0);
  await expect(team.locator(".docs-live-footer")).toContainText("2 articles live");
});

test("a late Autopilot edit gets a review link and Publish all continues with the remaining articles", async ({ browser }) => {
  const { team, slug, api } = await editor(browser);
  await throttleQueue(team);
  await api("/articles", { title: "First steps", body: "Open Settings." });
  await team.goto(`/app/${slug}/docs`);
  const queue = team.getByRole("region", { name: "Waiting to publish" });
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  const confirm = team.getByRole("alertdialog", { name: "Publish 2 articles?", exact: true });
  await pendingQueueEdit(slug, "first-steps");
  await confirm.getByRole("button", { name: "Publish all", exact: true }).click();
  await expect(confirm).toBeHidden();
  const review = queue.getByRole("link", { name: "Review Autopilot edit", exact: true });
  await expect(review).toBeVisible();
  await expect(review).toHaveAccessibleName("Review Autopilot edit");
  await expect(review).toHaveAttribute("href", `/app/${slug}/docs/first-steps`);
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await expect(queue.getByRole("listitem")).toContainText("First steps");
  await expect(queue.getByRole("link", { name: "First steps", exact: true })).toBeFocused();
  await expect(team.locator(".docs-live-footer")).toContainText("1 article live");
});

test("the portaled article title belongs to its form and blocks an empty title", async ({ browser }) => {
  const { team, slug } = await editor(browser);
  await team.goto(`/app/${slug}/docs/new`);
  const title = team.getByRole("textbox", { name: "Title", exact: true });
  await team.getByRole("textbox", { name: "Article", exact: true }).fill("A useful guide.");
  await title.fill("");
  await expect(title).toHaveAttribute("form", "article-form");
  await team.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(title).toBeFocused();
  expect(await title.evaluate((node: HTMLTextAreaElement) => node.validity.valueMissing)).toBe(true);
  await expect(team).toHaveURL(new RegExp(`/app/${slug}/docs/new$`));
  await title.fill("A useful guide");
  await team.getByRole("button", { name: "Save draft", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/a-useful-guide`);
});

for (const all of [false, true]) {
  test(`a late Autopilot edit restores focus after ${all ? "Publish all" : "Publish"} loses its control`, async ({ browser }) => {
    const { team, slug } = await editor(browser);
    await throttleQueue(team);
    await team.goto(`/app/${slug}/docs`);
    const queue = team.getByRole("region", { name: "Waiting to publish" });
    const action = all ? "Publish all" : "Publish";
    await queue.getByRole("button", { name: action, exact: true }).click();
    const confirm = team.getByRole("alertdialog");
    await pendingQueueEdit(slug, "invite-your-team");
    await confirm.getByRole("button", { name: action, exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(queue.getByRole("link", { name: "Review Autopilot edit", exact: true })).toBeVisible();
    await expect(queue.getByRole("button", { name: /Publish/ })).toHaveCount(0);
    await expect(queue.getByRole("link", { name: "Invite your team", exact: true })).toBeFocused();
  });
}

test("Publish all skips a published article changed by a late Autopilot edit and publishes the next draft", async ({ browser }) => {
  const { team, slug, api } = await editor(browser);
  await throttleQueue(team);
  const refresh = await holdQueueRefresh(team);
  await api("/articles", { title: "First steps", body: "Open Settings." });
  await api("/articles/invite-your-team/publish", {});
  await api("/articles/invite-your-team", { body: "Saved changes for the team." }, "PATCH");
  await team.goto(`/app/${slug}/docs`);
  const queue = team.getByRole("region", { name: "Waiting to publish" });
  await expect(queue.getByRole("listitem").first()).toContainText("Invite your team");
  await queue.getByRole("button", { name: "Publish all", exact: true }).click();
  const confirm = team.getByRole("alertdialog");
  await api("/articles/invite-your-team", { body: "Late suggested words." }, "PATCH");
  await pendingQueueEdit(slug, "invite-your-team");
  refresh();
  // The live render now knows about the edit, but the open dialog still confirms the earlier versions.
  await expect(team.locator(".docs-publish-queue li").filter({ hasText: "Invite your team" }).locator(".docs-review-link")).toHaveText("Review Autopilot edit");
  await expect(confirm).toHaveAccessibleName("Publish 2 articles?");
  await confirm.getByRole("button", { name: "Publish all", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await expect(queue.getByRole("link", { name: "Review Autopilot edit", exact: true })).toBeVisible();
  await expect(queue.getByRole("link", { name: "Invite your team", exact: true })).toBeFocused();
  await expect(team.locator(".docs-live-footer")).toContainText("2 articles live");
});

test("More actions restores focus after cancelling article dialogs", async ({ browser }) => {
  const { team, slug, api } = await editor(browser);
  await api("/articles/invite-your-team/publish", {});
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const more = team.getByRole("button", { name: "More actions", exact: true });
  for (const action of ["Unpublish", "Delete"]) {
    for (const close of ["cancel", "escape"]) {
      await more.click();
      await team.getByRole("button", { name: action, exact: true }).click();
      const confirm = team.getByRole("alertdialog");
      await expect(confirm).toBeVisible();
      if (close === "cancel") await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      else await team.keyboard.press("Escape");
      await expect(confirm).toBeHidden();
      await expect(more).toBeFocused();
    }
  }
  await more.click();
  await team.getByRole("button", { name: "Unpublish", exact: true }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Unpublish", exact: true }).click();
  await expect(team.getByText("Unpublished", { exact: true })).toBeVisible();
  await expect(more).toBeFocused();
});

test("the first paragraph uses the same body style as later paragraphs", async ({ browser }) => {
  const { team, slug, api } = await editor(browser);
  await api("/articles/invite-your-team", { body: "Owners send invites.\n\nTeammates accept them." }, "PATCH");
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const paragraphs = team.getByRole("textbox", { name: "Article", exact: true }).locator("p");
  await expect(paragraphs).toHaveCount(2);
  const styles = await paragraphs.evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    return [style.fontSize, style.color, style.lineHeight];
  }));
  expect(styles[0]).toEqual(styles[1]);
});

test("the collection drag hint requires two articles and a mouse-sized layout", async ({ browser }) => {
  const { team, slug, api } = await editor(browser);
  await api("/collections", { name: "Guides" });
  const hint = team.getByText("Drag rows to reorder them; readers see this order.", { exact: true });
  await team.goto(`/app/${slug}/docs/collections/guides`);
  const more = team.getByRole("button", { name: "More actions", exact: true });
  await more.click();
  await team.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = team.getByRole("alertdialog");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(more).toBeFocused();
  await expect(hint).toBeHidden();
  await api("/collections", { name: "Subguides", parent: "guides" });
  await team.reload();
  await expect(hint).toBeHidden();
  await api("/articles", { title: "One guide", body: "Words.", collection: "guides" });
  await team.reload();
  await expect(hint).toBeHidden();
  await api("/articles", { title: "Another guide", body: "Words.", collection: "guides" });
  await team.reload();
  await expect(hint).toBeVisible();
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(hint).toBeHidden();
  const touch = await browser.newContext({ hasTouch: true, viewport: { width: 1440, height: 900 }, storageState: await team.context().storageState() });
  try {
    const page = await touch.newPage();
    await page.goto(`${APP_URL}/app/${slug}/docs/collections/guides`);
    await expect(page.getByText("Drag rows to reorder them; readers see this order.", { exact: true })).toBeHidden();
  } finally { await touch.close(); }
});

for (const published of [true, false]) {
  test(`Publish all holds a ${published ? "published article" : "draft"} after a teammate's plain save and continues`, async ({ browser }) => {
    const { team, slug, api } = await editor(browser);
    await throttleQueue(team);
    const refresh = await holdQueueRefresh(team);
    const teammate = await signUp(browser, APP_URL, "Eddie Editor");
    const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
    await db.connect();
    try {
      await db.query(`INSERT INTO team_member (id, "projectId", "userId") SELECT gen_random_uuid()::text, p.id, u.id FROM project p, "user" u WHERE p.slug = $1 AND u.email = $2`, [slug, teammate.email]);
    } finally { await db.end(); }
    if (published) await api("/articles/invite-your-team/publish", {});
    await api("/articles", { title: "First steps", body: "Open Settings." });
    await api("/articles/invite-your-team", { body: "The reviewed words." }, "PATCH");
    await teammate.goto(`/app/${slug}/docs/invite-your-team`);
    await team.goto(`/app/${slug}/docs`);
    const queue = team.getByRole("region", { name: "Waiting to publish" });
    await expect(queue.getByRole("listitem").first()).toContainText("Invite your team");
    await queue.getByRole("button", { name: "Publish all", exact: true }).click();
    const confirm = team.getByRole("alertdialog");
    await teammate.getByRole("textbox", { name: "Article", exact: true }).fill("A half-finished save.");
    await teammate.getByRole("button", { name: "Save", exact: true }).click();
    await expect(teammate.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    await api("/articles", { title: "Later article", body: "Not in the confirmed batch." });
    refresh();
    await expect(team.locator('.docs-publish-queue [data-queue-article="later-article"]')).toBeVisible();
    await expect(confirm).toHaveAccessibleName("Publish 2 articles?");
    await confirm.getByRole("button", { name: "Publish all", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(queue.getByRole("listitem")).toHaveCount(2);
    await expect(queue.getByRole("link", { name: "Later article", exact: true })).toBeVisible();
    await expect(queue.getByRole("link", { name: "Invite your team", exact: true })).toBeFocused();
    await expect(team.locator(".docs-live-footer")).toContainText(`${published ? 2 : 1} article${published ? "s" : ""} live`);
    await team.setViewportSize({ width: 390, height: 844 });
    const review = queue.getByRole("link", { name: "Review changes", exact: true });
    await expect(review).toBeVisible();
    await expect(review).toHaveAccessibleName("Review changes");
    await expect(queue.getByRole("link", { name: "Review Autopilot edit", exact: true })).toHaveCount(0);
  });
}
