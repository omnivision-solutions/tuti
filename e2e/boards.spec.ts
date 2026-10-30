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

  // Boards are in Feedback (its header's Boards button); the old address lands there too.
  await owner.goto(`/app/${slug}/feedback`);
  await owner.getByRole("link", { name: "Boards" }).click();
  await owner.waitForURL(`**/app/${slug}/feedback/boards`);
  await owner.goto(`/app/${slug}/boards`);
  await owner.waitForURL(`**/app/${slug}/feedback/boards`);
  // A new project starts with one board, which can't be deleted while it's the only one.
  const row = (name: string) => owner.getByRole("listitem").filter({ hasText: name });
  await expect(row("Feature requests")).toContainText("/feedback/feature-requests · 0 posts");
  await expect(row("Feature requests").getByRole("button", { name: "Delete" })).toHaveCount(0);

  // Add a board ("New board", in a dialog); its URL follows the name. On a short screen the dialog scrolls to its button.
  await owner.setViewportSize({ width: 1280, height: 320 });
  await owner.getByRole("button", { name: "New board" }).click();
  const newBoard = owner.getByRole("dialog", { name: "New board" });
  await newBoard.getByLabel("Name").fill("Bug reports");
  await expect(newBoard.getByLabel("URL")).toHaveValue("bug-reports");
  await newBoard.getByLabel("Description").fill("Something broken? Tell us here.");
  await newBoard.getByRole("button", { name: "Create board" }).click();
  await expect(owner.getByText("Board created")).toBeVisible();
  await expect(newBoard).toBeHidden();
  await owner.setViewportSize({ width: 1280, height: 720 });
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

test("a board's own words for posting: the team sees them in a preview as they type, and the portal's button and form use them", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/feedback/boards`);
  await owner.getByRole("listitem").filter({ hasText: "Feature requests" }).getByRole("button", { name: "Edit" }).click();
  const dialog = owner.getByRole("dialog", { name: "Edit board" });
  const preview = dialog.getByRole("region", { name: "Preview" });
  // Until the team writes its own, the preview shows the defaults.
  await expect(preview).toContainText("Submit post");
  await expect(preview).toContainText("Short, descriptive title");
  await dialog.getByLabel("Description").fill("What should we build next?");
  await dialog.getByLabel("Button").fill("Request a feature");
  await dialog.getByLabel("Title placeholder").fill("What should it do?");
  await dialog.getByLabel("Details placeholder").fill("How would it help you?");
  for (const text of ["What should we build next?", "Request a feature", "What should it do?", "How would it help you?"]) {
    await expect(preview).toContainText(text);
  }
  await checkpoint(owner, "team-board-texts-preview", { fullPage: false });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Board updated")).toBeVisible();
  // Closed without saving, the dialog opens again with what's saved.
  const edit = owner.getByRole("listitem").filter({ hasText: "Feature requests" }).getByRole("button", { name: "Edit" });
  await edit.click();
  await dialog.getByLabel("Button").fill("Not saved");
  await owner.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await edit.click();
  await expect(dialog.getByLabel("Button")).toHaveValue("Request a feature");
  await expect(preview).not.toContainText("Not saved");
  await owner.keyboard.press("Escape");

  // On the portal: the description under the name, and the board's words in its "Share your idea" box.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await expect(ada.getByText("What should we build next?")).toBeVisible();
  const form = ada.getByRole("main").locator("form");
  await expect(form.getByLabel("Title")).toHaveAttribute("placeholder", "What should it do?");
  // The details once the title is clicked.
  await expect(form.getByRole("textbox", { name: "Details" })).toHaveCount(0);
  await form.getByLabel("Title").click();
  await expect(form.getByRole("textbox", { name: "Details" }).locator("p")).toHaveAttribute("data-placeholder", "How would it help you?");
  await checkpoint(ada, "portal-board-share-idea");
  await form.getByLabel("Title").fill("Dark mode");
  await form.getByRole("button", { name: "Request a feature" }).click();
  // Posted (saving runs its jobs first, see postFeedback): the post is on the board; the box starts empty again.
  await expect(ada.getByRole("link", { name: "Dark mode" })).toBeVisible({ timeout: 15_000 });
  await expect(form.getByLabel("Title")).toHaveValue("");
  // The widget's Feedback tab uses the same words (signed in on the portal, it posts as them).
  await ada.goto("/widget?tab=feedback");
  await expect(ada.getByLabel("Title")).toHaveAttribute("placeholder", "What should it do?");
  await expect(ada.getByRole("button", { name: "Request a feature" })).toBeVisible();
});
