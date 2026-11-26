import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, SUPPORT_EMAIL_DOMAIN } from "./env";
import { createProject, expectMoreView, moreView, signUp } from "./helpers";
import { rawEmail, receive } from "./inbound";

// Wide enough for the Inbox's four panes: its views, the list, the conversation and its details.
test.use({ viewport: { width: 1440, height: 900 } });

test("a sender marked as spam is filed next time, with the reason on the conversation; a blocked domain files its other senders, and Not spam says what stays", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByRole("button", { name: "Copy support address" })).toBeVisible();
  const address = `support@${slug}.${SUPPORT_EMAIL_DOMAIN}`;
  const rows = owner.getByRole("main").getByRole("listitem");
  /** Opens a conversation from the list, once it's the one beside it (its menu is the one before's till then). */
  const open = async (subject: string) => {
    await rows.filter({ hasText: subject }).getByRole("link").click();
    await expect(owner.locator(".inbox-conversation").getByTitle(subject)).toBeVisible();
  };
  const notice = owner.locator(".inbox-spam-notice");
  const more = owner.getByRole("button", { name: "More actions" });

  // Two strangers write: one from a company's subdomain, one from a free-mail address.
  await receive(address, rawEmail("Kim Lee <e2e-kim@mail.spam-corp.example>", "Cheap followers", "Buy 10,000 followers today."));
  await receive(address, rawEmail("Pat Day <e2e-pat@gmail.com>", "More followers", "Buy 20,000 followers today."));
  await owner.goto(`/app/${slug}/inbox`);
  await expectMoreView(owner, "Needs reply 2");

  // A free-mail domain is never offered for blocking: marking as spam blocks the address.
  await open("More followers");
  await more.click();
  await expect(owner.getByRole("menuitem", { name: "Mark as spam", exact: true })).toBeVisible();
  await expect(owner.getByRole("menuitem", { name: /also block/ })).toHaveCount(0);
  await owner.keyboard.press("Escape");

  // The company's: Mark as spam offers its organisational domain too, and asks first.
  await open("Cheap followers");
  await more.click();
  await owner.getByRole("menuitem", { name: "Mark as spam, also block spam-corp.example…" }).click();
  const dialog = owner.getByRole("alertdialog", { name: "Also block spam-corp.example?" });
  await expect(dialog).toContainText("every new conversation from an address at spam-corp.example goes straight to Spam: nobody is told about them.");
  await checkpoint(owner, "also-block-domain", { fullPage: false });
  await dialog.getByRole("button", { name: "Mark as spam and block" }).click();
  await expect(owner.getByText("Marked as spam, and blocked spam-corp.example")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expectMoreView(owner, "Spam 1");

  // Their next email, and a colleague's from the domain itself, never reach the inbox.
  await receive(address, rawEmail("Kim Lee <e2e-kim@mail.spam-corp.example>", "Followers, again", "Last chance."));
  await receive(address, rawEmail("Lee Roe <e2e-lee@spam-corp.example>", "Followers from Lee", "Ask me about followers."));
  await owner.goto(`/app/${slug}/inbox`);
  await expectMoreView(owner, "Needs reply 1");
  await (await moreView(owner, "Spam 3")).click();
  await expect(rows).toHaveCount(3);

  // Each says why it's there, with Not spam beside it.
  await open("Followers, again");
  await expect(notice).toContainText("Marked as spam: you marked an earlier conversation from this sender as spam");
  await open("Cheap followers");
  await expect(notice).toContainText("Marked as spam: a teammate marked it");
  await open("Followers from Lee");
  await expect(notice).toContainText("Marked as spam: you blocked this address's domain");
  // The button is beside the reason, not under it.
  const beside = async () => {
    const [reason, button] = [(await notice.locator("p").boundingBox())!, (await notice.getByRole("button", { name: "Not spam" }).boundingBox())!];
    return button.x >= reason.x + reason.width && button.y < reason.y + reason.height;
  };
  expect(await beside()).toBe(true);
  await checkpoint(owner, "why-its-in-spam");
  // On a phone too, the reason wrapping beside it, and nothing is wider than the screen.
  const desktop = owner.viewportSize()!;
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await beside()).toBe(true);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "why-its-in-spam-phone");
  await owner.setViewportSize(desktop);

  // Not spam, by an owner: this sender is let through, the domain stays blocked, and it says so.
  await notice.getByRole("button", { name: "Not spam" }).click();
  await expect(owner.getByText("Moved back to the inbox")).toBeVisible();
  await expect(owner.getByText("spam-corp.example stays blocked. e2e-lee@spam-corp.example is let through from now on.")).toBeVisible();
  await expectMoreView(owner, "Needs reply 2");
  await expectMoreView(owner, "Spam 2");
  await receive(address, rawEmail("Lee Roe <e2e-lee@spam-corp.example>", "Sorry about the followers", "That wasn't me."));
  await receive(address, rawEmail("Max Poe <e2e-max@spam-corp.example>", "Followers from Max", "Ask me instead."));
  await owner.goto(`/app/${slug}/inbox`);
  await expectMoreView(owner, "Needs reply 3");
  await expectMoreView(owner, "Spam 3");
});
