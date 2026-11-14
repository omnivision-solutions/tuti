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
  await expect(owner.getByText("Pro trial", { exact: true })).toBeVisible();
  await expect(owner.getByText(/^Ends on .+\. Choose a plan to keep going\.$/)).toBeVisible();
  await expect(owner.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
  await expect(owner.getByText("$0, after your trial")).toBeVisible();
  // Its trial's AI credits, until it ends.
  await expect(owner.getByRole("table", { name: "AI credits left" })).toContainText("500");
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
