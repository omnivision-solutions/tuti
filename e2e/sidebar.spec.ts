import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { createProject, signUp } from "./helpers";

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
