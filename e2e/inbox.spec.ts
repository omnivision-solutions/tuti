import { randomUUID } from "node:crypto";

import { type Browser, expect, type Page, test } from "@playwright/test";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { publishMx } from "./dns";
import { setTodaysEmails } from "./email-days";
import { APP_PORTAL_OWNER, APP_URL, CLOUD_URL, cloudPortalUrl, portalUrl, SUPPORT_EMAIL_DOMAIN } from "./env";
import { apiFor, createProject, expectOneRowOfTabs, png, signUp } from "./helpers";
import { rawEmail, receive } from "./inbound";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";
import { nextModelReply } from "./model";
import { sesBounce, verifySesDomain } from "./ses";

/** A conversation's meta line, its status first: "Waiting on user · #1 · Sam Smith …". */
const meta = (page: Page) => page.locator('[data-slot="page-header"] > p');

test("conversations from the API land in the inbox, where the team replies, assigns, closes and marks spam", async ({ browser }, testInfo) => {
  // The whole flow, dozens of pages (each Inbox page with its list beside the conversation): near 30 seconds on a busy runner.
  test.setTimeout(60_000);
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
  const emailed = countEmailsTo(owner.email);
  await api("/conversations", {
    user: { id: "user-42", name: "Sam Smith", email: "e2e-sam@example.com" },
    subject: "Can't export to CSV",
    body: "The export button does nothing on the reports page.",
  });
  await api("/conversations", { email: "e2e-asker@example.com", body: "Do you have a discount for nonprofits?" });
  // What the team's app says about Sam, and a group for its enterprise customers.
  await api("/users", { users: [{ id: "user-42", properties: { plan: "enterprise", seats: 40, company: "Initech", averyveryveryverylongpropertynamewithoutanyspacesatallinit: "x" } }] });
  // A user with the asker's address, which the asker never verified: their company isn't the asker's.
  await api("/users", { users: [{ id: "user-7", name: "Someone else", email: "e2e-asker@example.com", properties: { company: "Globex" } }] });
  await api("/groups", { name: "Enterprise", conditions: [{ property: "plan", op: "is", value: "enterprise" }] });

  // The team hears of each by email.
  const notice = await latestEmailTo(owner.email, { after: emailed + 1 });
  expect(notice.subject).toBe("New conversation: Do you have a discount for nonprofits?");
  expect(notice.text).toContain(`/app/${slug}/inbox/2`);

  const views = owner.getByRole("navigation", { name: "Views" });
  await owner.goto(`/app/${slug}/inbox`);
  // The sidebar and the tab's title count what's open.
  await expect(owner.getByRole("link", { name: "Inbox", exact: true }).locator("..")).toContainText("2 open");
  await expect(owner).toHaveTitle(/^\(2\) /);
  await expect(views.getByRole("link", { name: "Needs reply 2" })).toHaveAttribute("aria-current", "page");
  // What needs the team first: Needs reply, Mine, Unassigned, Waiting on user; then the rest.
  await expect(views.getByRole("link")).toHaveText([/^Needs reply/, /^Mine/, /^Unassigned/, /^Waiting on user/, /^Snoozed/, /^Closed/, /^Spam/]);
  await expect(views.getByRole("link", { name: "Unassigned 2" })).toBeVisible();
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows).toHaveCount(2);
  // Who's waited longest first.
  // Each row: who (and their company), the subject, the latest message's first line, and how long ago.
  await expect(rows.last().getByRole("link")).toHaveText("e2e-asker@example.com");
  await expect(rows.last()).not.toContainText("Globex");
  await expect(rows.last()).toContainText("Do you have a discount for nonprofits?");
  await expect(rows.first().getByRole("link")).toHaveText("Sam Smith · Initech");
  await expect(rows.first()).toContainText("Can't export to CSV · The export button does nothing on the reports page.");
  await expect(rows.first()).toContainText("#1");
  // Waiting on the team says so where not all of them are (not in Needs reply, where it would be every row);
  // "Waiting on user" is the view of those the team answered.
  await expect(rows.getByText("Needs reply", { exact: true })).toHaveCount(0);
  await expect(views.getByRole("link", { name: "Waiting on user 0" })).toBeVisible();
  await views.getByRole("link", { name: "Unassigned 2" }).click();
  await expect(rows.getByText("Needs reply", { exact: true })).toHaveCount(2);
  await checkpoint(owner, "inbox-unassigned");
  await views.getByRole("link", { name: "Needs reply 2" }).click();
  await expect(views.getByRole("link", { name: "Needs reply 2" })).toHaveAttribute("aria-current", "page");
  // The age once, short (in words to screen readers and on hover): not again in the badge.
  const age = rows.first().locator("time");
  await expect(age.locator("[aria-hidden]")).toHaveText(/^\d+m$/);
  await expect(age).toHaveAttribute("title", /^Waiting \d+ minutes?$/);
  await expect(rows.filter({ hasText: /Needs reply ·/ })).toHaveCount(0);
  await checkpoint(owner, "inbox");

  // Wide enough to read at laptop widths: who on one line, the subject and its first line in two at most.
  const rowsRead = async (width: number) => {
    const list = (await owner.getByRole("region", { name: "Conversations", exact: true }).boundingBox())!;
    const who = (await rows.first().getByRole("link").boundingBox())!;
    expect(who.height).toBeLessThan(30);
    // Who, two lines of the message, then the number: four lines at most, not five or six.
    expect((await rows.first().boundingBox())!.height).toBeLessThan(100);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    return list.width;
  };
  await owner.setViewportSize({ width: 1440, height: 900 });
  expect(await rowsRead(1440)).toBeGreaterThanOrEqual(384);
  await checkpoint(owner, "inbox-1440", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await rowsRead(390);
  // Its views don't fit: faded out at the end with more, nothing of a tab cut there in the last 1rem.
  await expect(views).toHaveAttribute("data-more", "end");
  expect(await views.evaluate((row) => getComputedStyle(row).maskImage)).toMatch(/^linear-gradient\((to left|270deg), rgba\(0, 0, 0, 0\) 16px, rgb\(0, 0, 0\) 48px\)$/);
  await checkpoint(owner, "inbox-phone-rows", { fullPage: false });
  // Scrolled under the page's header (room made below to scroll that far), a row's name (above its row's link) stays
  // under it too.
  const nameUnderHeader = await rows
    .first()
    .locator("span[title]")
    .evaluate((name) => {
      const header = document.querySelector("header")!;
      document.body.style.paddingBottom = "100vh";
      window.scrollBy(0, name.getBoundingClientRect().top - header.getBoundingClientRect().top);
      const box = name.getBoundingClientRect();
      const under = header.contains(document.elementFromPoint(box.x + 2, box.y + box.height / 2));
      document.body.style.paddingBottom = "";
      window.scrollTo(0, 0);
      return under;
    });
  expect(nameUnderHeader).toBe(true);
  await owner.setViewportSize({ width: 1280, height: 720 });

  // j and k open the next and the previous conversation beside the list, the open one marked in it.
  await owner.keyboard.press("j");
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1$`));
  await owner.keyboard.press("j");
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/2$`));
  await owner.keyboard.press("k");
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1$`));
  const list = owner.getByRole("region", { name: "Conversations", exact: true });
  await expect(list.getByRole("link", { name: /Can't export to CSV/ })).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("link", { name: /discount for nonprofits/ })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Can't export to CSV" })).toBeVisible();
  await expect(owner.getByText("#1 · Sam Smith (e2e-sam@example.com) · started from the API")).toBeVisible();
  // A click anywhere in a row opens it, not only on the name: its middle (the message), or its age (in words on hover).
  const rowAt = list.getByRole("listitem");
  await rowAt.last().click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/2$`));
  await rowAt.first().locator("time").click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1$`));
  await expect(rowAt.first().getByRole("link")).toBeFocused();
  await rowAt.first().locator("time").click();
  await expect(rowAt.first().getByRole("link")).toBeFocused();
  // The name and the age in full on hover: over the link's cover, not under it.
  for (const hovered of [rowAt.first().locator("span[title]"), rowAt.first().locator("time")]) {
    const onTop = await hovered.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + 2, box.y + box.height / 2));
    });
    expect(onTop).toBe(true);
  }

  // Beside it, who Sam is: their app's id, properties and groups, and nothing else from them yet.
  const about = owner.getByRole("complementary", { name: "About them" });
  await expect(about).toContainText("Sam Smith");
  await expect(about).toContainText("e2e-sam@example.com");
  await expect(about).toContainText("id user-42");
  await expect(about).toContainText("Enterprise");
  await expect(about.getByRole("definition")).toHaveText(["enterprise", "40", "Initech", "x"]);
  // Long names wrap inside the panel, never past it.
  const panel = (await about.boundingBox())!;
  const name = (await about.getByText("averyveryveryverylongpropertynamewithoutanyspacesatallinit").boundingBox())!;
  expect(name.x + name.width).toBeLessThanOrEqual(panel.x + panel.width);
  // And they leave the values room: "enterprise" stays on one line, as tall as the email above it.
  const line = (await about.getByText("e2e-sam@example.com", { exact: true }).boundingBox())!.height;
  expect((await about.getByRole("definition").filter({ hasText: "enterprise" }).boundingBox())!.height).toBeLessThan(line * 1.5);
  await expect(about.getByRole("region", { name: "Other conversations" })).toContainText("None.");

  // The team replies (⌘/Ctrl+Enter sends): it's waiting on the user now.
  // The messages themselves (a message's attachments are a list of their own).
  const messages = owner.getByRole("list", { name: "Messages" }).locator(":scope > li");
  await owner.getByRole("textbox", { name: "Reply" }).fill("Thanks, Sam! A fix is on its way.");
  await owner.getByRole("textbox", { name: "Reply" }).press("ControlOrMeta+Enter");
  await expect(messages).toHaveCount(2);
  await expect(messages.last()).toContainText("Olive Owner");
  await expect(messages.last()).toContainText("Thanks, Sam! A fix is on its way.");
  await expect(owner.getByRole("textbox", { name: "Reply" })).toHaveValue("");
  await expect(meta(owner)).toContainText("Waiting on user · #");

  // A file that can't start uploading (the server unreachable) says so, and can be removed.
  await owner.route("**/*", (route) => (route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await owner.locator('input[type="file"]').setInputFiles({ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
  await expect(owner.getByRole("list", { name: "Files to send" })).toContainText(/broken\.pdf\s*Couldn't upload it/);
  await owner.unroute("**/*");
  await owner.getByRole("button", { name: "Remove broken.pdf" }).click();
  await expect(owner.getByRole("list", { name: "Files to send" })).toHaveCount(0);

  // A reply with a file: it uploads as it's attached, then goes with the reply.
  await owner.locator('input[type="file"]').setInputFiles({ name: "steps.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 the steps") });
  await expect(owner.getByRole("list", { name: "Files to send" })).toContainText(/steps\.pdf\s*1 KB/);
  await owner.getByRole("textbox", { name: "Reply" }).fill("These are the steps.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(messages).toHaveCount(3);
  await expect(messages.last().getByRole("link", { name: "steps.pdf" })).toBeVisible();
  await expect(owner.getByRole("list", { name: "Files to send" })).toHaveCount(0);

  // A note for the team: shown apart, never sent, and it leaves the status alone.
  await owner.getByRole("tab", { name: "Note" }).click();
  await owner.getByRole("textbox", { name: "Note" }).fill("Sam is on the old plan: check with billing.");
  await owner.getByRole("button", { name: "Add note" }).click();
  await expect(messages).toHaveCount(4);
  await expect(messages.last()).toContainText("Note · Olive Owner");
  await expect(messages.last()).toContainText("Sam is on the old plan: check with billing.");
  await expect(meta(owner)).toContainText("Waiting on user · #");
  await checkpoint(owner, "conversation-note");
  await owner.getByRole("tab", { name: "Reply" }).click();

  // The AI: a reply drafted from the docs is offered, and a summary of the conversation is added as its note.
  await expect(owner.getByRole("button", { name: "Draft with AI" })).toBeVisible();
  await nextModelReply("Sam's CSV export fails; a fix is on its way, and billing needs checking.", "Can't export to CSV");
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("button", { name: "Summarize with AI" }).click();
  await expect(owner.getByText("Summary added as a note")).toBeVisible();
  await expect(messages).toHaveCount(5);
  await expect(messages.last()).toContainText("Note · AI");
  await expect(messages.last()).toContainText("Summary: Sam's CSV export fails");

  // Assigned from its button: "Assign to me" first, then the rest of the team. To a teammate first.
  const tara = await signUp(browser, APP_URL, "Tara Teammate");
  const team = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await team.connect();
  await team.query(
    `INSERT INTO team_member (id, "projectId", "userId") SELECT gen_random_uuid()::text, p.id, u.id FROM project p, "user" u WHERE p.slug = $1 AND u.email = $2`,
    [slug, tara.email],
  );
  await team.end();
  await tara.close();
  await owner.reload();
  await owner.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(owner.getByRole("menuitem")).toHaveText(["Assign to me", /Tara Teammate$/]);
  await checkpoint(owner, "conversation-assign-menu");
  await owner.getByRole("menuitem", { name: "Tara Teammate" }).click();
  await expect(owner.getByText("Assigned to Tara Teammate")).toBeVisible();
  // The button shows who has it, and keeps the focus.
  await expect(owner.getByRole("button", { name: "Assigned to Tara Teammate" })).toBeFocused();
  await expect(owner.getByRole("button", { name: "Assigned to Tara Teammate" })).toContainText("Tara Teammate");
  // Tara's off the team, but the assignment stayed (as one racing her removal can): it says so, and can be undone.
  const off = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await off.connect();
  await off.query(`DELETE FROM team_member WHERE "userId" = (SELECT id FROM "user" WHERE email = $1)`, [tara.email]);
  await off.end();
  await owner.reload();
  await owner.getByRole("button", { name: "Assigned to a former teammate" }).click();
  await expect(owner.getByRole("menuitem")).toHaveText(["Assign to me", "Unassign"]);
  await owner.getByRole("menuitem", { name: "Unassign" }).click();
  await expect(owner.getByRole("region", { name: /Notifications/ }).getByText("Unassigned", { exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Assign", exact: true })).toBeFocused();
  // Then to themselves, from the keyboard.
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("menuitem")).toHaveText(["Assign to me"]);
  await owner.getByRole("menuitem", { name: "Assign to me" }).press("Enter");
  await expect(owner.getByText("Assigned to Olive Owner")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Assigned to Olive Owner" })).toBeFocused();
  // Beside the messages, the linked posts aren't squeezed by who it's with under them: their button shows whole.
  await expect(owner.getByRole("region", { name: "Linked posts" }).getByRole("button", { name: "Link post…" })).toBeInViewport({ ratio: 1 });
  await checkpoint(owner, "conversation");

  // Its row shows the latest message, not a note: the team's "These are the steps.", not the AI's summary after it, said
  // as theirs ("You: "), not the person's.
  await owner.goto(`/app/${slug}/inbox?view=mine`);
  const samRow = rows.filter({ hasText: "Can't export to CSV" });
  await expect(samRow).toContainText("Can't export to CSV · You: These are the steps.");
  await checkpoint(owner, "inbox-row-your-reply");
  await expect(samRow).not.toContainText("Summary");
  await owner.goto(`/app/${slug}/inbox/1`);

  // It's about a post on the board: linked to it, the conversation shows on the post, and the post beside it.
  await api("/posts", { board: "feature-requests", title: "Export reports to CSV", author: { id: "user-42" } });
  await owner.reload();
  const linkedPosts = owner.getByRole("region", { name: "Linked posts" });
  await expect(linkedPosts).toContainText("Link the posts this is about");
  await linkedPosts.getByRole("button", { name: "Link post…" }).click();
  await owner.getByRole("dialog").getByRole("textbox", { name: "Search posts" }).fill("csv");
  await owner.getByRole("dialog").getByRole("button", { name: /Export reports to CSV/ }).click();
  await expect(owner.getByText("Linked to #1")).toBeVisible();
  await expect(linkedPosts.getByRole("link", { name: "Export reports to CSV" })).toBeVisible();
  await checkpoint(owner, "conversation-linked-post");
  await linkedPosts.getByRole("link", { name: "Export reports to CSV" }).click();
  await owner.waitForURL(`**/app/${slug}/p/1`);
  const conversations = owner.getByRole("complementary", { name: "Properties" }).getByRole("list", { name: "Conversations" });
  await expect(conversations.getByRole("listitem")).toHaveText([/^Can't export to CSVSam Smith · /]);
  await checkpoint(owner, "post-linked-conversation");
  await conversations.getByRole("link", { name: "Can't export to CSV" }).click();
  await owner.waitForURL(`**/app/${slug}/inbox/1`);
  // Unlinked, it's off the post again. While that runs (its answer held here), "Link post…" waits.
  let releaseUnlink!: () => void;
  const unlinkHeld = new Promise<void>((resolve) => (releaseUnlink = resolve));
  await owner.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) {
      return route.fallback();
    }
    const response = await route.fetch();
    await unlinkHeld;
    await route.fulfill({ response });
  });
  await linkedPosts.getByRole("button", { name: "Unlink “Export reports to CSV”" }).click();
  await expect(linkedPosts.getByRole("button", { name: "Link post…" })).toBeDisabled();
  releaseUnlink();
  await expect(owner.getByText("Unlinked #1")).toBeVisible();
  await owner.unroute("**/*");
  await expect(linkedPosts).toContainText("Link the posts this is about");
  // Unlinked, it looks related (an open post with the subject's words): Link links it, and it moves to the linked posts.
  const related = linkedPosts.getByRole("region", { name: "Looks related" });
  await expect(related.getByRole("link", { name: "Export reports to CSV" })).toBeVisible();
  await checkpoint(owner, "conversation-looks-related");
  await related.getByRole("button", { name: "Link “Export reports to CSV”" }).click();
  // Focus follows it, so a keyboard is still where it was.
  await expect(linkedPosts.getByRole("button", { name: "Unlink “Export reports to CSV”" })).toBeFocused();
  await expect(related).toHaveCount(0);
  await linkedPosts.getByRole("button", { name: "Unlink “Export reports to CSV”" }).click();
  await expect(related.getByRole("button", { name: "Link “Export reports to CSV”" })).toBeVisible();

  // Snoozed for a few hours: out of Open, in Snoozed, till then; woken by hand.
  await owner.getByRole("button", { name: "Snooze" }).click();
  await owner.getByRole("menuitem", { name: "In 3 hours" }).click();
  await expect(owner.getByText(/^Snoozed till /).first()).toBeVisible();
  await owner.goto(`/app/${slug}/inbox?view=snoozed`);
  await expect(views.getByRole("link", { name: "Snoozed 1" })).toHaveAttribute("aria-current", "page");
  // Out of Mine (it's assigned to Olive) while it's snoozed.
  await expect(views.getByRole("link", { name: "Mine 0" })).toBeVisible();
  await expect(owner.getByRole("main").getByRole("listitem")).toContainText(["Can't export to CSV"]);
  await expect(owner.getByRole("main").getByRole("listitem")).toContainText(/back in 3 hours|back in 2 hours/);
  // Waiting on Sam, not the team: its age is since the latest message, and nothing says it needs a reply.
  await expect(owner.getByRole("main").getByRole("listitem").locator("time")).toHaveAttribute("title", /^Latest message \d+ minutes? ago$/);
  await expect(owner.getByRole("main").getByRole("listitem").getByText("Needs reply")).toHaveCount(0);
  await checkpoint(owner, "inbox-snoozed");
  await owner.goto(`/app/${slug}/inbox/1`);
  await owner.getByRole("button", { name: /^Snoozed till / }).click();
  await owner.getByRole("menuitem", { name: "Wake now" }).click();
  await expect(owner.getByText("Back in the inbox")).toBeVisible();
  await owner.goto(`/app/${slug}/inbox?view=mine`);
  await expect(views.getByRole("link", { name: "Mine 1" })).toHaveAttribute("aria-current", "page");
  await expect(owner.getByRole("main").getByRole("listitem")).toContainText(["Can't export to CSV"]);
  await owner.goto(`/app/${slug}/inbox/1`);

  // Sam writes again from the team's app: it's open again.
  await api("/conversations/1/messages", { body: "Thanks! Any idea when?", author: { id: "user-42" } });
  await owner.reload();
  await expect(messages).toHaveCount(6);
  await expect(meta(owner)).toContainText("Open · #");

  // (Waiting on user isn't theirs to pick while Sam's message is the latest: replying sets it.)
  await owner.getByRole("button", { name: "More actions" }).click();
  await expect(owner.getByRole("button", { name: "Mark as waiting on user" })).toHaveCount(0);
  await owner.keyboard.press("Escape");

  // Closed and reopened from its button, which keeps the focus; closed, it can't be snoozed.
  const close = owner.getByRole("button", { name: "Close", exact: true });
  // While it saves (its answer held here), it's disabled and looks it, yet keeps the focus.
  let releaseClose!: () => void;
  const closeHeld = new Promise<void>((resolve) => (releaseClose = resolve));
  await owner.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) {
      return route.fallback();
    }
    const response = await route.fetch();
    await closeHeld;
    await route.fulfill({ response });
  });
  await close.click();
  await expect(close).toHaveAttribute("data-disabled");
  await expect(close).toHaveCSS("opacity", "0.5");
  await expect(close).toBeFocused();
  await checkpoint(owner, "conversation-closing");
  releaseClose();
  await expect(meta(owner)).toContainText("Closed · #");
  await owner.unroute("**/*");
  await expect(owner.getByRole("button", { name: "Reopen" })).toBeFocused();
  await expect(owner.getByRole("button", { name: "Snooze" })).toHaveCount(0);
  await checkpoint(owner, "conversation-closed");
  await owner.keyboard.press("Enter");
  await expect(owner.getByText("Reopened")).toBeVisible();
  await expect(meta(owner)).toContainText("Open · #");
  await expect(close).toBeFocused();

  // Open, unassigned: it joins Unassigned beside the asker's; then it's Olive's again.
  await expect(views.getByRole("link", { name: "Unassigned 1" })).toBeVisible();
  await owner.getByRole("button", { name: "Assigned to Olive Owner" }).click();
  await owner.getByRole("menuitem", { name: "Unassign" }).click();
  await expect(owner.getByRole("region", { name: /Notifications/ }).getByText("Unassigned", { exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Assign", exact: true })).toBeFocused();
  await expect(views.getByRole("link", { name: "Unassigned 2" })).toBeVisible();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("menuitem")).toHaveText(["Assign to me"]);
  await owner.getByRole("menuitem", { name: "Assign to me" }).click();
  await expect(views.getByRole("link", { name: "Unassigned 1" })).toBeVisible();

  // Answered and done with: Send and close. Closed, it moves to Closed; Mine has nothing left.
  await owner.getByRole("textbox", { name: "Reply" }).fill("It ships on Monday. Closing this for now.");
  await owner.getByRole("button", { name: "Send and close" }).click();
  await expect(messages.last()).toContainText("It ships on Monday.");
  await expect(meta(owner)).toContainText("Closed · #");
  await owner.goto(`/app/${slug}/inbox`);
  await expect(views.getByRole("link", { name: "Needs reply 1" })).toBeVisible();
  await expect(views.getByRole("link", { name: "Mine 0" })).toBeVisible();
  await views.getByRole("link", { name: "Closed 1" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Can't export to CSV");
  // A snooze left on it while closed (as a release from before could leave one) doesn't take it out of Closed.
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(`UPDATE conversation SET "snoozedUntil" = now() + interval '30 days' WHERE number = 1 AND "projectId" = (SELECT id FROM project WHERE slug = $1)`, [slug]);
  await db.end();
  await owner.reload();
  await expect(rows).toContainText("Can't export to CSV");
  await expect(views.getByRole("link", { name: "Snoozed 0" })).toBeVisible();

  // Nobody's waiting now but the one about to be marked as spam; and the owner turns the emails off.
  await expect(owner).toHaveTitle(/^\(1\) /);
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("button", { name: "Stop emailing me new conversations" }).click();
  await expect(owner.getByText("You won't be emailed new conversations")).toBeVisible();

  // The other one is spam: marked from More actions, it leaves the inbox for Spam.
  await owner.goto(`/app/${slug}/inbox/2`);
  // Someone known only by their address.
  await expect(owner.getByRole("complementary", { name: "About them" })).toContainText("e2e-asker@example.com (not verified)");
  // Never broken mid-word ("not verifie / d"), wherever the line ends: only the address breaks anywhere.
  expect(
    await owner.getByRole("complementary", { name: "About them" }).evaluate((panel) => {
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent!.includes("(not verified)")) return getComputedStyle(walker.currentNode.parentElement!).wordBreak;
      }
    }),
  ).toBe("normal");
  await expect(owner.getByRole("complementary", { name: "About them" })).toContainText("Known only by this address.");
  // Linked to the post as well (through the API): the post lists it until it's spam.
  await api("/conversations/2/posts", { post: 1 });
  await owner.goto(`/app/${slug}/p/1`);
  await expect(conversations).toContainText("Do you have a discount for nonprofits?");
  await owner.goto(`/app/${slug}/inbox/2`);
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("button", { name: "Mark as spam" }).click();
  await expect(owner.getByText("Marked as spam")).toBeVisible();
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByRole("complementary", { name: "Properties" })).toContainText("Voters");
  await expect(conversations).toHaveCount(0);
  await owner.goto(`/app/${slug}/inbox`);
  await expect(views.getByRole("link", { name: "Needs reply 0" })).toBeVisible();
  await views.getByRole("link", { name: "Spam 1" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Do you have a discount for nonprofits?");
  // Still open, but not a reply the team owes.
  await expect(rows.getByText(/^Needs reply/)).toHaveCount(0);

  // A view name the page doesn't know (even one every object has) is the Open view, of this project only:
  // another project's open conversation stays out of it.
  const otherSlug = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(owner, "Other", otherSlug);
  await (await apiFor(owner, otherSlug))("/conversations", { email: "e2e-elsewhere@example.com", body: "Another project's question" });
  await owner.goto(`/app/${slug}/inbox?view=constructor`);
  await expect(views.getByRole("link", { name: "Needs reply 0" })).toHaveAttribute("aria-current", "page");
  await expect(owner.getByText("Nothing waits for an answer.")).toBeVisible();

  // Reporting counts this project's conversations, spam left out, and the team's replies.
  await owner.goto(`/app/${slug}/reporting/inbox`);
  await expect(owner.getByRole("group", { name: "New conversations", exact: true })).toContainText("1");
  await expect(owner.getByRole("table", { name: "Where they began" }).getByRole("row").filter({ hasText: "The API" })).toContainText("1");
  await expect(owner.getByRole("table", { name: "Replies by teammate" })).toContainText("Olive Owner");
  await checkpoint(owner, "team-reporting-inbox");
});

test("on a phone, Assign, Snooze and Close are under the title, who the conversation is with opens as a sheet, and a long address wraps in its button", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const address = "e2e-a-rather-long-address-for-the-about-button-on-phones@example.com";
  await (await apiFor(owner, slug))("/conversations", { email: address, body: "Hello from a phone" });
  // A teammate with a long name and no spaces in it, for the Assign menu.
  const longName = "Maximilianaalexandrinafeatherstonehaughcholmondeleyworthingtonsmythe";
  const teammate = await signUp(browser, APP_URL, longName);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO team_member (id, "projectId", "userId") SELECT gen_random_uuid()::text, p.id, u.id FROM project p, "user" u WHERE p.slug = $1 AND u.email = $2`,
    [slug, teammate.email],
  );
  await db.end();
  await teammate.close();

  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/inbox/1`);
  const about = owner.getByRole("button", { name: `About ${address}` });
  await expect(about).toBeVisible();
  // Inside the page, not past its right edge (nothing scrolls sideways).
  expect((await about.boundingBox())!.x + (await about.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The reply box's buttons wrap, Send and close and Send together on the right.
  await checkpoint(owner, "inbox-phone-reply");
  // Assign, Snooze and Close under the title, in reach without the top bar's menu, on one row.
  const title = (await owner.getByRole("heading", { name: "Hello from a phone" }).boundingBox())!;
  const onPhone = [owner.getByRole("button", { name: "Assign", exact: true }), owner.getByRole("button", { name: "Snooze" }), owner.getByRole("button", { name: "Close", exact: true })];
  const boxes = await Promise.all(onPhone.map(async (button) => (await button.boundingBox())!));
  for (const box of boxes) {
    expect(box.y).toBeGreaterThan(title.y + title.height);
    expect(box.y).toBe(boxes[0].y);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await checkpoint(owner, "inbox-phone-actions", { fullPage: false });
  // And still in the menu, with the rest: there wherever a long conversation is scrolled to.
  const more = owner.getByRole("button", { name: "More actions" });
  await more.click();
  const actionsMenu = owner.locator(`[id="${await more.getAttribute("aria-controls")}"]`);
  for (const name of ["Assign", "Snooze", "Close", "Mark as spam"]) {
    await expect(actionsMenu.getByRole("button", { name, exact: true })).toBeVisible();
  }
  // Closed from the actions' menu: it closes, and the keyboard's focus is back on its button.
  await actionsMenu.getByRole("button", { name: "Close", exact: true }).click();
  await expect(meta(owner)).toContainText("Closed · #");
  await expect(actionsMenu).toBeHidden();
  await expect(more).toBeFocused();
  // So it is after a pick from a menu in it: Assign's, from the keyboard.
  await owner.keyboard.press("Enter");
  await actionsMenu.getByRole("button", { name: "Assign", exact: true }).press("Enter");
  // The menu fits the screen, the long name wrapping in it; nothing scrolls sideways.
  const menu = owner.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: longName })).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "inbox-phone-assign-menu");
  await owner.getByRole("menuitem", { name: "Assign to me" }).press("Enter");
  await expect(owner.getByText("Assigned to Olive Owner")).toBeVisible();
  await expect(more).toBeFocused();
  await about.click();
  await expect(owner.getByRole("dialog", { name: `About ${address}` })).toContainText("Known only by this address.");

  // A long opening line with no breaks (a pasted link): its row says it once, as the subject made from it, and wraps.
  const link = `https://example.com/reports/export?id=${"8f3c2a91b7d64e05".repeat(5)}&range=last-quarter`;
  await (await apiFor(owner, slug))("/conversations", { email: "e2e-link@example.com", body: link });
  await owner.goto(`/app/${slug}/inbox`);
  const row = owner.getByRole("main").getByRole("listitem").filter({ hasText: "e2e-link@example.com" });
  await expect(row).toContainText(`${link.slice(0, 79)}…`);
  await expect(row).not.toContainText(link);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("the views, the list and the open conversation side by side, each scrolling on its own; on a phone one at a time", async ({ browser }, testInfo) => {
  // Some thirty conversations and messages made first, then the whole layout at two widths: near 30 seconds on a busy runner.
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  // A long conversation (#1), then enough others for the list to scroll.
  await api("/conversations", { user: { id: "user-42", name: "Sam Smith", email: "e2e-sam@example.com" }, subject: "Can't export to CSV", body: "Message 1" });
  for (let i = 2; i <= 15; i++) {
    await api("/conversations/1/messages", { body: `Message ${i}\n\nwith a few lines\nto make it tall`, author: { id: "user-42" } });
  }
  for (let i = 2; i <= 20; i++) {
    await api("/conversations", { email: `e2e-asker-${i}@example.com`, body: `Question number ${i}` });
  }
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/inbox`);
  const views = owner.getByRole("navigation", { name: "Views" });
  const list = owner.getByRole("region", { name: "Conversations", exact: true });
  const conversation = owner.getByRole("region", { name: "Conversation", exact: true });
  await expect(conversation).toContainText("Open a conversation to reply here: click it, or press J.");

  // Opened from the list, it's beside it, the list still there, the views above the list.
  await list.getByRole("link", { name: /Can't export to CSV/ }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1$`));
  const messages = owner.getByRole("list", { name: "Messages" }).locator(":scope > li");
  await expect(messages).toHaveCount(15);
  await expect(list.getByRole("link", { name: /Can't export to CSV/ })).toHaveAttribute("aria-current", "page");
  // The view the list shows is still the current one, for screen readers too.
  await expect(views.getByRole("link", { name: "Needs reply 20" })).toHaveAttribute("aria-current", "true");
  await expect(owner.getByRole("complementary", { name: "About them" })).toBeVisible();
  const [v, l, c] = [(await views.boundingBox())!, (await list.boundingBox())!, (await conversation.boundingBox())!];
  expect(v.x).toBe(l.x);
  expect(v.y + v.height).toBeLessThanOrEqual(l.y + 1);
  expect(l.x + l.width).toBeLessThanOrEqual(c.x + 1);
  expect(c.x + c.width).toBeLessThanOrEqual(1440);
  // The messages beside who they're from, with room to read.
  expect((await owner.getByRole("list", { name: "Messages" }).boundingBox())!.width).toBeGreaterThan(600);
  // The list and the conversation the rest of the window's height, under the header (and the banner asking to verify
  // the email); the page itself doesn't scroll.
  expect(v.y).toBeGreaterThanOrEqual(48);
  expect(c.y).toBe(v.y);
  for (const pane of [l, c]) {
    expect(pane.y + pane.height).toBe(900);
  }
  // Between the views and the list, the note that Messages in the widget is off.
  const note = (await owner.getByRole("note").boundingBox())!;
  expect(note.y).toBeGreaterThanOrEqual(v.y + v.height - 1);
  expect(note.y + note.height).toBeLessThanOrEqual(l.y);
  expect(await owner.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
  await checkpoint(owner, "inbox-panes", { fullPage: false });
  // A reply started here is still here after another conversation opens beside the list.
  await owner.getByRole("textbox", { name: "Reply" }).fill("Half a reply, kept as another conversation opens.");

  // Each pane scrolls on its own: the conversation opens at its newest message, and scrolling the list leaves it there.
  const scrollTop = (pane: typeof list) => pane.evaluate((element) => element.scrollTop);
  // What scrolls in the conversation's pane: the messages and what's beside them, under its meta line.
  const thread = conversation.locator("#conversation");
  await expect(messages.last()).toBeInViewport();
  const at = await scrollTop(thread);
  expect(at).toBeGreaterThan(0);
  await list.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect.poll(() => scrollTop(list)).toBeGreaterThan(0);
  expect(await scrollTop(thread)).toBe(at);
  await expect(messages.last()).toBeInViewport();
  // Held beside the messages, what's about the conversation starts in the pane, not cut off above it.
  expect((await owner.getByRole("region", { name: "Linked posts" }).boundingBox())!.y).toBeGreaterThanOrEqual((await thread.boundingBox())!.y);
  // A conversation at the bottom of the list (the newest) opens beside it, the list where it was.
  const listAt = await scrollTop(list);
  await list.getByRole("link", { name: /Question number 20 / }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/20$`));
  await expect(list.getByRole("link", { name: /Question number 20 / })).toHaveAttribute("aria-current", "page");
  expect(await scrollTop(list)).toBe(listAt);
  await expect(list.getByRole("link", { name: /Question number 20 / })).toBeInViewport();
  // Focus is back on its row, for the keyboard and screen readers, not at the top of the page.
  await expect(list.getByRole("link", { name: /Question number 20 / })).toBeFocused();

  // Closed, a conversation leaves Needs reply: J goes on from where it stood in the list, not from its top.
  await list.getByRole("link", { name: /Question number 5 / }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/5$`));
  await owner.getByRole("button", { name: "Close", exact: true }).click();
  await expect(list.getByRole("link", { name: /Question number 5 / })).toHaveCount(0);
  await owner.keyboard.press("j");
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/6$`));

  // Back on the first, the reply started there is as it was left.
  await list.getByRole("link", { name: /Can't export to CSV/ }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1$`));
  await expect(owner.getByRole("textbox", { name: "Reply" })).toHaveValue("Half a reply, kept as another conversation opens.");

  // Narrowed past laptop width, the page scrolls instead of the pane: it's at the newest message too.
  await owner.setViewportSize({ width: 900, height: 900 });
  await expect(messages.last()).toBeInViewport();

  // On a phone, one at a time: the conversation, its way back to the list, then the list.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/inbox/1`);
  await expect(messages).toHaveCount(15);
  await expect(list).toBeHidden();
  await expect(views).toBeHidden();
  await checkpoint(owner, "inbox-phone-conversation", { fullPage: false });
  await owner.getByRole("link", { name: "Inbox", exact: true }).first().click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox$`));
  await expect(list).toBeVisible();
  await expect(conversation).toBeHidden();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "inbox-phone-list", { fullPage: false });
});

test("the Inbox's views are one row of tabs above the list, where they stay as a conversation opens: too narrow, it scrolls sideways to the current one", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const views = owner.getByRole("navigation", { name: "Views" });
  // Above the list at 1440px, at laptop width (its third of the window at 1280px), then on a phone.
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
  ]) {
    await owner.setViewportSize({ width, height });
    await owner.goto(`/app/${slug}/inbox`);
    await expectOneRowOfTabs(owner, views);
    await checkpoint(owner, `inbox-${width}`, { fullPage: false });
  }
  // The last view, past the window's edge: opened, the row is scrolled to it.
  await owner.goto(`/app/${slug}/inbox?view=spam`);
  await expect(views.getByRole("link", { name: "Spam 0" })).toHaveAttribute("aria-current", "page");
  await expectOneRowOfTabs(owner, views);
  await checkpoint(owner, "inbox-390-last-view", { fullPage: false });

  // Opening a conversation and closing it again moves neither the views nor their first tab, sideways or up and down.
  const api = await apiFor(owner, slug);
  await api("/conversations", { email: "e2e-asker@example.com", body: "Do you have a discount for nonprofits?" });
  const list = owner.getByRole("region", { name: "Conversations", exact: true });
  const boxes = async () => [(await views.boundingBox())!, (await views.getByRole("link").first().boundingBox())!];
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ]) {
    await owner.setViewportSize({ width, height });
    await owner.goto(`/app/${slug}/inbox`);
    await expectOneRowOfTabs(owner, views);
    const before = await boxes();
    await list.getByRole("link", { name: /discount for nonprofits/ }).click();
    await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1$`));
    await expect(views.getByRole("link", { name: "Needs reply 1" })).toHaveAttribute("aria-current", "true");
    expect(await boxes()).toEqual(before);
    if (width === 1440) await checkpoint(owner, "inbox-1440-conversation-open", { fullPage: false });
    await owner.goBack();
    await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox$`));
    await expect(views.getByRole("link", { name: "Needs reply 1" })).toHaveAttribute("aria-current", "page");
    expect(await boxes()).toEqual(before);
  }
});

test("until a conversation opens, the pane beside the list has the Inbox's numbers; on a phone the list is alone", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const pane = owner.getByRole("region", { name: "Conversation", exact: true });
  const list = owner.getByRole("region", { name: "Conversations", exact: true });
  const tile = (label: string) => pane.getByText(label, { exact: true }).locator("..");
  const shots = async (name: string) => {
    for (const [width, height] of [
      [1280, 800],
      [1440, 900],
    ]) {
      await owner.setViewportSize({ width, height });
      for (const colorScheme of ["light", "dark"] as const) {
        await owner.emulateMedia({ colorScheme });
        await checkpoint(owner, `${name}-${width}-${colorScheme}`, { fullPage: false });
      }
    }
    await owner.emulateMedia({ colorScheme: "light" });
    await owner.setViewportSize({ width: 1280, height: 800 });
  };

  // An empty Inbox: its numbers at zero and that new ones show up here, beside the list (not said twice).
  await owner.setViewportSize({ width: 1280, height: 800 });
  await owner.goto(`/app/${slug}/inbox`);
  await expect(tile("Waiting for a reply")).toHaveText(/^0\s*Waiting for a reply\s*Nobody's waiting$/);
  await expect(tile("Usual first reply")).toContainText("Not enough yet");
  await expect(tile("New conversations this week")).toHaveText(/^0\s*New conversations this week$/);
  await expect(pane.getByText("New conversations show up here as they come in.")).toBeVisible();
  await expect(list.getByText("New conversations show up here as they come in.")).toBeHidden();
  await shots("inbox-stats-empty");

  // Three come in: one is closed (still new this week), one is spam (in neither number).
  const api = await apiFor(owner, slug);
  await api("/conversations", { email: "e2e-asker@example.com", body: "Do you have a discount for nonprofits?" });
  await api("/conversations", { email: "e2e-closed@example.com", body: "Never mind, found it" });
  await api("/conversations", { email: "e2e-spam@example.com", body: "Buy cheap followers" });
  await api("/conversations/2", { status: "closed" }, "PATCH");
  await api("/conversations/3", { spam: true }, "PATCH");
  await owner.goto(`/app/${slug}/inbox`);
  await expect(tile("Waiting for a reply")).toHaveText(/^1\s*Waiting for a reply\s*Longest \d+ minutes?$/);
  await expect(tile("New conversations this week")).toHaveText(/^2\s*New conversations this week$/);
  await expect(pane).toContainText("Open a conversation to reply here: click it, or press J.");
  // Waiting is the Needs reply view's: it opens it, from another view.
  await owner.goto(`/app/${slug}/inbox?view=closed`);
  await expect(tile("Waiting for a reply")).toHaveAttribute("href", `/app/${slug}/inbox`);
  await owner.goto(`/app/${slug}/inbox`);
  await shots("inbox-stats");

  // Opening a conversation puts it in their place.
  await list.getByRole("link", { name: /discount for nonprofits/ }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/1$`));
  await expect(pane.getByText("Waiting for a reply", { exact: true })).toHaveCount(0);

  // On a phone, the list alone: no numbers.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/inbox`);
  await expect(list.getByRole("link", { name: /discount for nonprofits/ })).toBeVisible();
  await expect(pane).toBeHidden();
});

