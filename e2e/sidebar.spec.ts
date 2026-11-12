import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("the sidebar starts collapsed and remembers the user's choice across pages and reloads", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await team.setViewportSize({ width: 1366, height: 768 });
  await createProject(team, "Example", slug);
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  const rail = team.locator('[data-slot="sidebar-container"]');
  const toggle = sidebar.locator('[data-slot="sidebar-trigger"]');
  const pages = ["Home", "Inbox", "Feedback", "Docs", "Changelog"];
  const visit = async (name: string, state: "collapsed" | "expanded") => {
    await sidebar.getByRole("link", { name, exact: true }).click();
    await expect(sidebar.getByRole("link", { name, exact: true })).toHaveAttribute("data-active");
    await expect(sidebar).toHaveAttribute("data-state", state);
  };

  // No preference yet: direct loads of every page and navigation through the rail stay collapsed.
  expect((await team.context().cookies()).find((cookie) => cookie.name === "sidebar_state")).toBeUndefined();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  const width = (await rail.boundingBox())!.width;
  for (const name of pages) {
    await visit(name, "collapsed");
    await team.reload();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(width);
    if (name === "Docs") {
      const panes = team.locator('[data-slot="pane-layout"]');
      await expect.poll(async () => (await panes.boundingBox())!.x).toBe(width);
      await checkpoint(team, "docs-collapsed-laptop", { fullPage: false });
    }
  }

  await toggle.click();
  for (const name of pages) {
    await visit(name, "expanded");
    await team.reload();
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    if (name === "Docs") await checkpoint(team, "docs-opened-laptop", { fullPage: false });
  }

  // The keyboard shortcut persists the reverse choice too.
  await team.keyboard.press("ControlOrMeta+b");
  for (const name of pages) {
    await visit(name, "collapsed");
    await team.reload();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(width);
  }

  // Resizing doesn't change the desktop preference; the phone sheet still closes on navigation.
  await toggle.click();
  await team.setViewportSize({ width: 1100, height: 768 });
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await visit("Home", "expanded");
  await team.setViewportSize({ width: 390, height: 844 });
  await team.locator("main > header").getByRole("button", { name: "Toggle Sidebar" }).click();
  await team.getByRole("dialog").getByRole("link", { name: "Docs", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs`);
  await expect(team.getByRole("dialog")).toBeHidden();
  await checkpoint(team, "docs-phone", { fullPage: false });
  await team.setViewportSize({ width: 1366, height: 768 });
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await team.reload();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

for (const section of ["Settings", "Reporting", "Autopilot"]) {
  test(`${section} keeps room for its content with the sidebar open at tablet width`, async ({ browser }, testInfo) => {
    const checkpoint = checkpoints(testInfo);
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const team = await signUp(browser, APP_URL, "Example Team");
    await createProject(team, "Example", slug);
    await team.setViewportSize({ width: 768, height: 900 });
    const sidebar = team.locator('[data-slot="sidebar"][data-state]');
    await sidebar.locator('[data-slot="sidebar-trigger"]').click();
    await team.goto(`/app/${slug}/${section === "Settings" ? "settings/general" : section.toLowerCase()}`);
    const panes = team.locator('[data-slot="pane-layout"]');
    const content = panes.locator(":scope > div:last-child");
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    await expect(panes).toHaveCSS("flex-direction", "column");
    await expect.poll(async () => (await content.boundingBox())!.width).toBeGreaterThanOrEqual(480);
    if (section === "Settings") {
      await expect.poll(async () => (await team.getByRole("textbox", { name: "Project name", exact: true }).boundingBox())!.width).toBeGreaterThanOrEqual(400);
    }
    expect(await team.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await checkpoint(team, `${section.toLowerCase()}-opened-sidebar-tablet`, { fullPage: false });
    if (section !== "Autopilot") {
      await panes.locator("aside summary").click();
      const menu = panes.getByRole("navigation", { name: section, exact: true });
      await expect(menu).toBeVisible();
      await menu.getByRole("link", { name: section === "Settings" ? "Team & roles" : "Articles", exact: true }).click();
      await team.waitForURL(`**/${section === "Settings" ? "settings/team" : "reporting/articles"}`);
      await expect(panes.locator("aside details")).not.toHaveAttribute("open");
    }
    if (section === "Autopilot") {
      await team.setViewportSize({ width: 1024, height: 900 });
      await team.reload();
      await expect(panes).toHaveCSS("flex-direction", "column");
      await expect.poll(async () => (await content.boundingBox())!.width).toBeGreaterThanOrEqual(700);
    }
    // Wider insets restore the menu beside the content, preserving the open sidebar.
    await team.setViewportSize({ width: 1440, height: 900 });
    await expect(panes).toHaveCSS("flex-direction", "row");
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
  });
}

test("a collapsed rail preserves the Docs tree and Customize columns at 1024px", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await createProject(team, "Example", slug);
  await team.setViewportSize({ width: 1024, height: 768 });
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  await team.goto(`/app/${slug}/docs`);
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(team.getByRole("navigation", { name: "Docs", exact: true })).toBeVisible();
  await expect(team.getByRole("button", { name: "Browse docs", exact: true })).toBeHidden();
  await checkpoint(team, "docs-collapsed-sidebar-1024", { fullPage: false });
  await team.goto(`/app/${slug}/customize/branding`);
  const menu = team.getByRole("navigation", { name: "Customize", exact: true }).first();
  const settings = team.locator('[data-slot="customize-settings"]');
  const preview = team.locator('iframe[title="Portal preview"]');
  await expect(menu).toBeVisible();
  await expect(preview).toBeVisible();
  await expect.poll(async () => (await preview.boundingBox())!.x - (await settings.boundingBox())!.x).toBeGreaterThanOrEqual(384);
  expect((await settings.boundingBox())!.x).toBeGreaterThanOrEqual((await menu.boundingBox())!.x + (await menu.boundingBox())!.width);
  await expect.poll(async () => (await preview.boundingBox())!.width).toBeGreaterThanOrEqual(360);
  await expect(team.frameLocator('iframe[title="Portal preview"]').locator(".portal-header")).toBeVisible();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  expect(await team.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await checkpoint(team, "customize-collapsed-sidebar-1024", { fullPage: false });
});

test("bolding an article leaves the collapsed sidebar and its cookie alone", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await createProject(team, "Example", slug);
  const api = await apiFor(team, slug);
  await api("/articles", { title: "Invite your team", body: "Owners send invites from Settings." });
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  const article = team.getByRole("textbox", { name: "Article", exact: true });
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  const cookie = async () => (await team.context().cookies()).find((item) => item.name === "sidebar_state");
  const before = await cookie();
  await team.getByRole("textbox", { name: "Title", exact: true }).press("ControlOrMeta+b");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  expect(await cookie()).toEqual(before);
  await article.focus();
  await expect(article).toBeFocused();
  await team.keyboard.press("ControlOrMeta+Home");
  // Each key uses the selection the editor committed, after the browser's selectionchange and rendering.
  const selectionSettled = () => article.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await selectionSettled();
  for (let i = 0; i < "Owners".length; i++) {
    await team.keyboard.press("Shift+ArrowRight");
    await selectionSettled();
    await expect.poll(() => team.evaluate(() => window.getSelection()?.toString())).toBe("Owners".slice(0, i + 1));
  }
  await expect.poll(() => team.evaluate(() => window.getSelection()?.toString().trim())).toBe("Owners");
  await team.keyboard.press("ControlOrMeta+b");
  await expect(article.locator("strong")).toHaveText("Owners");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  expect(await cookie()).toEqual(before);
  await checkpoint(team, "docs-bold-with-collapsed-sidebar", { fullPage: false });
});

test("Customize keeps a usable preview with an opened sidebar on a small laptop", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await team.setViewportSize({ width: 1024, height: 768 });
  await createProject(team, "Example", slug);
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  await team.goto(`/app/${slug}/customize/branding`);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  const settings = team.locator('[data-slot="customize-settings"]');
  const preview = team.locator('iframe[title="Portal preview"]');
  await expect(preview).toBeVisible();
  await expect.poll(async () => (await preview.boundingBox())!.width).toBeGreaterThanOrEqual(360);
  const settingsBox = (await settings.boundingBox())!;
  expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(settingsBox.y + settingsBox.height);
  expect(await team.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await preview.scrollIntoViewIfNeeded();
  await expect(team.frameLocator('iframe[title="Portal preview"]').locator(".portal-header")).toBeVisible();
  await checkpoint(team, "customize-opened-sidebar-small-laptop", { fullPage: false });
  // More room restores the three panes without changing the sidebar preference.
  await team.setViewportSize({ width: 1440, height: 768 });
  await expect(team.getByRole("navigation", { name: "Customize", exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await preview.boundingBox())!.x - (await settings.boundingBox())!.x).toBeGreaterThanOrEqual(384);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

test("Inbox keeps the conversation usable as an opened sidebar reduces its room", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await team.setViewportSize({ width: 1024, height: 768 });
  await createProject(team, "Example", slug);
  const api = await apiFor(team, slug);
  await api("/conversations", {
    user: { id: "example-user", name: "Example User", email: "e2e-user@example.com" },
    subject: "Can I export?", body: "Can I export my reports?",
  });
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  await team.goto(`/app/${slug}/inbox/1`);
  const conversation = team.locator(".inbox-messages-and-composer");
  const list = team.locator(".inbox-list-body");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(conversation).toBeVisible();
  await expect.poll(async () => (await conversation.boundingBox())!.width).toBeGreaterThanOrEqual(480);
  await expect(list).toBeHidden();
  await expect(team.getByRole("textbox", { name: "Reply", exact: true })).toBeInViewport();
  expect(await team.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await checkpoint(team, "inbox-opened-sidebar-small-laptop", { fullPage: false });
  // At a wider viewport the list fits, but details still belong in a sheet.
  await team.setViewportSize({ width: 1280, height: 768 });
  await expect(list).toBeVisible();
  await expect.poll(async () => (await conversation.boundingBox())!.width).toBeGreaterThanOrEqual(480);
  await team.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(team.getByRole("dialog", { name: "Conversation details", exact: true })).toBeVisible();
  await team.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(team.getByRole("dialog")).toBeHidden();
  // Collapsing the sidebar makes room for inline details; the control must follow the container too.
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  await expect(team.getByRole("complementary", { name: "Conversation details", exact: true })).toBeVisible();
  await team.getByRole("button", { name: "Hide details", exact: true }).click();
  await expect(team.getByRole("complementary", { name: "Conversation details", exact: true })).toBeHidden();
});

test("Docs keeps a readable editor with the sidebar and an article tool open", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await createProject(team, "Example", slug);
  const api = await apiFor(team, slug);
  await api("/articles", { title: "Invite your team", body: "Owners send invites from Settings." });
  await team.setViewportSize({ width: 1024, height: 768 });
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  await expect(team.locator(".docs-tree-pane")).toBeHidden();
  await checkpoint(team, "docs-open-sidebar-small-laptop", { fullPage: false });
  await team.getByRole("toolbar", { name: "Article tools", exact: true }).getByRole("button", { name: "Settings", exact: true }).click();
  // The editor's text keeps its room even while the tool is open in front of it.
  const article = team.locator('.docs-editor-page [role="textbox"][aria-label="Article"]');
  await expect.poll(async () => (await article.boundingBox())!.width).toBeGreaterThanOrEqual(480);
  const sheet = team.getByRole("dialog", { name: "Article settings", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("combobox", { name: "Collection", exact: true })).toBeVisible();
  await checkpoint(team, "docs-open-tool-small-laptop", { fullPage: false });
  await sheet.getByRole("button", { name: "Collapse article tools", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await team.getByRole("button", { name: "Browse docs", exact: true }).click();
  const tree = team.getByRole("dialog", { name: "Docs navigation", exact: true });
  await expect(tree.getByRole("link", { name: /^Invite your team/ })).toBeVisible();
  await tree.getByRole("button", { name: "Close", exact: true }).click();
  await expect(tree).toBeHidden();
  // At a wider inset both panes fit, and the same open tool moves beside the text on resize.
  await team.getByRole("toolbar", { name: "Article tools", exact: true }).getByRole("button", { name: "Settings", exact: true }).click();
  await team.setViewportSize({ width: 1600, height: 900 });
  const tools = team.getByRole("complementary", { name: "Article tools", exact: true });
  await expect(tools).toBeVisible();
  await expect(team.getByRole("navigation", { name: "Docs", exact: true })).toBeVisible();
  await expect(team.getByRole("dialog")).toBeHidden();
  await expect.poll(async () => (await article.boundingBox())!.width).toBeGreaterThanOrEqual(480);
  await tools.getByRole("button", { name: "Collapse article tools", exact: true }).click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

test("Inbox details remain reachable when a larger root font changes the container breakpoint", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await createProject(team, "Example", slug);
  const api = await apiFor(team, slug);
  await api("/conversations", { email: "e2e-user@example.com", subject: "Reports", body: "Can I export my reports?" });
  await team.setViewportSize({ width: 1440, height: 900 });
  await team.goto(`/app/${slug}/inbox/1`);
  const details = team.getByRole("complementary", { name: "Conversation details", exact: true });
  await expect(details).toBeVisible();
  // Change the font without resizing the window: rem queries change even though its pixel width stays put.
  await team.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
  await expect(details).toBeHidden();
  const show = team.getByRole("button", { name: "Show details", exact: true });
  await expect(show).toHaveAttribute("aria-haspopup", "dialog");
  await show.click();
  const sheet = team.getByRole("dialog", { name: "Conversation details", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: /Unassigned/ })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Needs reply, change status", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Not snoozed", exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: /Unassigned/ }).click();
  await expect(team.getByRole("menuitem", { name: "Assign to me", exact: true })).toBeVisible();
  await team.keyboard.press("Escape");
  await checkpoint(team, "inbox-large-root-font-details", { fullPage: false });
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
  await team.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
  await expect(details).toBeVisible();
  await team.getByRole("button", { name: "Hide details", exact: true }).click();
  await expect(details).toBeHidden();
  await team.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(details).toBeVisible();
});

test("on phones the tab bar goes between the main parts and opens the rest under More; a post has the screen to itself", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const { number } = (await api("/posts", { board: "feature-requests", title: "Dark mode" })) as unknown as { number: number };
  await team.setViewportSize({ width: 390, height: 844 });
  await team.goto(`/app/${slug}`);

  const bar = team.getByRole("navigation", { name: "Main" });
  // After the page in reading and focus order, as it's at the bottom of the screen.
  expect(await bar.evaluate((nav) => !!(document.querySelector("main")!.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(bar.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await checkpoint(team, "home-tab-bar", { fullPage: false });
  await bar.getByRole("link", { name: "Feedback" }).click();
  await team.waitForURL(`**/app/${slug}/feedback`);
  await expect(bar.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  await checkpoint(team, "feedback-tab-bar", { fullPage: false });
  // What's focused near the bottom scrolls clear of the bar.
  expect(await team.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom)).toBe("96px");
  // A post opened from the list has the screen to itself.
  await team.getByRole("link", { name: "Dark mode" }).first().click();
  await team.waitForURL(/[?&]post=/);
  await expect(bar).toBeHidden();
  await team.goBack();
  await expect(bar.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");

  // The Inbox is the window's height and scrolls inside: it ends above the bar.
  await bar.getByRole("link", { name: "Inbox" }).click();
  await team.waitForURL(`**/app/${slug}/inbox`);
  const inbox = team.locator(".inbox-workspace");
  await expect.poll(async () => (await inbox.boundingBox())!.y + (await inbox.boundingBox())!.height).toBeLessThanOrEqual((await bar.boundingBox())!.y);
  // Docs keeps its own phone navigation.
  await team.goto(`/app/${slug}/docs`);
  await expect(bar).toBeHidden();
  await team.goto(`/app/${slug}/feedback`);

  // More is the sidebar's menu, for the parts without a tab; open on their pages.
  await bar.getByRole("button", { name: "More" }).click();
  await team.getByRole("dialog").getByRole("link", { name: "Changelog", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/changelog`);
  await expect(team.getByRole("dialog")).toBeHidden();
  await expect(bar.getByRole("link", { name: "Feedback" })).not.toHaveAttribute("aria-current", "page");

  // A post's page, and the desktop, have no tab bar.
  await team.goto(`/app/${slug}/p/${number}`);
  await expect(team.getByRole("heading", { name: "Dark mode" }).first()).toBeVisible();
  await expect(bar).toBeHidden();
  await team.setViewportSize({ width: 1366, height: 768 });
  await team.goto(`/app/${slug}/feedback`);
  await expect(bar).toBeHidden();
  await checkpoint(team, "feedback-desktop", { fullPage: false });
});
