import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { grantCredits, spendCredits } from "./credits";
import { APP_URL, portalUrl } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { apiFor, createProject, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";
import { nextDecision, nextDocsAgentAnswer } from "./model";
import { similar } from "./openai";

test("out of AI credits, each feature pauses its own way; with credits again, a paused code change resumes", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  // Verified, so Tuti emails them about the project's credits.
  await owner.goto(linkIn(await latestEmailTo(owner.email), `${APP_URL}/api/auth/verify-email`));
  const api = await apiFor(owner, slug);
  const question = `How do I add a colleague (${id})?`;
  const body = "Owners and admins send invites from the Team page.";
  await similar(question, `Inviting your team\n\n${body}`, 0.8);
  const article = await api("/articles", { title: "Inviting your team", body });
  await api(`/articles/${article.slug}/publish`, {});
  const entry = await api("/changelog", { title: "Next release", body: "Dark mode is here." });
  const installationId = await connectGithub(owner, slug);
  await spendCredits(slug);
  const emailsBefore = countEmailsTo(owner.email);

  // A visitor's question: no AI answer, the closest article instead.
  const visitor = await signUp(browser, portalUrl(slug), "Vera Visitor");
  await visitor.goto("/docs");
  await visitor.getByRole("button", { name: "Search or ask AI" }).click();
  const box = visitor.getByRole("dialog").getByRole("combobox", { name: "Search or ask AI" });
  await box.fill(question);
  await expect(visitor.getByRole("dialog").getByRole("option").first()).toContainText("Ask AI:");
  await box.press("Enter");
  const conversation = visitor.frameLocator('iframe[title="Feedback"]').getByRole("dialog", { name: "Assistant" }).getByRole("log", { name: "Conversation" });
  await expect(conversation.getByText("AI answers aren't available right now.")).toBeVisible();
  await expect(conversation.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await expect(conversation.getByRole("link", { name: "Post this as feedback" })).toBeVisible();
  await checkpoint(visitor, "portal-assistant-out-of-credits", { fullPage: false });

  // That's when the owner hears the AI stopped (the credits ran out without a charge here).
  const email = await latestEmailTo(owner.email, { after: emailsBefore });
  expect(email.subject).toBe("Acme is out of AI credits");
  expect(linkIn(email, APP_URL)).toBe(`${APP_URL}/app/${slug}/settings/billing`);

  // The changelog's AI: shown, disabled, and why.
  await owner.goto(`/app/${slug}/changelog/${entry.number}`);
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toContainText(
    "AI answers, Ask a person summaries, inbox drafts and summaries, changelog drafts, Autopilot and Verify are paused",
  );
  // Its one way in, Edit with AI (Draft with AI is in its menu).
  await expect(owner.getByRole("button", { name: "Edit with AI" })).toBeDisabled();
  await expect(owner.getByRole("button", { name: "Edit with AI" })).toHaveAttribute("title", "This project is out of AI credits");
  await checkpoint(owner, "team-changelog-out-of-credits");

  // The inbox's Summarize says why it's off, in the menu itself (a disabled item shows no tooltip).
  await api("/conversations", { email: `e2e-kim-${id}@example.com`, subject: "Invoices", body: "Where's my invoice?" });
  await owner.goto(`/app/${slug}/inbox/1`);
  await owner.getByRole("button", { name: "More actions" }).first().click();
  await expect(owner.getByRole("menuitem", { name: "Summarize with AI: out of AI credits" })).toBeDisabled();
  await owner.keyboard.press("Escape");

  // A merge waits, paused, for the team to resume it.
  const number = randomInt(1_000, 1_000_000);
  const pr = `Add a dark theme ${id}`;
  await mergePullRequest(installationId, { number, title: pr, files: [{ filename: "src/theme.css", patch: "+.dark { --background: #111; }" }] });
  // Its line is in the running draft; the changelog's list leads to its notes with Write it, not Draft with AI.
  await owner.goto(`/app/${slug}/changelog`);
  const running = owner.getByRole("region", { name: "Drafts" }).getByRole("listitem").filter({ hasText: "Collecting pull requests" });
  await expect(running.getByRole("link", { name: "Write it" })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Draft with AI" })).toHaveCount(0);
  await owner.goto(`/app/${slug}/autopilot`);
  // Every project page says so.
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toBeVisible();
  // It's under Activity, which To review points to.
  await owner.getByRole("button", { name: "see Activity" }).click();
  const row = owner.getByRole("listitem").filter({ hasText: pr });
  await expect(row).toContainText("Paused");
  await expect(row).toContainText("The project ran out of AI credits.");
  await checkpoint(owner, "autopilot-paused");
  await row.getByRole("button", { name: "Resume" }).click();
  await expect(owner.getByText("This project is out of AI credits. See Settings → Billing.")).toBeVisible();

  // Home says so, and lists what's paused.
  await owner.goto(`/app/${slug}`);
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toContainText(
    "AI answers, Ask a person summaries, inbox drafts and summaries, changelog drafts, Autopilot and Verify are paused",
  );
  await expect(owner.getByRole("listitem").filter({ hasText: pr })).toContainText("Paused");
  await checkpoint(owner, "home-paused");

  // The operator gives the project credits; Resume all on Home analyses it.
  expect(await grantCredits(slug, 50)).toBe(`grant: 50 credits for ${slug}, for good`);
  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Given by Tuti/ })).toContainText("Never");
  await expect(owner.getByRole("group", { name: "Balance" }).getByText("50 of 50 left")).toBeVisible();
  await nextDecision({ audience: { users: 0.05, internal: 0.9, dependencies: 0.03, repository_docs: 0.02 } }, pr);
  // (And the docs agent finds nothing either.)
  await nextDocsAgentAnswer(number, {});
  await owner.goto(`/app/${slug}`);
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Resume all" }).click();
  await expect(owner.getByText("Resumed")).toBeVisible();
  // Home reads it again by itself: nothing is paused now.
  await expect(owner.getByText("Merged pull requests not analysed yet")).toHaveCount(0);
  await expect(owner.getByRole("button", { name: "Resume all" })).toHaveCount(0);
  await owner.goto(`/app/${slug}/autopilot`);
  await owner.getByRole("tab", { name: "Activity" }).click();
  await expect(owner.getByText(/^Nothing to do \(1\)$/)).toBeVisible();
});

