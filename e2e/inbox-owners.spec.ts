import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, expectMoreView, holdActions, signUp } from "./helpers";

// Wide enough for the Inbox's views beside its list.
test.use({ viewport: { width: 1440, height: 900 } });

test("a conversation the AI has is in With AI and out of the team's views and counts, a priority one says so on its row, and a teammate's reply takes it over", async ({ browser }, testInfo) => {
  // Signing up, a project, an API key and a dozen pages, each captured, on a shared runner.
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  const api = await apiFor(owner, slug);
  await api("/conversations", { user: { id: "user-42", name: "Sam Smith", email: "e2e-sam@example.com" }, subject: "Can't export to CSV", body: "The export button does nothing on the reports page." });
  await api("/conversations", { email: "e2e-asker@example.com", subject: "Nonprofit discount", body: "Do you have a discount for nonprofits?" });
  // Over the API: nothing in the app hands a conversation to the AI or marks one priority yet.
  await api("/conversations/1", { handledBy: "ai", priority: true }, "PATCH");
  await api("/conversations/2", { priority: true }, "PATCH");

  // The team's views, the sidebar and the tab's title count only what the team has; With AI counts the AI's.
  await owner.goto(`/app/${slug}/inbox`);
  const views = owner.getByRole("navigation", { name: "Inbox", exact: true });
  await expect(views.getByRole("link")).toHaveText([/^Needs reply\s*1$/, /^Mine\s*0$/, /^Unassigned\s*1$/, /^Waiting on user\s*0$/, /^With AI\s*1$/, /^Snoozed\s*0$/, /^Closed\s*0$/, /^Spam\s*0$/]);
  await expect(owner.getByRole("link", { name: "Inbox", exact: true }).locator("..")).toContainText("1 open");
  await expect(owner).toHaveTitle(/^\(1\) /);
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Nonprofit discount");
  // Priority, in words on the row and in its name to the ear.
  await expect(rows.first().getByText("Priority", { exact: true })).toBeVisible();
  await expect(rows.first().getByRole("link").first()).toHaveAccessibleName(/\(#2\), priority$/);
  await checkpoint(owner, "needs-reply-priority");

  await views.getByRole("link", { name: "With AI 1" }).click();
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText(/^With AI\s*1$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Can't export to CSV");
  await expect(rows.first().getByText("Priority", { exact: true })).toBeVisible();
  // The AI has it: it isn't waiting on the team.
  await expect(rows.getByText("Needs reply", { exact: true })).toHaveCount(0);
  await checkpoint(owner, "with-ai");
  // A search finds it among the team's: its row says who has it, as no view's title does there, and still not Needs reply.
  const search = owner.getByRole("searchbox", { name: "Search conversations" });
  await search.fill("export");
  await search.press("Enter");
  await expect(owner.getByRole("heading", { name: "Results 1" })).toBeVisible();
  await expect(rows.first().getByText("With AI", { exact: true })).toBeVisible();
  await expect(rows.first().getByText("Priority", { exact: true })).toBeVisible();
  await expect(rows.getByText("Needs reply", { exact: true })).toHaveCount(0);
  await checkpoint(owner, "search-with-ai");
  await search.fill("");
  await search.press("Enter");
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText(/^With AI\s*1$/);
  // On a phone the row still reads on its lines, the page no wider than the screen.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(rows.first().getByText("Priority", { exact: true })).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "with-ai-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1440, height: 900 });

  // A teammate's reply takes it over: the team's, waiting on the user, and With AI is empty.
  await api("/conversations/1/messages", { body: "I'm on it." });
  await expect(views.getByRole("link")).toHaveText([/^Needs reply\s*1$/, /^Mine\s*0$/, /^Unassigned\s*1$/, /^Waiting on user\s*1$/, /^With AI\s*0$/, /^Snoozed\s*0$/, /^Closed\s*0$/, /^Spam\s*0$/]);
  await expect(owner.getByText("Nothing's with the AI.")).toBeVisible();
  await checkpoint(owner, "with-ai-empty");
});

test("a conversation the AI has says so and offers Take over where the reply box would be; taken over, it's replied to; Mark priority shows on its page and its row", async ({ browser }, testInfo) => {
  // Signing up, a project, an API key and a dozen pages, each captured, on a shared runner.
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  const api = await apiFor(owner, slug);
  await api("/conversations", { user: { id: "user-42", name: "Sam Smith", email: "e2e-sam@example.com" }, subject: "Can't export to CSV", body: "The export button does nothing on the reports page." });
  // Over the API: nothing in the app hands a conversation to the AI (docs/plan.md W6: W12 adds "Hand back to the AI").
  await api("/conversations/1", { handledBy: "ai" }, "PATCH");

  await owner.goto(`/app/${slug}/inbox/1?view=ai`);
  const meta = owner.locator(".inbox-conversation-meta");
  const takeOver = owner.getByRole("button", { name: "Take over" });
  const reply = owner.getByRole("textbox", { name: "Reply" });
  const row = owner.locator(".inbox-row").filter({ hasText: "Can't export to CSV" });
  const more = owner.getByRole("button", { name: "More actions" });
  const details = owner.getByRole("complementary", { name: "Conversation details" });

  // Who has it, under the title; it isn't waiting on the team, there or in its details.
  await expect(meta.getByText("With AI", { exact: true })).toBeVisible();
  await expect(meta.getByText("Needs reply")).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Open, change status", exact: true })).toBeVisible();
  // Taking over comes before typing: no reply box, no Note tab, and nothing hands it back.
  await expect(owner.locator(".inbox-take-over")).toHaveText(/^The AI has this conversation\.\s*Take over$/);
  await expect(takeOver).toHaveAccessibleDescription("The AI has this conversation.");
  await expect(reply).toHaveCount(0);
  await expect(owner.getByRole("tab")).toHaveCount(0);
  await more.click();
  await expect(owner.getByRole("menuitem", { name: /hand back/i })).toHaveCount(0);

  // Mark priority: on its page as on its row, and still the AI's.
  await owner.getByRole("menuitem", { name: "Mark priority" }).click();
  await expect(owner.getByText("Marked priority")).toBeVisible();
  await expect(meta.getByText("Priority", { exact: true })).toBeVisible();
  await expect(row.getByText("Priority", { exact: true })).toBeVisible();
  await expect(meta.getByText("With AI", { exact: true })).toBeVisible();
  await expectMoreView(owner, "With AI 1");
  await checkpoint(owner, "with-ai-take-over");

  // On a phone the conversation is alone: who has it, the mark and Take over all in view, the page no wider than the screen.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(meta.getByText("With AI", { exact: true })).toBeVisible();
  await expect(meta.getByText("Priority", { exact: true })).toBeVisible();
  await expect(takeOver).toBeInViewport({ ratio: 1 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "with-ai-take-over-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1440, height: 900 });

  // Take over: while it saves the button keeps the focus; then it's the team's, still open here, the cursor in the reply.
  const release = await holdActions(owner);
  await takeOver.click();
  await expect(takeOver).toBeDisabled();
  await expect(takeOver).toBeFocused();
  await release();
  await expect(owner.getByText("Taken over")).toBeVisible();
  await expect(takeOver).toHaveCount(0);
  await expect(reply).toBeFocused();
  await expect(meta.getByText("With AI", { exact: true })).toHaveCount(0);
  // Nothing else about it moved: it needs a reply, as before the AI had it, and keeps its mark.
  await expect(meta.locator(".inbox-conversation-state")).toHaveText("Needs reply");
  await expect(details.getByRole("button", { name: "Needs reply, change status", exact: true })).toBeVisible();
  await expect(meta.getByText("Priority", { exact: true })).toBeVisible();
  await expectMoreView(owner, "With AI 0");
  await expectMoreView(owner, "Needs reply 1");
  await expect(owner).toHaveURL(new RegExp(`/inbox/1\\?view=ai$`));
  await checkpoint(owner, "taken-over");

  // Replied to, as any of the team's.
  await reply.fill("I'm on it, Sam.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByText("Sent", { exact: true })).toBeVisible();
  await expect(owner.getByRole("list", { name: "Messages" })).toContainText("I'm on it, Sam.");
  await expect(meta.locator(".inbox-conversation-state")).toHaveText("Waiting on user");
  await expectMoreView(owner, "Waiting on user 1");

  // The mark shows on its row in the team's views too, till it's removed.
  await owner.goto(`/app/${slug}/inbox/1?view=waiting`);
  await expect(row.getByText("Priority", { exact: true })).toBeVisible();
  await checkpoint(owner, "priority-team");
  await more.click();
  await owner.getByRole("menuitem", { name: "Remove priority" }).click();
  await expect(owner.getByText("Priority removed")).toBeVisible();
  await expect(meta.getByText("Priority", { exact: true })).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(row.getByText("Priority", { exact: true })).toHaveCount(0);
  await more.click();
  await expect(owner.getByRole("menuitem", { name: "Mark priority" })).toBeVisible();
});
