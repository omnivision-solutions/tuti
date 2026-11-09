import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

test("a team adds, renames and deletes boards; old board links keep working", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  // Three posts on the first board: one done, one merged into another.
  const api = await apiFor(owner, slug);
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/posts", { board: "feature-requests", title: "CSV export" });
  await api("/posts", { board: "feature-requests", title: "Night theme" });
  await api("/posts/2", { status: "completed" }, "PATCH");
  await api("/posts/3/merge", { into: 1 });

  // Boards are in Feedback (its header's Boards button); the old address lands there too.
  await owner.goto(`/app/${slug}/feedback`);
  await owner.getByRole("link", { name: "Boards" }).click();
  await owner.waitForURL(`**/app/${slug}/feedback/boards`);
  await owner.goto(`/app/${slug}/boards`);
  await owner.waitForURL(`**/app/${slug}/feedback/boards`);
  // A new project starts with one board, which can't be deleted while it's the only one.
  const row = (name: string) => owner.getByRole("main").getByRole("listitem").filter({ hasText: name });
  // Each board's card says what it counts: the posts Feedback lists (merged duplicates aside), and the open ones as the portal counts them.
  await expect(row("Feature requests")).toContainText("/feedback/feature-requests");
  await expect(row("Feature requests").locator("dd")).toHaveText(["2", "1"]);
  await row("Feature requests").getByRole("button", { name: "More for Feature requests" }).click();
  await expect(owner.getByRole("menuitem", { name: "Turn off" })).toBeVisible();
  await expect(owner.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
  await owner.keyboard.press("Escape");

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
  await expect(row("Bug reports")).toContainText("Something broken? Tell us here.");
  await expect(row("Bug reports")).toContainText("/feedback/bug-reports");
  await expect(row("Bug reports").locator("dd")).toHaveText(["0", "0"]);
  await checkpoint(owner, "team-boards");
  // A board's name opens its posts in Feedback, all of them: as many rows as its count says.
  await row("Feature requests").getByRole("link", { name: "Feature requests" }).click();
  await owner.waitForURL(`**/app/${slug}/feedback?board=feature-requests&status=all`);
  await expect(owner.getByRole("checkbox", { name: /^Select / })).toHaveCount(2);
  await expect(owner.getByRole("link", { name: "Dark mode" })).toBeVisible();
  await expect(owner.getByRole("link", { name: "CSV export" })).toBeVisible();
  await owner.goBack();

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
  // On a phone the header is one line: the parts are in its menu, with the boards.
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.goto("/feedback/bugs");
  await expect(boards).toBeVisible();
  await expect(parts).toBeHidden();
  expect(await visitor.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(visitor, "portal-header-phone");
  await visitor.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const menu = visitor.getByRole("dialog", { name: "Menu" });
  await expect(menu.getByRole("navigation", { name: "Portal" }).getByRole("link")).toHaveText(["Feedback", "Roadmap", "Changelog", "Docs"]);
  await expect(menu.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  await expect(menu.getByRole("navigation", { name: "Boards" }).getByRole("link", { name: "Bug reports" })).toHaveAttribute("aria-current", "page");
  await checkpoint(visitor, "portal-header-phone-menu", { fullPage: false });
  await menu.getByRole("link", { name: "Feature requests" }).click();
  await expect(menu).toBeHidden();
  await expect(visitor).toHaveURL(/\/feedback\/feature-requests$/);

  // Turned off, a board is the team's alone: Off in the list, gone from the portal; turned on, it's back.
  // Turning off is in its menu ("⋯"), asking first; Turn on is in sight on a board that's off.
  await row("Bug reports").getByRole("button", { name: "More for Bug reports" }).click();
  await owner.getByRole("menuitem", { name: "Turn off" }).click();
  await expect(owner.getByRole("alertdialog")).toContainText("You can turn it on again any time.");
  await owner.getByRole("alertdialog").getByRole("button", { name: "Turn off" }).click();
  await expect(owner.getByText("Bug reports is off the portal")).toBeVisible();
  await expect(row("Bug reports")).toContainText("Not on the portal: only the team sees it and its posts.");
  await expect(row("Bug reports")).toContainText("/feedback/bugs");
  await checkpoint(owner, "team-board-off");
  expect((await visitor.goto("/feedback/bugs"))?.status()).toBe(404);
  await row("Bug reports").getByRole("button", { name: "Turn on" }).click();
  await expect(owner.getByText("Bug reports is on the portal")).toBeVisible();
  // Its Turn on button gone, the focus is on the board's menu (not lost to the page).
  await expect(row("Bug reports").getByRole("button", { name: "More for Bug reports" })).toBeFocused();
  expect((await visitor.goto("/feedback/bugs"))?.status()).toBe(200);

  // A merged duplicate doesn't keep a board: deleting it moves the duplicate to the board of the post it was merged into.
  await api("/posts", { board: "bugs", title: "Crash on dark mode" });
  await api("/posts/4/merge", { into: 1 });
  await owner.reload();
  await expect(row("Bug reports").locator("dd")).toHaveText(["0", "0"]);
  await row("Bug reports").getByRole("button", { name: "More for Bug reports" }).click();
  await expect(owner.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await owner.keyboard.press("Escape");
  await checkpoint(owner, "team-boards-merged-only");
  // Delete the empty board: gone from the team's list and from the portal.
  await row("Bug reports").getByRole("button", { name: "More for Bug reports" }).click();
  await owner.getByRole("menuitem", { name: "Delete" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  // (While the dialog is open the list is hidden from queries, so wait for the result first.)
  await expect(owner.getByText("Bug reports deleted")).toBeVisible();
  await expect(row("Bug reports")).toHaveCount(0);
  const response = await visitor.goto("/feedback/bugs");
  expect(response?.status()).toBe(404);
  // The portal's own page not found, in its header and footer: the way home, and no part marked as this page's.
  await expect(visitor.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(visitor.getByRole("main").getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
  await expect(visitor.locator('[aria-current="page"]')).toHaveCount(0);
  await expect(visitor.getByRole("navigation", { name: "Boards" })).toHaveCount(0);
  await checkpoint(visitor, "portal-not-found");
  // A mistyped address too: the same page, in the portal's header.
  expect((await visitor.goto("/fedback"))?.status()).toBe(404);
  await expect(visitor.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(visitor.getByRole("banner")).toBeVisible();
  // With one board there's no row of them.
  await visitor.setViewportSize({ width: 1280, height: 800 });
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
  // The button is the form's own: no other one says "Submit post".
  await expect(preview).not.toContainText("Submit post");
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

  // On the portal: the description under the name, and the board's words in its New idea dialog.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await expect(ada.getByText("What should we build next?")).toBeVisible();
  await ada.getByRole("button", { name: "New idea" }).click();
  const form = ada.getByRole("dialog", { name: "Share an idea" }).locator("form");
  await expect(form.getByLabel("Title")).toHaveAttribute("placeholder", "What should it do?");
  await expect(form.getByRole("textbox", { name: "Details" }).locator("p")).toHaveAttribute("data-placeholder", "How would it help you?");
  await checkpoint(ada, "portal-board-share-idea");
  await form.getByLabel("Title").fill("Dark mode");
  await form.getByRole("button", { name: "Request a feature" }).click();
  // Posted (saving runs its jobs first, see postFeedback): the post is on the board, the dialog closed; it opens empty again.
  await expect(ada.getByRole("link", { name: "Dark mode" })).toBeVisible({ timeout: 15_000 });
  await expect(ada.getByRole("dialog")).toHaveCount(0);
  await ada.getByRole("button", { name: "New idea" }).click();
  await expect(form.getByLabel("Title")).toHaveValue("");
  await ada.keyboard.press("Escape");
  // The widget's Feedback tab uses the same words (signed in on the portal, it posts as them).
  await ada.goto("/widget?tab=feedback");
  await expect(ada.getByLabel("Title")).toHaveAttribute("placeholder", "What should it do?");
  await expect(ada.getByRole("button", { name: "Request a feature" })).toBeVisible();
});
