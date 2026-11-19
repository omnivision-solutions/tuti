import { randomUUID } from "node:crypto";

import pg from "pg";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { TRIAL_URL, trialPortalUrl } from "./env";
import { createProject, signUp } from "./helpers";

/** Ends the project's trial now, as if its days had passed (journeys have no other way to). */
async function endTrial(slug: string) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE project SET "trialEndsAt" = now() - interval '1 minute' WHERE slug = $1`, [slug]);
  } finally {
    await client.end();
  }
}

// On Tuti's cloud with a free trial: 7 days of Pro.
test("sign-up pitches the free trial, its days and plan from the billing file, and what Tuti does (on phones, the form near the top); not on the way to an invite", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const page = await browser.newPage({ baseURL: TRIAL_URL, viewport: { width: 1280, height: 800 } });
  await page.goto("/app/auth/sign-up");
  await expect(page.getByText("7-day free trial · No card needed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ship code. Your help center keeps up." })).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveText([
    "Help center and AI answers from your docs",
    "Autopilot keeps them current from your pull requests",
    "One inbox for chat and email",
    "Feedback board, roadmap and changelog",
  ]);
  await expect(page.getByText("Start your free trial", { exact: true })).toBeVisible();
  await expect(page.getByText("7 days of Pro. No card needed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start free trial" })).toBeVisible();
  await checkpoint(page, "sign-up-trial");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("listitem").first()).toBeHidden();
  await checkpoint(page, "sign-up-trial-phone", { fullPage: false });
  // An invite joins a team's project, starting no trial.
  await page.goto(`/app/auth/sign-up?${new URLSearchParams({ next: "/app/auth/invite/some-token" })}`);
  await expect(page.getByText("Create an account", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign up" })).toBeVisible();
  await expect(page.getByText(/free trial/)).toHaveCount(0);
});

test("a new account's first project starts a free trial: every page says what's left, Billing offers the plans, and it ends on the default plan", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, TRIAL_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, trialPortalUrl);

  const banner = owner.getByRole("alert").filter({ hasText: "left in your trial" });
  await expect(banner).toHaveText("7 days left in your trial. Choose a plan");
  await checkpoint(owner, "team-home-trial-banner");
  await owner.goto(`/app/${slug}/feedback`);
  await expect(banner).toBeVisible();

  await banner.getByRole("link", { name: "Choose a plan" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing`);
  await expect(owner.getByRole("heading", { name: "Pro trial", exact: true })).toBeVisible();
  await expect(owner.getByText(/^Ends on \d{1,2} [A-Z][a-z]+ \d{4}\. Choose a plan to keep going\.$/)).toBeVisible();
  await expect(owner.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
  await expect(owner.getByText("After your trial", { exact: true })).toBeVisible();
  // Its trial's AI credits, until it ends.
  await expect(owner.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Pro trial/ })).toContainText("500");
  await checkpoint(owner, "team-settings-billing-trial");

  // Ended: the default plan, and Billing's plans to buy.
  await endTrial(slug);
  await owner.goto(`/app/${slug}`);
  const ended = owner.getByRole("alert").filter({ hasText: "Your trial has ended" });
  await expect(ended).toHaveText("Your trial has ended. Choose a plan");
  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByText("Your trial has ended", { exact: true }).last()).toBeVisible();
  await expect(owner.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
  await checkpoint(owner, "team-settings-billing-trial-ended");

  // One trial an account: its next project starts on the default plan.
  const next = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(owner, "Acme Two", next, trialPortalUrl);
  await expect(owner.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(owner.getByText(/left in your trial|Your trial has ended/)).toHaveCount(0);
});
