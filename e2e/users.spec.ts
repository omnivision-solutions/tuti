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

  // A table the whole width: each with their email and id, company and plan to start with (headed in words), their
  // groups, and what they did here.
  await owner.goto(`/app/${slug}/users`);
  const table = owner.getByRole("main").getByRole("table");
  const rows = table.locator("tbody").getByRole("row");
  await expect(rows).toHaveCount(3);
  expect((await table.boundingBox())!.width).toBeGreaterThan(900);
  await expect(table.getByRole("columnheader")).toHaveText(["User", "Company", "Plan", "Groups", "Posts", "Votes", "Conversations", "Last seen"]);
  const ada = rows.filter({ hasText: "Ada Lovelace" });
  await expect(ada).toContainText("e2e-ada@example.com · id user-1");
  await expect(ada.getByRole("cell")).toHaveText([/^A/, "–", "enterprise", "Enterprise", "0", "0", "0", "Never"]);
  await expect(rows.filter({ hasText: "Bea Byte" })).not.toContainText("Enterprise");

  // Columns: the team shows seats too, and not company.
  await owner.getByRole("button", { name: "Columns" }).click();
  await owner.getByRole("menuitemcheckbox", { name: "Seats" }).click();
  await expect(table.getByRole("columnheader")).toHaveText(["User", "Company", "Plan", "Seats", "Groups", "Posts", "Votes", "Conversations", "Last seen"]);
  await owner.getByRole("menuitemcheckbox", { name: "Company" }).click();
  await expect(table.getByRole("columnheader")).toHaveText(["User", "Plan", "Seats", "Groups", "Posts", "Votes", "Conversations", "Last seen"]);
  // A property named like something every object has is only theirs who have it.
  await owner.getByRole("menuitemcheckbox", { name: "Constructor" }).click();
  await expect(table.getByRole("columnheader")).toHaveText(["User", "Plan", "Seats", "Constructor", "Groups", "Posts", "Votes", "Conversations", "Last seen"]);
  await owner.keyboard.press("Escape");
  await expect(ada.getByRole("cell")).toHaveText([/^A/, "enterprise", "40", "–", "Enterprise", "0", "0", "0", "Never"]);

  // The team's names and formats for them (the API, for now): "Licensed seats", a number.
  await api("/project", { propertyFormats: { seats: { label: "Licensed seats", format: "number" } } }, "PATCH");
  await api("/users", { users: [{ id: "user-1", properties: { seats: 1200 } }] });
  await owner.reload();
  await expect(table.getByRole("columnheader")).toHaveText(["User", "Plan", "Licensed seats", "Constructor", "Groups", "Posts", "Votes", "Conversations", "Last seen"]);
  await expect(ada.getByRole("cell").nth(2)).toHaveText("1,200");
  await checkpoint(owner, "team-users-formats");

  // Bea votes, on six posts: sorted by votes, she's first, seen just now.
  for (const [i, title] of ["Dark mode", "Exports", "SSO", "Webhooks", "Audit log", "Slack alerts"].entries()) {
    await api("/posts", { board: "feature-requests", title });
    await api(`/posts/${i + 1}/vote`, { voted: true, author: { id: "user-2" } });
  }
  await api("/posts/1", { status: "planned" }, "PATCH");
  // And writes twice; one of them is answered and closed.
  await api("/conversations", { user: { id: "user-2" }, subject: "Exports in CSV?", body: "Can I export to CSV?" });
  await api("/conversations", { user: { id: "user-2" }, subject: "Invoices", body: "Where are my invoices?" });
  await api("/conversations/2", { status: "closed" }, "PATCH");
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
  // Bea's page: who she is (her initial for an avatar, her name its heading), beside what she did here: all six votes,
  // each status a badge.
  await rows.first().getByRole("link", { name: "Bea Byte" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/users/user-2$`));
  const who = owner.getByRole("region", { name: "Who" });
  await expect(who.getByRole("heading", { name: "Bea Byte", level: 2 })).toBeVisible();
  await expect(who.locator("[data-slot=avatar]")).toHaveText("B");
  const votes = owner.getByRole("region", { name: "Votes" });
  await expect(votes.getByRole("link")).toHaveCount(6);
  await expect(votes.getByRole("listitem").filter({ hasText: "Dark mode" }).locator("[data-slot=badge]")).toHaveText("Planned");
  const conversations = owner.getByRole("region", { name: "Conversations" }).getByRole("listitem");
  await expect(conversations.filter({ hasText: "Exports in CSV?" }).locator("[data-slot=badge]")).toHaveText("Open");
  await expect(conversations.filter({ hasText: "Exports in CSV?" }).locator("[data-slot=badge]")).toHaveAttribute("data-variant", "outline");
  await expect(conversations.filter({ hasText: "Invoices" }).locator("[data-slot=badge]")).toHaveText("Closed");
  await expect(conversations.filter({ hasText: "Invoices" }).locator("[data-slot=badge]")).toHaveAttribute("data-variant", "secondary");
  const [profile, activity] = [(await who.boundingBox())!, (await votes.boundingBox())!];
  expect(profile.x + profile.width).toBeLessThan(activity.x);
  await checkpoint(owner, "team-user");
  // On a phone, her name once: the page's title, above the profile.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(who.getByRole("heading", { name: "Bea Byte" })).toBeHidden();
  await expect(owner.getByRole("heading", { name: "Bea Byte", level: 1 })).toBeVisible();
  await checkpoint(owner, "team-user-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  // Anyone's, whatever their app's id holds.
  await api("/users", { users: [{ id: "team/7 x", name: "Dee Slash" }] });
  await owner.goto(`/app/${slug}/users?q=Dee`);
  await rows.getByRole("link", { name: "Dee Slash" }).click();
  await expect(owner.getByRole("heading", { name: "Dee Slash", level: 2 })).toBeVisible();
  await expect(owner.getByText("id team/7 x")).toBeVisible();
  // A percent sign in it too.
  await api("/users", { users: [{ id: "50% off", name: "Eve Percent" }] });
  await owner.goto(`/app/${slug}/users?q=Eve`);
  await rows.getByRole("link", { name: "Eve Percent" }).click();
  await expect(owner.getByRole("heading", { name: "Eve Percent", level: 2 })).toBeVisible();
  await expect(owner.getByText("id 50% off")).toBeVisible();
  // Companies: the one Cy is at, with its users and votes; it opens its people.
  await owner.goto(`/app/${slug}/users`);
  await owner.getByRole("navigation", { name: "Users views" }).getByRole("link", { name: "Companies" }).click();
  await expect(owner).toHaveURL(/\?view=companies$/);
  const companyRows = owner.getByRole("main").getByRole("table").locator("tbody").getByRole("row");
  await expect(companyRows).toHaveCount(1);
  await expect(companyRows.getByRole("cell")).toHaveText(["A company with a rather long name, Incorporated", "1", "0"]);
  await checkpoint(owner, "team-companies");
  await companyRows.getByRole("link").click();
  await expect(owner).toHaveURL(/\?company=A\+company/);
  await expect(owner.getByText("Users at A company with a rather long name, Incorporated")).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Cy Cipher");
  await owner.getByRole("link", { name: "All users" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/users$`));

  // A link cut off mid-escape is nobody's: not found, as an id no user has.
  expect((await owner.goto(`/app/${slug}/users/50%`))?.status()).toBe(404);
  expect((await owner.goto(`/app/${slug}/users/nobody`))?.status()).toBe(404);
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
  // Ada, Bea, Cy, Dee, Eve and 50 Zeds: five on the second page.
  await expect(rows).toHaveCount(5);
  await owner.getByRole("combobox", { name: "Group" }).click();
  await owner.getByRole("option", { name: "Enterprise" }).click();
  await expect(owner).toHaveURL(/\?group=enterprise$/);
  await expect(rows).toHaveCount(2);

  // On a phone, long values wrap instead of pushing the page sideways.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/users?q=cipher`);
  await expect(rows).toHaveCount(1);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // Ids only from tablet width up, so emails don't wrap under them.
  await expect(rows.getByText("id user-3")).toBeHidden();
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
      { id: "user-1", name: "Ada Lovelace", properties: { plan: "enterprise", mrr: 1200, company: "Acme", account_id: 1234567 } },
      { id: "user-2", name: "Bea Byte", properties: { plan: "pro", mrr: 300, company: "Acme" } },
    ],
  });
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });
  await api("/posts", { board: "feature-requests", title: "SSO" });
  await api("/posts", { board: "feature-requests", title: "Exports" });
  await api("/posts/1/vote", { voted: true, author: { id: "user-1" } });
  await api("/posts/1/vote", { voted: true, author: { id: "user-2" } });
  await api("/posts/2/vote", { voted: true, author: { id: "user-2" } });

  // Settings → Users → User properties: the synced keys in words, mrr a number as its values are (an id isn't), and nothing the team set yet.
  await owner.goto(`/app/${slug}/settings/properties`);
  const properties = owner.getByRole("region", { name: "User properties" });
  await expect(properties.getByRole("listitem")).toHaveText([/^Account IDaccount_id · Text/, /^Companycompany · Text/, /^MRRmrr · Number/, /^Planplan · Text/]);
  // Who's asking, beside it in Users, is None, and offers the users' first amount in one click (not their id, a number too).
  const menu = owner.getByRole("navigation", { name: "Settings" });
  await menu.getByRole("link", { name: "Who's asking" }).click();
  const card = owner.getByRole("region", { name: "Who's asking" });
  await expect(card.getByRole("combobox", { name: "Property to total" })).toContainText("None");
  await expect(card).toContainText("Your users have MRR, a number Feedback can total.");
  await checkpoint(owner, "settings-whos-asking-suggested");
  await owner.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await checkpoint(owner, "settings-whos-asking-suggested-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await card.getByRole("button", { name: "Use MRR" }).click();
  await expect(owner.getByText("Feedback totals MRR over each post's voters")).toBeVisible();
  await expect(card.getByRole("combobox", { name: "Property to total" })).toContainText("MRR");
  await expect(card.getByRole("button", { name: "Use MRR" })).toBeHidden();
  await expect(card.getByRole("combobox", { name: "Property to total" })).toBeFocused();
  await card.getByRole("combobox", { name: "Property to total" }).click();
  await expect(owner.getByRole("option")).toHaveText(["None", "Account ID", "MRR"]);
  await owner.keyboard.press("Escape");

  // Under User properties, the team shows mrr as money (in dollars, as it's first offered); its name stays MRR.
  await menu.getByRole("link", { name: "User properties" }).click();
  await properties.getByRole("button", { name: "Edit mrr" }).click();
  const dialog = owner.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "Name shown" })).toHaveAttribute("placeholder", "MRR");
  await expect(dialog.getByRole("combobox", { name: "Format" })).toContainText("Number");
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
  // Each voter's amount in the narrow sidebar wraps between words, never mid-word ("$1,200 M" / "RR").
  const amount = owner.getByRole("list", { name: "Voters" }).getByText("$1,200 MRR");
  await expect(amount).toHaveCSS("word-break", "normal");
  await expect(amount).toHaveCSS("overflow-wrap", "break-word");
  await checkpoint(owner, "team-post-voters");
  // And on the roadmap, once it's planned.
  await api("/posts/1", { status: "planned" }, "PATCH");
  await owner.goto(`/app/${slug}/feedback/roadmap`);
  await expect(owner.getByRole("region", { name: "Planned" }).getByRole("listitem").filter({ hasText: "SSO" })).toContainText("$1,500 MRR");
  // And per company: Acme's two users, their three votes, and their MRR.
  await owner.goto(`/app/${slug}/users?view=companies`);
  const table = owner.getByRole("main").getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Company", "Users", "Votes", "MRR"]);
  await expect(table.locator("tbody").getByRole("row").getByRole("cell")).toHaveText(["Acme", "2", "3", "$1,500"]);
  // Sorted by MRR: the heading says so.
  await table.getByRole("link", { name: "MRR" }).click();
  await expect(owner).toHaveURL(/\?view=companies&sort=total$/);
  await expect(table.getByRole("columnheader", { name: "MRR" })).toHaveAttribute("aria-sort", "descending");
  // On a phone: the company and its MRR, nothing sideways.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(table.getByRole("columnheader")).toHaveText(["Company", "MRR"]);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("on a phone, Who's asking's suggestion of a long-named property stays inside its card", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const name = "averyveryveryverylongnumberpropertynamewithoutanyspaces";
  await api("/users", { users: [{ id: "user-1", name: "Ada Lovelace", properties: { [name]: 12 } }] });

  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/settings/asking`);
  const card = owner.getByRole("region", { name: "Who's asking" });
  // Cut short to fit, its name whole.
  const use = card.getByRole("button", { name: "Use Averyveryveryverylongnumberpropertynamewithoutanyspaces" });
  await use.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  const button = (await use.boundingBox())!;
  expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width);
  await checkpoint(owner, "settings-whos-asking-long-name-phone");
});
