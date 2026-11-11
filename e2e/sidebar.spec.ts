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
  await team.getByRole("textbox", { name: "Title", exact: true }).press("Control+b");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  expect(await cookie()).toEqual(before);
  await article.click();
  await article.press("ControlOrMeta+Home");
  await article.press("Control+Shift+ArrowRight");
  await expect.poll(() => team.evaluate(() => window.getSelection()?.toString().trim())).toBe("Owners");
  await article.press("Control+b");
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
