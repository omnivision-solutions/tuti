import { createHash, createHmac, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_PORTAL_OWNER, APP_URL, CLOUD_URL, cloudPortalUrl, INBOUND_SECRET, SUPPORT_EMAIL_DOMAIN } from "./env";
import { apiFor, createProject, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";

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
  await owner.goto(`/app/${slug}/settings/support`);
  await expect(owner.getByText(/^Last email received/)).toBeVisible();
});

/** A raw email as a mail provider delivers it. */
function rawEmail(from: string, subject: string, body: string) {
  return [`From: ${from}`, `Subject: ${subject}`, `Message-ID: <${randomUUID()}@mail.example.com>`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
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

test("on a server selling plans, the operator approves a project before its replies are emailed", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByText("Your replies reach your users in the widget for now.")).toBeVisible();
  const asked = countEmailsTo(APP_PORTAL_OWNER);
  await owner.getByRole("button", { name: "Request email sending" }).click();
  await expect(owner.getByText("Asked just now. It shows here once it's approved.")).toBeVisible();

  // The operator's email: its link shows what's asked, and its button approves.
  const operator = await (await browser.newContext()).newPage();
  await operator.goto(linkIn(await latestEmailTo(APP_PORTAL_OWNER, { after: asked }), `${CLOUD_URL}/approve-email?`));
  await expect(operator.getByText("Let Acme email its users?")).toBeVisible();
  await operator.getByRole("button", { name: "Approve" }).click();
  await expect(operator.getByText("Acme is approved")).toBeVisible();

  await owner.reload();
  await expect(owner.getByText("Your replies reach your users in the widget for now.")).toHaveCount(0);
});
