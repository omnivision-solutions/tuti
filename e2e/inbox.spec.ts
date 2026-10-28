import { createHash, createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_PORTAL_OWNER, APP_URL, CLOUD_URL, cloudPortalUrl, INBOUND_SECRET, SUPPORT_EMAIL_DOMAIN } from "./env";
import { apiFor, createProject, png, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";
import { nextModelReply } from "./model";
import { verifySesDomain } from "./ses";

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
  const emailed = countEmailsTo(owner.email);
  await api("/conversations", {
    user: { id: "user-42", name: "Sam Smith", email: "e2e-sam@example.com" },
    subject: "Can't export to CSV",
    body: "The export button does nothing on the reports page.",
  });
  await api("/conversations", { email: "e2e-asker@example.com", body: "Do you have a discount for nonprofits?" });
  // What the team's app says about Sam, and a group for its enterprise customers.
  await api("/users", { users: [{ id: "user-42", properties: { plan: "enterprise", seats: 40, averyveryveryverylongpropertynamewithoutanyspacesatallinit: "x" } }] });
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
  await expect(about.getByRole("definition")).toHaveText(["enterprise", "40", "x"]);
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
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Waiting");

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
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Waiting");
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

  // Assigned to themselves.
  await owner.getByRole("combobox", { name: "Assignee" }).click();
  await owner.getByRole("option", { name: "Olive Owner" }).click();
  await expect(owner.getByText("Assigned to Olive Owner")).toBeVisible();
  await checkpoint(owner, "conversation");

  // Sam writes again from the team's app: it's open again.
  await api("/conversations/1/messages", { body: "Thanks! Any idea when?", author: { id: "user-42" } });
  await owner.reload();
  await expect(messages).toHaveCount(6);
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Open");

  // Closed, it moves to Closed; Mine has nothing left.
  // Waiting isn't theirs to pick: replying sets it.
  await owner.getByRole("combobox", { name: "Status" }).click();
  await expect(owner.getByRole("option", { name: "Waiting" })).toBeDisabled();
  await checkpoint(owner, "inbox-status-menu");
  await owner.getByRole("option", { name: "Closed" }).click();
  await expect(owner.getByText("Status: Closed")).toBeVisible();
  await owner.goto(`/app/${slug}/inbox`);
  await expect(views.getByRole("link", { name: "Open 1" })).toBeVisible();
  await expect(views.getByRole("link", { name: "Mine 0" })).toBeVisible();
  await views.getByRole("link", { name: "Closed 1" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Can't export to CSV");

  // Nobody's waiting now but the one about to be marked as spam; and the owner turns the emails off.
  await expect(owner).toHaveTitle(/^\(1\) /);
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("button", { name: "Stop emailing me new conversations" }).click();
  await expect(owner.getByText("You won't be emailed new conversations")).toBeVisible();

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

  // A view name the page doesn't know (even one every object has) is the Open view, of this project only:
  // another project's open conversation stays out of it.
  const otherSlug = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(owner, "Other", otherSlug);
  await (await apiFor(owner, otherSlug))("/conversations", { email: "e2e-elsewhere@example.com", body: "Another project's question" });
  await owner.goto(`/app/${slug}/inbox?view=constructor`);
  await expect(views.getByRole("link", { name: "Open 0" })).toHaveAttribute("aria-current", "page");
  await expect(owner.getByText("Nothing waits for an answer.")).toBeVisible();
});

test("on a phone, who the conversation is with opens as a sheet, and a long address wraps in its button", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const address = "e2e-a-rather-long-address-for-the-about-button-on-phones@example.com";
  await (await apiFor(owner, slug))("/conversations", { email: address, body: "Hello from a phone" });

  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/inbox/1`);
  const about = owner.getByRole("button", { name: `About ${address}` });
  await expect(about).toBeVisible();
  // Inside the page, not past its right edge (nothing scrolls sideways).
  expect((await about.boundingBox())!.x + (await about.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await about.click();
  await expect(owner.getByRole("dialog", { name: `About ${address}` })).toContainText("Known only by this address.");
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
  // As in Safari, which keeps no place in the page as things above it grow (Chrome's scroll anchoring does).
  await owner.addInitScript(() =>
    document.addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: "html { overflow-anchor: none }" }))),
  );
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
  await expect(owner.getByRole("complementary", { name: "About them" })).toContainText("property49");
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
  await owner.goto(`/app/${slug}/inbox`);
  await owner.getByRole("link", { name: "Invoice missing" }).click();
  await expect(owner.getByText(/e2e-kim@example\.com · started from email/)).toBeVisible();
  const messages = owner.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(messages).toHaveText([/I can't find my October invoice\.\s*Show the whole email/]);
  await owner.getByText("Show the whole email").click();
  await expect(messages.first()).toContainText("> earlier");

  // Another email with a screenshot and a PDF: the image shows, the PDF downloads under its name.
  await receive(address, emailWithAttachments("Kim Lee <e2e-kim@example.com>", "Screenshot of the billing page"));
  await owner.goto(`/app/${slug}/inbox`);
  await owner.getByRole("link", { name: "Screenshot of the billing page" }).click();
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
function rawEmail(from: string, subject: string, body: string) {
  return [`From: ${from}`, `Subject: ${subject}`, `Message-ID: <${randomUUID()}@mail.example.com>`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
}

/** A small PNG (160×90, a gradient), so the screenshot shows a real image. */
const PIXEL = "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";

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

/** Posts `raw` to /api/inbound/email as the receiver does, signed, with DMARC passed. */
async function receive(recipient: string, raw: string) {
  const auth = "spf=pass dkim=pass dmarc=pass";
  const body = Buffer.from(raw);
  const t = Math.floor(Date.now() / 1000);
  const hash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", INBOUND_SECRET).update(`${t}.${recipient}.${auth}.${hash}`).digest("hex");
  const response = await fetch(`${APP_URL}/api/inbound/email`, {
    method: "POST",
    headers: { "tuti-recipient": recipient, "tuti-auth": auth, "tuti-signature": `t=${t},v1=${signature}` },
    body,
  });
  expect(response.status).toBe(200);
}

test("on a server selling plans, the operator approves a project before its replies are emailed", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByText("Your replies reach your users in the widget for now.")).toBeVisible();
  await checkpoint(owner, "support-email-approval-needed");
  const asked = countEmailsTo(APP_PORTAL_OWNER);
  await owner.getByRole("button", { name: "Request email sending" }).click();
  await expect(owner.getByText("Asked just now. It shows here once it's approved.")).toBeVisible();
  await checkpoint(owner, "support-email-requested");

  // The operator's email: its link shows what's asked, and its button approves.
  const operator = await (await browser.newContext()).newPage();
  await operator.goto(linkIn(await latestEmailTo(APP_PORTAL_OWNER, { after: asked, subject: /asks to email its users$/ }), `${CLOUD_URL}/approve-email?`));
  await expect(operator.getByText("Let Acme email its users?")).toBeVisible();
  await checkpoint(operator, "operator-approve-email");
  await operator.getByRole("button", { name: "Approve" }).click();
  await expect(operator.getByText("Acme is approved")).toBeVisible();
  await checkpoint(operator, "operator-approved");

  await owner.reload();
  await expect(owner.getByText("Your replies reach your users in the widget for now.")).toHaveCount(0);
});

test("replies from the team's own address: add it, put SES's records in DNS, check, and a test email comes from it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const domain = `${slug}.example.com`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  const supportAddress = `support@${slug}.${SUPPORT_EMAIL_DOMAIN}`;
  await expect(owner.getByText(supportAddress).first()).toBeVisible();

  await owner.getByLabel("Your company's address").fill(`support@${domain}`);
  await owner.getByRole("button", { name: "Use this address" }).click();
  await expect(owner.getByText("Waiting for DNS")).toBeVisible();
  for (const n of [1, 2, 3]) {
    await expect(owner.getByRole("region", { name: `CNAME record ${n}` })).toContainText(`._domainkey.${domain}`);
  }
  await checkpoint(owner, "own-address-records");
  // Not in DNS yet.
  await owner.getByRole("button", { name: "Check DNS" }).click();
  await expect(owner.getByText(/Not found yet/)).toBeVisible();

  await verifySesDomain(domain);
  await owner.getByRole("button", { name: "Check DNS" }).click();
  await expect(owner.getByText(`support@${domain} is verified`)).toBeVisible();
  await expect(owner.getByText(`Replies to your users come from support@${domain}.`, { exact: false })).toBeVisible();
  await owner.getByRole("button", { name: "Send a test email" }).click();
  await expect(owner.getByText("Test email sent to you")).toBeVisible();
  const test = await latestEmailTo(owner.email, { subject: /A test from/ });
  expect(test.from).toBe(`"Acme" <support@${domain}>`);
  await checkpoint(owner, "own-address-verified");

  await owner.getByRole("button", { name: "Remove address" }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(owner.getByText(`support@${domain} removed`)).toBeVisible();
  await expect(owner.getByLabel("Your company's address")).toBeVisible();
});
