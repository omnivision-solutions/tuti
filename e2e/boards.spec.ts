import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("a team adds, renames and deletes boards; old board links keep working", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // A new project starts with one board, which can't be deleted while it's the only one.
  await owner.goto(`/app/${slug}/boards`);
  const row = (name: string) => owner.getByRole("listitem").filter({ hasText: name });
  await expect(row("Feature requests")).toContainText("/feedback/feature-requests · 0 posts");
  await expect(row("Feature requests").getByRole("button", { name: "Delete" })).toHaveCount(0);

  // Add a board; its URL follows the name.
  await owner.getByLabel("Name").fill("Bug reports");
  await expect(owner.getByLabel("URL")).toHaveValue("bug-reports");
  await owner.getByLabel("Description").fill("Something broken? Tell us here.");
  await owner.getByRole("button", { name: "Create board" }).click();
  await expect(row("Bug reports")).toContainText("/feedback/bug-reports · 0 posts · Something broken? Tell us here.");
  await checkpoint(owner, "team-boards");

  // Change its URL: the old one redirects on the portal.
  await row("Bug reports").getByRole("button", { name: "Edit" }).click();
  const dialog = owner.getByRole("dialog", { name: "Edit board" });
  await dialog.getByLabel("URL").fill("bugs");
  await checkpoint(owner, "team-edit-board", { fullPage: false });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(row("Bug reports")).toContainText("/feedback/bugs");

  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/feedback/bug-reports");
  await expect(visitor).toHaveURL(/\/feedback\/bugs$/);
  // The header's Feedback opens the first board; under it, a row of the boards.
  const parts = visitor.getByRole("navigation", { name: "Portal" });
  await expect(parts.getByRole("link")).toHaveText(["Feedback", "Roadmap", "Changelog", "Docs"]);
  await expect(parts.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  await expect(parts.getByRole("link", { name: "Feedback" })).toHaveAttribute("href", "/feedback/feature-requests");
  const boards = visitor.getByRole("navigation", { name: "Boards" });
  await expect(boards.getByRole("link", { name: "Bug reports" })).toHaveAttribute("aria-current", "page");
  await expect(boards.getByRole("link", { name: "Feature requests" })).not.toHaveAttribute("aria-current");
  await expect(visitor.getByText("Something broken? Tell us here.")).toBeVisible();
  await checkpoint(visitor, "portal-board-tabs");
  // Roadmap has no row of its own.
  await parts.getByRole("link", { name: "Roadmap" }).click();
  await expect(visitor.getByRole("heading", { name: "Roadmap" })).toBeVisible();
  await expect(parts.getByRole("link", { name: "Roadmap" })).toHaveAttribute("aria-current", "page");
  await expect(parts.getByRole("link", { name: "Feedback" })).not.toHaveAttribute("aria-current");
  await expect(boards).toHaveCount(0);
  // On a phone the parts get a line of their own, scrolling sideways rather than widening the page.
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.goto("/feedback/bugs");
  await expect(boards).toBeVisible();
  expect(await visitor.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(visitor, "portal-header-phone");
  // The header's menu has the boards.
  await visitor.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const menu = visitor.getByRole("dialog", { name: "Menu" });
  await expect(menu.getByRole("navigation", { name: "Boards" }).getByRole("link", { name: "Bug reports" })).toHaveAttribute("aria-current", "page");
  await checkpoint(visitor, "portal-header-phone-menu", { fullPage: false });
  await menu.getByRole("link", { name: "Feature requests" }).click();
  await expect(menu).toBeHidden();
  await expect(visitor).toHaveURL(/\/feedback\/feature-requests$/);

  // Delete the empty board: gone from the team's list and from the portal.
  await row("Bug reports").getByRole("button", { name: "Delete" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  // (While the dialog is open the list is hidden from queries, so wait for the result first.)
  await expect(owner.getByText("Bug reports deleted")).toBeVisible();
  await expect(row("Bug reports")).toHaveCount(0);
  const response = await visitor.goto("/feedback/bugs");
  expect(response?.status()).toBe(404);
  // With one board there's no row of them.
  await visitor.goto("/feedback/feature-requests");
  await expect(parts.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  await expect(boards).toHaveCount(0);
});
