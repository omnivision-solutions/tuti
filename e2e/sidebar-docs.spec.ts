import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

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