test("an owner buys AI credits on Stripe; they're added once it's paid", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await spendCredits(slug);

  await owner.goto(`/app/${slug}/settings/billing`);
  // A self-hosted server sells no plans: its credits (none left here) and buying more, in one card, then its AI use.
  await expect(owner.getByRole("heading", { name: "AI credits", exact: true })).toBeVisible();
  await expect(owner.getByRole("group", { name: "Balance" })).toContainText("No credits left.");
  await expect(owner.getByText("No AI use yet.")).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Plan", exact: true })).toHaveCount(0);
  // An amount from the presets, or Other for one of its own (not both at once), beside the button that buys it.
  const amounts = owner.getByRole("radiogroup", { name: "Amount" });
  const buy = owner.getByRole("button", { name: "Buy", exact: true });
  await expect(amounts.getByRole("radio", { name: "$25" })).toBeChecked();
  await expect(owner.getByLabel("Amount in US dollars")).toHaveCount(0);
  await amounts.getByText("Other", { exact: true }).click();
  await owner.getByLabel("Amount in US dollars").fill("12");
  await expect(owner.getByText("1,200 AI credits, lasting 365 days.", { exact: true })).toBeVisible();
  // Outside what can be bought, the line says the range and Buy is off.
  await owner.getByLabel("Amount in US dollars").fill("0");
  await expect(owner.getByText(/^From \$\d+ to \$[\d,]+, lasting 365 days\.$/)).toBeVisible();
  await expect(buy).toBeDisabled();
  await amounts.getByText("$10", { exact: true }).click();
  await expect(owner.getByLabel("Amount in US dollars")).toHaveCount(0);
  // The journeys' rate: 100 credits a dollar, for a year.
  await expect(owner.getByText("1,000 AI credits, lasting 365 days.", { exact: true })).toBeVisible();
  // One row: the amounts and Buy on the label's line.
  const label = (await owner.getByText("Buy AI credits", { exact: true }).boundingBox())!;
  const control = (await amounts.boundingBox())!;
  expect(control.y).toBeLessThan(label.y + label.height);
  expect(control.x).toBeGreaterThan(label.x + label.width);
  await checkpoint(owner, "team-settings-billing-buy");
  // In dark mode too the picked amount stands out from the others by more than its text.
  await owner.emulateMedia({ colorScheme: "dark" });
  // The theme follows the system's a moment later (next-themes): compared once it's dark.
  await expect(owner.locator("html")).toHaveClass(/\bdark\b/);
  const look = (amount: string) => amounts.locator("label").filter({ hasText: new RegExp(`^\\${amount}$`) }).evaluate((label) => getComputedStyle(label).backgroundColor);
  await expect.poll(async () => (await look("$10")) !== (await look("$25"))).toBe(true);
  await checkpoint(owner, "team-settings-billing-buy-dark");
  await owner.emulateMedia({ colorScheme: "light" });
  await expect(owner.locator("html")).not.toHaveClass(/\bdark\b/);
  // On a phone: nothing runs off the side, and the amounts go under the label.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => owner.locator('[data-slot="pane-body"]').last().evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const phoneLabel = (await owner.getByText("Buy AI credits", { exact: true }).boundingBox())!;
  expect((await amounts.boundingBox())!.y).toBeGreaterThanOrEqual(phoneLabel.y + phoneLabel.height);
  await checkpoint(owner, "team-settings-billing-buy-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  // From the keyboard: while Stripe's page is being opened (its request held here), Buy is off but keeps the focus.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await owner.route("**/settings/billing", async (route) => {
    if (route.request().method() === "POST") {
      await held;
    }
    await route.fallback();
  });
  await buy.focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("button", { name: "Opening Stripe…" })).toBeDisabled();
  await expect(owner.getByRole("button", { name: "Opening Stripe…" })).toBeFocused();
  release();

  // Stripe's page (the fake), then back to Billing with the credits.
  await expect(owner.getByRole("heading", { name: `1,000 AI credits for ${slug}` })).toBeVisible();
  await owner.getByRole("button", { name: "Pay $10.00" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?paid=1`);
  await expect(owner.getByText("Thanks for your payment.")).toBeVisible();
  await expect(owner.getByRole("group", { name: "Balance" }).getByText("1,000 of 1,000 left")).toBeVisible();
  await expect(owner.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Top-up/ })).toContainText("1,000");
  await checkpoint(owner, "team-settings-billing-paid");
});
