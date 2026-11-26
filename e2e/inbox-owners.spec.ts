import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";

// Wide enough for the Inbox's views beside its list.
test.use({ viewport: { width: 1440, height: 900 } });

test("a conversation the AI has is in With AI and out of the team's views and counts, a priority one says so on its row, and a teammate's reply takes it over", async ({ browser }, testInfo) => {
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
  // On a phone the row still reads on its lines, the page no wider than the screen.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(rows.first().getByText("Priority", { exact: true })).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "with-ai-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1440, height: 900 });

  // A teammate's reply takes it over: the team's, waiting on the user, and With AI is empty.
  await api("/conversations/1/messages", { body: "I'm on it." });
  await expect(views.getByRole("link")).toHaveText([/^Needs reply\s*1$/, /^Mine\s*0$/, /^Unassigned\s*0$/, /^Waiting on user\s*1$/, /^With AI\s*0$/, /^Snoozed\s*0$/, /^Closed\s*0$/, /^Spam\s*0$/]);
  await expect(owner.getByText("Nothing's with the AI.")).toBeVisible();
  await checkpoint(owner, "with-ai-empty");
});
