import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, postFeedback, signUp } from "./helpers";

test("a board's posts are private to their author and the team; the team makes one public, or keeps a board to itself", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // A board whose new posts are private: "New board" picks who sees them.
  await owner.goto(`/app/${slug}/feedback/boards`);
  await owner.getByRole("button", { name: "New board" }).click();
  const newBoard = owner.getByRole("dialog", { name: "New board" });
  await newBoard.getByLabel("Name").fill("Bug reports");
  await newBoard.getByRole("combobox", { name: "New posts are" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(newBoard.getByText("Only the person who posted each one and your team see it.")).toBeVisible();
  await checkpoint(owner, "new-private-board", { fullPage: false });
  await newBoard.getByRole("button", { name: "Create board" }).click();
  await expect(owner.getByText("Board created")).toBeVisible();
  await expect(owner.getByRole("listitem").filter({ hasText: "Bug reports" })).toContainText("Private");

  // Ada reports a bug: it's hers, marked private.
  const ada = await signUp(browser, portalUrl(slug), "Ada Author");
  await ada.goto("/feedback/bug-reports");
  await postFeedback(ada, "Export crashes on large files");
  await expect(ada.getByRole("listitem").filter({ hasText: "Export crashes on large files" })).toContainText("Private");
  await ada.getByRole("link", { name: "Export crashes on large files" }).click();
  await ada.waitForURL("**/feedback/bug-reports/export-crashes-on-large-files-1");
  await expect(ada.getByRole("heading", { name: "Export crashes on large files", level: 1 })).toBeVisible();
  await checkpoint(ada, "private-post-author");
  const postUrl = new URL(ada.url()).pathname;

  // Anyone else: not on the board, and its page isn't found.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/feedback/bug-reports");
  await expect(visitor.getByText("No ideas waiting")).toBeVisible();
  expect((await visitor.goto(postUrl))?.status()).toBe(404);

  // The team sees it, and makes it public: its page says who sees it.
  await owner.goto(`/app/${slug}/p/1`);
  const visibility = owner.getByRole("combobox", { name: "Visibility" });
  await expect(visibility).toContainText("Private");
  await expect(owner.getByText("Only the person who posted it and your team.")).toBeVisible();
  await checkpoint(owner, "team-post-private");
  await visibility.click();
  await owner.getByRole("option", { name: "Public" }).click();
  await expect(owner.getByText("Visibility: Public")).toBeVisible();
  expect((await visitor.goto(postUrl))?.status()).toBe(200);
  await expect(visitor.getByRole("heading", { name: "Export crashes on large files", level: 1 })).toBeVisible();

  // A Team only board: off the portal, and nobody else posts there.
  await owner.goto(`/app/${slug}/feedback/boards`);
  await owner.getByRole("listitem").filter({ hasText: "Bug reports" }).getByRole("button", { name: "Edit" }).click();
  const edit = owner.getByRole("dialog", { name: "Edit board" });
  await edit.getByRole("combobox", { name: "New posts are" }).click();
  await owner.getByRole("option", { name: "Team only" }).click();
  await expect(edit.getByText("Only your team sees them and posts here; the board isn't on your portal. Posts already on it keep theirs.")).toBeVisible();
  await checkpoint(owner, "edit-board-team-only", { fullPage: false });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Board updated")).toBeVisible();
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.getByRole("navigation", { name: "Boards" })).toHaveCount(0);
  expect((await visitor.goto("/feedback/bug-reports"))?.status()).toBe(404);
  // The post made public stays public.
  expect((await visitor.goto(postUrl))?.status()).toBe(200);
});
