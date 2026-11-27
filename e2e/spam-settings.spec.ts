import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, SUPPORT_EMAIL_DOMAIN } from "./env";
import { createProject, expectMoreView, moreView, signUp } from "./helpers";
import { rawEmail, receive } from "./inbound";

// Wide enough for the Inbox's four panes: its views, the list, the conversation and its details.
test.use({ viewport: { width: 1440, height: 900 } });

test("an owner blocks a domain, allows an address and adds a phrase in Settings → Spam, tries a message, and the next emails are filed by them; a domain taken off the list arrives again", async ({ browser }, testInfo) => {
  // Four emails and as many page loads.
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByRole("button", { name: "Copy support address" })).toBeVisible();
  const address = `support@${slug}.${SUPPORT_EMAIL_DOMAIN}`;

  // Settings → Spam, under Inbox and email in the menu.
  await owner.locator(`a[href="/app/${slug}/settings/spam"]`).click();
  await owner.waitForURL(`**/app/${slug}/settings/spam`);
  await expect(owner.getByRole("heading", { name: "Spam", level: 1 })).toBeVisible();
  await expect(owner).toHaveTitle(/Spam · Settings · Acme/);
  const card = (title: string) => owner.locator("section:not([data-slot])").filter({ has: owner.getByRole("heading", { name: new RegExp(`^${title}`), level: 2 }) });
  const add = async (title: string, field: string, entry: string) => {
    await card(title).getByLabel(field).fill(entry);
    await card(title).getByRole("button", { name: `Add to ${title}` }).click();
  };

  // The blocked list: what isn't an address or a domain is refused, and stays in the field; a domain is for its subdomains.
  await expect(card("Blocked")).toContainText("Nobody is blocked");
  await add("Blocked", "Address or domain to block", "not a domain");
  await expect(card("Blocked")).toContainText("Enter an address or a domain, like kim@acme.example or acme.example");
  await expect(card("Blocked").getByLabel("Address or domain to block")).toHaveValue("not a domain");
  await add("Blocked", "Address or domain to block", "Spam-Corp.example");
  await expect(owner.getByText("Added to Blocked")).toBeVisible();
  await expect(card("Blocked").getByRole("listitem")).toHaveText(["spam-corp.example and its subdomains"]);
  await expect(card("Blocked").getByRole("heading", { level: 2 })).toHaveText("Blocked 1");
  await expect(card("Blocked").getByLabel("Address or domain to block")).toHaveValue("");

  // The allowed list says what an address on it is spared.
  await expect(card("Blocked")).toContainText("Their email goes to Spam, and what they write signed in to the widget.");
  await expect(card("Allowed")).toContainText(
    "Their email, and what they write signed in, skips your phrases. An address, not a domain, also skips the limit of 20 new conversations by email an hour.",
  );
  await add("Allowed", "Address or domain to allow", "e2e-forms@relay.example");
  await expect(card("Allowed").getByRole("listitem")).toHaveText(["e2e-forms@relay.example"]);

  await expect(card("Phrases")).toContainText("A new conversation with one in its subject or first message goes to Spam, unless its sender is allowed, trusted (one of your users, a teammate, someone you've replied to) or was marked Not spam before. Whole words, any case.");
  await add("Phrases", "Phrase to add", "Facebook Admin");
  await expect(card("Phrases").getByRole("listitem")).toHaveText(["Facebook Admin"]);
  // One that's there already, however it's written, says so.
  await add("Phrases", "Phrase to add", "facebook-admin");
  await expect(card("Phrases")).toContainText("facebook-admin is already on the list");
  await card("Phrases").getByLabel("Phrase to add").fill("");

  // The guidance for the AI's checks: saved with the page's Save changes, and there again on the next visit.
  const guidance = card("Guidance for the AI");
  await expect(guidance).toContainText("Once it's written, the AI checks each new conversation nothing above decided, holding it for a few minutes at most, and files only what it's sure is spam.");
  await guidance.getByLabel("Guidance for the AI").fill("Agencies offering SEO work are spam");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Guidance saved")).toBeVisible();
  await owner.reload();
  await expect(card("Guidance for the AI").getByLabel("Guidance for the AI")).toHaveValue("Agencies offering SEO work are spam");

  // Try a message: what the filter would do with it, and why. What was typed stays, to change and try again.
  const attempt = card("Try a message");
  await attempt.getByLabel("From").fill("e2e-kim@strangers.example");
  await attempt.getByLabel("Subject").fill("A notice");
  await attempt.getByLabel("Message").fill("This is the facebook admin: your page will be disabled.");
  await attempt.getByRole("button", { name: "Try it" }).click();
  await expect(attempt.getByRole("status")).toHaveText("This would go to Spam: it has your phrase “Facebook Admin”.");
  // The whole screen in one picture: the pane scrolls inside the window, so the window is made tall enough for it.
  await expect(owner.getByText("Guidance saved")).toBeHidden({ timeout: 10_000 });
  await owner.setViewportSize({ width: 1440, height: 1300 });
  await checkpoint(owner, "spam-settings", { fullPage: false });
  await owner.setViewportSize({ width: 1440, height: 900 });
  await attempt.getByLabel("From").fill("e2e-forms@relay.example");
  await attempt.getByRole("button", { name: "Try it" }).click();
  await expect(attempt.getByRole("status")).toHaveText("This would reach the Inbox: your lists and marks let this sender through.");
  await expect(attempt.getByLabel("Message")).toHaveValue("This is the facebook admin: your page will be disabled.");
  // With the guidance written, a stranger's message nothing else decides is the AI check's to judge (not asked here).
  await attempt.getByLabel("From").fill("e2e-kim@strangers.example");
  await attempt.getByLabel("Message").fill("Can I export to CSV?");
  await attempt.getByRole("button", { name: "Try it" }).click();
  await expect(attempt.getByRole("status")).toHaveText("The AI spam check would decide this one.");
  // On a phone nothing is wider than the screen.
  const desktop = owner.viewportSize()!;
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "spam-settings-phone");
  await owner.setViewportSize(desktop);

  // Trying changed nothing. Now the emails: the blocked domain's and a stranger's with the phrase go to Spam; the allowed
  // address's, with the phrase too, reaches the inbox.
  await receive(address, rawEmail("Lee Roe <e2e-lee@mail.spam-corp.example>", "Cheap followers", "Buy 10,000 followers today."));
  await receive(address, rawEmail("Kim Lee <e2e-kim@strangers.example>", "A notice", "This is the FACEBOOK ADMIN: your page will be disabled."));
  await receive(address, rawEmail("Acme forms <e2e-forms@relay.example>", "Contact form", "Someone wrote: are you the facebook admin?"));
  await owner.goto(`/app/${slug}/inbox`);
  await expectMoreView(owner, "Needs reply 1");
  await (await moreView(owner, "Spam 2")).click();
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows).toHaveCount(2);
  // The conversation says which phrase.
  await rows.filter({ hasText: "A notice" }).getByRole("link").click();
  await expect(owner.locator(".inbox-spam-notice")).toContainText("Marked as spam: it has your phrase “Facebook Admin”");
  await checkpoint(owner, "filed-for-a-phrase", { fullPage: false });

  // Taken off the blocked list (under its ⋯), the domain's next email arrives.
  await owner.goto(`/app/${slug}/settings/spam`);
  await card("Blocked").getByRole("button", { name: "Actions for spam-corp.example" }).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await expect(owner.getByText("spam-corp.example removed")).toBeVisible();
  await expect(card("Blocked")).toContainText("Nobody is blocked");
  // Its row and menu are gone: the keyboard's focus is in the list's field.
  await expect(card("Blocked").getByLabel("Address or domain to block")).toBeFocused();
  await receive(address, rawEmail("Lee Roe <e2e-lee@mail.spam-corp.example>", "Followers, again", "Last chance."));
  await owner.goto(`/app/${slug}/inbox`);
  await expectMoreView(owner, "Needs reply 2");
  await expectMoreView(owner, "Spam 2");
});
