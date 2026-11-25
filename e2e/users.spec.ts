import { randomUUID } from "node:crypto";

import pg from "pg";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
import { apiFor, createProject, signUp } from "./helpers";
import { sesComplaint } from "./ses";

test("the team syncs its users over the API and finds them on the Users page, by name and by group", async ({ browser }, testInfo) => {
  // A long journey (pages of a hundred users, Back to a place in the list): more than the default 30s on a loaded runner.
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // None yet: the page says how they get there.
  await owner.goto(`/app/${slug}`);
  await owner.getByRole("link", { name: "Users", exact: true }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/users$`));
  await expect(owner.getByText("No users yet")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Syncing users" })).toHaveAttribute("href", "/api/docs#users.sync");

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
  // One pane: Users in its header, its views as pills (People with how many), Sync from your app at its right end.
  const header = owner.getByRole("region", { name: "Users" }).locator('[data-slot="pane-header"]');
  await expect(header.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();
  await expect(header.getByRole("navigation", { name: "Users views" }).getByRole("link")).toHaveText(["People 3", "Companies", "Subscribers"]);
  await expect(header.getByRole("link", { name: /^People\s*3$/ })).toHaveAttribute("aria-current", "page");
  await expect(header.getByRole("link", { name: "Sync from your app" })).toHaveAttribute("href", "/api/docs#users.sync");
  const table = owner.getByRole("main").getByRole("table");
  const rows = table.locator("tbody").getByRole("row");
  await expect(rows).toHaveCount(3);
  expect((await table.boundingBox())!.width).toBeGreaterThan(900);
  await expect(table.getByRole("columnheader")).toHaveText(["User", "Company", "Plan", "Groups", "Posts", "Votes", "Conversations", "Last seen"]);
  const ada = rows.filter({ hasText: "Ada Lovelace" });
  await expect(ada).toContainText("e2e-ada@example.com");
  await expect(ada.getByRole("cell")).toHaveText([/^A/, "–", "enterprise", "Enterprise", "–", "–", "–", "Never"]);
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
  await expect(ada.getByRole("cell")).toHaveText([/^A/, "enterprise", "40", "–", "Enterprise", "–", "–", "–", "Never"]);

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
  // On a phone: the views a row of pills under the title, each row who they are and when they were last seen.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(owner.getByRole("navigation", { name: "Users views" })).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "team-users-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  // A search keeps the sort.
  await owner.getByRole("searchbox", { name: "Search users" }).fill("example.com");
  await owner.getByRole("searchbox", { name: "Search users" }).press("Enter");
  await expect(owner).toHaveURL(/\?sort=votes&q=example\.com$/);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Bea Byte");
  // Bea's page: her name its title, who she is (her initial for an avatar) beside what she did here: all six votes,
  // each status a badge.
  await rows.first().getByRole("link", { name: "Bea Byte" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/users/user-2$`));
  const who = owner.getByRole("region", { name: "Who" });
  await expect(owner.getByRole("heading", { name: "Bea Byte", level: 1 })).toBeVisible();
  await expect(owner.locator("[data-slot=person-header] [data-slot=avatar]")).toHaveText("B");
  await expect(owner.locator("[data-slot=person-header]")).toContainText("e2e-bea@example.com");
  // The way back in the pane's header: "All users ›" before her name.
  const back = owner.locator('[data-slot="pane-header"]').getByRole("link", { name: "All users" });
  await expect(back).toHaveAttribute("href", `/app/${slug}/users`);
  const votes = owner.getByRole("region", { name: "Votes" });
  await expect(votes.getByRole("link")).toHaveCount(6);
  await expect(votes.getByRole("listitem").filter({ hasText: "Dark mode" }).locator("[data-slot=badge]")).toHaveText("Planned");
  const conversations = owner.getByRole("region", { name: "Conversations" }).getByRole("listitem");
  await expect(conversations.filter({ hasText: "Exports in CSV?" }).getByText("Open", { exact: true })).toBeVisible();
  await expect(conversations.filter({ hasText: "Invoices" }).getByText("Closed", { exact: true })).toBeVisible();
  const [profile, activity] = [(await owner.getByRole("region", { name: "Properties" }).boundingBox())!, (await votes.boundingBox())!];
  expect(profile.x + profile.width).toBeLessThan(activity.x);
  await checkpoint(owner, "team-user");
  // In a short window her page scrolls in its pane: a vote far down, opened, then Back is where it was, that vote in view.
  await owner.setViewportSize({ width: 1280, height: 420 });
  const last = votes.getByRole("link", { name: "Dark mode" });
  await last.scrollIntoViewIfNeeded();
  await expect(owner.locator("[data-slot=person-header]")).not.toBeInViewport();
  await last.click();
  await expect(owner.getByRole("heading", { name: "Dark mode", level: 1 })).toBeVisible();
  await owner.goBack();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/users/user-2$`));
  await expect(last).toBeInViewport();
  await expect(owner.locator("[data-slot=person-header]")).not.toBeInViewport();
  await owner.setViewportSize({ width: 1280, height: 720 });
  // On a phone, "‹ All users" in the header (her name there for screen readers) and her name once, above the profile.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(back).toBeVisible();
  await expect(who.getByRole("heading", { name: "Bea Byte" })).toBeHidden();
  await expect(owner.locator("[data-slot=person-header]")).toContainText("Bea Byte");
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "team-user-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  // She marks one of the project's emails as spam: her page says replies aren't emailed to her any more.
  await expect(owner.getByText("Marked your email as spam")).toHaveCount(0);
  await sesComplaint(slug, "e2e-bea@example.com");
  await owner.reload();
  await expect(who.getByText("Marked your email as spam, so replies aren't emailed to them any more.")).toBeVisible();
  await checkpoint(owner, "team-user-spam");
  // Anyone's, whatever their app's id holds.
  await api("/users", { users: [{ id: "team/7 x", name: "Dee Slash" }] });
  await owner.goto(`/app/${slug}/users?q=Dee`);
  await rows.getByRole("link", { name: "Dee Slash" }).click();
  await expect(owner.getByRole("heading", { name: "Dee Slash", level: 1 })).toBeVisible();
  await expect(owner.getByText("id team/7 x")).toBeVisible();
  // A percent sign in it too.
  await api("/users", { users: [{ id: "50% off", name: "Eve Percent" }] });
  await owner.goto(`/app/${slug}/users?q=Eve`);
  await rows.getByRole("link", { name: "Eve Percent" }).click();
  await expect(owner.getByRole("heading", { name: "Eve Percent", level: 1 })).toBeVisible();
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

  // Found by name, email or id, from the search box above the table (under the title and its tabs).
  const heading = (await owner.getByRole("heading", { name: "Users", level: 1 }).boundingBox())!;
  expect((await owner.getByRole("searchbox", { name: "Search users" }).boundingBox())!.y).toBeGreaterThan(heading.y + heading.height);
  await owner.getByRole("searchbox", { name: "Search users" }).fill("bea");
  await owner.getByRole("searchbox", { name: "Search users" }).press("Enter");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Bea Byte");
  await owner.getByRole("searchbox", { name: "Search users" }).fill("nobody");
  await owner.getByRole("searchbox", { name: "Search users" }).press("Enter");
  await expect(owner.getByText("No users match")).toBeVisible();

  // By group, picked with the keyboard: the list follows and focus stays on Group (nothing remounted under it).
  await owner.goto(`/app/${slug}/users`);
  const groupPicker = owner.getByRole("combobox", { name: "Group" });
  await groupPicker.focus();
  await owner.keyboard.press("Enter");
  // Each key once the list shows the last one landed (its focus on the option), as a person sees it.
  await expect(owner.getByRole("option", { name: "All users" })).toBeFocused();
  await owner.keyboard.press("ArrowDown");
  await expect(owner.getByRole("option", { name: "Enterprise" })).toBeFocused();
  await owner.keyboard.press("Enter");
  await expect(owner).toHaveURL(/\?group=enterprise$/);
  await expect(rows).toHaveCount(2);
  await expect(groupPicker).toBeFocused();
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
  // Which of them these are, below the table only: nothing about pages above it.
  const pages = owner.getByRole("navigation", { name: /pages/i });
  await expect(pages).toHaveCount(1);
  await expect(pages).toContainText("1–50 of 55");
  const below = (await table.boundingBox())!;
  expect((await pages.boundingBox())!.y).toBeGreaterThanOrEqual(below.y + below.height);
  // In the middle, clear of the bottom right where Tuti's chat launcher sits (56px, 20px in).
  const next = (await pages.getByRole("link", { name: "Next" }).boundingBox())!;
  expect(next.x + next.width).toBeLessThan(owner.viewportSize()!.width - 76);
  await pages.getByRole("link", { name: "Next" }).click();
  await expect(owner).toHaveURL(/\?page=2$/);
  // Ada, Bea, Cy, Dee, Eve and 50 Zeds: five on the second page.
  await expect(rows).toHaveCount(5);
  await expect(pages).toContainText("51–55 of 55");
  await checkpoint(owner, "team-users-second-page", { fullPage: false });
  // Next from the bottom of a page: the next one starts at its top (the pane scrolls, not the window).
  await api("/users", { users: Array.from({ length: 50 }, (_, i) => ({ id: `more-${i}`, name: `Zoe ${String(i).padStart(2, "0")}` })) });
  await owner.goto(`/app/${slug}/users`);
  await pages.getByRole("link", { name: "Next" }).scrollIntoViewIfNeeded();
  await expect(table.getByRole("columnheader", { name: "User" })).not.toBeInViewport();
  await pages.getByRole("link", { name: "Next" }).click();
  await expect(owner).toHaveURL(/\?page=2$/);
  await expect(rows).toHaveCount(50);
  await expect(table.getByRole("columnheader", { name: "User" })).toBeInViewport();
  // Someone from far down the list, then Back: the list is where it was, their row in view.
  const far = rows.nth(45).getByRole("link").first();
  await far.scrollIntoViewIfNeeded();
  const name = (await far.textContent())!;
  await far.click();
  await expect(owner.getByRole("heading", { name, level: 1 })).toBeAttached();
  await owner.goBack();
  await expect(owner).toHaveURL(/\?page=2$/);
  await expect(rows.getByRole("link", { name, exact: true })).toBeInViewport();
  await expect(table.getByRole("columnheader", { name: "User" })).not.toBeInViewport();
  await owner.getByRole("combobox", { name: "Group" }).click();
  await owner.getByRole("option", { name: "Enterprise" }).click();
  await expect(owner).toHaveURL(/\?group=enterprise$/);
  await expect(rows).toHaveCount(2);

  // On a phone, long values wrap instead of pushing the page sideways.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/users?q=cipher`);
  await expect(rows).toHaveCount(1);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // Ids only from tablet width up, so emails don't wrap under them; no header row (its sort links would be unseen).
  await expect(rows.getByText("id user-3")).toBeHidden();
  await expect(table.locator("thead")).toBeHidden();
  await checkpoint(owner, "team-users-phone");
  // There too the search is above the table, with what it searched for.
  await expect(owner.getByRole("searchbox", { name: "Search users" })).toBeInViewport();
  await expect(owner.getByRole("searchbox", { name: "Search users" })).toHaveValue("cipher");
});