test("an Inbox row reads in four lines at most: who on one, cut short, and the message in two", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const name = "Maximilian Alexander Featherstonehaugh-Worthington";
  await api("/conversations", {
    user: { id: "user-1", name, email: "e2e-max@example.com" },
    subject: "Exports stopped working",
    body: "Since the update last week none of our scheduled exports have arrived, and the reports page shows an error for every one of them. We rely on these for our month end close, so we need them working again before Friday.",
  });
  await api("/users", { users: [{ id: "user-1", properties: { company: "Vandelay Industries International Holdings" } }] });
  const row = owner.getByRole("main").getByRole("listitem");
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await owner.setViewportSize({ width, height });
    await owner.goto(`/app/${slug}/inbox`);
    // Who on one line (in full on hover), however long.
    const who = row.getByRole("link");
    await expect(who.locator("[title]")).toHaveAttribute("title", `${name} · Vandelay Industries International Holdings`);
    expect((await who.boundingBox())!.height).toBeLessThan(30);
    // The subject and the first line: two lines of small text at most.
    expect((await row.getByText("Exports stopped working").locator("..").boundingBox())!.height).toBeLessThanOrEqual(2 * 16 + 1);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

/** A project whose inbox has Sam's conversation (#1) and another (#2), its owner on it at 1440px, and its API. */
async function twoConversations(browser: Browser) {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/conversations", { user: { id: "user-42", name: "Sam Smith", email: "e2e-sam@example.com" }, subject: "Can I export?", body: "Can I export my reports?" });
  await api("/conversations", { email: "e2e-asker@example.com", body: "Another question" });
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/inbox/1`);
  const list = owner.getByRole("region", { name: "Conversations", exact: true });
  return {
    slug,
    owner,
    api,
    list,
    sam: list.getByRole("link", { name: /Can I export\?/ }),
    other: list.getByRole("link", { name: /Another question/ }),
    reply: owner.getByRole("textbox", { name: "Reply" }),
    messages: owner.getByRole("list", { name: "Messages" }).locator(":scope > li"),
  };
}

test("a reply kept while another conversation was open holds what the team had seen: Sam writing meanwhile keeps it open", async ({ browser }) => {
  const { owner, api, sam, other, reply, messages } = await twoConversations(browser);
  await reply.fill("Reports, then Export.");
  await other.click();
  await expect(owner).toHaveURL(/\/inbox\/2$/);
  // Sam writes again while the team is on the other one.
  await api("/conversations/1/messages", { body: "Also, as a PDF?", author: { id: "user-42" } });
  await sam.click();
  await expect(owner).toHaveURL(/\/inbox\/1$/);
  await expect(messages).toHaveCount(2);
  await expect(reply).toHaveValue("Reports, then Export.");
  await owner.getByRole("button", { name: "Send and close" }).click();
  await expect(owner.getByText("Sent, and kept open: they wrote again since")).toBeVisible();
  await expect(meta(owner)).toContainText("Open · #");
});

test("a reply sent as another conversation opens isn't kept as unsent", async ({ browser }) => {
  const { owner, sam, other, reply, messages } = await twoConversations(browser);
  await reply.fill("On its way.");
  // The reply is held on its way until the test lets it go: the team moves on while it's still sending.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await owner.route("**/*", async (route) => {
    if (route.request().headers()["next-action"]) {
      await held;
    }
    await route.fallback();
  });
  const sent = owner.waitForResponse((response) => response.request().headers()["next-action"] !== undefined);
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("button", { name: "Sending…" })).toBeVisible();
  await other.click();
  // Still sending: the other conversation opens only once the reply has gone (the router waits for it).
  await expect(owner.getByRole("button", { name: "Sending…" })).toBeVisible();
  release();
  await sent;
  await expect(owner).toHaveURL(/\/inbox\/2$/);
  await owner.unroute("**/*");
  // Back on it (answered, it waits on Sam now), the reply is in the conversation and the box is empty: Send again
  // wouldn't send it twice.
  await owner.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Waiting on user 1" }).click();
  await sam.click();
  await expect(owner).toHaveURL(/\/inbox\/1\?view=waiting$/);
  await expect(messages.last()).toContainText("On its way.");
  await expect(reply).toHaveValue("");
});

test("a reply kept in the tab is its writer's: a teammate signing in after them there doesn't get it", async ({ browser }) => {
  const { slug, owner, list, reply } = await twoConversations(browser);
  await reply.fill("Olive's half-written reply.");
  // A teammate, who signs in on the same tab once Olive signs out (the page never reloads).
  const tara = await signUp(browser, APP_URL, "Tara Teammate");
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO team_member (id, "projectId", "userId") SELECT gen_random_uuid()::text, p.id, u.id FROM project p, "user" u WHERE p.slug = $1 AND u.email = $2`,
    [slug, tara.email],
  );
  await db.end();
  await owner.evaluate(() => Object.assign(window, { sameTab: true }));
  await owner.getByRole("button", { name: /Olive Owner/ }).click();
  await owner.getByRole("menuitem", { name: "Sign out" }).press("Enter");
  await owner.waitForURL(`${APP_URL}/`);
  await owner.getByRole("link", { name: "Sign in" }).first().click();
  await owner.getByLabel("Email").fill(tara.email);
  await owner.getByLabel("Password").fill("correct horse battery staple");
  await owner.getByRole("button", { name: "Sign in" }).click();
  await owner.waitForURL(`**/app/${slug}`);
  await owner.getByRole("link", { name: "Inbox", exact: true }).click();
  await list.getByRole("link", { name: /Can I export\?/ }).click();
  await expect(owner).toHaveURL(/\/inbox\/1$/);
  expect(await owner.evaluate(() => "sameTab" in window)).toBe(true);
  await expect(reply).toHaveValue("");
});

