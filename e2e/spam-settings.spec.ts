import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, SUPPORT_EMAIL_DOMAIN } from "./env";
import { apiFor, createProject, expectMoreView, moreView, signUp } from "./helpers";
import { rawEmail, receive } from "./inbound";

// Wide enough for the Inbox's four panes: its views, the list, the conversation and its details.
test.use({ viewport: { width: 1440, height: 900 } });

test("an owner adds block rules of a few kinds in Settings → Spam, tries a message, and the next emails are filed by them; a rule removed lets its sender in again", async ({ browser }, testInfo) => {
  // Four emails and as many page loads.
  test.setTimeout(120_000);
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
  const rules = card("Block rules");
  /** Adds a rule: the field, matcher and who it applies to picked where given (Sender domain, "is", Everyone to start), then the value. */
  const add = async (value: string, field?: string, matcher?: string, appliesTo?: string) => {
    for (const [label, option] of [["Field", field], ["Matcher", matcher], ["Applies to", appliesTo]] as const) {
      if (option) {
        await rules.getByRole("combobox", { name: label }).click();
        await owner.getByRole("option", { name: option, exact: true }).click();
      }
    }
    await rules.getByLabel("Value").fill(value);
    await rules.getByRole("button", { name: "Add rule" }).click();
  };

  // One short line per card; no allowed list while it's empty.
  await expect(rules).toContainText("Matching new conversations go to Spam.");
  await expect(rules.getByRole("listitem")).toHaveCount(0);
  await expect(owner.getByRole("heading", { name: /^Allowed/, level: 2 })).toHaveCount(0);
  await expect(rules.getByRole("combobox", { name: "Field" })).toContainText("Sender domain");
  await expect(rules.getByRole("combobox", { name: "Matcher" })).toContainText("is");
  await expect(rules.getByRole("combobox", { name: "Applies to" })).toContainText("Everyone");

  // What can't be a domain is refused, and stays in the field; a domain is for its subdomains.
  await add("not a domain");
  await expect(rules).toContainText("Enter a domain, like acme.example");
  await expect(rules.getByLabel("Value")).toHaveValue("not a domain");
  await add("Spam-Corp.example");
  await expect(owner.getByText("Rule added")).toBeVisible();
  await expect(rules.getByRole("listitem")).toHaveText(["Sender domain · is · spam-corp.example"]);
  await expect(rules.getByLabel("Value")).toHaveValue("");
  await add("Facebook Admin", "Subject or body", "contains");
  await add("*giveaway*", "Sender name", "matches pattern", "Strangers only");
  await expect(rules.getByRole("listitem")).toHaveText([
    "Sender name · matches pattern · *giveaway* · strangers only",
    "Subject or body · contains · Facebook Admin",
    "Sender domain · is · spam-corp.example",
  ]);
  await expect(rules.getByRole("heading", { level: 2 })).toHaveText("Block rules 3");
  // One that's there already, however it's written, says so.
  await add("facebook-admin", "Subject or body", "contains", "Everyone");
  await expect(rules).toContainText("That rule is already there");
  await add("@SPAM-corp.example", "Sender domain", "is");
  await expect(rules).toContainText("That rule is already there");
  await rules.getByLabel("Value").fill("");

  // The AI spam check: Off till it's described, saved with the page's Save changes, and On on the next visit.
  const check = card("AI spam check");
  await expect(check.getByRole("heading", { level: 2 })).toHaveText("AI spam check Off");
  await expect(check).toContainText("Describe your spam; the AI checks what the rules miss.");
  await check.getByLabel("Describe your spam").fill("Agencies offering SEO work are spam");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Guidance saved")).toBeVisible();
  await owner.reload();
  await expect(card("AI spam check").getByLabel("Describe your spam")).toHaveValue("Agencies offering SEO work are spam");
  await expect(card("AI spam check").getByRole("heading", { level: 2 })).toHaveText("AI spam check On");

  // Try a message: what the filter would do with it, and which rule. What was typed stays, to change and try again.
  const attempt = card("Try a message");
  await expect(attempt).toContainText("Nothing is sent or saved.");
  // To starts as the project's support address.
  await expect(attempt.getByLabel("To")).toHaveValue(address);
  await attempt.getByLabel("From").fill("Kim Lee <e2e-kim@strangers.example>");
  await attempt.getByLabel("Subject").fill("A notice");
  await attempt.getByLabel("Message").fill("This is the facebook admin: your page will be disabled.");
  await attempt.getByRole("button", { name: "Try it" }).click();
  await expect(attempt.getByRole("status")).toHaveText("This would go to Spam: your rule “subject or body contains Facebook Admin”.");
  await attempt.getByLabel("From").fill("e2e-lee@mail.spam-corp.example");
  await attempt.getByLabel("Message").fill("Buy 10,000 followers today.");
  await attempt.getByRole("button", { name: "Try it" }).click();
  await expect(attempt.getByRole("status")).toHaveText("This would go to Spam: your rule “sender domain is spam-corp.example”.");
  await expect(attempt.getByLabel("Subject")).toHaveValue("A notice");
  // The name in From, for rules on the sender's name.
  await attempt.getByLabel("From").fill("Big GIVEAWAY team <e2e-win@prizes.example>");
  await attempt.getByLabel("Message").fill("Claim your prize.");
  await attempt.getByRole("button", { name: "Try it" }).click();
  await expect(attempt.getByRole("status")).toHaveText("This would go to Spam: your rule “sender name matches pattern *giveaway* (strangers only)”.");
  // The whole screen in one picture: the pane scrolls inside the window, so the window is made tall enough for it.
  await expect(owner.getByText("Guidance saved")).toBeHidden({ timeout: 10_000 });
  await owner.setViewportSize({ width: 1440, height: 1300 });
  await checkpoint(owner, "spam-settings", { fullPage: false });
  await owner.setViewportSize({ width: 1440, height: 900 });
  // With the guidance written, a stranger's message no rule decides is the AI check's to judge (not asked here).
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

  // Trying changed nothing. Now the emails: the blocked domain's, a stranger's with the phrase and a "giveaway" name go
  // to Spam; one with none of them reaches the inbox.
  await receive(address, rawEmail("Lee Roe <e2e-lee@mail.spam-corp.example>", "Cheap followers", "Buy 10,000 followers today."));
  await receive(address, rawEmail("Kim Lee <e2e-kim@strangers.example>", "A notice", "This is the FACEBOOK ADMIN: your page will be disabled."));
  await receive(address, rawEmail("Big Giveaway Team <e2e-win@prizes.example>", "You won", "Claim your prize."));
  await receive(address, rawEmail("Acme forms <e2e-forms@relay.example>", "Contact form", "Someone wrote: how do I export my data?"));
  // The last is held while the AI check (the guidance is written) judges it, then released: a reload till it's in.
  await expect(async () => {
    await owner.goto(`/app/${slug}/inbox`);
    await expectMoreView(owner, "Needs reply 1");
  }).toPass({ timeout: 30_000 });
  await (await moreView(owner, "Spam 3")).click();
  const rows = owner.getByRole("main").getByRole("listitem");
  await expect(rows).toHaveCount(3);
  // The conversation says which rule.
  await rows.filter({ hasText: "A notice" }).getByRole("link").click();
  await expect(owner.locator(".inbox-spam-notice")).toContainText("Marked as spam: it matches your rule “Subject or body contains Facebook Admin”");
  // An owner may take it out with the rule that filed it.
  await expect(owner.locator(".inbox-spam-notice").getByRole("button", { name: "Not spam, and remove the rule" })).toBeVisible();
  await checkpoint(owner, "filed-by-a-rule", { fullPage: false });

  // Removed (under its ⋯), the domain's next email arrives.
  await owner.goto(`/app/${slug}/settings/spam`);
  await rules.getByRole("button", { name: "Actions for Sender domain is spam-corp.example" }).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await expect(owner.getByText("Rule removed")).toBeVisible();
  await expect(rules.getByRole("listitem")).toHaveCount(2);
  // Its row and menu are gone: the keyboard's focus is in the value field.
  await expect(rules.getByLabel("Value")).toBeFocused();
  await receive(address, rawEmail("Lee Roe <e2e-lee@mail.spam-corp.example>", "Followers, again", "Last chance."));
  // Held while the AI check judges it, then released.
  await expect(async () => {
    await owner.goto(`/app/${slug}/inbox`);
    await expectMoreView(owner, "Needs reply 2");
  }).toPass({ timeout: 30_000 });
  await expectMoreView(owner, "Spam 3");

  // An address allowed before (or over the API) is listed while it lets its sender through, so it can be removed.
  const api = await apiFor(owner, slug);
  await api("/spam", { allow: ["e2e-forms@relay.example"] }, "PATCH");
  await owner.goto(`/app/${slug}/settings/spam`);
  await expect(card("Allowed")).toContainText("Rules on their domain don't apply to them.");
  await expect(card("Allowed").getByRole("listitem")).toHaveText(["e2e-forms@relay.example"]);
  await card("Allowed").getByRole("button", { name: "Actions for e2e-forms@relay.example" }).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await expect(owner.getByText("e2e-forms@relay.example removed")).toBeVisible();
  // The card stays for this visit, with the keyboard's focus in it; on the next it's gone.
  await expect(card("Allowed")).toContainText("Nobody is allowed by name");
  await expect(card("Allowed").getByLabel("Address or domain to allow")).toBeFocused();
  await owner.reload();
  await expect(rules).toBeVisible();
  await expect(owner.getByRole("heading", { name: /^Allowed/, level: 2 })).toHaveCount(0);
});
