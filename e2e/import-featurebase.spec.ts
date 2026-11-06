import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { FAKE_FEATUREBASE_KEY, FAKE_FEATUREBASE_SLOW_KEY } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";

test("in the first run the team comes from Featurebase: a bad key is refused, a good one brings its contacts across as Users while setup goes on", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();

  // Where are you coming from: Featurebase, with a key and what to bring.
  await owner.waitForURL(`**/app/${slug}/setup`);
  await expect(owner.getByText("Step 1 of 4")).toBeVisible();
  await owner.getByRole("radio", { name: /^Featurebase/ }).check();
  await expect(owner.getByRole("link", { name: "Settings → API" })).toHaveAttribute("href", "https://auth.featurebase.app/login?redirect=/settings/api");
  await expect(owner.getByRole("checkbox", { name: /^Contacts/ })).toBeChecked();
  await expect(owner.getByText("Contacts, feedback and the inbox come across for now: the help center follows in a later version, and the changelog after it.")).toBeVisible();
  await checkpoint(owner, "setup-featurebase");

  // A key Featurebase refuses: said under the field, nothing started.
  const key = owner.getByRole("textbox", { name: "API key" });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("sk_not_a_real_key");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  await expect(owner.getByText("Featurebase didn't accept this API key. Check you copied all of it, or make a new one.")).toBeVisible();
  await checkpoint(owner, "setup-featurebase-bad-key");

  // A good one (Featurebase holding its pages until the journey lets them go, so the import is running when the page looks): it starts,
  // and its progress shows here until it's done.
  await key.fill(FAKE_FEATUREBASE_SLOW_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Featurebase" });
  const continueLink = owner.getByRole("link", { name: "Continue" });
  // Started, focus is on Continue, the way on; screen readers hear only that it's importing, not each page's count.
  await expect(status).toHaveText("Importing from Featurebase");
  await expect(continueLink).toBeFocused();
  // The key isn't left in the page.
  await expect(key).toHaveCount(0);
  // Featurebase answers now; done, Continue still has focus (one Continue, kept as the import ends), and the summary is said.
  await fetch(`${process.env.E2E_FEATUREBASE_URL}/_fake/release`, { method: "POST" });
  await expect(status).toHaveText("Imported from Featurebase. 3 contacts brought across.", { timeout: 15_000 });
  await expect(continueLink).toBeFocused();
  await checkpoint(owner, "setup-featurebase-imported");

  // Setup goes on.
  await owner.getByRole("link", { name: "Continue" }).click();
  await owner.waitForURL(`**/app/${slug}/setup?step=use`);
  await expect(owner.getByText("Step 2 of 4")).toBeVisible();
  await owner.getByRole("link", { name: "Skip setup" }).click();

  // Home says what came across, and the contacts are the project's users, with their company.
  await owner.waitForURL(`**/app/${slug}`);
  await expect(owner.getByText("Imported from Featurebase", { exact: true })).toBeVisible();
  await expect(owner.getByText("3 contacts brought across.", { exact: true })).toBeVisible();
  // Screen readers hear it in one status: the title and, once it's over, the summary.
  await expect(owner.getByRole("status").filter({ hasText: "Featurebase" })).toHaveText("Imported from Featurebase. 3 contacts brought across.");
  await checkpoint(owner, "home-imported");
  await owner.getByRole("link", { name: "See users" }).click();
  await owner.waitForURL(`**/app/${slug}/users`);
  const rows = owner.getByRole("main").getByRole("table").locator("tbody").getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Mira Fenwick" })).toContainText("Fenwick Labs");
  await expect(rows.filter({ hasText: "Tobias Quill" })).toBeVisible();
  await expect(rows.filter({ hasText: "Juno Park" })).toBeVisible();
  await checkpoint(owner, "users-imported");
});

test("Feedback comes across with Contacts: the posts with their dates, votes and comments on the portal, and the team's private comment as a note in the app", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await owner.waitForURL(`**/app/${slug}/setup`);
  await owner.getByRole("radio", { name: /^Featurebase/ }).check();

  // Feedback needs Contacts: ticking it keeps Contacts ticked, and unticking Contacts unticks it.
  const contacts = owner.getByRole("checkbox", { name: /^Contacts/ });
  const feedback = owner.getByRole("checkbox", { name: /^Feedback/ });
  await feedback.check();
  await expect(contacts).toBeChecked();
  await contacts.uncheck();
  await expect(feedback).not.toBeChecked();
  await feedback.check();
  await expect(contacts).toBeChecked();
  await checkpoint(owner, "setup-featurebase-feedback");

  await owner.getByRole("textbox", { name: "API key" }).fill(FAKE_FEATUREBASE_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Featurebase" });
  await expect(status).toContainText("Imported from Featurebase", { timeout: 30_000 });
  for (const count of ["3 contacts", "2 boards", "5 posts", "8 votes", "3 comments", "1 note", "1 avatar"]) {
    await expect(status).toContainText(count);
  }
  await expect(status).toContainText("3 boards only some people see");
  await expect(status).toContainText("1 post hidden from the portal");
  await checkpoint(owner, "setup-featurebase-feedback-imported");

  // On the portal: the post with its date, its votes, its comments in date order and its status change; never the note.
  const visitor = await browser.newPage({ baseURL: portalUrl(slug) });
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.getByRole("link", { name: /Dark mode/ })).toBeVisible();
  await expect(visitor.getByText("Hidden from the portal")).toHaveCount(0);
  await checkpoint(visitor, "portal-board-imported");
  await visitor.goto("/feedback/feature-requests/dark-mode-1");
  const post = visitor.getByRole("article");
  await expect(post.getByRole("heading", { name: "Dark mode" })).toBeVisible();
  await expect(post.getByText("Night owls need it.")).toBeVisible();
  await expect(post.getByRole("img", { name: "A sketch" })).toBeVisible();
  await expect(post.locator('time[datetime="2024-01-10T08:00:00.000Z"]')).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Upvote" })).toHaveText("3");
  const activity = visitor.getByRole("region", { name: "Comments" });
  await expect(activity.getByText("Yes please!")).toBeVisible();
  await expect(activity.locator('time[datetime="2024-01-11T09:00:00.000Z"]')).toBeVisible();
  await expect(activity.getByText("On our list, thanks!")).toBeVisible();
  await expect(visitor.getByText("Planning it for June.")).toHaveCount(0);
  await checkpoint(visitor, "portal-post-imported");

  // In the app: the posts on their boards, and the team's private comment as an internal note.
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByText("Planning it for June.")).toBeVisible();
  await expect(owner.getByText("Internal note", { exact: true })).toBeVisible();
  await expect(owner.getByText("Yes please!")).toBeVisible();
  await checkpoint(owner, "app-post-imported");
  await owner.goto(`/app/${slug}/p/2`);
  await expect(owner.getByRole("heading", { name: "Export fails on Safari" })).toBeVisible();
  await expect(owner.getByText("Fern Former").first()).toBeVisible();
  await checkpoint(owner, "app-post-imported-admin");
});