test("a conversation opened beside the list is at its newest message when it's first shown, never at its top", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const { owner, api, sam, other, messages } = await twoConversations(browser);
  for (let i = 2; i <= 15; i++) {
    await api("/conversations/1/messages", { body: `Message ${i}\n\nwith a few lines\nto make it tall`, author: { id: "user-42" } });
  }
  await other.click();
  await expect(owner).toHaveURL(/\/inbox\/2$/);
  // Where Sam's conversation is scrolled to as it goes into the page: right after React puts it there, before the
  // browser can paint it.
  await owner.evaluate(() => {
    const old = document.getElementById("conversation");
    new MutationObserver(() => {
      const pane = document.getElementById("conversation");
      if (pane && pane !== old && !("shownAt" in window)) {
        // How far its end is below what shows: nothing, at its newest message.
        Object.assign(window, { shownAt: pane.scrollHeight - pane.scrollTop - pane.clientHeight });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await sam.click();
  await expect(owner).toHaveURL(/\/inbox\/1$/);
  expect(await owner.evaluate(() => (window as unknown as { shownAt?: number }).shownAt)).toBeLessThanOrEqual(1);
  await expect(messages.last()).toBeInViewport();
  await checkpoint(owner, "inbox-conversation-opened-beside-list", { fullPage: false });
});

test("Needs reply lists who's waited longest first, one woken from a snooze (waiting since its latest message) among them", async ({ browser }) => {
  const { slug, owner, list } = await twoConversations(browser);
  // The newer one was waiting on its user, snoozed, and woke: open, waiting since its latest message, an hour ago.
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `UPDATE conversation SET "waitingSince" = NULL, "lastMessageAt" = now() - interval '1 hour' WHERE number = 2 AND "projectId" = (SELECT id FROM project WHERE slug = $1)`,
    [slug],
  );
  await db.end();
  await owner.goto(`/app/${slug}/inbox`);
  await expect(list.getByRole("link")).toHaveText([/e2e-asker/, /Sam Smith/]);
});

test("J goes on down the list after a reply, though the one answered moves to its top", async ({ browser }) => {
  const { slug, owner, api, list, reply } = await twoConversations(browser);
  await api("/conversations", { email: "e2e-third@example.com", body: "A third question" });
  // All three Olive's: answered, they stay in Mine (waiting on the user), at its top.
  for (const number of [1, 2, 3]) {
    await api(`/conversations/${number}`, { assignee: owner.email }, "PATCH");
  }
  await owner.goto(`/app/${slug}/inbox?view=mine`);
  const rows = list.getByRole("link");
  await expect(rows).toHaveText([/e2e-third/, /e2e-asker/, /Sam Smith/]);
  const answer = async (text: string) => {
    await reply.fill(text);
    await owner.getByRole("button", { name: "Send", exact: true }).click();
    await expect(reply).toHaveValue("");
    await expect(meta(owner)).toContainText("Waiting on user · #");
  };
  await rows.first().click();
  await expect(owner).toHaveURL(/\/inbox\/3\?view=mine$/);
  await answer("Thanks, on it.");
  await owner.keyboard.press("j");
  await expect(owner).toHaveURL(/\/inbox\/2\?view=mine$/);
  await answer("Yes, there is.");
  // Answered, #2 is at the top now, above #3: J opens #1, the next one down as the list was.
  await expect(rows).toHaveText([/e2e-asker/, /e2e-third/, /Sam Smith/]);
  await owner.keyboard.press("j");
  await expect(owner).toHaveURL(/\/inbox\/1\?view=mine$/);
});

test("a reply kept while another conversation was open keeps its files", async ({ browser }) => {
  const { owner, sam, other, reply, messages } = await twoConversations(browser);
  await reply.fill("Here's the invoice, attached.");
  await owner.locator('input[type="file"]').setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 the invoice") });
  const files = owner.getByRole("list", { name: "Files to send" });
  await expect(files).toContainText(/invoice\.pdf\s*1 KB/);
  await other.click();
  await expect(owner).toHaveURL(/\/inbox\/2$/);
  await sam.click();
  await expect(owner).toHaveURL(/\/inbox\/1$/);
  await expect(reply).toHaveValue("Here's the invoice, attached.");
  await expect(files).toContainText(/invoice\.pdf\s*1 KB/);
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(messages.last().getByRole("link", { name: "invoice.pdf" })).toBeVisible();
  await expect(files).toHaveCount(0);
});

test("a kept draft's file attached too long ago to send isn't kept: the reply box says so", async ({ browser }) => {
  const { owner, sam, other, reply } = await twoConversations(browser);
  // The page's clock, to move it on a day.
  await owner.clock.install();
  await owner.reload();
  await reply.fill("Here's the invoice, attached.");
  await owner.locator('input[type="file"]').setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 the invoice") });
  const files = owner.getByRole("list", { name: "Files to send" });
  await expect(files).toContainText(/invoice\.pdf\s*1 KB/);
  await other.click();
  await expect(owner).toHaveURL(/\/inbox\/2$/);
  // Most of a day later (an unsent file is deleted a day after its upload): the text is kept, the file isn't.
  await owner.clock.fastForward("23:30:00");
  await sam.click();
  await expect(owner).toHaveURL(/\/inbox\/1$/);
  await expect(reply).toHaveValue("Here's the invoice, attached.");
  await expect(files).toHaveCount(0);
  await expect(owner.getByText("invoice.pdf attached too long ago to send: attach it again.")).toBeVisible();
});

test("a kept draft's file that hadn't finished uploading isn't kept: the reply box says so", async ({ browser }) => {
  const { owner, sam, other, reply } = await twoConversations(browser);
  // The file's upload to the media storage is held till the test lets it go.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await owner.route("**/*", async (route) => {
    if (route.request().method() === "PUT") {
      await held;
    }
    await route.fallback();
  });
  await reply.fill("Here's the invoice, attached.");
  await owner.locator('input[type="file"]').setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 the invoice") });
  const files = owner.getByRole("list", { name: "Files to send" });
  await expect(files).toContainText(/invoice\.pdf\s*Uploading…/);
  await other.click();
  await expect(owner).toHaveURL(/\/inbox\/2$/);
  release();
  await owner.unroute("**/*");
  await sam.click();
  await expect(owner).toHaveURL(/\/inbox\/1$/);
  await expect(reply).toHaveValue("Here's the invoice, attached.");
  await expect(files).toHaveCount(0);
  await expect(owner.getByText("invoice.pdf didn't finish uploading: attach it again.")).toBeVisible();
});

test("only a conversation the list opens gets its row focused: not after a click on the row already open; one opened from who they are stays in the view", async ({ browser }) => {
  const { owner, api, list, sam } = await twoConversations(browser);
  await api("/conversations", { user: { id: "user-42" }, subject: "And invoices?", body: "Where are my invoices?" });
  // And one Olive has taken: it needs a reply, but isn't in Unassigned.
  await api("/conversations", { user: { id: "user-42" }, subject: "And refunds?", body: "Can I get a refund?" });
  await api("/conversations/4", { assignee: owner.email }, "PATCH");
  // In a view of its own: Unassigned.
  await owner.goto(owner.url().replace(/\/inbox\/1$/, "/inbox/1?view=unassigned"));
  // The open row again: nothing opens.
  await sam.click();
  await expect(owner).toHaveURL(/\/inbox\/1\?view=unassigned$/);
  // Sam's other conversation, opened from who they are, not from the list: beside the same view.
  await owner.getByRole("complementary", { name: "About them" }).getByRole("link", { name: /And invoices\?/ }).click();
  await expect(owner).toHaveURL(/\/inbox\/3\?view=unassigned$/);
  await expect(owner.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Unassigned 3" })).toHaveAttribute("aria-current", "true");
  await expect(list.getByRole("link", { name: /And invoices\?/ })).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("link", { name: /And invoices\?/ })).not.toBeFocused();
  // One that isn't in Unassigned opens in the first view, where it has its row.
  await owner.getByRole("complementary", { name: "About them" }).getByRole("link", { name: /And refunds\?/ }).click();
  await expect(owner).toHaveURL(/\/inbox\/4$/);
  await expect(list.getByRole("link", { name: /And refunds\?/ })).toHaveAttribute("aria-current", "page");
});

test("a reply started before the user wrote again doesn't close it: what the team saw is held from the first file attached", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/conversations", { user: { id: "user-42", name: "Sam Smith", email: "e2e-sam@example.com" }, body: "Can I export my reports?" });
  await owner.goto(`/app/${slug}/inbox/1`);
  const messages = owner.getByRole("list", { name: "Messages" }).locator(":scope > li");
  await expect(messages).toHaveCount(1);

  // The reply starts with a file; Sam writes again meanwhile, and the page shows it as it comes.
  await owner.locator('input[type="file"]').setInputFiles({ name: "steps.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 the steps") });
  await expect(owner.getByRole("list", { name: "Files to send" })).toContainText(/steps\.pdf\s*1 KB/);
  await api("/conversations/1/messages", { body: "Also, can it be a PDF?", author: { id: "user-42" } });
  await expect(messages).toHaveCount(2);
  await owner.getByRole("textbox", { name: "Reply" }).fill("Reports, then Export: these are the steps.");
  await owner.getByRole("button", { name: "Send and close" }).click();
  await expect(owner.getByText("Sent, and kept open: they wrote again since")).toBeVisible();
  await expect(meta(owner)).toContainText("Open · #");
  await checkpoint(owner, "inbox-kept-open");
  // The reply answered the follow-up too: the team spoke last, so they set it waiting on Sam themselves.
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("button", { name: "Mark as waiting on user" }).click();
  await expect(owner.getByText("Marked as waiting on user")).toBeVisible();
  await expect(meta(owner)).toContainText("Waiting on user · #");
  // Picked from More actions, which closes: the keyboard's focus is back on its button.
  await expect(owner.getByRole("button", { name: "More actions" })).toBeFocused();
  // And back to open, when it needs a reply after all; then waiting again.
  await owner.keyboard.press("Enter");
  await owner.getByRole("button", { name: "Mark as open" }).click();
  await expect(meta(owner)).toContainText("Open · #");
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("button", { name: "Mark as waiting on user" }).click();
  await expect(meta(owner)).toContainText("Waiting on user · #");

  // A file that couldn't upload, left in the list, isn't a reply started: Sam writing again is seen, and the next reply closes.
  await owner.route("**/*", (route) => (route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await owner.locator('input[type="file"]').setInputFiles({ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
  await expect(owner.getByRole("list", { name: "Files to send" })).toContainText(/broken\.pdf\s*Couldn't upload it/);
  await owner.unroute("**/*");
  await api("/conversations/1/messages", { body: "Thanks, and the PDF?", author: { id: "user-42" } });
  await expect(messages).toHaveCount(4);
  await owner.getByRole("textbox", { name: "Reply" }).fill("Yes: pick PDF in the export menu.");
  await owner.getByRole("button", { name: "Send and close" }).click();
  await expect(meta(owner)).toContainText("Closed · #");
});

test("the reply box stays at the bottom of the screen, and a long conversation opens at its newest message", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/conversations", { email: "e2e-short@example.com", body: "Just one line" });
  await api("/conversations", { email: "e2e-long@example.com", body: "Message 1" });
  for (let i = 2; i <= 20; i++) {
    await api("/conversations/2/messages", { body: `Message ${i}\n\nwith a few lines\nto make it tall` });
  }
  // Someone the team's app knows a lot about: the panel beside the conversation is taller than the screen.
  const properties = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`property${i}`, `value ${i}`]));
  await api("/users", { users: [{ id: "user-7", properties }] });
  await api("/conversations", { user: { id: "user-7", name: "Pat Props", email: "e2e-pat@example.com" }, body: "A short question" });
  await owner.setViewportSize({ width: 1280, height: 720 });
  const reply = owner.getByRole("textbox", { name: "Reply" });
  const send = owner.getByRole("button", { name: "Send", exact: true });

  // One message: the reply box is at the bottom of the screen all the same, not under the message.
  await owner.goto(`/app/${slug}/inbox/1`);
  await expect(reply).toBeVisible();
  expect((await send.boundingBox())!.y).toBeGreaterThan(720 - 100);

  // Many: it opens at the newest, with the reply box under it.
  await owner.goto(`/app/${slug}/inbox/2`);
  const messages = owner.getByRole("list", { name: "Messages" }).locator(":scope > li");
  await expect(messages.last()).toBeInViewport();
  await expect(messages.first()).not.toBeInViewport();
  await expect(reply).toBeInViewport();
  // What's beside it stays in view too: the linked posts and who it's with.
  await expect(owner.getByRole("region", { name: "Linked posts" })).toBeInViewport();
  await expect(owner.getByRole("complementary", { name: "About them" })).toBeInViewport();
  await checkpoint(owner, "conversation-newest", { fullPage: false });
  // Scrolled back to the first message, the reply box is where it was.
  const y = (await send.boundingBox())!.y;
  await messages.first().scrollIntoViewIfNeeded();
  await expect(messages.first()).toBeInViewport();
  await expect(reply).toBeInViewport();
  expect((await send.boundingBox())!.y).toBe(y);
  await checkpoint(owner, "conversation-scrolled-up", { fullPage: false });

  // A tall image in the newest reply loads after the page has scrolled to it: the page follows it.
  await owner.locator('input[type="file"]').setInputFiles({ name: "tall.png", mimeType: "image/png", buffer: png(100, 600) });
  await expect(owner.getByRole("list", { name: "Files to send" })).toContainText("tall.png");
  await reply.fill("Here's where it is.");
  await send.click();
  await expect(messages).toHaveCount(21);
  // As in Safari, which keeps no place in the page (or the pane) as things above it grow (Chrome's scroll anchoring does).
  await owner.addInitScript(() =>
    document.addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: "* { overflow-anchor: none }" }))),
  );
  // And without the browser putting the reloaded page back where it was before (Chrome does, once its images
  // are in): when that lands against the page's own scroll varies run to run, which made this step flaky.
  await owner.addInitScript(() => {
    history.scrollRestoration = "manual";
  });
  await owner.route("**/*", async (route) => {
    if (route.request().resourceType() === "image") {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await route.fallback();
  });
  // Not waiting for the page's load event, which waits for its images.
  await owner.reload({ waitUntil: "domcontentloaded" });
  await expect(owner.getByRole("img", { name: "tall.png" })).toHaveJSProperty("complete", true);
  // Above the reply box, not under it.
  await expect(async () => {
    const newest = (await messages.last().boundingBox())!;
    expect(newest.y + newest.height).toBeLessThanOrEqual((await owner.getByRole("tab", { name: "Reply" }).boundingBox())!.y);
  }).toPass({ timeout: 5_000 });
  await owner.unroute("**/*");

  // The tall panel scrolls on its own: the conversation opens at its message, not past it.
  await owner.goto(`/app/${slug}/inbox/3`);
  await expect(owner.getByRole("complementary", { name: "About them" })).toContainText("Property49");
  await expect(messages.first()).toBeInViewport();
  await expect(reply).toBeInViewport();
});

