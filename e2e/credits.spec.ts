import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { grantCredits, spendCredits } from "./credits";
import { APP_URL, portalUrl } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { apiFor, createProject, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";
import { nextDecision } from "./model";
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
  await visitor.getByRole("banner").getByRole("button", { name: "Search or ask AI" }).click();
  const box = visitor.getByRole("dialog").getByRole("combobox", { name: "Search or ask AI" });
  await box.fill(question);
  await expect(visitor.getByRole("dialog").getByRole("option").first()).toContainText("Ask AI:");
  await box.press("Enter");
  const conversation = visitor.getByRole("dialog", { name: "Assistant" }).getByRole("log", { name: "Conversation" });
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
    "AI answers, changelog drafts and Autopilot are paused",
  );
  await expect(owner.getByRole("button", { name: "Draft with AI" })).toBeDisabled();
  await expect(owner.getByRole("button", { name: "Edit with AI" })).toBeDisabled();
  await checkpoint(owner, "team-changelog-out-of-credits");

  // A merge waits, paused, for the team to resume it.
  const number = randomInt(1_000, 1_000_000);
  const pr = `Add a dark theme ${id}`;
  await mergePullRequest(installationId, { number, title: pr, files: [{ filename: "src/theme.css", patch: "+.dark { --background: #111; }" }] });
  await owner.goto(`/app/${slug}/autopilot`);
  // Every project page says so.
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toBeVisible();
  const row = owner.getByRole("listitem").filter({ hasText: pr });
  await expect(row).toContainText("Paused");
  await expect(row).toContainText("The project ran out of AI credits.");
  await checkpoint(owner, "autopilot-paused");
  await row.getByRole("button", { name: "Resume" }).click();
  await expect(owner.getByText("This project is out of AI credits. See Settings → Billing.")).toBeVisible();

  // Home says so, and lists what's paused.
  await owner.goto(`/app/${slug}`);
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toContainText(
    "AI answers, changelog drafts and Autopilot are paused",
  );
  await expect(owner.getByRole("listitem").filter({ hasText: pr })).toContainText("Paused");
  await checkpoint(owner, "home-paused");

  // The operator gives the project credits; Resume all on Home analyses it.
  expect(await grantCredits(slug, 50)).toBe(`grant: 50 credits for ${slug}, for good`);
  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Given by Tuti/ })).toContainText("Never");
  await nextDecision({ audience: { users: 0.05, internal: 0.9, dependencies: 0.03, repository_docs: 0.02 } }, pr);
  await owner.goto(`/app/${slug}`);
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Resume all" }).click();
  await expect(owner.getByText("Resumed")).toBeVisible();
  // Home reads it again by itself: nothing is paused now.
  await expect(owner.getByText("Merged pull requests not analysed yet")).toHaveCount(0);
  await expect(owner.getByRole("button", { name: "Resume all" })).toHaveCount(0);
  await owner.goto(`/app/${slug}/autopilot`);
  await expect(owner.getByText(/^Nothing to do \(1\)$/)).toBeVisible();
});

test("an owner buys AI credits on Stripe; they're added once it's paid", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await spendCredits(slug);

  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByText(/^0 AI credits$/)).toBeVisible();
  // An amount from the presets, or Other for one of its own (not both at once).
  await expect(owner.getByLabel("Amount in US dollars")).toHaveCount(0);
  await owner.getByText("Other amount", { exact: true }).click();
  await owner.getByLabel("Amount in US dollars").fill("12");
  await expect(owner.getByText("1,200 AI credits, lasting 365 days. You pay on Stripe.")).toBeVisible();
  await owner.getByText("$10", { exact: true }).click();
  await expect(owner.getByLabel("Amount in US dollars")).toHaveCount(0);
  // The journeys' rate: 100 credits a dollar, for a year.
  await expect(owner.getByText("1,000 AI credits, lasting 365 days. You pay on Stripe.")).toBeVisible();
  await checkpoint(owner, "team-settings-billing-buy");
  await owner.getByRole("button", { name: "Buy credits" }).click();

  // Stripe's page (the fake), then back to Billing with the credits.
  await expect(owner.getByRole("heading", { name: `1,000 AI credits for ${slug}` })).toBeVisible();
  await owner.getByRole("button", { name: "Pay $10.00" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?paid=1`);
  await expect(owner.getByText("Thanks for your payment.")).toBeVisible();
  await expect(owner.getByText(/^1,000 AI credits$/)).toBeVisible();
  await expect(owner.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Top-up/ })).toContainText("1,000");
  await checkpoint(owner, "team-settings-billing-paid");
});
