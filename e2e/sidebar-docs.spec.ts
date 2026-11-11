import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("narrowing the article inset closes its tools without losing the Settings draft", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await createProject(team, "Example", slug);
  const api = await apiFor(team, slug);
  await api("/collections", { name: "Guides" });
  await api("/articles", { title: "Invite your team", body: "Owners send invites from Settings." });
  await team.setViewportSize({ width: 1366, height: 900 });
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  const buttons = team.getByRole("toolbar", { name: "Article tools", exact: true });
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await buttons.getByRole("button", { name: "Settings", exact: true }).click();
  const card = team.getByRole("complementary", { name: "Article tools", exact: true });
  await expect(card).toBeVisible();
  await card.getByRole("checkbox", { name: /^Custom slug/ }).check();
  await card.getByRole("textbox", { name: "Slug", exact: true }).fill("invite-your-whole-team");
  await card.getByRole("combobox", { name: "Listed in", exact: true }).click();
  await team.getByRole("option", { name: "Unlisted", exact: true }).click();
  await card.getByRole("combobox", { name: "Collection", exact: true }).click();
  await team.getByRole("option", { name: "Guides", exact: true }).click();
  await card.getByRole("checkbox", { name: /^Show the updated date/ }).uncheck();
  await card.getByRole("radio", { name: "Signed-in readers", exact: true }).check();
  await card.getByRole("radio", { name: "Show with a lock", exact: true }).check();
  await card.getByRole("textbox", { name: "Search description", exact: true }).fill("A draft summary.");
  await card.getByRole("textbox", { name: "Keywords", exact: true }).fill("teams, invitations");
  await card.getByRole("checkbox", { name: /^Block search indexing/ }).check();
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(card).toBeHidden();
  await expect(team.getByRole("dialog")).toBeHidden();
  await expect(buttons.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("aria-expanded", "false");
  await buttons.getByRole("button", { name: "Settings", exact: true }).click();
  const sheet = team.getByRole("dialog", { name: "Article settings", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: "Slug", exact: true })).toHaveValue("invite-your-whole-team");
  await expect(sheet.getByRole("combobox", { name: "Listed in", exact: true })).toContainText("Unlisted");
  await expect(sheet.getByRole("combobox", { name: "Collection", exact: true })).toContainText("Guides");
  await expect(sheet.getByRole("checkbox", { name: /^Show the updated date/ })).not.toBeChecked();
  await expect(sheet.getByRole("radio", { name: "Signed-in readers", exact: true })).toBeChecked();
  await expect(sheet.getByRole("radio", { name: "Show with a lock", exact: true })).toBeChecked();
  await expect(sheet.getByRole("textbox", { name: "Search description", exact: true })).toHaveValue("A draft summary.");
  await expect(sheet.getByRole("textbox", { name: "Keywords", exact: true })).toHaveValue("teams, invitations");
  await expect(sheet.getByRole("checkbox", { name: /^Block search indexing/ })).toBeChecked();
  await checkpoint(team, "settings-draft-after-sidebar-opens", { fullPage: false });
  await team.setViewportSize({ width: 1680, height: 900 });
  await expect(sheet).toBeHidden();
  await expect(card).toBeVisible();
  await expect(card.getByRole("textbox", { name: "Slug", exact: true })).toHaveValue("invite-your-whole-team");
  await expect(card.getByRole("combobox", { name: "Collection", exact: true })).toContainText("Guides");
  await expect(card.getByRole("combobox", { name: "Listed in", exact: true })).toContainText("Unlisted");
  // A shared tool URL still opens its sheet on a fresh load at a narrow inset.
  await team.setViewportSize({ width: 1366, height: 900 });
  await expect(buttons.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute("aria-expanded", "false");
  await team.goto(`/app/${slug}/docs/invite-your-team?settings`);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("checkbox", { name: /^Custom slug/ })).not.toBeChecked();
});

test("App navigation in the Docs sheet persists the sidebar choice at non-phone widths", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await createProject(team, "Example", slug);
  await team.setViewportSize({ width: 900, height: 800 });
  await team.goto(`/app/${slug}/docs`);
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  const cookie = async () => (await team.context().cookies()).find((cookie) => cookie.name === "sidebar_state")?.value;
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  expect(await cookie()).toBeUndefined();
  await team.getByRole("button", { name: "Browse docs", exact: true }).click();
  const sheet = team.getByRole("dialog", { name: "Docs navigation", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "App navigation", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect.poll(cookie).toBe("true");
  await team.reload();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(sheet).toBeHidden();
  await checkpoint(team, "docs-app-navigation-opened-sidebar", { fullPage: false });
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect.poll(cookie).toBe("false");
  await team.reload();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(sheet).toBeHidden();
  await checkpoint(team, "docs-app-navigation-collapsed-sidebar", { fullPage: false });
});

test("new and saved articles fit the same room beside the sidebar", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await createProject(team, "Example", slug);
  const api = await apiFor(team, slug);
  await api("/articles", { title: "Invite your team", body: "Owners send invites from Settings." });
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  for (const article of ["new", "invite-your-team"]) {
    await team.setViewportSize({ width: 1280, height: 900 });
    await team.goto(`/app/${slug}/docs/${article}`);
    const formatting = team.getByRole("toolbar", { name: "Formatting", exact: true });
    await expect(formatting.getByRole("button", { name: "Bold", exact: true })).toBeVisible();
    for (const name of ["Quote", "Code", "Table"]) {
      await expect(formatting.getByRole("button", { name, exact: true })).toBeHidden();
    }
    // Its scrollbar is hidden: no formatting control should be clipped out of sight.
    expect(await formatting.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await team.setViewportSize({ width: 1024, height: 768 });
    await expect(team.locator(".docs-article-form")).toHaveCSS("padding-left", "28px");
    await expect.poll(async () => (await team.getByRole("textbox", { name: "Article", exact: true }).boundingBox())!.width).toBeGreaterThanOrEqual(480);
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    await checkpoint(team, `${article === "new" ? "new" : "saved"}-article-open-sidebar-laptop`, { fullPage: false });
    await team.setViewportSize({ width: 1680, height: 900 });
    for (const name of ["Quote", "Code", "Table"]) {
      await expect(formatting.getByRole("button", { name, exact: true })).toBeVisible();
    }
  }
});

test("the Docs sheet stays closed after sidebar toggles move its tree inline", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Example Team");
  await createProject(team, "Example", slug);
  await team.setViewportSize({ width: 1024, height: 768 });
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  await team.goto(`/app/${slug}/docs`);
  const browse = team.getByRole("button", { name: "Browse docs", exact: true });
  await browse.click();
  const sheet = team.getByRole("dialog", { name: "Docs navigation", exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).focus();
  await team.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(team.getByRole("navigation", { name: "Docs", exact: true })).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await team.getByRole("button", { name: "Search docs", exact: true }).click();
  const command = team.getByRole("dialog", { name: "Go to or do", exact: true });
  await expect(command).toBeVisible();
  await expect(command.getByRole("combobox")).toBeFocused();
  await checkpoint(team, "docs-search-after-inline-tree", { fullPage: false });
  await team.keyboard.press("Escape");
  await expect(command).toBeHidden();
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect(browse).toBeVisible();
  await expect(browse).toHaveAttribute("aria-expanded", "false");
  await expect(sheet).toBeHidden();
  await browse.click();
  await expect(sheet).toBeVisible();
});
