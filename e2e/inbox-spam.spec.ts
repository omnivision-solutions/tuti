import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, SUPPORT_EMAIL_DOMAIN } from "./env";
import { query as db } from "./db";
import { apiFor, createProject, expectMoreView, moreView, signUp } from "./helpers";
import { rawEmail, receive } from "./inbound";
import { nextDecision } from "./model";

// Wide enough for the Inbox's four panes: its views, the list, the conversation and its details.
test.use({ viewport: { width: 1440, height: 900 } });

test("Report spam, and block the sender or the domain, files their next emails, with the reason on the conversation; a member is offered Report spam alone, nobody a free-mail domain; Not spam says what stays", async ({ browser }, testInfo) => {
  // Eleven emails, two people and as many page loads.
  test.setTimeout(120_000);
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

  // A free-mail domain is never offered for blocking; its address is, shown under the item.
  await open("More followers");
  await more.click();
  await expect(owner.getByRole("menuitem", { name: "Report spam", exact: true })).toBeVisible();
  await expect(owner.getByRole("menuitem", { name: /^Report spam and block sender/ })).toContainText("e2e-pat@gmail.com");
  await expect(owner.getByRole("menuitem", { name: /block domain/ })).toHaveCount(0);
  await owner.keyboard.press("Escape");

  // A member is offered Report spam alone: block rules are the owners' and admins'.
  const member = await signUp(browser, APP_URL, "Mo Member");
  await db(
    `INSERT INTO team_member (id, "projectId", "userId", role) SELECT gen_random_uuid()::text, p.id, u.id, 'MEMBER' FROM project p, "user" u WHERE p.slug = $1 AND u.email = $2`,
    [slug, member.email],
  );
  await member.goto(`/app/${slug}/inbox/1`);
  await member.getByRole("button", { name: "More actions" }).click();
  await expect(member.getByRole("menuitem", { name: /^Report spam/ })).toHaveText(["Report spam"]);
  await member.close();

  // The company's: the owner sees all three, the organisational domain under the last, and blocking it asks nothing.
  await open("Cheap followers");
  await more.click();
  const items = owner.getByRole("menuitem", { name: /^Report spam/ });
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveText("Report spam");
  await expect(items.nth(1)).toContainText("e2e-kim@mail.spam-corp.example");
  await expect(items.nth(2)).toContainText("spam-corp.example");
  await checkpoint(owner, "report-spam-menu", { fullPage: false });
  await owner.getByRole("menuitem", { name: /^Report spam and block domain/ }).click();
  await expect(owner.getByText("Marked as spam, and blocked spam-corp.example")).toBeVisible();
  await expectMoreView(owner, "Spam 1");

  // Report spam and block sender, on the free-mail one: the address as a rule from a report.
  await owner.goto(`/app/${slug}/inbox/2`);
  await more.click();
  await owner.getByRole("menuitem", { name: /^Report spam and block sender/ }).click();
  await expect(owner.getByText("Marked as spam, and blocked e2e-pat@gmail.com")).toBeVisible();
  await owner.goto(`/app/${slug}/settings/spam`);
  await expect(owner.getByRole("list", { name: "Block rules" }).getByRole("listitem")).toHaveText([
    "Sender address · is · e2e-pat@gmail.com · from a report",
    "Sender domain · is · spam-corp.example · from a report",
  ]);

  // Their next emails, and a colleague's from the domain itself, never reach the inbox.
  await receive(address, rawEmail("Kim Lee <e2e-kim@mail.spam-corp.example>", "Followers, again", "Last chance."));
  await receive(address, rawEmail("Lee Roe <e2e-lee@spam-corp.example>", "Followers from Lee", "Ask me about followers."));
  await receive(address, rawEmail("Pat Day <e2e-pat@gmail.com>", "Followers from Pat", "Still selling."));
  await owner.goto(`/app/${slug}/inbox`);
  await (await moreView(owner, "Spam 5")).click();
  await expect(rows).toHaveCount(5);

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
  await expectMoreView(owner, "Needs reply 1");
  await expectMoreView(owner, "Spam 4");
  await receive(address, rawEmail("Lee Roe <e2e-lee@spam-corp.example>", "Sorry about the followers", "That wasn't me."));
  await receive(address, rawEmail("Max Poe <e2e-max@spam-corp.example>", "Followers from Max", "Ask me instead."));
  await owner.goto(`/app/${slug}/inbox`);
  await expectMoreView(owner, "Needs reply 2");
  await expectMoreView(owner, "Spam 5");

  // Report spam alone: no rule, and the sender's next email is filed by the report.
  await receive(address, rawEmail("Ana Lu <e2e-ana@other.example>", "Guest post", "Can I write for your blog?"));
  await owner.goto(`/app/${slug}/inbox/8`);
  await more.click();
  await owner.getByRole("menuitem", { name: "Report spam", exact: true }).click();
  await expect(owner.getByText("Marked as spam", { exact: true })).toBeVisible();
  await receive(address, rawEmail("Ana Lu <e2e-ana@other.example>", "Guest post, again", "Still keen."));
  await owner.goto(`/app/${slug}/inbox`);
  await expectMoreView(owner, "Needs reply 2");
  await expectMoreView(owner, "Spam 7");
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
    // The menu scales in as it opens, so its edges and the item's are read again until it has settled.
    await expect
      .poll(async () => {
        const [menu, box] = [(await owner.getByRole("menu").boundingBox())!, (await item.boundingBox())!];
        return box.x >= menu.x - 1 && box.x + box.width <= menu.x + menu.width + 1;
      })
      .toBe(true);
    expect(await item.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await checkpoint(owner, `not-spam-unblock-${width}`, { fullPage: false });
    await owner.keyboard.press("Escape");
    await expect(item).toBeHidden();
  }
});

