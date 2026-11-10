import { randomUUID } from "node:crypto";

import { expect, test, type Browser } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
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
  await expect(team.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
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
  const save = team.getByRole("button", { name: "Save", exact: true });
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
  const save = team.getByRole("button", { name: "Save", exact: true });
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
  await team.getByRole("textbox", { name: "Description", exact: true }).fill("Download and read your invoices.");
  const text = team.getByRole("textbox", { name: "Article", exact: true });
  await text.fill("Open Billing to download it.");
  const style = team.getByRole("combobox", { name: "Text style" });
  await style.selectOption("h2");
  await expect(text.getByRole("heading", { name: "Open Billing to download it.", level: 2 })).toBeVisible();
  await expect(style).toHaveValue("h2");
  await style.selectOption("text");
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
  await expect(team.getByText("Download and read your invoices.", { exact: true })).toBeVisible();
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
  await team.getByRole("button", { name: "Save", exact: true }).click();
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
  await expect(team.getByText("Articles published", { exact: true })).toBeVisible();
  await expect(queue).toContainText("Everything is published.");
  await expect(team.getByRole("region", { name: "At a glance" })).toContainText("4Live articles");
  await checkpoints(testInfo)(team, "docs-published-queue", { fullPage: false });
});


test("the phone Docs sheet keeps app navigation reachable without a breadcrumb bar", async ({ browser }) => {
  const { team, slug } = await editor(browser);
  await team.setViewportSize({ width: 390, height: 844 });
  await team.goto(`/app/${slug}/docs`);
  await expect(team.locator("main > header")).toHaveCount(0);
  await team.getByRole("button", { name: "Browse docs" }).click();
  await team.getByRole("dialog", { name: "Docs navigation" }).getByRole("button", { name: "App navigation" }).click();
  const app = team.getByRole("dialog", { name: "Sidebar" });
  await expect(app).toBeVisible();
  await app.getByRole("link", { name: "Settings", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/settings/general`);
});