test("with an address for the project, an email to it lands in the inbox without the part it quotes", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  const address = `support@${slug}.${SUPPORT_EMAIL_DOMAIN}`;
  await expect(owner.getByText(address)).toBeVisible();
  await expect(owner.getByText("No email received yet.")).toBeVisible();
  await checkpoint(owner, "support-email-settings");

  // A customer writes to the team's own support address, which forwards it here.
  await receive(address, rawEmail("Kim Lee <e2e-kim@example.com>", "Invoice missing", "I can't find my October invoice.\r\n\r\nOn Mon, someone wrote:\r\n> earlier"));
  // Kim's address, verified by the email, is a user's the team's app synced: the row says their company. Its link is
  // named for who (the name their email came from), what and which, for screen readers.
  await (await apiFor(owner, slug))("/users", { users: [{ id: "kim-1", name: "Kim Lee", email: "e2e-kim@example.com", properties: { company: "Hooli" } }] });
  await owner.goto(`/app/${slug}/inbox`);
  const kimLink = owner.getByRole("link", { name: "Kim Lee, Hooli: Invoice missing (#1)" });
  await expect(kimLink).toHaveText("Kim Lee · Hooli");
  await checkpoint(owner, "inbox-row-email-name");
  await kimLink.click();
  await expect(owner.getByText(/Kim Lee \(e2e-kim@example\.com\) · started from email/)).toBeVisible();
  const messages = owner.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(messages).toHaveText([/I can't find my October invoice\.\s*Show the whole email/]);
  await owner.getByText("Show the whole email").click();
  await expect(messages.first()).toContainText("> earlier");

  // Another email with a screenshot and a PDF: the image shows, the PDF downloads under its name.
  await receive(address, emailWithAttachments("Kim Lee <e2e-kim@example.com>", "Screenshot of the billing page"));
  await owner.goto(`/app/${slug}/inbox`);
  // A row opens by its link (who it's with), found by its subject.
  await owner.getByRole("main").getByRole("listitem").filter({ hasText: "Screenshot of the billing page" }).getByRole("link").click();
  await expect(owner.getByRole("img", { name: "screenshot.png" })).toBeVisible();
  const pdf = owner.getByRole("list", { name: "Attachments" }).getByRole("link", { name: "Invoice Oct.pdf" });
  await expect(pdf).toBeVisible();
  expect(new URL((await pdf.getAttribute("href"))!).searchParams.get("response-content-disposition")).toBe("attachment; filename*=UTF-8''Invoice%20Oct.pdf");
  const download = await owner.request.get((await pdf.getAttribute("href"))!);
  expect(await download.text()).toBe("%PDF-1.4 the invoice");
  await checkpoint(owner, "email-attachments");

  await owner.goto(`/app/${slug}/settings/support`);
  await expect(owner.getByText(/^Last email received/)).toBeVisible();
});

/** A raw email as a mail provider delivers it. */
/** A small PNG (160×90, a gradient), so the screenshot shows a real image. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAJvUlEQVR42u3RWRKCgGEA0BysKiIgggoqoCguyHWa7m3SvU3SJl2SNlvbc3Ci/jnvDA4z7wbvB3/wh+PHDHMsEGCJECtEiJFgjRQbZMixxQ57FChxwBEnVKjR4IwLWlxxQ4c7HnjihR5vDPjBFPztwT8cP2aYY4EAS4RYIUKMBGuk2CBDji122KNAiQOOOKFCjQZnXNDiihs63PHAEy/0eGPAFPz1wX80fswwxwIBlgixQoQYCdZIsUGGHFvssEeBEgcccUKFGg3OuKDFFTd0uOOBJ17o8caAKfjrg/94/JhhjgUCLBFihQgxEqyRYoMMObbYYY8CJQ444oQKNRqccUGLK27ocMcDT7zQ440BU/DXB//J+DHDHAsEWCLEChFiJFgjxQYZcmyxwx4FShxwxAkVajQ444IWV9zQ4Y4HnnihxxsDpuCvD/7T8WOGORYIsESIFSLESLBGig0y5Nhihz0KlDjgiBMq1GhwxgUtrrihwx0PPPFCjzcGTMFfH/xn48cMcywQYIkQK0SIkWCNFBtkyLHFDnsUKHHAESdUqNHgjAtaXHFDhzseeOKFHm8MmIK/PvjPx48Z5lggwBIhVogQI8EaKTbIkGOLHfYoUOKAI06oUKPBGRe0uOKGDnc88MQLPd4YMAV/ffBfjB8zzLFAgCVCrBAhRoI1UmyQIccWO+xRoMQBR5xQoUaDMy5occUNHe544IkXerwxYAr++uC/HD9mmGOBAEuEWCFCjARrpNggQ44tdtijQIkDjjihQo0GZ1zQ4oobOtzxwBMv9HhjwBT89cF/NX7MMMcCAZYIsUKEGAnWSLFBhhxb7LBHgRIHHHFChRoNzrigxRU3dLjjgSde6PHGgCn464N/NH7MMMcCAZYIsUKEGAnWSLFBhhxb7LBHgRIHHHFChRoNzrigxRU3dLjjgSde6PHGgCn464N/PH7MMMcCAZYIsUKEGAnWSLFBhhxb7LBHgRIHHHFChRoNzrigxRU3dLjjgSde6PHGgCn464P/evyYYY4FAiwRYoUIMRKskWKDDDm22GGPAiUOOOKECjUanHFBiytu6HDHA0+80OONAVPw1wf/zfgxwxwLBFgixAoRYiRYI8UGGXJsscMeBUoccMQJFWo0OOOCFlfc0OGOB554occbA6bgrw/+2/FjhjkWCLBEiBUixEiwRooNMuTYYoc9CpQ44IgTKtRocMYFLa64ocMdDzzxQo83BkzBXx/8d+PHDHMsEGCJECtEiJFgjRQbZMixxQ57FChxwBEnVKjR4IwLWlxxQ4c7HnjihR5vDJiCvz7478ePGeZYIMASIVaIECPBGik2yJBjix32KFDigCNOqFCjwRkXtLjihg53PPDECz3eGDAFf33wP4wfM8yxQIAlQqwQIUaCNVJskCHHFjvsUaDEAUecUKFGgzMuaHHFDR3ueOCJF3q8MWAK/vrgfxw/ZphjgQBLhFghQowEa6TYIEOOLXbYo0CJA444oUKNBmdc0OKKGzrc8cATL/R4Y8AU/PXB/zR+zDDHAgGWCLFChBgJ1kixQYYcW+ywR4ESBxxxQoUaDc64oMUVN3S444EnXujxxoAp+OuD/3n8mGGOBQIsEWKFCDESrJFigww5tthhjwIlDjjihAo1GpxxQYsrbuhwxwNPvNDjjQFT8NcH/2T8mGGOBQIsEWKFCDESrJFigww5tthhjwIlDjjihAo1GpxxQYsrbuhwxwNPvNDjjQFT8NcH/3T8mGGOBQIsEWKFCDESrJFigww5tthhjwIlDjjihAo1GpxxQYsrbuhwxwNPvNDjjQFT8NcH/2z8mGGOBQIsEWKFCDESrJFigww5tthhjwIlDjjihAo1GpxxQYsrbuhwxwNPvNDjjQFT8NcH/8v4McMcCwRYIsQKEWIkWCPFBhlybLHDHgVKHHDECRVqNDjjghZX3NDhjgeeeKHHGwOm4K8P/tfxY4Y5FgiwRIgVIsRIsEaKDTLk2GKHPQqUOOCIEyrUaHDGBS2uuKHDHQ888UKPNwZMwV8f/PPxY4Y5FgiwRIgVIsRIsEaKDTLk2GKHPQqUOOCIEyrUaHDGBS2uuKHDHQ888UKPNwZMwV8f/IvxY4Y5FgiwRIgVIsRIsEaKDTLk2GKHPQqUOOCIEyrUaHDGBS2uuKHDHQ888UKPNwZMwV8f/G/jxwxzLBBgiRArRIiRYI0UG2TIscUOexQoccARJ1So0eCMC1pccUOHOx544oUebwyYgr8++N/HjxnmWCDAEiFWiBAjwRopNsiQY4sd9ihQ4oAjTqhQo8EZF7S44oYOdzzwxAs93hgwBX998H+MHzPMsUCAJUKsECFGgjVSbJAhxxY77FGgxAFHnFChRoMzLmhxxQ0d7njgiRd6vDFgCv764P8cP2aYY4EAS4RYIUKMBGuk2CBDji122KNAiQOOOKFCjQZnXNDiihs63PHAEy/0eGPAFPz1wb8cP2aYY4EAS4RYIUKMBGuk2CBDji122KNAiQOOOKFCjQZnXNDiihs63PHAEy/0eGPAFPz1wb8aP2aYY4EAS4RYIUKMBGuk2CBDji122KNAiQOOOKFCjQZnXNDiihs63PHAEy/0eGPAFPz1wf81fswwxwIBlgixQoQYCdZIsUGGHFvssEeBEgcccUKFGg3OuKDFFTd0uOOBJ17o8caAKfjrg/97/JhhjgUCLBFihQgxEqyRYoMMObbYYY8CJQ444oQKNRqccUGLK27ocMcDT7zQ440BU/DXB/96/JhhjgUCLBFihQgxEqyRYoMMObbYYY8CJQ444oQKNRqccUGLK27ocMcDT7zQ440BU/DXB/9m/JhhjgUCLBFihQgxEqyRYoMMObbYYY8CJQ444oQKNRqccUGLK27ocMcDT7zQ440BU/DXB/92/JhhjgUCLBFihQgxEqyRYoMMObbYYY8CJQ444oQKNRqccUGLK27ocMcDT7zQ440BU/DXB/9u/JhhjgUCLBFihQgxEqyRYoMMObbYYY8CJQ444oQKNRqccUGLK27ocMcDT7zQ440BU/DXB/9+/JhhjgUCLBFihQgxEqyRYoMMObbYYY8CJQ444oQKNRqccUGLK27ocMcDT7zQ440BU/DXB//P+DHDHAsEWCLEChFiJFgjxQYZcmyxwx4FShxwxAkVajQ444IWV9zQ4Y4HnnihxxsDpuCvD/7f8WOGORYIsESIFSLESLBGig0y5Nhihz0KlDjgiBMq1GhwxgUtrrihwx0PPPFCjzcGTMFfH/x/48cMcywQYIkQK0SIkWCNFBtkyLHFDnsUKHHAESdUqNHgjAtaXHFDhzseeOKFHm8MmIK/PPj/AV4JOq5KOkoPAAAAAElFTkSuQmCC";

/** An email with a screenshot and a PDF attached. */
function emailWithAttachments(from: string, subject: string) {
  return [
    `From: ${from}`,
    `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@mail.example.com>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mixed"',
    "",
    "--mixed",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Here's what I see, and the invoice I do have.",
    "--mixed",
    'Content-Type: image/png; name="screenshot.png"',
    'Content-Disposition: attachment; filename="screenshot.png"',
    "Content-Transfer-Encoding: base64",
    "",
    PIXEL,
    "--mixed",
    'Content-Type: application/pdf; name="Invoice Oct.pdf"',
    'Content-Disposition: attachment; filename="Invoice Oct.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 the invoice").toString("base64"),
    "--mixed--",
    "",
  ].join("\r\n");
}

test("on a server selling plans, a new project's email is capped in its first week, and paused when too much bounces till the operator resumes it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByText("No email received yet.")).toBeVisible();

  // In its first week, a project sends up to 200 emails a day: past that, a reply waits for tomorrow.
  await receive(`support@${slug}.${SUPPORT_EMAIL_DOMAIN}`, rawEmail("Kim Lee <e2e-kim@example.com>", "Invoice missing", "Where's my October invoice?"));
  await setTodaysEmails(slug, { claimed: 200 });
  await owner.goto(`/app/${slug}/inbox/1`);
  await owner.getByRole("textbox", { name: "Reply" }).fill("It's under Billing.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByText("Emailed tomorrow: in its first week, a project sends up to 200 emails a day")).toBeVisible();
  await checkpoint(owner, "reply-waits-for-daily-cap");

  // 2 of 100 bounced: paused, and the operator is told.
  const projectId = await setTodaysEmails(slug, { sent: 100, bounced: 1 });
  const told = countEmailsTo(APP_PORTAL_OWNER);
  await sesBounce(CLOUD_URL, projectId);
  await owner.reload();
  await expect(owner.getByText("Not emailed while your project's email is paused (Settings → Inbox and email)")).toBeVisible();
  await checkpoint(owner, "reply-waits-while-paused");
  await owner.goto(`/app/${slug}/settings/support`);
  const paused = owner.getByText("Email sending is paused because of high bounces or spam reports: 2.0% of emails bounced in the last 2 weeks (2 of 100).");
  await expect(paused).toBeVisible();
  await expect(owner.getByText("No emails go out until an admin reviews it, except sign-in links.")).toBeVisible();
  await checkpoint(owner, "support-email-paused");

  // The operator's email: its link shows why, and its button resumes it.
  const operator = await (await browser.newContext()).newPage();
  await operator.goto(linkIn(await latestEmailTo(APP_PORTAL_OWNER, { after: told, subject: /email is paused$/ }), `${CLOUD_URL}/resume-email?`));
  await expect(operator.getByText("Resume Acme's email?")).toBeVisible();
  await checkpoint(operator, "operator-resume-email");
  await operator.getByRole("button", { name: "Resume" }).click();
  await expect(operator.getByText("Acme's email is on again")).toBeVisible();

  await owner.reload();
  await expect(owner.getByText("No email received yet.").or(owner.getByText(/^Last email received/))).toBeVisible();
  await expect(paused).toHaveCount(0);
});

test("the team's own address: add it, put SES's records in DNS, check, a test email comes from it, and its forwarded emails land in the Inbox", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example.com`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  const supportAddress = `support@${slug}.${SUPPORT_EMAIL_DOMAIN}`;
  await expect(owner.getByText(supportAddress).first()).toBeVisible();

  // Its email is at Google Workspace: the guide to forwarding it there.
  await publishMx(domain, ["aspmx.l.google.com", "alt1.aspmx.l.google.com"]);
  await owner.getByLabel("Your company's address").fill(`support@${domain}`);
  await owner.getByRole("button", { name: "Use this address" }).click();
  await expect(owner.getByRole("region", { name: "Sending emails" }).getByText("Waiting for DNS")).toBeVisible();
  const receiving = owner.getByRole("region", { name: "Receiving emails" });
  await expect(receiving).toContainText(`${domain}'s email is at Google Workspace. There, forward support@${domain} to your support address`);
  await expect(receiving.getByRole("link", { name: "How to forward with Google Workspace" })).toHaveAttribute("href", "https://tuti.so/help/docs/forward-from-google-workspace");
  await expect(receiving.getByText("Waiting for an email")).toBeVisible();
  const records = owner.getByRole("table", { name: `DNS records for ${domain}` }).getByRole("row").filter({ hasText: "CNAME" });
  await expect(records).toHaveCount(3);
  for (const record of await records.all()) {
    await expect(record).toContainText(`._domainkey.${domain}`);
    await expect(record).toContainText("Pending");
  }
  await checkpoint(owner, "own-address-records");
  // Not in DNS yet.
  await owner.getByRole("button", { name: "Check DNS" }).click();
  await expect(owner.getByText(/Not found yet/)).toBeVisible();

  await verifySesDomain(domain);
  await owner.getByRole("button", { name: "Check DNS" }).click();
  await expect(owner.getByText(`support@${domain} is verified`)).toBeVisible();
  await expect(owner.getByText(`Replies to your users come from support@${domain}.`, { exact: false })).toBeVisible();
  for (const record of await records.all()) {
    await expect(record).toContainText("Verified");
  }
  await owner.getByRole("button", { name: "Send a test email" }).click();
  await expect(owner.getByText("Test email sent to you")).toBeVisible();
  const test = await latestEmailTo(owner.email, { subject: /A test from/ });
  expect(test.from).toBe(`"Acme" <support@${domain}>`);

  // Forwarded by Google: still to the team's address, and it lands in the Inbox.
  await receive(
    supportAddress,
    [`From: Kim Lee <e2e-kim@example.com>`, `To: support@${domain}`, `X-Forwarded-For: support@${domain} ${supportAddress}`, "Subject: Forwarded?", `Message-ID: <${randomUUID()}@mail.example.com>`, "", "Hello"].join("\r\n"),
  );
  await owner.reload();
  await expect(receiving.getByText("Forwarded", { exact: true })).toBeVisible();
  await expect(receiving).toContainText(`Emails to support@${domain} land in the Inbox.`);
  await checkpoint(owner, "own-address-verified");

  await owner.getByRole("button", { name: "Remove address" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(`support@${domain} removed`)).toBeVisible();
  await expect(owner.getByLabel("Your company's address")).toBeVisible();
});

test("Insert article in a reply: ⌘K in the reply box, search, ↓ and Enter put a link to the article where the cursor is, and the visitor sees it in the widget", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(owner.getByText("Messages on")).toBeVisible();

  // Without published articles, the reply box has nothing to insert.
  const api = await apiFor(owner, slug);
  const visitor = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await visitor.goto("/widget");
  await visitor.getByRole("link", { name: "Messages" }).click();
  await visitor.getByRole("textbox", { name: "Your email" }).fill(`e2e-kim-${slug}@example.com`);
  await visitor.getByRole("textbox", { name: "Message" }).fill("How do I export my reports?");
  await visitor.getByRole("button", { name: "Send" }).click();
  const widgetMessages = visitor.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(widgetMessages).toHaveCount(1);
  await owner.goto(`/app/${slug}/inbox/1`);
  await expect(owner.getByRole("textbox", { name: "Reply" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Insert article" })).toHaveCount(0);

  // Listed and unlisted articles can be sent; a hidden one can't.
  for (const [title, listing] of [
    ["Exporting reports", "everywhere"],
    ["Export limits", "unlisted"],
    ["Export internals", "hidden"],
  ]) {
    const { slug: article } = await api("/articles", { title, body: "Reports → Export.", listing });
    await api(`/articles/${article}/publish`, {});
  }
  await owner.reload();
  const reply = owner.getByRole("textbox", { name: "Reply" });
  await reply.fill("Hi Kim! See  for the steps.");
  // The cursor after "See ": where the link goes.
  await reply.evaluate((box: HTMLTextAreaElement) => box.setSelectionRange("Hi Kim! See ".length, "Hi Kim! See ".length));
  await reply.press("ControlOrMeta+k");
  const dialog = owner.getByRole("dialog", { name: "Insert article" });
  await expect(dialog).toBeVisible();
  // ⌘K in the reply box is this, not the app's search; nor is it in the picker.
  await expect(owner.getByRole("dialog", { name: "Go to or do" })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "Search articles" }).press("ControlOrMeta+k");
  await expect(owner.getByRole("dialog", { name: "Go to or do" })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Search articles" })).toBeFocused();
  await dialog.getByRole("combobox", { name: "Search articles" }).fill("export");
  const status = dialog.getByRole("status");
  const options = dialog.getByRole("option");
  await expect(options).toHaveCount(2);
  // How many it found is read out.
  await expect(status).toHaveText("2 articles");
  expect((await options.allInnerTexts()).sort()).toEqual(["Export limits", "Exporting reports"]);
  await checkpoint(owner, "inbox-insert-article");

  // ↓ chooses the second; Enter puts its link in, and the cursor is at its end, in the reply box.
  await owner.keyboard.press("ArrowDown");
  const chosen = dialog.getByRole("option", { selected: true });
  await expect(chosen).toHaveText(await options.nth(1).innerText());
  const title = await chosen.innerText();
  const articleSlug = title === "Export limits" ? "export-limits" : "exporting-reports";
  await owner.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  const link = `${title}: ${portalUrl(slug)}/docs/${articleSlug}`;
  await expect(reply).toHaveValue(`Hi Kim! See ${link} for the steps.`);
  await expect(reply).toBeFocused();
  expect(await reply.evaluate((box: HTMLTextAreaElement) => [box.selectionStart, box.selectionEnd])).toEqual(Array(2).fill(`Hi Kim! See ${link}`.length));
  // Typed in as if by them: ⌘Z takes it out, and redo puts it back.
  await reply.press("ControlOrMeta+z");
  await expect(reply).toHaveValue("Hi Kim! See  for the steps.");
  await reply.press("ControlOrMeta+Shift+z");
  await expect(reply).toHaveValue(`Hi Kim! See ${link} for the steps.`);
  await owner.keyboard.type(",");
  await expect(reply).toHaveValue(`Hi Kim! See ${link}, for the steps.`);
  await checkpoint(owner, "inbox-article-inserted");

  // The button opens it too, its shortcut named as this platform has it (Ctrl K off a Mac).
  await expect(owner.getByRole("button", { name: "Insert article" })).toHaveAttribute("title", process.platform === "darwin" ? "Insert article (⌘K)" : "Insert article (Ctrl K)");
  await owner.getByRole("button", { name: "Insert article" }).click();
  await expect(dialog).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(reply).toBeFocused();

  await owner.getByRole("button", { name: "Send", exact: true }).click();
  const messages = owner.getByRole("list", { name: "Messages" }).locator(":scope > li");
  await expect(messages).toHaveCount(2);
  await expect(messages.last()).toContainText(link);

  // The visitor reads it in the widget, link and all.
  await expect(widgetMessages).toHaveCount(2, { timeout: 15_000 });
  await expect(widgetMessages.last()).toContainText(link);
  await checkpoint(visitor, "widget-reply-with-article");

});

test("Insert article: a search that doesn't reach the server, or that the server refuses, says so with Try again, not as no match", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const { slug: article } = await api("/articles", { title: "Exporting reports", body: "Reports → Export." });
  await api(`/articles/${article}/publish`, {});
  await api("/conversations", { email: "e2e-asker@example.com", body: "How do I export my reports?" });
  await owner.goto(`/app/${slug}/inbox/1`);
  await owner.getByRole("button", { name: "Insert article" }).click();
  const dialog = owner.getByRole("dialog", { name: "Insert article" });
  const search = dialog.getByRole("combobox", { name: "Search articles" });
  const status = dialog.getByRole("status");

  // Unreachable: said so, and Try again finds it once it's back.
  await owner.route("**/*", (route) => (route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await search.fill("export");
  await expect(status).toHaveText("Couldn't search your articles. Try again");
  await checkpoint(owner, "inbox-insert-article-failed");
  await owner.unroute("**/*");
  await status.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("option")).toHaveText(["Exporting reports"]);
  await expect(status).toHaveText("1 article");
  await expect(search).toBeFocused();

  // Refused (asked of a project they're not on, as for someone taken off the team): the server's words, with Try again.
  await owner.route("**/*", (route) => {
    const request = route.request();
    return request.headers()["next-action"]
      ? route.fallback({ postData: request.postData()?.replace(`"${slug}"`, `"${slug}-elsewhere"`) })
      : route.fallback();
  });
  await search.fill("exporting");
  await expect(status).toHaveText("Only the project's team can insert articles. Try again");
  await owner.unroute("**/*");
  await owner.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // A reply never clicked into (as a kept draft is, its cursor at the start) gets the link at its end.
  const reply = owner.getByRole("textbox", { name: "Reply" });
  const link = `Exporting reports: ${portalUrl(slug)}/docs/${article}`;
  await reply.fill("Thanks!");
  await reply.evaluate((box: HTMLTextAreaElement) => {
    box.setSelectionRange(0, 0);
    box.blur();
  });
  await owner.getByRole("button", { name: "Insert article" }).click();
  await search.fill("export");
  await expect(dialog.getByRole("option")).toHaveText(["Exporting reports"]);
  await search.press("Enter");
  await expect(reply).toHaveValue(`Thanks! ${link}`);
  // Clicked into, the button puts it where the cursor is.
  await reply.evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(0, 0));
  await owner.getByRole("button", { name: "Insert article" }).click();
  await search.fill("export");
  await expect(dialog.getByRole("option")).toHaveText(["Exporting reports"]);
  await search.press("Enter");
  await expect(reply).toHaveValue(`${link} Thanks! ${link}`);
});

test("on a server selling plans, a conversation closed before the plan's history starts leaves the Inbox, and its page says how to see it again", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  const api = await apiFor(owner, slug);
  await api("/conversations", { email: "e2e-kim@example.com", body: "Where's my October invoice?" });
  await api("/conversations/1", { status: "closed" }, "PATCH");
  // Nothing done in it for 10 days: past Free's 7 days.
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(`UPDATE conversation SET "lastMessageAt" = now() - interval '10 days', "activeAt" = now() - interval '10 days', "updatedAt" = now() - interval '10 days' WHERE number = 1 AND "projectId" = (SELECT id FROM project WHERE slug = $1)`, [slug]);
  await db.end();

  await owner.goto(`/app/${slug}/inbox?view=closed`);
  await expect(owner.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Closed 0" })).toBeVisible();
  await expect(owner.getByText("No closed conversations yet.")).toBeVisible();
  // Said above the list, rather than an empty one alone.
  const notice = owner.getByRole("note").filter({ hasText: "Closed conversations with nothing done in them for more than 7 days are past your plan's history." });
  await expect(notice.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "inbox-closed-past-plan-history");

  await owner.goto(`/app/${slug}/inbox/1`);
  await expect(owner.getByText("Past your plan's history")).toBeVisible();
  await expect(owner.getByText("Nothing has happened in it for more than 7 days, longer than your plan keeps inbox history. Upgrade to see it again.")).toBeVisible();
  await expect(owner.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "conversation-past-plan-history");
});
