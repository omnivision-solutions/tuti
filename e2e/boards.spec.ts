import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

test("a team adds, renames and deletes boards; old board links keep working", async ({ browser }, testInfo) => {
  // A long journey: the team's boards, then the portal's overview, board pages and phones.
  test.setTimeout(60_000);
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

  // Boards are in Feedback (its menu's Manage boards); the old address lands there too.
  await owner.goto(`/app/${slug}/feedback`);
  await owner.getByRole("navigation", { name: "Feedback" }).getByRole("link", { name: "Manage boards" }).click();
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
  // With two boards the header's Feedback opens their overview; a board's rail lists them.
  const parts = visitor.getByRole("navigation", { name: "Portal" });
  await expect(parts.getByRole("link")).toHaveText(["Feedback", "Roadmap", "Changelog", "Documentation"]);
  await expect(parts.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  await expect(parts.getByRole("link", { name: "Feedback" })).toHaveAttribute("href", "/feedback");
  const boards = visitor.getByRole("navigation", { name: "Boards" });
  await expect(boards.getByRole("link", { name: "Bug reports" })).toHaveAttribute("aria-current", "page");
  await expect(boards.getByRole("link", { name: "Feature requests" })).not.toHaveAttribute("aria-current");
  await expect(visitor.getByText("Something broken? Tell us here.")).toBeVisible();
  await checkpoint(visitor, "portal-board-tabs");
  // No second row of boards under the site bar: the rail has them.
  await expect(boards).toHaveCount(1);
  await expect(visitor.getByRole("complementary", { name: "About this board" }).getByRole("navigation", { name: "Boards" })).toBeVisible();

  // The overview (the portal's home too): a card per board with its open ideas, the boards as pills, New post asks which board.
  await visitor.goto("/");
  await expect(visitor).toHaveURL(/\/feedback$/);
  const overview = visitor.getByRole("main");
  await expect(overview.getByRole("heading", { level: 1, name: "Feedback" })).toBeVisible();
  await expect(parts.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  const pills = overview.getByRole("navigation", { name: "Boards" });
  await expect(pills.getByRole("link")).toHaveText(["All boards 1", "Feature requests 1", "Bug reports 0"]);
  await expect(pills.getByRole("link", { name: /^All boards/ })).toHaveAttribute("aria-current", "page");
  const card = (name: string) => overview.getByRole("region", { name });
  await expect(card("Feature requests").getByRole("link", { name: "Dark mode" })).toBeVisible();
  // Shipped ideas aren't among a card's; they're under Recently shipped.
  await expect(card("Feature requests").getByRole("link", { name: "CSV export" })).toHaveCount(0);
  await expect(card("Feature requests")).toContainText("1 idea still to come");
  await expect(card("Bug reports")).toContainText("Something broken? Tell us here.");
  await expect(card("Bug reports")).toContainText("0 ideas still to come");
  await expect(overview.getByRole("region", { name: "Recently shipped" }).getByRole("link", { name: "CSV export" })).toBeVisible();
  await expect(overview.getByRole("button", { name: "Get updates" })).toBeVisible();
  await overview.getByRole("button", { name: "New post" }).click();
  const newPost = visitor.getByRole("menu");
  await expect(newPost.getByRole("menuitem")).toHaveText(["New post Feature requests", "New post Bug reports"]);
  await checkpoint(visitor, "portal-feedback-overview");
  await newPost.getByRole("menuitem", { name: /Bug reports/ }).click();
  await visitor.waitForURL(/\/feedback\/bugs$/);
  await expect(visitor.getByRole("dialog", { name: "Share an idea" })).toBeVisible();
  await visitor.keyboard.press("Escape");
  // Its search looks through every board.
  await visitor.goto("/feedback?q=csv");
  await expect(overview.getByRole("listitem").getByRole("link", { name: "CSV export" })).toBeVisible();
  await expect(overview.getByRole("region", { name: "Feature requests" })).toHaveCount(0);
  // A card's Open board opens it.
  await visitor.goto("/feedback");
  await card("Feature requests").getByRole("link", { name: "Open board" }).click();
  await visitor.waitForURL(/\/feedback\/feature-requests$/);
  // On a phone: round search and New post beside the title, the board pills scroll, nothing runs off the side.
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.goto("/feedback");
  await expect(overview.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await expect(overview.getByRole("button", { name: "New post" })).toBeVisible();
  expect(await visitor.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(visitor, "portal-feedback-overview-phone");
  // Without JavaScript the round search's box can't open: on a phone the overview's search form is in the page, and searches every board.
  const noScript = await browser.newContext({ baseURL: portalUrl(slug), javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const early = await noScript.newPage();
  await early.goto("/feedback");
  await early.getByRole("searchbox", { name: "Search ideas" }).fill("csv");
  await early.getByRole("searchbox", { name: "Search ideas" }).press("Enter");
  await early.waitForURL(/\/feedback\?q=csv$/);
  const found = early.getByRole("main").getByRole("listitem").filter({ hasText: "CSV export" });
  await expect(found.getByRole("link", { name: "CSV export" })).toBeVisible();
  await expect(found).toContainText("Feature requests");
  await noScript.close();
  await visitor.setViewportSize({ width: 1280, height: 720 });
  await visitor.goto("/feedback/bugs");
  // Roadmap has no row of its own.
  await parts.getByRole("link", { name: "Roadmap" }).click();
  await expect(visitor.getByRole("heading", { name: "Roadmap" })).toBeVisible();
  await expect(parts.getByRole("link", { name: "Roadmap" })).toHaveAttribute("aria-current", "page");
  await expect(parts.getByRole("link", { name: "Feedback" })).not.toHaveAttribute("aria-current");
  await expect(boards).toHaveCount(0);
  // On a phone the header is one line: the parts are in its menu, with the boards; the page's pill row starts with a board switcher.
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.goto("/feedback/bugs");
  await expect(visitor.getByRole("button", { name: "Board: Bug reports" })).toBeVisible();
  await expect(boards).toBeHidden();
  await expect(parts).toBeHidden();
  expect(await visitor.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(visitor, "portal-header-phone");
  await visitor.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const menu = visitor.getByRole("dialog", { name: "Menu" });
  await expect(menu.getByRole("navigation", { name: "Portal" }).getByRole("link")).toHaveText(["Feedback", "Roadmap", "Changelog", "Documentation"]);
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
  // Its other ways out name the parts as the header does.
  await expect(visitor.getByRole("main").getByRole("link", { name: "Documentation", exact: true })).toHaveAttribute("href", "/docs");
  await expect(visitor.locator('[aria-current="page"]')).toHaveCount(0);
  await expect(visitor.getByRole("navigation", { name: "Boards" })).toHaveCount(0);
  await checkpoint(visitor, "portal-not-found");
  // A mistyped address too: the same page, in the portal's header.
  expect((await visitor.goto("/fedback"))?.status()).toBe(404);
  await expect(visitor.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(visitor.getByRole("banner")).toBeVisible();
  // With one board there's no list of them, and Feedback (and /feedback) opens that board.
  await visitor.setViewportSize({ width: 1280, height: 800 });
  await visitor.goto("/feedback");
  await expect(visitor).toHaveURL(/\/feedback\/feature-requests$/);
  await expect(parts.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  await expect(parts.getByRole("link", { name: "Feedback" })).toHaveAttribute("href", "/feedback/feature-requests");
  await expect(boards).toHaveCount(0);
  await expect(visitor.getByRole("button", { name: /^Board: / })).toHaveCount(0);
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
  // The Button names the portal's button that opens the form, and the form's own.
  await expect(dialog.getByText("The button that opens the board's form on your portal, and the form's submit button")).toBeVisible();
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

  // On the portal: the description under the name, the board's button text as the header's button, and its words in the dialog.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await expect(ada.getByText("What should we build next?")).toBeVisible();
  // One board, nothing shipped: no rail, and the list takes the header's whole width (no empty column beside it).
  await expect(ada.getByRole("complementary", { name: "About this board" })).toHaveCount(0);
  await expect(ada.getByRole("button", { name: "New post" })).toHaveCount(0);
  await ada.getByRole("main").locator("header").getByRole("button", { name: "Request a feature" }).click();
  const form = ada.getByRole("dialog", { name: "Share an idea" }).locator("form");
  await expect(form.getByLabel("Title")).toHaveAttribute("placeholder", "What should it do?");
  await expect(form.getByRole("textbox", { name: "Details" }).locator("p")).toHaveAttribute("data-placeholder", "How would it help you?");
  await checkpoint(ada, "portal-board-share-idea");
  await form.getByLabel("Title").fill("Dark mode");
  await form.getByRole("button", { name: "Request a feature" }).click();
  // Posted (saving runs its jobs first, see postFeedback): the post is on the board, the dialog closed; it opens empty again.
  await expect(ada.getByRole("link", { name: "Dark mode" })).toBeVisible({ timeout: 15_000 });
  await expect(ada.getByRole("dialog")).toHaveCount(0);
  const [list, header] = [(await ada.getByRole("main").locator("ul.divide-y").boundingBox())!, (await ada.getByRole("main").locator("header").boundingBox())!];
  expect(Math.abs(list.width - header.width)).toBeLessThanOrEqual(1);
  await ada.getByRole("main").locator("header").getByRole("button", { name: "Request a feature" }).click();
  await expect(form.getByLabel("Title")).toHaveValue("");
  await ada.keyboard.press("Escape");
  // The widget's Feedback tab uses the same words (signed in on the portal, it posts as them).
  await ada.goto("/widget?tab=feedback");
  await expect(ada.getByLabel("Title")).toHaveAttribute("placeholder", "What should it do?");
  await expect(ada.getByRole("button", { name: "Request a feature" })).toBeVisible();
});