test("on a plan with a board limit, the setup step says before starting what happens to Featurebase's boards past it, and which plan has room", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/setup`);
  await owner.getByRole("radio", { name: /^Featurebase/ }).check();
  const note = owner.getByText(
    "Projects on the free plan have up to 2 feedback boards: posts on Featurebase's boards past that go into the last one brought across. Pro has up to 5, and Business any number.",
  );
  // Only while Feedback is picked.
  await expect(note).toHaveCount(0);
  await owner.getByRole("checkbox", { name: /^Feedback/ }).check();
  await expect(note).toBeVisible();
  await checkpoint(owner, "setup-featurebase-board-limit");
  await owner.getByRole("checkbox", { name: /^Feedback/ }).uncheck();
  await expect(note).toHaveCount(0);
});

test("the inbox comes across from Featurebase: its conversations with their messages, notes, images and statuses, history marked as imported", async ({ browser }, testInfo) => {
  // Setup, the import, then several Inbox pages (each with its list beside the conversation).
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await owner.waitForURL(`**/app/${slug}/setup`);
  await owner.getByRole("radio", { name: /^Featurebase/ }).check();

  // The inbox needs contacts: they're ticked with it.
  await owner.getByRole("checkbox", { name: /^Contacts/ }).uncheck();
  await owner.getByRole("checkbox", { name: /^Inbox/ }).check();
  await expect(owner.getByRole("checkbox", { name: /^Contacts/ })).toBeChecked();
  await expect(owner.getByText("Contacts, feedback and the inbox come across for now: the help center follows in a later version, and the changelog after it.")).toBeVisible();
  await checkpoint(owner, "setup-featurebase-inbox");
  await owner.getByRole("textbox", { name: "API key" }).fill(FAKE_FEATUREBASE_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Featurebase" });
  await expect(status).toContainText("Imported from Featurebase");
  await expect(status).toContainText("3 contacts, 4 conversations, 1 attachment brought across.");
  await checkpoint(owner, "setup-featurebase-inbox-imported");

  // The one where the user wrote last needs a reply; the snoozed and closed ones are in their views.
  await owner.goto(`/app/${slug}/inbox`);
  const views = owner.getByRole("navigation", { name: "Views" });
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(views.getByRole("link", { name: "Needs reply 1" })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Exporting to CSV");
  await checkpoint(owner, "inbox-imported");

  // Its messages as they were: the user's, the team's reply (seen, as Featurebase's read receipt said), a note, an image.
  await rows.first().getByRole("link").click();
  await owner.waitForURL(`**/app/${slug}/inbox/4`);
  const messages = owner.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(messages).toHaveCount(4);
  await expect(messages.nth(0)).toContainText("Can I export my data to CSV?");
  await expect(messages.nth(1)).toContainText("Yes: Settings → Export. See the guide (https://docs.example.com/export).");
  await expect(messages.nth(1)).toContainText("Seen");
  await expect(messages.nth(2)).toContainText("Note · Olive Owner");
  await expect(messages.nth(2)).toContainText("They're on the pro plan.");
  await expect(messages.nth(3).getByRole("img", { name: "shot.png" })).toBeVisible();
  await checkpoint(owner, "conversation-imported");

  // Snoozed after the team's reply, which the user hadn't read: never emailed, so it says it was imported.
  await owner.goto(`/app/${slug}/inbox`);
  await views.getByRole("link", { name: /^Snoozed/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Invoice for October");
  await rows.first().getByRole("link").click();
  // Opened from the Snoozed view, which it keeps.
  await owner.waitForURL(new RegExp(`/app/${slug}/inbox/3\\?view=snoozed$`));
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(1)).toContainText("Sent again: it's in your inbox.");
  await expect(messages.nth(1)).toContainText("Imported from Featurebase");
  await expect(messages.nth(1)).not.toContainText("Emailed");
  await checkpoint(owner, "conversation-imported-unread");

  // Closed: the bot's and the one from two years ago (this server keeps every closed conversation).
  await owner.goto(`/app/${slug}/inbox`);
  await views.getByRole("link", { name: /^Closed/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "How do I reset my password?" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Dark mode?" })).toHaveCount(1);
});
