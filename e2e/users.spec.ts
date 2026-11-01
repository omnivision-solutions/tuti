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
      { id: "user-3", name: "Cy Cipher", properties: { plan: "enterprise", company: "A company with a rather long name, Incorporated", constructor: "x" } },
    ],
  });
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });

  // A table: each with their email, id and groups, company and plan to start with, and what they did here.
  await owner.goto(`/app/${slug}/users`);
  const table = owner.getByRole("main").getByRole("table");
  const rows = table.locator("tbody").getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(table.getByRole("columnheader")).toHaveText(["User", "company", "plan", "Posts", "Votes", "Conversations", "Last seen"]);
  const ada = rows.filter({ hasText: "Ada Lovelace" });
  await expect(ada).toContainText("e2e-ada@example.com · id user-1");
  await expect(ada).toContainText("Enterprise");
  await expect(ada.getByRole("cell")).toHaveText([/^A/, "–", "enterprise", "0", "0", "0", "Never"]);
  await expect(rows.filter({ hasText: "Bea Byte" })).not.toContainText("Enterprise");

  // Columns: the team shows seats too, and not company.
  await owner.getByRole("button", { name: "Columns" }).click();
  await owner.getByRole("menuitemcheckbox", { name: "seats" }).click();
  await expect(table.getByRole("columnheader")).toHaveText(["User", "company", "plan", "seats", "Posts", "Votes", "Conversations", "Last seen"]);
  await owner.getByRole("menuitemcheckbox", { name: "company" }).click();
  await expect(table.getByRole("columnheader")).toHaveText(["User", "plan", "seats", "Posts", "Votes", "Conversations", "Last seen"]);
  // A property named like something every object has is only theirs who have it.
  await owner.getByRole("menuitemcheckbox", { name: "constructor" }).click();
  await expect(table.getByRole("columnheader")).toHaveText(["User", "plan", "seats", "constructor", "Posts", "Votes", "Conversations", "Last seen"]);
  await owner.keyboard.press("Escape");
  await expect(ada.getByRole("cell")).toHaveText([/^A/, "enterprise", "40", "–", "0", "0", "0", "Never"]);

  // The team's names and formats for them (the API, for now): "Seats", a number.
  await api("/project", { propertyFormats: { seats: { label: "Seats", format: "number" } } }, "PATCH");
  await api("/users", { users: [{ id: "user-1", properties: { seats: 1200 } }] });
  await owner.reload();
  await expect(table.getByRole("columnheader")).toHaveText(["User", "plan", "Seats", "constructor", "Posts", "Votes", "Conversations", "Last seen"]);
  await expect(ada.getByRole("cell").nth(2)).toHaveText("1,200");
  await checkpoint(owner, "team-users-formats");

  // Bea votes: sorted by votes, she's first, seen just now.
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/posts/1/vote", { voted: true, author: { id: "user-2" } });
  await owner.reload();
  await table.getByRole("link", { name: "Votes" }).click();
  await expect(owner).toHaveURL(/\?sort=votes$/);
  await expect(table.getByRole("columnheader", { name: "Votes" })).toHaveAttribute("aria-sort", "descending");
  await expect(rows.first()).toContainText("Bea Byte");
  await expect(rows.first().getByRole("cell").last()).not.toHaveText("Never");
  await checkpoint(owner, "team-users");
  // A search keeps the sort.
  await owner.getByRole("searchbox", { name: "Search users" }).fill("example.com");
  await owner.getByRole("searchbox", { name: "Search users" }).press("Enter");
  await expect(owner).toHaveURL(/\?sort=votes&q=example\.com$/);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Bea Byte");
  await owner.goto(`/app/${slug}/users?sort=votes`);
  await table.getByRole("link", { name: "User" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/users$`));
  await expect(rows.first()).toContainText("Ada Lovelace");

  // Found by name, email or id, from the search box in the top bar.
  expect((await owner.getByRole("searchbox", { name: "Search users" }).boundingBox())!.y).toBeLessThan(48);
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
  // There, the search is in the top bar's "More actions", with what it searched for.
  await owner.getByRole("button", { name: "More actions" }).click();
  await expect(owner.getByRole("searchbox", { name: "Search users" })).toHaveValue("cipher");
});

test("who's asking: Feedback totals the property the team picks over each post's voters, and lists what a group voted for", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/users", {
    users: [
      { id: "user-1", name: "Ada Lovelace", properties: { plan: "enterprise", mrr: 1200 } },
      { id: "user-2", name: "Bea Byte", properties: { plan: "pro", mrr: 300 } },
    ],
  });
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });
  await api("/posts", { board: "feature-requests", title: "SSO" });
  await api("/posts", { board: "feature-requests", title: "Exports" });
  await api("/posts/1/vote", { voted: true, author: { id: "user-1" } });
  await api("/posts/1/vote", { voted: true, author: { id: "user-2" } });
  await api("/posts/2/vote", { voted: true, author: { id: "user-2" } });

  // Settings → Access: the team picks MRR, from its users' number properties.
  await owner.goto(`/app/${slug}/settings/access`);
  const card = owner.getByRole("region", { name: "Who's asking" });
  await card.getByRole("combobox", { name: "Property to total" }).click();
  await expect(owner.getByRole("option")).toHaveText(["None", "mrr"]);
  await owner.getByRole("option", { name: "mrr" }).click();
  await expect(owner.getByText("Feedback totals mrr over each post's voters")).toBeVisible();

  // Under User properties, the team calls mrr MRR, and shows it as money (in dollars, as it's first offered).
  const properties = owner.getByRole("region", { name: "User properties" });
  await properties.getByRole("button", { name: "Edit mrr" }).click();
  const dialog = owner.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name shown" }).fill("MRR");
  await dialog.getByRole("combobox", { name: "Format" }).click();
  await owner.getByRole("option", { name: "Money" }).click();
  await expect(dialog.getByRole("combobox", { name: "Currency" })).toContainText("USD");
  await checkpoint(owner, "settings-user-property");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Saved how mrr shows")).toBeVisible();
  await expect(properties.getByRole("listitem").filter({ hasText: "MRR" })).toContainText("mrr · Money, USD");
  await checkpoint(owner, "settings-user-properties");

  // Each post's voters' total, on the list and the post.
  await owner.goto(`/app/${slug}/feedback`);
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows.filter({ hasText: "SSO" })).toContainText("$1,500 MRR");
  await expect(rows.filter({ hasText: "Exports" })).toContainText("$300 MRR");
  await checkpoint(owner, "team-feedback-whos-asking");
  // What Enterprise voted for.
  await owner.getByRole("combobox", { name: "Voters" }).click();
  await owner.getByRole("option", { name: "Voted by Enterprise" }).click();
  await expect(owner).toHaveURL(/\?group=enterprise$/);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("SSO");
  await rows.getByRole("link", { name: "SSO" }).click();
  await expect(owner.getByRole("region", { name: /^Post #/ })).toContainText("$1,500 MRR");
  // And on the roadmap, once it's planned.
  await api("/posts/1", { status: "planned" }, "PATCH");
  await owner.goto(`/app/${slug}/feedback/roadmap`);
  await expect(owner.getByRole("region", { name: "Planned" }).getByRole("listitem").filter({ hasText: "SSO" })).toContainText("$1,500 MRR");
});
