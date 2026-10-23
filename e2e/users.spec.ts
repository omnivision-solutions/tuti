import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("the team syncs its users over the API and finds them on the Users page, by name and by group", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // None yet: the page says how they get there.
  await owner.goto(`/app/${slug}`);
  await owner.getByRole("link", { name: "Users", exact: true }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/users$`));
  await expect(owner.getByText("No users yet")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Syncing users" })).toHaveAttribute("href", "/docs/api#users.sync");

  // The team's app sends three users, and there's a group for enterprise customers.
  const api = await apiFor(owner, slug);
  await api("/users", {
    users: [
      { id: "user-1", name: "Ada Lovelace", email: "e2e-ada@example.com", properties: { plan: "enterprise", seats: 40, features: ["sso", "audit"] } },
      { id: "user-2", name: "Bea Byte", email: "e2e-bea@example.com", properties: { plan: "free" } },
      { id: "user-3", name: "Cy Cipher", properties: { plan: "enterprise", company: "A company with a rather long name, Incorporated" } },
    ],
  });
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });

  // Each with their email, id, properties and groups.
  await owner.goto(`/app/${slug}/users`);
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows).toHaveCount(3);
  const ada = rows.filter({ hasText: "Ada Lovelace" });
  await expect(ada).toContainText("e2e-ada@example.com · id user-1");
  await expect(ada).toContainText("Enterprise");
  await expect(ada.getByRole("definition")).toHaveText(["enterprise", "40", "sso, audit"]);
  await expect(rows.filter({ hasText: "Bea Byte" })).not.toContainText("Enterprise");
  await checkpoint(owner, "team-users");

  // Found by name, email or id.
  await owner.getByRole("searchbox", { name: "Search users" }).fill("bea");
  await owner.getByRole("searchbox", { name: "Search users" }).press("Enter");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Bea Byte");
  await owner.getByRole("searchbox", { name: "Search users" }).fill("nobody");
  await owner.getByRole("searchbox", { name: "Search users" }).press("Enter");
  await expect(owner.getByText("No users match")).toBeVisible();

  // By group.
  await owner.goto(`/app/${slug}/users`);
  await owner.getByRole("combobox", { name: "Group" }).click();
  await owner.getByRole("option", { name: "Enterprise" }).click();
  await expect(owner).toHaveURL(/\?group=enterprise$/);
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Bea Byte" })).toHaveCount(0);

  // A group named "All" is a group like any other, not every user.
  await api("/groups", { name: "All", conditions: [{ property: "plan", op: "is", value: "free" }] });
  await owner.goto(`/app/${slug}/users`);
  await owner.getByRole("combobox", { name: "Group" }).click();
  await owner.getByRole("option", { name: "All", exact: true }).click();
  await expect(owner).toHaveURL(/\?group=all$/);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Bea Byte");

  // 50 a page; picking a group from a later page starts at its first.
  await api("/users", { users: Array.from({ length: 50 }, (_, i) => ({ id: `bulk-${i}`, name: `Zed ${String(i).padStart(2, "0")}` })) });
  await owner.goto(`/app/${slug}/users`);
  await expect(rows).toHaveCount(50);
  await owner.getByRole("link", { name: "Next" }).click();
  await expect(owner).toHaveURL(/\?page=2$/);
  await expect(rows).toHaveCount(3);
  await owner.getByRole("combobox", { name: "Group" }).click();
  await owner.getByRole("option", { name: "Enterprise" }).click();
  await expect(owner).toHaveURL(/\?group=enterprise$/);
  await expect(rows).toHaveCount(2);

  // On a phone, long values wrap instead of pushing the page sideways.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/users?q=cipher`);
  await expect(rows).toHaveCount(1);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await checkpoint(owner, "team-users-phone");
});
