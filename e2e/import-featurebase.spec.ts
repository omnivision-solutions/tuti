import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { FAKE_FEATUREBASE_KEY, FAKE_FEATUREBASE_SLOW_KEY } from "@tuti/testkit";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("in the first run the team comes from Featurebase: a bad key is refused, a good one brings its contacts across as Users while setup goes on, and its team as invitations to send", async ({ browser }, testInfo) => {
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
  await expect(owner.getByText("Bring what you have in another tool across, or start fresh. You can always import later, in Settings → Import.")).toBeVisible();
  await owner.getByRole("radio", { name: /^Featurebase/ }).check();
  // Where the key is made, beside its field, in a new tab.
  const keysLink = owner.getByRole("link", { name: /^Get your API key.*opens in a new tab/ });
  await expect(keysLink).toHaveAttribute("href", "https://auth.featurebase.app/login?redirect=/settings/api");
  await expect(keysLink).toHaveAttribute("target", "_blank");
  // Their team, as invitations to review and send, and Contacts, ticked to begin with.
  await expect(owner.getByRole("checkbox", { name: /^Team/ })).toBeChecked();
  await expect(owner.getByText("Your Featurebase team, as invitations you review and send. They join as members; owners can change roles in Team & roles.")).toBeVisible();
  await expect(owner.getByRole("checkbox", { name: /^Contacts/ })).toBeChecked();
  // Profile pictures too: copied last, so nothing waits for them.
  await expect(owner.getByRole("checkbox", { name: /^Profile pictures/ })).toBeChecked();
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
  // Each part says where it is, in the order they run: the team done, contacts under way.
  const parts = owner.getByRole("list", { name: "What's brought across" });
  const part = (name: string) => parts.getByRole("listitem").filter({ has: owner.getByText(name, { exact: true }) });
  await expect(owner.getByText("Part 2 of 3.", { exact: false })).toBeVisible();
  await expect(part("Team")).toContainText("2 invitations ready to send.");
  // Said once, with their link: no count of its own besides.
  await expect(part("Team")).not.toContainText("2 invitations.");
  await expect(part("Team")).toContainText("Done");
  await expect(part("Contacts")).toContainText("Starting…");
  await expect(part("Contacts")).toContainText("In progress");
  await expect(part("Profile pictures")).toContainText("Your users' profile pictures");
  await expect(part("Profile pictures")).toContainText("Next");
  await checkpoint(owner, "setup-featurebase-importing");
  // Featurebase answers now; done, Continue still has focus (one Continue, kept as the import ends), and the summary is said.
  await fetch(`${process.env.E2E_FEATUREBASE_URL}/_fake/release`, { method: "POST" });
  await expect(status).toHaveText("Imported from Featurebase. 2 invitations, 3 contacts, 1 profile picture brought across.", { timeout: 15_000 });
  await expect(continueLink).toBeFocused();
  // Nothing was emailed: the invitations wait for the team to send them.
  await expect(owner.getByText("2 invitations ready to send.")).toBeVisible();
  await checkpoint(owner, "setup-featurebase-imported");

  // Setup goes on.
  await owner.getByRole("link", { name: "Continue" }).click();
  await owner.waitForURL(`**/app/${slug}/setup?step=use`);
  await expect(owner.getByText("Step 2 of 4")).toBeVisible();
  await owner.getByRole("link", { name: "Skip setup" }).click();

  // Home says what came across, and the contacts are the project's users, with their company.
  await owner.waitForURL(`**/app/${slug}`);
  await expect(owner.getByText("Imported from Featurebase", { exact: true })).toBeVisible();
  await expect(owner.getByText("Team, Contacts, and Profile pictures brought across.", { exact: true })).toBeVisible();
  // Its card is a line; View details opens each part's progress, as the setup step shows it.
  await owner.getByRole("button", { name: "View details" }).click();
  const details = owner.getByRole("dialog", { name: "Imported from Featurebase" });
  await expect(details.getByRole("listitem").filter({ hasText: "Team" })).toContainText("2 invitations ready to send.");
  await expect(details.getByRole("listitem").filter({ hasText: "Team" })).not.toContainText("2 invitations.");
  await expect(details.getByRole("listitem").filter({ hasText: "Contacts" })).toContainText("3 contacts.");
  await expect(details.getByRole("link", { name: "See users" })).toBeVisible();
  // Each row says it's done to screen readers too, beside its link.
  await expect(details.getByRole("listitem").filter({ hasText: "Contacts" })).toContainText("Done");
  await checkpoint(owner, "home-import-details");
  await owner.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  // Screen readers hear it in one status: the title and, once it's over, the summary.
  await expect(owner.getByRole("status").filter({ hasText: "Featurebase" })).toHaveText("Imported from Featurebase. 2 invitations, 3 contacts, 1 profile picture brought across.");
  await checkpoint(owner, "home-imported");

  // The team's invitations, not sent yet, in Team & roles: one is sent, and waits there as any invite does.
  await owner.getByRole("link", { name: "Send them in Team & roles" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/team`);
  const unsent = owner.getByRole("list", { name: "Invitations not sent yet" });
  await expect(unsent.getByRole("listitem")).toHaveCount(2);
  await expect(unsent.getByText("e2e-featurebase-former@example.com · Member")).toBeVisible();
  await checkpoint(owner, "team-invitations-not-sent");
  // By keyboard: from Send all, Tab reaches the first row's Send (named for its address); Enter sends it, and focus goes on
  // to the next row's Send.
  const sends = unsent.getByRole("button", { name: /^Send the invite to / });
  const [first, next] = await Promise.all([sends.nth(0).getAttribute("aria-label"), sends.nth(1).getAttribute("aria-label")]);
  const sentTo = first!.replace("Send the invite to ", "");
  await owner.getByRole("button", { name: "Send all 2" }).focus();
  await owner.keyboard.press("Tab");
  await expect(owner.getByRole("button", { name: first! })).toBeFocused();
  await owner.keyboard.press("Enter");
  await expect(owner.getByText("Invite sent")).toBeVisible();
  await expect(unsent.getByRole("listitem")).toHaveCount(1);
  await expect(owner.getByRole("button", { name: next! })).toBeFocused();
  await expect(unsent.getByRole("button", { name: `Remove the invite to ${next!.replace("Send the invite to ", "")}` })).toBeVisible();
  const pending = owner.getByRole("list", { name: "Pending invites" }).getByRole("listitem").filter({ hasText: `${sentTo} · Member` });
  await expect(pending).toContainText("Created by Olive Owner");
  await expect(pending.getByRole("button", { name: "Revoke" })).toBeVisible();
  await checkpoint(owner, "team-invitation-sent");

  // Remove asks first, naming the address; the last row gone (and the card with it), focus goes to the pending invites.
  const left = next!.replace("Send the invite to ", "");
  await unsent.getByRole("button", { name: `Remove the invite to ${left}` }).focus();
  await owner.keyboard.press("Enter");
  const dialog = owner.getByRole("alertdialog");
  await expect(dialog.getByRole("heading")).toHaveText(`Remove the invite for ${left}?`);
  await checkpoint(owner, "team-invitation-remove");
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(owner.getByText("Invite removed")).toBeVisible();
  await expect(unsent).toHaveCount(0);
  await expect(owner.locator("#pending-invites")).toBeFocused();

  // None wait now: Home says nothing of them.
  await owner.goto(`/app/${slug}`);
  await expect(owner.getByText("Imported from Featurebase", { exact: true })).toBeVisible();
  await expect(owner.getByText(/ready to send/)).toHaveCount(0);
  await owner.getByRole("button", { name: "View details" }).click();
  await owner.getByRole("dialog").getByRole("link", { name: "See users" }).click();
  await owner.waitForURL(`**/app/${slug}/users`);
  const rows = owner.getByRole("main").getByRole("table").locator("tbody").getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Mira Fenwick" })).toContainText("Fenwick Labs");
  await expect(rows.filter({ hasText: "Tobias Quill" })).toBeVisible();
  await expect(rows.filter({ hasText: "Juno Park" })).toBeVisible();
  await checkpoint(owner, "users-imported");
});

test("after setup, Settings → Import brings what's in Featurebase across any time; importing again brings nothing twice", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/settings/general`);
  await owner.getByRole("link", { name: "Import", exact: true }).click();
  await owner.waitForURL(`**/app/${slug}/settings/import`);
  // Only the tools to import from: starting fresh is the first run's.
  await expect(owner.getByRole("radio", { name: /^Featurebase/ })).toBeChecked();
  await expect(owner.getByRole("radio", { name: /^Starting fresh/ })).toHaveCount(0);
  await checkpoint(owner, "settings-import");

  const status = owner.getByRole("status").filter({ hasText: "Featurebase" });
  await owner.getByRole("textbox", { name: "API key" }).fill(FAKE_FEATUREBASE_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).press("Enter");
  await expect(status).toHaveText("Imported from Featurebase. 2 invitations, 3 contacts, 1 profile picture brought across.", { timeout: 15_000 });
  // With no Continue here, focus is on the import's progress, not lost with the form.
  await expect(owner.locator(":focus")).toContainText("Imported from Featurebase");
  await expect(owner.getByText("Importing again brings only what's new since: nothing comes twice.")).toBeVisible();
  await checkpoint(owner, "settings-import-done");

  await owner.getByRole("textbox", { name: "API key" }).fill(FAKE_FEATUREBASE_KEY);
  await owner.getByRole("button", { name: "Import again" }).click();
  await expect(status).toContainText("Nothing brought across.", { timeout: 15_000 });
  await expect(status).toContainText("3 contacts already brought across earlier");
  await checkpoint(owner, "settings-import-again");
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
  // Profile pictures went with Contacts, and don't come back with them.
  const pictures = owner.getByRole("checkbox", { name: /^Profile pictures/ });
  await expect(pictures).not.toBeChecked();
  await pictures.check();
  await checkpoint(owner, "setup-featurebase-feedback");

  await owner.getByRole("textbox", { name: "API key" }).fill(FAKE_FEATUREBASE_KEY);
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Featurebase" });
  await expect(status).toContainText("Imported from Featurebase", { timeout: 30_000 });
  for (const count of ["3 contacts", "2 boards", "6 posts", "9 votes", "3 comments", "1 note", "1 profile picture"]) {
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
  // The post Featurebase showed only to its author came as Private: not on the portal for anyone else.
  await visitor.goto("/feedback/bugs");
  await expect(visitor.getByRole("link", { name: /Export fails on Safari/ })).toBeVisible();
  await expect(visitor.getByText("Only for one customer")).toHaveCount(0);
  await visitor.goto("/feedback/feature-requests/dark-mode-1");
  const post = visitor.getByRole("article");
  await expect(post.getByRole("heading", { name: "Dark mode" })).toBeVisible();
  await expect(post.getByText("Night owls need it.")).toBeVisible();
  await expect(post.getByRole("img", { name: "A sketch" })).toBeVisible();
  await expect(post.locator('time[datetime="2024-01-10T08:00:00.000Z"]')).toBeVisible();
  // Signed out: its votes on the link to sign in and vote.
  await expect(visitor.getByRole("link", { name: "Sign in to vote (3 votes)" })).toBeVisible();
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

test("the help center comes across from Featurebase: the portal's docs have its collections, and its articles with their formatting, images and links to each other", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await owner.waitForURL(`**/app/${slug}/setup`);

  // The help center alone.
  await owner.getByRole("radio", { name: /^Featurebase/ }).check();
  await owner.getByRole("checkbox", { name: /^Help center/ }).check();
  await owner.getByRole("checkbox", { name: /^Contacts/ }).uncheck();
  await owner.getByRole("textbox", { name: "API key" }).fill(FAKE_FEATUREBASE_KEY);
  await checkpoint(owner, "setup-featurebase-help-center");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Featurebase" });
  await expect(status).toContainText("Imported from Featurebase");
  await expect(status).toContainText("3 collections, 3 articles, 1 article as a draft (only some people could see it) brought across.");
  await checkpoint(owner, "setup-help-center-imported");

  // On the portal: the collections at the top, with what's in them.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs");
  const cards = visitor.getByRole("list", { name: "Collections" });
  await expect(cards.getByRole("link", { name: /^Getting started/ })).toContainText("Your first steps.");
  await expect(cards.getByRole("link", { name: /^Getting started/ }).locator("svg.lucide-lightbulb")).toBeVisible();
  await expect(cards.getByRole("link", { name: /^Billing/ })).toBeVisible();
  await checkpoint(visitor, "portal-docs-imported");

  // An article with its formatting, image and document; its draft and the one only some could see aren't there.
  await visitor.goto("/docs/welcome-to-acme");
  const welcome = visitor.getByRole("article", { name: "Welcome to Acme" });
  await expect(welcome.getByRole("heading", { name: "Start here", level: 2 })).toBeVisible();
  await expect(welcome.locator("strong", { hasText: "every invoice" })).toBeVisible();
  await expect(welcome.getByRole("listitem")).toHaveText(["Add your team", "Connect your bank"]);
  await expect(welcome.getByRole("img", { name: "The dashboard" })).toBeVisible();
  await expect(welcome.getByText("setup-guide.pdf")).toBeVisible();
  const tree = visitor.getByRole("navigation", { name: "Docs", exact: true });
  await expect(tree.getByRole("link", { name: "Roadmap notes" })).toHaveCount(0);
  await checkpoint(visitor, "portal-imported-article");

  // Its link to another imported article goes to that one's page here, in the same tab (a link to the portal's own article).
  const link = welcome.getByRole("paragraph").getByRole("link", { name: "Paying by card" });
  await expect(link).toHaveAttribute("href", "/docs/paying-by-card");
  await link.click();
  await visitor.waitForURL(`${portalUrl(slug)}/docs/paying-by-card`);
  await expect(visitor.getByRole("article", { name: "Paying by card" })).toContainText("Cards are charged on the 1st.");
  await checkpoint(visitor, "portal-imported-linked-article");
});

test("the changelog comes across from Featurebase: its entries on the portal at their dates, with their images; drafts and those only some people see aren't there", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();
  await owner.waitForURL(`**/app/${slug}/setup`);

  // The changelog alone.
  await owner.getByRole("radio", { name: /^Featurebase/ }).check();
  await owner.getByRole("checkbox", { name: /^Changelog/ }).check();
  await expect(owner.getByText("Your updates, published at their dates (drafts stay drafts), with their images; categories like New, Improved and Fixed become tags. Nothing is emailed.")).toBeVisible();
  await owner.getByRole("checkbox", { name: /^Team/ }).uncheck();
  await owner.getByRole("checkbox", { name: /^Contacts/ }).uncheck();
  await owner.getByRole("textbox", { name: "API key" }).fill(FAKE_FEATUREBASE_KEY);
  await checkpoint(owner, "setup-featurebase-changelog");
  await owner.getByRole("button", { name: "Check the key and start" }).click();
  const status = owner.getByRole("status").filter({ hasText: "Featurebase" });
  await expect(status).toContainText("Imported from Featurebase");
  await expect(status).toContainText("3 changelog entries, 2 images in the changelog brought across.");
  await expect(status).toContainText("2 changelog entries only some people see");
  await expect(owner.getByRole("link", { name: "See changelog" })).toBeVisible();
  await checkpoint(owner, "setup-changelog-imported");

  // On the portal: the published entries, the newest first, with the image; the draft and the segment's one aren't there.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/changelog");
  await expect(visitor.getByRole("heading", { name: "Faster exports" })).toBeVisible();
  await expect(visitor.getByRole("heading", { name: "Dark mode is here" })).toBeVisible();
  // Its cover, and the image in it.
  await expect(visitor.getByRole("img", { name: "Dark mode is here", exact: true })).toBeVisible();
  await expect(visitor.getByRole("img", { name: "Dark mode", exact: true })).toBeVisible();
  await expect(visitor.getByText("Single sign-on")).toHaveCount(0);
  await expect(visitor.getByText("For our beta group")).toHaveCount(0);
  await checkpoint(visitor, "portal-changelog-imported");

  // In the app: the entry Featurebase emailed says so, and isn't emailed again; the one it didn't, says that.
  await owner.goto(`/app/${slug}/changelog/1`);
  await expect(owner.getByText("Emailed to your subscribers from Featurebase.")).toBeVisible();
  await owner.goto(`/app/${slug}/changelog/2`);
  await expect(owner.getByText("Not emailed to subscribers.")).toBeVisible();
  await checkpoint(owner, "app-changelog-imported-entry");
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
  await owner.waitForURL(`**/app/${slug}/inbox/1`);
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
  await owner.waitForURL(new RegExp(`/app/${slug}/inbox/2\\?view=snoozed$`));
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(1)).toContainText("Sent again: it's in your inbox.");
  await expect(messages.nth(1)).toContainText("Imported from Featurebase");
  await expect(messages.nth(1)).not.toContainText("Emailed");
  // Sent by email: only its new part shows, the quote it carried behind "Show the whole email".
  const quote = messages.nth(1).getByText(/Tobias Quill <e2e-tobias@example\.com> wrote:/);
  await expect(quote).toBeHidden();
  await checkpoint(owner, "conversation-imported-unread");
  await messages.nth(1).getByText("Show the whole email").click();
  await expect(quote).toBeVisible();
  await checkpoint(owner, "conversation-imported-whole-email");

  // Closed: the bot's and the one from two years ago (this server keeps every closed conversation).
  await owner.goto(`/app/${slug}/inbox`);
  await views.getByRole("link", { name: /^Closed/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "How do I reset my password?" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Dark mode?" })).toHaveCount(1);
});
