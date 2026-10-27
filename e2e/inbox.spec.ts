import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("conversations from the API land in the inbox, where the team replies, assigns, closes and marks spam", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Empty to start with.
  await owner.goto(`/app/${slug}`);
  await owner.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox$`));
  await expect(owner.getByText("Nothing waits for an answer.")).toBeVisible();

  // Someone from the team's app, and someone known only by their email address, write in.
  const api = await apiFor(owner, slug);
  await api("/conversations", {
    user: { id: "user-42", name: "Sam Smith", email: "e2e-sam@example.com" },
    subject: "Can't export to CSV",
    body: "The export button does nothing on the reports page.",
  });
  await api("/conversations", { email: "e2e-asker@example.com", body: "Do you have a discount for nonprofits?" });
  // What the team's app says about Sam, and a group for its enterprise customers.
  await api("/users", { users: [{ id: "user-42", properties: { plan: "enterprise", seats: 40 } }] });
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });

  const views = owner.getByRole("navigation", { name: "Views" });
  await owner.goto(`/app/${slug}/inbox`);
  await expect(views.getByRole("link", { name: "Open 2" })).toHaveAttribute("aria-current", "page");
  await expect(views.getByRole("link", { name: "Unassigned 2" })).toBeVisible();
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows).toHaveCount(2);
  // Newest message first, each waiting on the team.
  await expect(rows.first()).toContainText("Do you have a discount for nonprofits?");
  await expect(rows.first()).toContainText("#2 · e2e-asker@example.com");
  await expect(rows.last()).toContainText("#1 · Sam Smith");
  await expect(rows.first().getByText(/^Waiting \d+m$/)).toBeVisible();
  await checkpoint(owner, "inbox");

  // j and k move through the list; Enter opens one.
  await owner.keyboard.press("j");
  await owner.keyboard.press("j");
  await owner.keyboard.press("k");
  await expect(rows.first().getByRole("link")).toBeFocused();
  await owner.keyboard.press("j");
  await owner.keyboard.press("Enter");
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1$`));
  await expect(owner.getByRole("heading", { name: "Can't export to CSV" })).toBeVisible();
  await expect(owner.getByText("#1 · Sam Smith (e2e-sam@example.com) · started from the API")).toBeVisible();

  // Beside it, who Sam is: their app's id, properties and groups, and nothing else from them yet.
  const about = owner.getByRole("complementary", { name: "About them" });
  await expect(about).toContainText("Sam Smith");
  await expect(about).toContainText("e2e-sam@example.com");
  await expect(about).toContainText("id user-42");
  await expect(about).toContainText("Enterprise");
  await expect(about.getByRole("definition")).toHaveText(["enterprise", "40"]);
  await expect(about.getByRole("region", { name: "Other conversations" })).toContainText("None.");

  // The team replies (⌘/Ctrl+Enter sends): it's waiting on the user now.
  const messages = owner.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await owner.getByRole("textbox", { name: "Reply" }).fill("Thanks, Sam! A fix is on its way.");
  await owner.getByRole("textbox", { name: "Reply" }).press("ControlOrMeta+Enter");
  await expect(messages).toHaveCount(2);
  await expect(messages.last()).toContainText("Olive Owner");
  await expect(messages.last()).toContainText("Thanks, Sam! A fix is on its way.");
  await expect(owner.getByRole("textbox", { name: "Reply" })).toHaveValue("");
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Waiting");

  // Assigned to themselves.
  await owner.getByRole("combobox", { name: "Assignee" }).click();
  await owner.getByRole("option", { name: "Olive Owner" }).click();
  await expect(owner.getByText("Assigned to Olive Owner")).toBeVisible();
  await checkpoint(owner, "conversation");

  // Sam writes again from the team's app: it's open again.
  await api("/conversations/1/messages", { body: "Thanks! Any idea when?", author: { id: "user-42" } });
  await owner.reload();
  await expect(messages).toHaveCount(3);
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Open");

  // Closed, it moves to Closed; Mine has nothing left.
  await owner.getByRole("combobox", { name: "Status" }).click();
  await owner.getByRole("option", { name: "Closed" }).click();
  await expect(owner.getByText("Status: Closed")).toBeVisible();
  await owner.goto(`/app/${slug}/inbox`);
  await expect(views.getByRole("link", { name: "Open 1" })).toBeVisible();
  await expect(views.getByRole("link", { name: "Mine 0" })).toBeVisible();
  await views.getByRole("link", { name: "Closed 1" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Can't export to CSV");

  // The other one is spam: marked from More actions, it leaves the inbox for Spam.
  await owner.goto(`/app/${slug}/inbox/2`);
  // Someone known only by their address.
  await expect(owner.getByRole("complementary", { name: "About them" })).toContainText("e2e-asker@example.com (not verified)");
  await expect(owner.getByRole("complementary", { name: "About them" })).toContainText("Known only by this address.");
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("button", { name: "Mark as spam" }).click();
  await expect(owner.getByText("Marked as spam")).toBeVisible();
  await owner.goto(`/app/${slug}/inbox`);
  await expect(views.getByRole("link", { name: "Open 0" })).toBeVisible();
  await views.getByRole("link", { name: "Spam 1" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Do you have a discount for nonprofits?");
});