test("who's asking: Feedback totals the property the team picks over each post's voters, and lists what a group voted for", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
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
  await expect(properties.getByRole("listitem")).toHaveText([/^Account IDaccount_idText/, /^CompanycompanyText/, /^MRRmrrNumber/, /^PlanplanText/]);
  // What they're for is one line beside the title; no Edit buttons, and no Save: a format saves as it's picked.
  await expect(properties).toContainText("Names and formats for the properties your app sends");
  await expect(properties.getByRole("button", { name: /^(Edit|Save)/ })).toHaveCount(0);
  // Who's asking, beside it in Users, is None, and lists the users' first amount first, as suggested (not their id, a number too).
  const menu = owner.getByRole("navigation", { name: "Settings" });
  await menu.getByRole("link", { name: "Who's asking" }).click();
  const card = owner.getByRole("region", { name: "Who's asking" });
  const value = card.getByRole("combobox", { name: "Value of a post" });
  await expect(value).toContainText("None");
  await expect(value).toHaveAccessibleDescription("Totals a number property over each post's voters. Only your team sees it.");
  await value.click();
  await expect(owner.getByRole("option")).toHaveText(["None", "MRRSuggested", "Account ID"]);
  // Said as two words.
  await expect(owner.getByRole("option", { name: "MRR Suggested", exact: true })).toBeVisible();
  await checkpoint(owner, "settings-whos-asking-suggested");
  // Picked with the keyboard, focus stays on the box once it's saved.
  await owner.keyboard.press("ArrowDown");
  await owner.keyboard.press("Enter");
  await expect(owner.getByText("Feedback totals MRR over each post's voters")).toBeVisible();
  await expect(value).toContainText("MRR");
  await expect(value).toBeFocused();
  // Picked, nothing is suggested: the properties in their order.
  await value.click();
  await expect(owner.getByRole("option")).toHaveText(["None", "Account ID", "MRR"]);
  await owner.keyboard.press("Escape");
  // Saved: there after a reload (and its toast gone).
  await owner.reload();
  await expect(value).toContainText("MRR");
  await owner.setViewportSize({ width: 1440, height: 900 });
  await checkpoint(owner, "settings-whos-asking");
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(value).toBeVisible();
  await checkpoint(owner, "settings-whos-asking-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Under User properties, the team shows mrr as money (in dollars, as it's first offered); its name stays MRR.
  await menu.getByRole("link", { name: "User properties" }).click();
  const mrr = properties.getByRole("listitem").filter({ hasText: "MRR" });
  await expect(mrr.getByRole("combobox", { name: "Format of mrr" })).toContainText("Number");
  await expect(mrr.getByRole("combobox", { name: "Currency of mrr" })).toHaveCount(0);
  // Picked on the row, it's saved at once; money then has its currency beside it.
  // A number can't be shown as text (nothing is kept for that), so Text isn't offered for one; it is for the rest.
  await properties.getByRole("combobox", { name: "Format of plan" }).click();
  await expect(owner.getByRole("option")).toHaveText(["Text", "Number", "Money", "Date"]);
  await owner.keyboard.press("Escape");
  await mrr.getByRole("combobox", { name: "Format of mrr" }).click();
  await expect(owner.getByRole("option")).toHaveText(["Number", "Money", "Date"]);
  await owner.getByRole("option", { name: "Money" }).click();
  await expect(owner.getByText("Saved how mrr shows")).toBeVisible();
  await expect(mrr.getByRole("combobox", { name: "Format of mrr" })).toContainText("Money");
  await expect(mrr.getByRole("combobox", { name: "Currency of mrr" })).toContainText("USD");
  // A row's control that can't narrow (its fixed width, money's two selects) keeps the card's width at tablet size with
  // the settings list open: the label gives way, nothing scrolls sideways.
  await owner.setViewportSize({ width: 940, height: 768 });
  await expect(async () => {
    expect(await owner.locator('[data-slot="pane-body"]').last().evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(940);
  }).toPass({ timeout: 5_000 });
  await owner.setViewportSize({ width: 1280, height: 720 });
  // Its name is under the row's menu: MRR until the team gives it one; a name typed and cancelled is gone the next time.
  await mrr.getByRole("button", { name: "Actions for mrr" }).click();
  await owner.getByRole("menuitem", { name: "Rename" }).click();
  const dialog = owner.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "Name shown" })).toHaveAttribute("placeholder", "MRR");
  await dialog.getByRole("textbox", { name: "Name shown" }).fill("Not kept");
  await checkpoint(owner, "settings-user-property");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await mrr.getByRole("button", { name: "Actions for mrr" }).click();
  await owner.getByRole("menuitem", { name: "Rename" }).click();
  await expect(dialog.getByRole("textbox", { name: "Name shown" })).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  const plan = properties.getByRole("listitem").filter({ hasText: "plan" });
  await plan.getByRole("button", { name: "Actions for plan" }).click();
  await owner.getByRole("menuitem", { name: "Rename" }).click();
  await expect(dialog.getByRole("textbox", { name: "Name shown" })).toHaveValue("");
  await dialog.getByRole("textbox", { name: "Name shown" }).fill("Tier");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Saved how plan shows")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(properties.getByRole("listitem")).toHaveText([/^Account IDaccount_id/, /^Companycompany/, /^MRRmrrMoney.*USD/, /^TierplanText/]);
  // Saved, not only shown: it's all there after a reload, the name with the format it had.
  await owner.reload();
  await expect(mrr.getByRole("combobox", { name: "Currency of mrr" })).toContainText("USD");
  await expect(plan.getByRole("combobox", { name: "Format of plan" })).toContainText("Text");
  await expect(plan).toContainText("Tier");
  // A row saves one thing at a time. While its name is being saved, even with the dialog closed, its format can't be
  // picked; picked once that's done, it's saved with the new name: both are there after a reload.
  const company = properties.getByRole("listitem").filter({ hasText: "company" });
  await company.getByRole("button", { name: "Actions for company" }).click();
  await owner.getByRole("menuitem", { name: "Rename" }).click();
  await dialog.getByRole("textbox", { name: "Name shown" }).fill("Employer");
  let releaseRename = () => {};
  const renameHeld = new Promise<void>((resolve) => (releaseRename = resolve));
  await owner.route(`**/app/${slug}/settings/properties`, async (route) => {
    if (route.request().method() === "POST") {
      await renameHeld;
    }
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Save" }).click();
  await owner.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(company.getByRole("combobox", { name: "Format of company" })).toHaveAttribute("aria-readonly", "true");
  releaseRename();
  await expect(owner.getByText("Saved how company shows")).toBeVisible();
  await owner.unroute(`**/app/${slug}/settings/properties`);
  await expect(company.getByRole("combobox", { name: "Format of company" })).not.toHaveAttribute("aria-readonly", "true");
  // The rename's toast gone, the next one is the format's.
  await expect(owner.getByText("Saved how company shows")).toHaveCount(0, { timeout: 15_000 });
  await company.getByRole("combobox", { name: "Format of company" }).click();
  await owner.getByRole("option", { name: "Date" }).click();
  // Focus stays on the dropdown while its pick saves.
  await expect(company.getByRole("combobox", { name: "Format of company" })).toBeFocused();
  await expect(owner.getByText("Saved how company shows")).toBeVisible();
  await owner.reload();
  await expect(company).toContainText("Employer");
  await expect(company.getByRole("combobox", { name: "Format of company" })).toContainText("Date");
  await company.getByRole("combobox", { name: "Format of company" }).click();
  await owner.getByRole("option", { name: "Text" }).click();
  await expect(owner.getByText("Saved how company shows")).toBeVisible();
  // A save that doesn't get through says so and puts the format back to what's kept.
  await owner.route(`**/app/${slug}/settings/properties`, (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await mrr.getByRole("combobox", { name: "Format of mrr" }).click();
  await owner.getByRole("option", { name: "Date" }).click();
  await expect(owner.getByText("Couldn't reach Tuti. Try again.")).toBeVisible();
  await expect(mrr.getByRole("combobox", { name: "Format of mrr" })).toContainText("Money");
  // A name that doesn't get through either: its dialog stays open with what was typed, and the row keeps its name.
  await expect(owner.getByText("Couldn't reach Tuti. Try again.")).toHaveCount(0, { timeout: 15_000 });
  await mrr.getByRole("button", { name: "Actions for mrr" }).click();
  await owner.getByRole("menuitem", { name: "Rename" }).click();
  await dialog.getByRole("textbox", { name: "Name shown" }).fill("Monthly revenue");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Couldn't reach Tuti. Try again.")).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Name shown" })).toHaveValue("Monthly revenue");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(mrr).toContainText("MRR");
  await owner.unroute(`**/app/${slug}/settings/properties`);
  // Beside its name on a wide card, a row's key and format are level with it; on a phone they go under it, and nothing runs past the edge.
  const label = mrr.getByText("MRR", { exact: true });
  const format = mrr.getByRole("combobox", { name: "Format of mrr" });
  const box = async (locator: typeof label) => (await locator.boundingBox())!;
  expect((await box(format)).y).toBeLessThan((await box(label)).y + (await box(label)).height);
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await box(format)).y - ((await box(label)).y + (await box(label)).height)).toBeGreaterThanOrEqual(0);
  expect(await properties.locator('[data-slot="pane-body"]').evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "settings-user-properties-phone");
  await owner.setViewportSize({ width: 1440, height: 900 });
  await checkpoint(owner, "settings-user-properties");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Each post's voters' total, on the list and the post.
  await owner.goto(`/app/${slug}/feedback`);
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows.filter({ hasText: "SSO" })).toContainText("$1,500 MRR");
  await expect(rows.filter({ hasText: "Exports" })).toContainText("$300 MRR");
  await checkpoint(owner, "team-feedback-whos-asking");
  // What Enterprise voted for.
  await owner.getByRole("button", { name: /^Filters/ }).click();
  await owner.getByRole("combobox", { name: "Voters" }).click();
  await owner.getByRole("option", { name: "Voted by Enterprise" }).click();
  await expect(owner).toHaveURL(/\?group=enterprise$/);
  await expect(owner.getByRole("dialog", { name: "Filters" })).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(owner.getByRole("dialog", { name: "Filters" })).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("SSO");
  await rows.getByRole("link", { name: "SSO" }).click();
  await expect(owner.getByRole("region", { name: /^Post #/ })).toContainText("$1,500 MRR");
  // On the post's own page at laptop width, each voter's amount in the narrow sidebar wraps between words, never mid-word ("$1,200 M" / "RR").
  await owner.getByRole("link", { name: "Open full page" }).click();
  // The pane shows the same voters: on the post's page now, not the pane.
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/p/\\d+$`));
  await expect(owner.getByRole("list", { name: "Voters" })).toHaveCount(1);
  await owner.setViewportSize({ width: 1024, height: 768 });
  const amount = owner.getByRole("list", { name: "Voters" }).getByText("$1,200 MRR");
  await expect(amount).toHaveCSS("word-break", "normal");
  await expect(amount).toHaveCSS("overflow-wrap", "break-word");
  await checkpoint(owner, "team-post-voters");
  await owner.setViewportSize({ width: 1280, height: 720 });
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

test("on a phone, Who's asking's suggestion of a long-named property stays inside its list and its card", async ({ browser }, testInfo) => {
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
  const value = card.getByRole("combobox", { name: "Value of a post" });
  await value.click();
  // Cut short to fit, its name whole and "Suggested" in sight.
  const option = owner.getByRole("option", { name: "Averyveryveryverylongnumberpropertynamewithoutanyspaces Suggested", exact: true });
  const tag = (await option.getByText("Suggested").boundingBox())!;
  const list = (await owner.getByRole("listbox").boundingBox())!;
  expect(tag.x + tag.width).toBeLessThanOrEqual(list.x + list.width);
  await checkpoint(owner, "settings-whos-asking-long-name-phone");
  await option.click();
  await expect(owner.getByText("Feedback totals Averyveryveryverylongnumberpropertynamewithoutanyspaces over each post's voters")).toBeVisible();
  // Picked, it's cut short in its box too.
  const box = (await card.boundingBox())!;
  const trigger = (await value.boundingBox())!;
  expect(trigger.x + trigger.width).toBeLessThanOrEqual(box.x + box.width);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("Users → Subscribers lists the changelog's email subscribers, users or not, and an admin removes one", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);

  // None yet: the view says how they get there.
  await owner.goto(`/app/${slug}/users`);
  await owner.getByRole("link", { name: "Subscribers" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/users\\?view=subscribers$`));
  await expect(owner.getByText("No subscribers yet")).toBeVisible();

  // The team's app adds a user of theirs and an address with no user.
  await api("/users", { users: [{ id: "user-1", name: "Ada Lovelace", email: "e2e-ada@example.com" }] });
  await api("/changelog-subscribers", { users: ["user-1"], emails: ["e2e-reader@example.com"] });
  await owner.reload();
  const rows = owner.getByRole("main").getByRole("table").locator("tbody").getByRole("row");
  await expect(rows).toHaveCount(2);
  const ada = rows.filter({ hasText: "e2e-ada@example.com" });
  await expect(ada).toContainText("Subscribed");
  await expect(ada.getByRole("link", { name: "User user-1" })).toHaveAttribute("href", `/app/${slug}/users/user-1`);
  await expect(owner.getByText("isn't emailed to anyone")).toHaveCount(0);
  await checkpoint(owner, "subscribers");
  // On a phone: each row who and its status, Remove inside the table's visible width.
  await owner.setViewportSize({ width: 390, height: 844 });
  const scroller = owner.getByRole("main").getByRole("table").locator("..");
  const remove = ada.getByRole("button", { name: "Remove e2e-ada@example.com" });
  // The Status column is hidden here: the one shown is under the address.
  await expect(ada.getByText("Subscribed", { exact: true }).filter({ visible: true })).toHaveCount(1);
  const [box, button] = [(await scroller.boundingBox())!, (await remove.boundingBox())!];
  expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "subscribers-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Remove asks first; then they're removed, and Subscribed no longer lists them.
  await rows.filter({ hasText: "e2e-reader@example.com" }).getByRole("button", { name: "Remove e2e-reader@example.com" }).click();
  await expect(owner.getByRole("alertdialog")).toContainText("They stop getting your changelog by email, and any link to confirm it stops working.");
  await owner.getByRole("button", { name: "Remove subscriber" }).click();
  await expect(owner.getByText("e2e-reader@example.com removed")).toBeVisible();
  // Its row has no Remove now: focus goes to the search box, not the page's top.
  await expect(owner.getByRole("searchbox", { name: "Search subscribers" })).toBeFocused();
  await expect(rows.filter({ hasText: "e2e-reader@example.com" })).toContainText("Removed");
  await expect(rows.filter({ hasText: "e2e-reader@example.com" }).getByRole("button")).toHaveCount(0);
  // Ada turns all of the project's emails off: still confirmed, so still removable (turned back on, she'd get it).
  await api("/email-preferences", { unsubscribed: true, author: { id: "user-1" } }, "PATCH");
  await owner.reload();
  await expect(ada).toContainText("All emails off");
  await expect(ada.getByRole("button", { name: "Remove e2e-ada@example.com" })).toBeVisible();
  await owner.getByRole("combobox", { name: "Status" }).click();
  await owner.getByRole("option", { name: "All emails off" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("e2e-ada@example.com");

  // A private portal emails nobody its changelog: the view says so.
  await owner.goto(`/app/${slug}/settings/access`);
  await owner.getByRole("combobox", { name: "Who can see your portal" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("Portal is now private")).toBeVisible();
  await owner.goto(`/app/${slug}/users?view=subscribers`);
  await expect(owner.getByText("Your portal is private, so its changelog isn't emailed to anyone.")).toBeVisible();
});

test("on a server selling plans, Users → Subscribers says when the project's email is paused", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/users?view=subscribers`);
  await expect(owner.getByText("No subscribers yet")).toBeVisible();
  await expect(owner.getByText("Your project's email is paused")).toHaveCount(0);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(`UPDATE project SET "emailPausedAt" = now() WHERE slug = $1`, [slug]);
  } finally {
    await db.end();
  }
  await owner.reload();
  await expect(owner.getByText("Your project's email is paused, so nothing is sent until it's resumed.")).toBeVisible();
});
