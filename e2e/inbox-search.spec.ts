import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, openPersonDetails, signUp } from "./helpers";

// Wide enough for the Inbox's panes side by side: its views, the list and the conversation.
test.use({ viewport: { width: 1440, height: 900 } });

test("the Inbox's search finds conversations in every view but Spam by what was said, who wrote and their number; a result opens beside the results, and clearing it goes back to the view", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  // #1: Sam, at Northwind, answered (waiting on Sam). #2: closed. #3: open, about something else. #4: Sam again. #5: spam.
  await api("/conversations", { user: { id: "sam", name: "Sam Smith", email: "e2e-sam@example.com" }, subject: "Charged twice", body: "I was charged twice this month." });
  await api("/users", { users: [{ id: "sam", properties: { company: "Northwind" } }] });
  await api("/conversations/1/messages", { body: "Sorry about that, Sam. I've looked at both charges on your account, and the refund for the second one is on its way: it takes about five days." });
  await api("/conversations", { email: "e2e-alex@example.com", subject: "Cancel my plan", body: "Please cancel. Can I get a refund for this year?" });
  await api("/conversations/2", { status: "closed" }, "PATCH");
  await api("/conversations", { email: "e2e-jamie@example.com", subject: "Calendar won't connect", body: "It keeps asking me to sign in again." });
  await api("/conversations/3/messages", { body: "Jamie's on the legacy plan: check before answering.", note: true });
  await api("/conversations", { user: { id: "sam" }, subject: "A copy of my invoice", body: "Could you send last month's invoice?" });
  await api("/conversations", { email: "e2e-spammer@example.com", body: "Refund guaranteed, click here" });
  await api("/conversations/5", { spam: true }, "PATCH");

  await owner.goto(`/app/${slug}/inbox?view=waiting`);
  const views = owner.getByRole("navigation", { name: "Inbox", exact: true });
  const rows = owner.getByRole("region", { name: "Conversations" }).getByRole("listitem");
  const search = owner.getByRole("searchbox", { name: "Search conversations" });
  await expect(owner.getByRole("heading", { name: "Waiting on user 1" })).toBeVisible();
  // The field is the list's search: no button for the project's (⌘K) beside it.
  await expect(owner.getByRole("button", { name: "Search project" })).toHaveCount(0);

  // What was said, in a closed one and one waiting on its user: the latest message first, not the spam.
  await search.fill("refund");
  await search.press("Enter");
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox\\?view=waiting&q=refund$`));
  await expect(owner.getByRole("heading", { name: "Results 2" })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Cancel my plan");
  await expect(rows.nth(0)).toContainText("Closed");
  await expect(rows.nth(1)).toContainText("Charged twice");
  // Each row shows the message that has the text, around it, the text marked.
  await expect(rows.nth(1)).toContainText("and the refund for the second one is on its way");
  await expect(rows.locator("mark")).toHaveText(["refund", "refund"]);
  await expect(owner.getByRole("status").filter({ hasText: "Search for" })).toHaveText("Search for “refund” found 2 conversations");
  // No view is the current one while searching.
  await expect(views.locator("[aria-current]")).toHaveCount(0);
  await checkpoint(owner, "search-results", { fullPage: false });

  // A result opens beside the results.
  await rows.nth(1).getByRole("link", { name: /Sam Smith/ }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1\\?view=waiting&q=refund$`));
  await expect(owner.getByRole("heading", { name: "Charged twice" })).toBeVisible();
  await expect(search).toHaveValue("refund");
  await expect(rows).toHaveCount(2);
  await checkpoint(owner, "search-result-open", { fullPage: false });

  // Their company, and a number; the conversation stays open.
  await search.fill("NORTHWIND");
  await search.press("Enter");
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1\\?view=waiting&q=NORTHWIND$`));
  await expect(rows).toHaveCount(2);
  await expect(rows).toContainText(["A copy of my invoice", "Charged twice"]);
  // Their other conversation, opened from the details, is one of the results: they stay beside it.
  await openPersonDetails(owner);
  await owner.getByRole("complementary", { name: "About them" }).getByRole("link", { name: "A copy of my invoice" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/4\\?view=waiting&q=NORTHWIND$`));
  await expect(owner.getByRole("heading", { level: 1, name: "A copy of my invoice" })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await search.fill("#3");
  await search.press("Enter");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Calendar won't connect");
  // The team's notes are searched too: the row says it's one.
  await search.fill("legacy plan");
  await search.press("Enter");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Note: Jamie's on the legacy plan: check before answering.");

  // Nothing found says so; Clear search goes back to the view.
  await search.fill("zebra");
  await search.press("Enter");
  await expect(owner.getByText("No conversations match your search")).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Results 0" })).toBeVisible();
  await checkpoint(owner, "search-nothing", { fullPage: false });
  await owner.getByRole("link", { name: "Clear search" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/4\\?view=waiting$`));
  await expect(owner.getByRole("heading", { name: "Waiting on user 1" })).toBeVisible();
  await expect(search).toHaveValue("");
  await expect(views.getByRole("link", { name: "Waiting on user 1" })).toHaveAttribute("aria-current", "true");

  // On a phone the field is under the list's title, the page no wider than the screen.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/inbox?q=refund`);
  await expect(rows).toHaveCount(2);
  await expect(search).toHaveValue("refund");
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "search-phone", { fullPage: false });
  // A result opens alone there; the way back is to the results.
  await rows.nth(1).getByRole("link", { name: /Sam Smith/ }).click();
  await expect(owner.getByRole("heading", { name: "Charged twice" })).toBeVisible();
  await owner.locator('[data-inbox-conversation] [data-slot="pane-header"]').getByRole("link", { name: "Inbox" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox\\?q=refund$`));
  await expect(rows).toHaveCount(2);
  await expect(search).toHaveValue("refund");
});
