import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, SUPPORT_EMAIL_DOMAIN } from "./env";
import { apiFor, createProject, expectMoreView, moreView, signUp } from "./helpers";
import { rawEmail, receive } from "./inbound";

// Wide enough for the Inbox's four panes: its views, the list, the conversation and its details.
test.use({ viewport: { width: 1440, height: 900 } });

test("a sender marked as spam is filed next time, with the reason on the conversation; a blocked domain files its other senders, and Not spam says what stays", async ({ browser }, testInfo) => {
  // Ten emails and as many page loads.
  test.setTimeout(90_000);
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
  await expect(dialog).toContainText(
    "new conversations from addresses at spam-corp.example go straight to Spam, where nobody is told about them. Senders an owner or admin marked Not spam still get through.",
  );
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
    const [reason, button] = [(await notice.locator("p").boundingBox())!, (await notice.getByRole("button", { name: "Not spam", exact: true }).boundingBox())!];
    return button.x >= reason.x + reason.width && button.y < reason.y + reason.height;
  };
  expect(await beside()).toBe(true);
  // A dense control's height, as the buttons over it.
  expect((await notice.getByRole("button", { name: "Not spam", exact: true }).boundingBox())!.height).toBe(32);
  await checkpoint(owner, "why-its-in-spam");
  // On a phone too, the reason wrapping beside it, and nothing is wider than the screen.
  const desktop = owner.viewportSize()!;
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await beside()).toBe(true);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "why-its-in-spam-phone");
  await owner.setViewportSize(desktop);

  // Not spam, by an owner: this sender is let through, the domain stays blocked, and it says so. Opened by its address
  // (in no list to move on in), its line goes with the mark, and the keyboard's focus to More actions, which stays.
  await owner.goto(`/app/${slug}/inbox/4`);
  await notice.getByRole("button", { name: "Not spam", exact: true }).click();
  await expect(owner.getByText("Moved back to the inbox")).toBeVisible();
  await expect(owner.getByText("spam-corp.example stays blocked. e2e-lee@spam-corp.example is let through from now on.")).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(more).toBeFocused();
  await expectMoreView(owner, "Needs reply 2");
  await expectMoreView(owner, "Spam 2");
  await receive(address, rawEmail("Lee Roe <e2e-lee@spam-corp.example>", "Sorry about the followers", "That wasn't me."));
  await receive(address, rawEmail("Max Poe <e2e-max@spam-corp.example>", "Followers from Max", "Ask me instead."));
  await owner.goto(`/app/${slug}/inbox`);
  await expectMoreView(owner, "Needs reply 3");
  await expectMoreView(owner, "Spam 3");
});

test("Not spam on a conversation from a blocked address says it unblocks it, a long address wrapping inside More actions and on the Spam line", async ({ browser }, testInfo) => {
  // Signing up, a project, an API key and an email, on a shared runner.
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByRole("button", { name: "Copy support address" })).toBeVisible();

  // An address on the blocked list, far longer than the menu is wide, with nowhere a line would break by itself.
  const sender = "e2e-newslettersandspecialoffersdepartment@mailserver.spamcorp.example";
  const api = await apiFor(owner, slug);
  await api("/spam", { block: [sender] }, "PATCH");
  await receive(`support@${slug}.${SUPPORT_EMAIL_DOMAIN}`, rawEmail(`Kim Lee <${sender}>`, "Cheap followers", "Buy 10,000 followers today."));

  await owner.goto(`/app/${slug}/inbox/1?view=spam`);
  const notice = owner.locator(".inbox-spam-notice");
  await expect(notice).toContainText("Marked as spam: you blocked this address");
  const label = `Not spam, and unblock ${sender}`;
  for (const width of [1440, 390]) {
    await owner.setViewportSize({ width, height: 900 });
    // On the Spam line the button wraps inside the conversation.
    await expect(notice.getByRole("button", { name: label })).toBeVisible();
    expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // In More actions the address wraps too: the item is no wider than its menu, with nothing cut off.
    await owner.getByRole("button", { name: "More actions" }).click();
    const item = owner.getByRole("menuitem", { name: label });
    const [menu, box] = [(await owner.getByRole("menu").boundingBox())!, (await item.boundingBox())!];
    // Within a pixel: read while the menu opens (it scales in), the edges can be a fraction of one apart.
    expect(box.x).toBeGreaterThanOrEqual(menu.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(menu.x + menu.width + 1);
    expect(await item.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await checkpoint(owner, `not-spam-unblock-${width}`, { fullPage: false });
    await owner.keyboard.press("Escape");
    await expect(item).toBeHidden();
  }
});
