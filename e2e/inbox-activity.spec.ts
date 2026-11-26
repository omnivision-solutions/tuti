import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";

// Wide enough for the details beside the conversation.
test.use({ viewport: { width: 1440, height: 900 } });

test("a conversation's Activity: its workflows' run, an API key's and a teammate's changes, the filters, and at phone width", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Sam is on the Pro plan; a workflow for Enterprise, then one for everyone.
  const api = await apiFor(owner, slug);
  await api("/users", { users: [{ id: "user-42", name: "Sam Smith", email: "e2e-sam@example.com", properties: { plan: "pro" } }] });
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });
  await api("/workflows", { name: "Enterprise goes first", trigger: "conversation_started", conditions: [{ kind: "in_group", group: "enterprise" }], actions: [{ kind: "mark_priority" }] });
  await api("/workflows", { name: "Priority for everyone", trigger: "conversation_started", actions: [{ kind: "mark_priority" }] });
  await api("/conversations", { user: { id: "user-42" }, subject: "Can't export to CSV", body: "The export button does nothing on the reports page." });
  // The API key hands it to the AI: credited to the key, by its name.
  await api("/conversations/1", { handledBy: "ai" }, "PATCH");

  await owner.goto(`/app/${slug}/inbox/1`);
  const activity = owner.getByRole("complementary", { name: "Conversation details" }).getByRole("region", { name: "Activity" });
  const rows = activity.locator("li[data-event]");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("The API key “Help test” handed it back to the AI");
  await expect(rows.nth(1)).toContainText("A conversation starts ran");
  await expect(rows.nth(1)).toContainText("2 workflows checked");
  await expect(rows.nth(1)).toContainText("Enterprise goes first · didn't match (not in Enterprise)");
  await expect(rows.nth(1)).toContainText("Priority for everyone · marked this priority");
  // Nothing about it in the thread: what the workflows did is here.
  await expect(owner.getByText("Priority for everyone marked this priority")).toHaveCount(0);
  await checkpoint(owner, "activity");

  // The teammate's changes, as they make them.
  await owner.getByRole("button", { name: "Unassigned, assign conversation" }).click();
  await owner.getByRole("menuitem", { name: "Assign to me" }).click();
  await expect(rows.nth(0)).toContainText("Olive Owner assigned it to themselves");
  await owner.getByRole("button", { name: "Needs reply, change status" }).click();
  await owner.getByRole("menuitem", { name: "Closed" }).click();
  await expect(rows.nth(0)).toContainText("Olive Owner closed it");
  await expect(rows).toHaveCount(4);

  // The filters: what the team did, and what ran on its own.
  await activity.getByRole("button", { name: "People" }).click();
  await expect(activity.getByRole("button", { name: "People" })).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "A conversation starts ran" })).toHaveCount(0);
  await activity.getByRole("button", { name: "Workflows" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("A conversation starts ran");
  await checkpoint(owner, "activity-workflows");
  await activity.getByRole("button", { name: "All" }).click();
  await expect(rows).toHaveCount(4);

  // On a phone the details are a sheet, and the Activity reads there, no wider than the screen.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.getByRole("button", { name: "Show details" }).click();
  const sheet = owner.getByRole("dialog", { name: "Conversation details" }).getByRole("region", { name: "Activity" });
  await sheet.scrollIntoViewIfNeeded();
  await expect(sheet.locator("li[data-event]").filter({ hasText: "Enterprise goes first · didn't match (not in Enterprise)" })).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await sheet.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await checkpoint(owner, "activity-phone", { fullPage: false });
  await owner.keyboard.press("Escape");
  await owner.setViewportSize({ width: 1440, height: 900 });

  // An API key's change is under People too, by the key's name.
  await api("/conversations/1", { priority: false }, "PATCH");
  await expect(rows.nth(0)).toContainText("The API key “Help test” took its priority off");
  await activity.getByRole("button", { name: "People" }).click();
  await expect(rows.filter({ hasText: "The API key “Help test”" })).toHaveCount(2);
  await activity.getByRole("button", { name: "All" }).click();

  // More than a page: the earliest come with Show earlier, the row after the last one shown takes focus, and the button
  // goes with the last of them.
  for (let i = 0; i < 20; i++) {
    await api("/conversations/1", { priority: i % 2 === 0 }, "PATCH");
  }
  await owner.reload();
  await expect(rows).toHaveCount(20);
  await expect(rows.filter({ hasText: "A conversation starts ran" })).toHaveCount(0);
  await activity.getByRole("button", { name: "Show earlier" }).click();
  await expect(rows).toHaveCount(25);
  await expect(rows.nth(20)).toBeFocused();
  await expect(rows.last()).toContainText("A conversation starts ran");
  await expect(activity.getByRole("button", { name: "Show earlier" })).toHaveCount(0);
  // Something new meanwhile: nothing shown goes missing, and focus stays where it was.
  await api("/conversations/1", { priority: true }, "PATCH");
  await expect(rows).toHaveCount(26);
  await expect(rows.nth(21)).toBeFocused();
  await expect(rows.last()).toContainText("A conversation starts ran");
});