test("with guidance written, the AI check holds a stranger's email: one it's unsure of is released to the inbox, one it's sure of is filed with its reason", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByRole("button", { name: "Copy support address" })).toBeVisible();
  const address = `support@${slug}.${SUPPORT_EMAIL_DOMAIN}`;
  const api = await apiFor(owner, slug);
  // The AI check runs only for a team that wrote its guidance.
  await api("/spam", { guidance: "Agencies pitching SEO work are spam" }, "PATCH");

  // A customer's question: the model fake is sure it isn't spam (global setup), so it's held only till it answers.
  await receive(address, rawEmail("Kim Lee <e2e-kim@acme-customer.example>", "Export broken", "Exporting to CSV gives me an empty file."));
  // An SEO pitch: the model is sure it is.
  await nextDecision({ spam: 0.99 }, "e2e-growth@rankfast.example");
  await receive(address, rawEmail("Growth Team <e2e-growth@rankfast.example>", "Get to #1 on Google", "Our agency guarantees page one in 30 days."));

  // Released and filed once the requests have answered: a reload till the Inbox shows both where they belong.
  await expect(async () => {
    await owner.goto(`/app/${slug}/inbox`);
    await expectMoreView(owner, "Needs reply 1");
    await expectMoreView(owner, "Spam 1");
  }).toPass({ timeout: 30_000 });

  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows.filter({ hasText: "Export broken" })).toBeVisible();
  const activity = owner.getByRole("complementary", { name: "Conversation details" }).getByRole("region", { name: "Activity" });

  // The pitch is in Spam, saying why, its Activity with how sure the AI check was.
  await owner.goto(`/app/${slug}/inbox/2?view=spam`);
  await expect(owner.locator(".inbox-spam-notice")).toContainText("Marked as spam: the spam filter judged this spam");
  await expect(activity.locator("li[data-event]").first()).toContainText("Spam filter filed it as spam");
  await expect(activity.locator("li[data-event]").first()).toContainText("the AI check was 99% sure it's spam");
  await checkpoint(owner, "filed-by-the-ai-check");

  // The customer's is in the inbox, its Activity saying the check let it through.
  await owner.goto(`/app/${slug}/inbox/1`);
  await expect(owner.locator(".inbox-spam-notice")).toHaveCount(0);
  await expect(activity.locator("li[data-event]").first()).toContainText("Spam filter let it through");
});
