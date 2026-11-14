import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

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
  // Feature requests' own words for posting; Bug reports keeps none.
  await team.getByRole("listitem").filter({ hasText: "Feature requests" }).getByRole("button", { name: "Edit" }).click();
  const editBoard = team.getByRole("dialog", { name: "Edit board" });
  await editBoard.getByLabel("Button").fill("Suggest a feature");
  await editBoard.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("Board updated")).toBeVisible();

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
  // A public idea on a board then made Team only: still a card under All boards, the board without a pill.
  await team.goto(`/app/${slug}/feedback/boards`);
  await team.getByRole("button", { name: "New board" }).click();
  await newBoard.getByLabel("Name").fill("Internal");
  await newBoard.getByRole("button", { name: "Create board" }).click();
  await expect(team.getByRole("listitem").filter({ hasText: "Internal" })).toBeVisible();
  await api("/posts", { board: "internal", title: "Offline mode" }); // 6
  await api("/posts/6", { status: "planned" }, "PATCH");
  await team.getByRole("listitem").filter({ hasText: "Internal" }).getByRole("button", { name: "Edit" }).click();
  await editBoard.getByRole("combobox", { name: "Who sees new posts" }).click();
  await team.getByRole("option", { name: "Team only" }).click();
  await editBoard.getByRole("button", { name: "Save" }).click();
  await expect(editBoard).toBeHidden();

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
  await expect(columns.getByRole("link")).toHaveText(["Planned 3", "In progress 1", "Completed 2"]);
  await expect(column("Planned")).toBeVisible();
  await expect(column("Completed")).toBeHidden();
  await columns.getByRole("link", { name: "Completed 2" }).click();
  await visitor.waitForURL("**/roadmap?column=completed");
  await expect(column("Completed")).toBeVisible();
  // New post is a round + beside the title, with the same menu.
  await visitor.getByRole("button", { name: "New post" }).click();
  await expect(visitor.getByRole("menuitem")).toHaveText(["Suggest a feature Feature requests", "New post Bug reports"]);
  await visitor.keyboard.press("Escape");
  // A board's pill keeps the column open, and so does All boards.
  const boardPills = visitor.getByRole("navigation", { name: "Board" });
  await boardPills.getByRole("link", { name: "Bug reports" }).click();
  await visitor.waitForURL("**/roadmap?board=all&column=completed");
  await expect(column("Completed")).toBeVisible();
  await expect(boardPills.getByRole("link", { name: "All boards" })).toHaveAttribute("href", "/roadmap?column=completed");
  await visitor.goto("/roadmap?column=completed");
  await expect(column("Planned")).toBeHidden();
  await checkpoint(visitor, "roadmap-phone-completed", { fullPage: false });
  await visitor.goto("/roadmap");
  await visitor.setViewportSize({ width: 1440, height: 900 });

  // With every board shown, New post asks which, in each board's own words (New post without them).
  await visitor.getByRole("button", { name: "New post" }).click();
  await expect(visitor.getByRole("menuitem")).toHaveText(["Suggest a feature Feature requests", "New post Bug reports"]);
  await expect(visitor.getByRole("menuitem", { name: /Suggest a feature/ })).toHaveAttribute("href", "/feedback/feature-requests?new");
  await checkpoint(visitor, "roadmap-signed-out", { fullPage: false });
  await visitor.keyboard.press("Escape");

  // The boards' pills, with their ideas on the roadmap, narrow the cards and stay in the address.
  const boards = visitor.getByRole("navigation", { name: "Board" });
  await expect(boards.getByRole("link")).toHaveText(["All boards 6", "Feature requests 4", "Bug reports 1"]);
  await expect(visitor.getByRole("link", { name: "Offline mode" })).toBeVisible();
  await expect(boards.getByRole("link", { name: "All boards" })).toHaveAttribute("aria-current", "page");
  // Pills without an outline: the open one a neutral fill (not the accent), the others on the paper.
  const accent = await visitor.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("i"));
    probe.style.color = "var(--accent)";
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  await expect(boards.getByRole("link", { name: "All boards" })).toHaveCSS("background-color", accent);
  await expect(boards.getByRole("link", { name: "Bug reports" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(boards.getByRole("link", { name: "Bug reports" })).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await boards.getByRole("link", { name: "Bug reports" }).click();
  await visitor.waitForURL("**/roadmap?board=all");
  await expect(column("Planned")).toContainText("Nothing here yet.");
  await visitor.reload();
  await expect(column("In progress").getByRole("link", { name: "Login fails on Safari" })).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Dark mode" })).toHaveCount(0);
  await expect(boards.getByRole("link", { name: "Bug reports" })).toHaveAttribute("aria-current", "page");
  // On one board, its button opens that board's form, in its words: New post, as it has none of its own.
  await expect(visitor.getByRole("link", { name: "New post" })).toHaveAttribute("href", "/feedback/all?new");
  await boards.getByRole("link", { name: "Feature requests" }).click();
  await visitor.waitForURL("**/roadmap?board=feature-requests");
  await expect(visitor.getByRole("link", { name: "Suggest a feature" })).toHaveAttribute("href", "/feedback/feature-requests?new");
  // The columns' headings have no line under them.
  await expect(column("Planned").getByRole("heading", { name: "Planned" }).locator("..")).toHaveCSS("border-bottom-width", "0px");

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

test("the portal's roadmap: the columns' headings stay under the header as the cards scroll", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Enough ideas to scroll well past the headings: 12 planned, 8 in progress, one completed.
  for (let i = 1; i <= 21; i++) {
    await api("/posts", { board: "feature-requests", title: `Idea ${i}` });
    await api(`/posts/${i}`, { status: i <= 12 ? "planned" : i <= 20 ? "in_progress" : "completed" }, "PATCH");
  }
  const visitor = await newPerson(browser, portalUrl(slug));
  const headerBottom = async () => (await visitor.locator("[data-portal-top]").boundingBox())!.height;
  const scrollFar = () => visitor.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight - innerHeight - 200));

  // On a laptop, each heading stays just under the header, over its own column.
  await visitor.setViewportSize({ width: 1280, height: 800 });
  await visitor.goto("/roadmap");
  await expect(visitor.getByRole("link", { name: "Idea 12" })).toBeVisible();
  await scrollFar();
  await expect.poll(() => visitor.evaluate(() => scrollY)).toBeGreaterThan(800);
  for (const name of ["Planned", "In progress", "Completed"]) {
    const column = visitor.getByRole("region", { name });
    const heading = column.getByRole("heading", { name });
    const [box, columnBox, top] = [(await heading.boundingBox())!, (await column.boundingBox())!, await headerBottom()];
    expect(box.y).toBeGreaterThanOrEqual(top - 1);
    expect(box.y).toBeLessThan(top + 40);
    expect(box.x).toBeGreaterThanOrEqual(columnBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(columnBox.x + columnBox.width + 1);
  }
  // Not hidden under a card.
  const planned = visitor.getByRole("heading", { name: "Planned" });
  const point = (await planned.boundingBox())!;
  expect(await visitor.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("h2")?.textContent, { x: point.x + 30, y: point.y + point.height / 2 })).toContain("Planned");
  // Shift+Tab up a column scrolls the card it reaches out from under the headings, however tall they are.
  const focusUpAColumn = async () => {
    const stuckBottom = async () =>
      Math.max(
        ...(await Promise.all(
          ["Planned", "In progress", "Completed"].map(async (name) => {
            const box = (await visitor.getByRole("region", { name }).locator("[data-roadmap-sticky]").boundingBox())!;
            return box.y + box.height;
          }),
        )),
      );
    // Idea 4's title just below the headings, Idea 5's vote chip above it under them.
    const idea4 = visitor.getByRole("link", { name: "Idea 4", exact: true });
    await idea4.evaluate((link, top) => window.scrollBy(0, link.getBoundingClientRect().top - top), (await stuckBottom()) + 4);
    await idea4.evaluate((link) => (link as HTMLElement).focus({ preventScroll: true }));
    await visitor.keyboard.press("Shift+Tab");
    const focused = visitor.locator(":focus");
    await expect(focused).toHaveAccessibleName(/^Sign in to vote/);
    // Its focus ring (3px) clear of them too.
    expect((await focused.boundingBox())!.y).toBeGreaterThanOrEqual((await stuckBottom()) + 3);
  };
  await focusUpAColumn();
  await visitor.setViewportSize({ width: 800, height: 800 });
  await scrollFar();
  // In narrower columns, in the team's own wider font, the meanings wrap and the headings are taller.
  await visitor.addStyleTag({ content: "[data-roadmap-sticky] p { font-size: 1.375rem }" });
  expect((await visitor.getByRole("region", { name: "Planned" }).locator("[data-roadmap-sticky]").boundingBox())!.height).toBeGreaterThan(120);
  await focusUpAColumn();
  await visitor.setViewportSize({ width: 1280, height: 800 });
  await visitor.reload();
  await scrollFar();
  await checkpoint(visitor, "roadmap-sticky-headings", { fullPage: false });
  await visitor.emulateMedia({ colorScheme: "dark" });
  await checkpoint(visitor, "roadmap-sticky-headings-dark", { fullPage: false });
  await visitor.emulateMedia({ colorScheme: "light" });

  // On a phone, the column switcher stays just under the header.
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.goto("/roadmap");
  await scrollFar();
  await expect.poll(() => visitor.evaluate(() => scrollY)).toBeGreaterThan(800);
  const switcher = (await visitor.getByRole("navigation", { name: "Columns" }).boundingBox())!;
  const top = await headerBottom();
  expect(switcher.y).toBeGreaterThanOrEqual(top - 1);
  expect(switcher.y).toBeLessThan(top + 20);
  await checkpoint(visitor, "roadmap-phone-sticky-switcher", { fullPage: false });
  await visitor.emulateMedia({ colorScheme: "dark" });
  await checkpoint(visitor, "roadmap-phone-sticky-switcher-dark", { fullPage: false });
  await visitor.emulateMedia({ colorScheme: "light" });
  const inProgress = visitor.getByRole("navigation", { name: "Columns" }).getByRole("link", { name: "In progress 8" });
  // Tabbing through the stuck switcher leaves the page where it is.
  const deep = await visitor.evaluate(() => scrollY);
  await visitor.getByRole("navigation", { name: "Columns" }).getByRole("link", { name: "Planned 12" }).evaluate((link) => (link as HTMLElement).focus({ preventScroll: true }));
  await visitor.keyboard.press("Tab");
  await expect(inProgress).toBeFocused();
  expect(await visitor.evaluate(() => scrollY)).toBe(deep);
  // Opening another column in a new tab leaves this one where it was.
  const scrolled = await visitor.evaluate(() => scrollY);
  const [tab] = await Promise.all([visitor.context().waitForEvent("page"), inProgress.click({ modifiers: ["ControlOrMeta"] })]);
  await tab.close();
  expect(await visitor.evaluate(() => scrollY)).toBe(scrolled);
  await expect(visitor).toHaveURL(/\/roadmap$/);
  // Switching from down there shows the other column from its first card, just under the switcher.
  await inProgress.click();
  await visitor.waitForURL("**/roadmap?column=inProgress");
  const first = (await visitor.getByRole("link", { name: "Idea 20" }).boundingBox())!;
  const switcherNow = (await visitor.getByRole("navigation", { name: "Columns" }).boundingBox())!;
  expect(first.y).toBeGreaterThan(switcherNow.y + switcherNow.height);
  expect(first.y).toBeLessThan(switcherNow.y + switcherNow.height + 120);
});
