import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, test } from "./fixtures";
import { checkpoints } from "./checkpoint";
import { verifyEmail } from "./mail";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test.use({ timezoneId: "UTC" });

test("inbox cards keep triage in details, context folded, and phone details in a sheet", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const capture = checkpoints(testInfo);
  const checkpoint = async (...args: Parameters<typeof capture>) => {
    await args[0].mouse.move(0, 0);
    await args[0].evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await capture(...args);
  };
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme Calendar", slug);
  await verifyEmail(owner);
  const api = await apiFor(owner, slug);
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/inbox`);
  await expect(owner.getByRole("note").locator("p")).toHaveCSS("font-size", "13px");
  const firstReply = owner.locator(".inbox-overview-stats dl > div").nth(1);
  await expect(firstReply).toContainText("—");
  await expect(firstReply).toContainText("Not enough yet");
  await checkpoint(owner, "empty-laptop-light", { fullPage: false });
  await owner.getByRole("link", { name: "See waiting conversations" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox\\?view=waiting$`));
  await owner.getByRole("navigation", { name: "Inbox", exact: true }).getByRole("link", { name: "Needs reply 0" }).click();
  await owner.getByRole("button", { name: "Search project", exact: true }).click();
  await expect(owner.getByRole("dialog", { name: "Go to or do" })).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(owner.getByRole("dialog", { name: "Go to or do" })).toBeHidden();
  await api("/conversations", {
    user: { id: "demo-sam", name: "Sam Smith", email: "e2e-sam@example.com" },
    subject: "Can I export my reports?",
    body: "Can I export reports for our weekly planning?",
  });
  await api("/users", { users: [{ id: "demo-sam", properties: { company: "Northwind", plan: "Business", seats: 12 } }] });
  await api("/conversations/1/messages", { body: "Hi Sam! Would a CSV work, or do you need a PDF?" });
  await api("/conversations/1/messages", { body: "A CSV like this would be great.", author: { id: "demo-sam" } });
  await api("/conversations/1/messages", { body: "Checking the export options with Sam.", note: true });
  await api("/conversations/1/messages", { body: "Got it. Do you need one calendar or your whole team?" });
  await api("/conversations", {
    user: { id: "demo-alex", email: "e2e-alex@example.com", name: "Alex Park" },
    subject: "Calendar won’t connect",
    body: "It keeps asking me to sign in again.",
  });
  await api("/conversations", {
    user: { id: "demo-jamie", email: "e2e-jamie@example.com", name: "Jamie Lee" },
    subject: "A different time zone per event",
    body: "Our team is in two time zones.",
  });
  await api("/conversations", {
    user: { id: "demo-sam", name: "Sam Smith", email: "e2e-sam@example.com" },
    subject: "Inviting a teammate",
    body: "Thanks, that worked. We’re all set!",
  });
  await api("/conversations/4", { status: "closed" }, "PATCH");
  for (const [id, name, company, subject, body] of [
    ["demo-robin", "Robin Chen", "Northwind", "Invite link has expired", "Could you send a fresh link?"],
    ["demo-casey", "Casey Morgan", "Paperplane", "Move a recurring meeting", "Just this Friday, not the whole series."],
    ["demo-taylor", "Taylor Reed", "Luma Studio", "Where can I find my invoice?", "Thanks for taking a look."],
  ]) {
    await api("/conversations", { user: { id, name, email: `e2e-${id}@example.com` }, subject, body });
    await api("/users", { users: [{ id, properties: { company } }] });
  }
  await api("/users", {
    users: [
      { id: "demo-alex", properties: { company: "Luma Studio" } },
      { id: "demo-jamie", properties: { company: "Fieldwork" } },
    ],
  });
  const { number: post } = await api("/posts", {
    board: "feature-requests",
    author: { id: "demo-sam" },
    title: "Shared team calendars",
    body: "Share calendars with the whole team.",
  });
  await api(`/posts/${post}`, { status: "planned" }, "PATCH");
  await api("/conversations/1/posts", { post });
  await api("/posts", { board: "feature-requests", author: { id: "demo-sam" }, title: "Export reports to CSV", body: "Export reports for weekly planning." });
  await api("/conversations/1/messages", { body: "The whole team. The CSV option would be perfect.", author: { id: "demo-sam" } });
  await owner.goto(`/app/${slug}/inbox/1`);
  // Beside the list, no way back to it: it would open an empty pane.
  const header = owner.locator('[data-inbox-conversation] [data-slot="pane-header"]');
  await expect(header.getByRole("heading", { name: "Can I export my reports?" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Inbox" })).toBeHidden();
  // A pane title again, as it is with nothing before it.
  await expect(header.getByRole("heading", { name: "Can I export my reports?" }).locator("span")).toHaveCSS("font-size", "20px");
  const details = owner.getByRole("complementary", { name: "Conversation details", exact: true });
  const assertTeamAtRight = async () => {
    const messages = owner.getByRole("list", { name: "Messages" });
    await expect(messages.locator(".team:not(.note) .inbox-chat-avatar")).toHaveCount(2);
    const messageBox = (await messages.boundingBox())!;
    for (const avatar of await messages.locator(".team:not(.note) .inbox-chat-avatar").all()) {
      const box = (await avatar.boundingBox())!;
      expect(box.x + box.width).toBeCloseTo(messageBox.x + messageBox.width, 0);
    }
  };
  await expect(details).toBeVisible();
  // A run across midnight can make the first message yesterday by the time it opens.
  await expect(owner.locator(".inbox-day")).toHaveText(/^(Today|Yesterday) · /);
  const folded = ["Customer details", "Company", "Other conversations from this person", "Recent page visits", "Events", "Conversation attributes"];
  for (const name of folded) {
    const section = details.locator("details").filter({ has: owner.locator("summary", { hasText: name }) });
    await expect(section).not.toHaveAttribute("open");
    await expect(section.locator("summary small")).toHaveText(/^\d+$/);
  }
  for (const name of ["Linked posts", "Looks related"])
    await expect(details.locator("details").filter({ has: owner.locator("summary", { hasText: name }) })).toHaveAttribute("open");
  await expect(owner.locator('[data-inbox-conversation] [data-slot="pane-header"]').getByRole("button", { name: "Unassigned, assign conversation", exact: true })).toHaveCount(0);
  await details.getByRole("button", { name: "Unassigned, assign conversation", exact: true }).click();
  await owner.getByRole("menuitem", { name: "Assign to me" }).click();
  await expect(details.getByRole("button", { name: "Assigned to Olive Owner" })).toBeVisible();
  await owner.reload();
  await expect(details).toBeVisible();
  await assertTeamAtRight();
  await details.getByRole("button", { name: "Link a post to this conversation" }).click();
  const linkDialog = owner.getByRole("dialog", { name: "Link a post" });
  await expect(linkDialog).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(linkDialog).toBeHidden();
  await expect(details.getByRole("button", { name: "Link a post to this conversation" })).toBeFocused();
  await checkpoint(owner, "laptop-light", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "laptop-dark", { fullPage: false });
  await details.locator("summary", { hasText: "Other conversations from this person" }).click();
  await expect(details.getByRole("link", { name: "Inviting a teammate" })).toBeVisible();
  const other = details.getByRole("region", { name: "Other conversations", exact: true }).getByRole("listitem");
  await expect(other).toContainText(/Closed · #4 · \d+ \w+/);
  await expect(other).toContainText("Thanks, that worked. We’re all set!");
  await checkpoint(owner, "section-expanded-dark", { fullPage: false });
  // At 1280px the views' pane leaves no room for the details beside the conversation: they're in a sheet.
  await owner.setViewportSize({ width: 1280, height: 900 });
  await expect(details).toBeHidden();
  await expect(owner.getByRole("button", { name: "Show details" })).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
  await checkpoint(owner, "laptop-1280-dark", { fullPage: false });
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.getByRole("button", { name: "Hide details" }).click();
  await expect(details).toBeHidden();
  await assertTeamAtRight();
  await checkpoint(owner, "panel-collapsed-dark", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.emulateMedia({ colorScheme: "light" });
  await owner.reload();
  const title = owner.locator('[data-inbox-conversation] [data-slot="pane-header"]');
  await expect(title.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await title.getByRole("button", { name: "Show details" }).click();
  const sheet = owner.getByRole("dialog", { name: "Conversation details" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Assigned to Olive Owner" })).toBeVisible();
  for (const name of folded) await expect(sheet.locator("details").filter({ has: owner.locator("summary", { hasText: name }) })).not.toHaveAttribute("open");
  await checkpoint(owner, "phone-details-light", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "phone-details-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await sheet.getByRole("button", { name: "Link a post to this conversation" }).click();
  await expect(linkDialog).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(linkDialog).toBeHidden();
  await expect(sheet.getByRole("button", { name: "Link a post to this conversation" })).toBeFocused();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(title.getByRole("button", { name: "Show details" })).toBeFocused();
  await expect(owner.getByRole("region", { name: "Conversations", exact: true })).toBeHidden();
  await expect(owner.getByRole("textbox", { name: "Reply" })).toBeInViewport();
  await checkpoint(owner, "phone-conversation-light", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "phone-conversation-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await owner.getByRole("textbox", { name: "Reply" }).fill("Thanks, Sam! We’ll check this for you.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("list", { name: "Messages" })).toContainText("Thanks, Sam!");
  await title.getByRole("button", { name: "Show details" }).click();
  await sheet.getByRole("button", { name: "Waiting on user, change status" }).click();
  await owner.getByRole("menuitem", { name: "Needs reply", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Needs reply, change status" })).toContainText("Needs reply");
  await sheet.locator("summary", { hasText: "Other conversations from this person" }).click();
  await sheet.getByRole("link", { name: "Inviting a teammate" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox/4$`));
  await expect(sheet).toBeHidden();
  await expect(title.getByRole("heading", { name: "Inviting a teammate" })).toBeVisible();
  await owner.locator('[data-inbox-conversation] [data-slot="pane-header"]').getByRole("link", { name: "Inbox" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/inbox$`));
  await expect(owner.getByRole("region", { name: "Conversations", exact: true })).toBeVisible();
  await expect(owner.getByRole("note").locator("p")).toHaveCSS("font-size", "13px");
  await checkpoint(owner, "phone-list-light", { fullPage: false });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("long names and subjects fit both laptop widths with wrapping details labels", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const teammate = "Olive Owner with a very long name that still fits the assignment control";
  const person = "Sam Smith with a very long customer name that stays inside the list";
  const subject = "Can I export all calendars across the entire company, including archived calendars and the complete history, so we can review every team together at our weekly planning meeting?";
  const owner = await signUp(browser, APP_URL, teammate);
  await createProject(owner, "Acme Calendar", slug);
  await verifyEmail(owner);
  const api = await apiFor(owner, slug);
  await api("/conversations", { user: { id: "long-name", name: person, email: "e2e-long-name@example.com" }, subject, body: "Please keep the full report." });
  await api("/conversations", { user: { id: "long-name", name: person, email: "e2e-long-name@example.com" }, subject: `${subject} The previous question.`, body: "Thanks, the previous export worked." });
  await api("/conversations/2", { status: "closed" }, "PATCH");
  for (const width of [1440, 1600]) {
    await owner.setViewportSize({ width, height: 900 });
    await owner.goto(`/app/${slug}/inbox/1`);
    const details = owner.getByRole("complementary", { name: "Conversation details", exact: true });
    if (width === 1440) {
      await details.getByRole("button", { name: "Unassigned, assign conversation", exact: true }).click();
      await owner.getByRole("menuitem", { name: "Assign to me" }).click();
    }
    await expect(details.getByRole("button", { name: `Assigned to ${teammate}` })).toBeVisible();
    await details.locator("summary", { hasText: "Other conversations from this person" }).click();
    await expect(details.getByRole("link", { name: `${subject} The previous question.` })).toBeVisible();
    const title = owner.locator('[data-inbox-conversation] [data-slot="pane-header"]');
    const heading = title.getByRole("heading", { name: subject, exact: true });
    await expect(heading).toBeVisible();
    await expect(heading.locator("[title]")).toHaveAttribute("title", subject);
    expect(await heading.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await expect(title.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    for (const box of [title, details, details.locator("summary", { hasText: "Other conversations from this person" })]) {
      expect(await box.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }
    // Capture the layout after transient assignment feedback has cleared the heading.
    await owner.mouse.move(0, 0);
    await owner.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await expect(owner.locator("[data-sonner-toast]")).toHaveCount(0);
    await checkpoint(owner, `long-content-${width}`, { fullPage: false });
  }
});

test("messages read as chat bubbles, a run from one sender under one name, and the reply box lights up as one", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme Calendar", slug);
  await verifyEmail(owner);
  const api = await apiFor(owner, slug);
  await api("/conversations", {
    user: { id: "demo-sam", name: "Sam Smith", email: "e2e-sam@example.com" },
    subject: "Can I export my reports?",
    body: "Can I export reports for our weekly planning? We plan every Monday and would love to share them with the whole team.",
  });
  await api("/conversations/1/messages", { body: "Hi Sam! Yes, from Reports → Export: https://docs.example.com/export" });
  await api("/conversations/1/messages", { body: "Would a CSV work, or do you need a PDF?" });
  await api("/conversations/1/messages", { body: "thanks!!", author: { id: "demo-sam" } });
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/inbox/1`);
  const messages = owner.getByRole("list", { name: "Messages" });
  const bubbles = messages.locator(".inbox-bubble");
  await expect(bubbles).toHaveCount(4);

  // The team's two replies are a run: one avatar shown, their name and time once, under the second (the first's line is
  // there for screen readers only).
  const lines = messages.locator(".team .inbox-message-by");
  await expect(lines).toHaveCount(2);
  await expect(lines.first()).toHaveCSS("position", "absolute");
  await expect(lines.last()).toHaveCSS("position", "static");
  await expect(messages.getByRole("listitem").nth(1)).toContainText("Olive Owner · ");
  await expect(messages.locator(".team .inbox-chat-avatar").first()).toHaveCSS("visibility", "hidden");
  await expect(messages.locator(".team .inbox-chat-avatar").last()).toHaveCSS("visibility", "visible");
  // The team's in the primary colour; the customer's long message stays well short of the pane's width.
  const primary = await owner.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bg-primary";
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
  await expect(bubbles.nth(1)).toHaveCSS("background-color", primary);
  const list = (await messages.boundingBox())!;
  expect((await bubbles.first().boundingBox())!.width).toBeLessThanOrEqual(list.width * 0.72);
  // A link in the team's colour shows its keyboard focus: an outline in the bubble's text colour, not primary on primary.
  const link = bubbles.nth(1).getByRole("link", { name: "https://docs.example.com/export" });
  await link.focus();
  await expect(link).not.toHaveCSS("outline-style", "none");
  await expect(link).toHaveCSS("outline-color", await bubbles.nth(1).evaluate((bubble) => getComputedStyle(bubble).color));
  // A short one stays short.
  expect((await bubbles.last().boundingBox())!.width).toBeLessThan(120);

  // The reply box, not its text field, lights up while it's written in.
  const composer = owner.locator("form.inbox-composer");
  const reply = owner.getByRole("textbox", { name: "Reply" });
  await reply.click();
  expect(await reply.evaluate((field) => getComputedStyle(field).boxShadow)).not.toMatch(/0px 0px 0px [1-9]/);
  // Its 3px ring, once the transition has run.
  await expect.poll(() => composer.evaluate((form) => getComputedStyle(form).boxShadow)).toMatch(/0px 0px 0px 3px/);
  await reply.fill("Thanks for flagging this, I’ve refunded the charge");
  await checkpoint(owner, "laptop-reply-focused", { fullPage: false });
  // Reply and Note keep their focus ring and full underline: the tab list doesn't clip them.
  await expect(owner.getByRole("tablist")).toHaveCSS("overflow-x", "visible");
  // On Note the whole box takes the note's colours.
  const card = await composer.evaluate((form) => getComputedStyle(form).backgroundColor);
  await owner.getByRole("tab", { name: "Note" }).click();
  await expect(composer).not.toHaveCSS("background-color", card);
  await owner.getByRole("textbox", { name: "Note" }).fill("Refunded in Stripe, check again Friday");
  await checkpoint(owner, "laptop-note-focused", { fullPage: false });

  // A file sent in the team's colour stays readable: its card's name in the card's own text colour.
  await owner.getByRole("tab", { name: "Reply" }).click();
  await reply.fill("Here it is.");
  await owner.getByLabel("Files to attach").setInputFiles({ name: "report.csv", mimeType: "text/csv", buffer: Buffer.from("week,hours\n1,40") });
  await expect(composer.getByText("report.csv")).toBeVisible();
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  const file = messages.getByRole("list", { name: "Attachments" }).getByRole("link", { name: /report\.csv/ });
  await expect(file).toBeVisible();
  const cardText = await owner.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "text-card-foreground";
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  await expect(file).toHaveCSS("color", cardText);
  // Its focus outline is the ring's, seen on the card, not the bubble's text colour.
  // From the keyboard (after the Send click, the browser would only show focus for keys).
  await owner.keyboard.press("Shift");
  await file.focus();
  // Focus shows (the browser draws an outline only for :focus-visible), so the colour below is the focused one.
  await expect(file).not.toHaveCSS("outline-style", "none");
  await expect(file).not.toHaveCSS("outline-color", await file.locator("xpath=ancestor::*[contains(@class,'inbox-bubble')]").evaluate((bubble) => getComputedStyle(bubble).color));

  await owner.setViewportSize({ width: 390, height: 844 });
  await reply.click();
  await checkpoint(owner, "phone-bubbles", { fullPage: false });
  expect((await bubbles.first().boundingBox())!.width).toBeLessThanOrEqual((await messages.boundingBox())!.width * 0.82 + 1);
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "phone-bubbles-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });

  // Two replies minutes apart either side of midnight are two days, not a run: each keeps its avatar and line.
  await api("/conversations", { user: { id: "demo-sam" }, subject: "Late night", body: "Still up?" });
  await api("/conversations/2/messages", { body: "Yes, still here." });
  await api("/conversations/2/messages", { body: "What can I do?" });
  // Midnight in the browser's own time zone (its sessions don't all take the file's), three days back.
  const midnight = await owner.evaluate(() => {
    const day = new Date();
    day.setDate(day.getDate() - 3);
    day.setHours(0, 0, 0, 0);
    return day.toISOString();
  });
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `UPDATE conversation_message m SET "createdAt" = ($2::timestamptz AT TIME ZONE 'UTC') + (CASE m.body WHEN 'Still up?' THEN interval '-10 minutes' WHEN 'Yes, still here.' THEN interval '-2 minutes' ELSE interval '2 minutes' END)
     FROM conversation c JOIN project p ON p.id = c."projectId" WHERE c.id = m."conversationId" AND c.number = 2 AND p.slug = $1`,
    [slug, midnight],
  );
  // And two teammates of one name, a minute apart, are two senders.
  await api("/conversations", { user: { id: "demo-sam" }, subject: "Two Olives", body: "Hello?" });
  await api("/conversations/3/messages", { body: "Hi from one Olive." });
  await api("/conversations/3/messages", { body: "Hi from the other." });
  const twin = `e2e-${randomUUID()}`;
  await db.query(`INSERT INTO "user" (id, name, email, "updatedAt") VALUES ($1, 'Olive Owner', $2, now())`, [twin, `${twin}@example.com`]);
  await db.query(
    `UPDATE conversation_message m SET "authorId" = $2 FROM conversation c JOIN project p ON p.id = c."projectId"
     WHERE c.id = m."conversationId" AND c.number = 3 AND p.slug = $1 AND m.body = 'Hi from the other.'`,
    [slug, twin],
  );
  await db.end();
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/inbox/3`);
  await expect(messages.locator(".team .inbox-message-by")).toHaveCount(2);
  for (const line of await messages.locator(".team .inbox-message-by").all()) {
    await expect(line).toHaveCSS("position", "static");
  }
  await owner.goto(`/app/${slug}/inbox/2`);
  await expect(messages.locator(".inbox-day")).toHaveCount(2);
  for (const line of await messages.locator(".team .inbox-message-by").all()) {
    await expect(line).toHaveCSS("position", "static");
  }
  await expect(messages.locator(".team .inbox-chat-avatar").first()).toHaveCSS("visibility", "visible");
});
