import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

test("the portal's roadmap: votes from the cards, what each column means, a board filter, shipped entries", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  // A second board.
  await team.goto(`/app/${slug}/feedback/boards`);
  await team.getByRole("button", { name: "New board" }).click();
  const newBoard = team.getByRole("dialog", { name: "New board" });
  await newBoard.getByLabel("Name").fill("Bug reports");
  // At /feedback/all: still a board of its own in the filter, not "All boards".
  await newBoard.getByLabel("URL").fill("all");
  await newBoard.getByRole("button", { name: "Create board" }).click();
  await expect(team.getByText("Board created")).toBeVisible();

  const api = await apiFor(team, slug);
  await api("/posts", { board: "feature-requests", title: "Dark mode" }); // 1
  await api("/posts", { board: "all", title: "Login fails on Safari" }); // 2
  await api("/posts", { board: "feature-requests", title: "CSV export" }); // 3
  await api("/posts", { board: "feature-requests", title: "Webhooks" }); // 4
  await api("/posts", { board: "feature-requests", title: "Night theme" }); // 5
  await api("/posts/1", { status: "planned" }, "PATCH");
  // When the team expects it (far ahead: a month that's passed isn't shown).
  await api("/posts/1", { eta: "2099-06" }, "PATCH");
  await api("/posts/5", { status: "planned" }, "PATCH");
  await api("/posts/2", { status: "in_progress" }, "PATCH");
  // CSV export shipped in a published entry; Webhooks is completed, its entry still a draft.
  await api("/changelog", { title: "CSV export is here", posts: [3] });
  await api("/changelog/1/publish", {});
  await api("/posts/4", { status: "completed" }, "PATCH");
  await api("/changelog", { title: "Webhooks (draft)", posts: [4] });

  // Signed out, on a laptop: the columns side by side, about 1100px across.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.setViewportSize({ width: 1440, height: 900 });
  await visitor.goto("/roadmap");
  const content = visitor.getByRole("main").locator("> div");
  await expect.poll(async () => (await content.boundingBox())!.width).toBeGreaterThan(1050);
  expect((await content.boundingBox())!.width).toBeLessThan(1150);

  // Each column says what it means, with its status's icon.
  const column = (name: string) => visitor.getByRole("region", { name });
  for (const [name, meaning] of [
    ["Planned", "We've decided to build these."],
    ["In progress", "We're building these now."],
    ["Completed", "Shipped and ready to use."],
  ]) {
    await expect(column(name)).toHaveAccessibleDescription(meaning!);
    await expect(column(name).getByRole("heading", { name }).locator("[data-status-icon]")).toBeVisible();
  }

  // Votes on the cards; signed out, they ask to sign in.
  const darkMode = column("Planned").getByRole("listitem").filter({ hasText: "Dark mode" });
  await expect(darkMode.getByRole("link", { name: /^Sign in to vote/ })).toHaveAttribute("href", "/sign-in?next=%2Froadmap");
  await expect(visitor.getByRole("main").getByText(/to vote\.$/)).toBeVisible();
  // The card says when it's expected.
  await expect(darkMode).toContainText("Expected June 2099");

  // A completed card links to the published entry that shipped it, not to a draft.
  const completed = column("Completed");
  await expect(completed.getByRole("listitem").filter({ hasText: "CSV export" }).getByRole("link", { name: "In the changelog: CSV export is here" })).toHaveAttribute(
    "href",
    "/changelog/1",
  );
  await expect(completed.getByRole("listitem").filter({ hasText: "Webhooks" })).not.toContainText("In the changelog");
  // Shipped, there's nothing left to vote for: its votes as text, no button.
  const csvCard = completed.getByRole("listitem").filter({ hasText: "CSV export" });
  await expect(csvCard.getByRole("button")).toHaveCount(0);
  await expect(csvCard.getByText(/^\d+ votes?$/)).toBeAttached();

  // On a phone, one column at a time: Planned first, the others from the tabs over it.
  await visitor.setViewportSize({ width: 390, height: 844 });
  const columns = visitor.getByRole("navigation", { name: "Columns" });
  await expect(columns.getByRole("link")).toHaveText(["Planned 2", "In progress 1", "Completed 2"]);
  await expect(column("Planned")).toBeVisible();
  await expect(column("Completed")).toBeHidden();
  await columns.getByRole("link", { name: "Completed 2" }).click();
  await visitor.waitForURL("**/roadmap?column=completed");
  await expect(column("Completed")).toBeVisible();
  await expect(column("Planned")).toBeHidden();
  await checkpoint(visitor, "roadmap-phone-completed", { fullPage: false });
  await visitor.goto("/roadmap");
  await visitor.setViewportSize({ width: 1440, height: 900 });

  // With every board shown, New idea asks which.
  await visitor.getByRole("button", { name: "New idea" }).click();
  await expect(visitor.getByRole("menuitem")).toHaveText(["Feature requests", "Bug reports"]);
  await checkpoint(visitor, "roadmap-signed-out", { fullPage: false });
  await visitor.keyboard.press("Escape");

  // The boards' chips narrow the cards and stay in the address.
  const boards = visitor.getByRole("navigation", { name: "Board" });
  await expect(boards.getByRole("link")).toHaveText(["All boards", "Feature requests", "Bug reports"]);
  await expect(boards.getByRole("link", { name: "All boards" })).toHaveAttribute("aria-current", "page");
  await boards.getByRole("link", { name: "Bug reports" }).click();
  await visitor.waitForURL("**/roadmap?board=all");
  await expect(column("Planned")).toContainText("Nothing here yet.");
  await visitor.reload();
  await expect(column("In progress").getByRole("link", { name: "Login fails on Safari" })).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Dark mode" })).toHaveCount(0);
  await expect(boards.getByRole("link", { name: "Bug reports" })).toHaveAttribute("aria-current", "page");
  // New idea opens that board's idea form.
  await expect(visitor.getByRole("link", { name: "New idea" })).toHaveAttribute("href", "/feedback/all?new");

  // Signed in, a vote from a card counts.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.setViewportSize({ width: 1440, height: 900 });
  await ada.goto("/roadmap");
  await expect(ada.getByRole("main").getByText(/to vote\.$/)).toHaveCount(0);
  const adaCard = ada.getByRole("region", { name: "Planned" }).getByRole("listitem").filter({ hasText: "Dark mode" });
  // Tess's own vote, as the post's author; the count is in the button's name, for screen readers.
  await expect(adaCard.getByRole("button", { name: "Upvote" })).toHaveText("1");
  await expect(adaCard.getByRole("button", { name: "Upvote" })).toHaveAccessibleName("Upvote (1 vote)");
  await adaCard.getByRole("button", { name: "Upvote" }).click();
  await expect(adaCard.getByRole("button", { name: "Remove vote" })).toHaveText("2");
  await expect(adaCard.getByRole("button", { name: "Remove vote" })).toHaveAccessibleName("Remove vote (2 votes)");
  // Saved once it's pressable again (it shows the vote at once).
  await expect(adaCard.getByRole("button", { name: "Remove vote" })).toBeEnabled();
  await ada.reload();
  await expect(adaCard.getByRole("button", { name: "Remove vote" })).toHaveText("2");
  // A vote that can't count says why: Night theme was merged into Dark mode since the page was opened.
  const nightTheme = ada.getByRole("region", { name: "Planned" }).getByRole("listitem").filter({ hasText: "Night theme" });
  await expect(nightTheme).toBeVisible();
  await api("/posts/5/merge", { into: 1 });
  await nightTheme.getByRole("button", { name: "Upvote" }).click();
  await expect(ada.getByText("This post was merged into another one; vote there instead")).toBeVisible();
  await ada.reload();
  await expect(nightTheme).toHaveCount(0);
  await checkpoint(ada, "roadmap-desktop-light");

  // Dark, and on a phone: the columns stack, and nothing runs off the page.
  await ada.emulateMedia({ colorScheme: "dark" });
  await ada.reload();
  await checkpoint(ada, "roadmap-desktop-dark");
  for (const colorScheme of ["light", "dark"] as const) {
    await ada.emulateMedia({ colorScheme });
    await ada.setViewportSize({ width: 390, height: 844 });
    await ada.reload();
    await expect(adaCard).toBeVisible();
    expect(await ada.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await checkpoint(ada, `roadmap-phone-${colorScheme}`);
  }
});
