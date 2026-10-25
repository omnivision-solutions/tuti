import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { createProject, signUp } from "./helpers";

test("an owner starts Pro on Stripe, gets its month's AI credits, and cancels it in Stripe's portal", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByText("Free plan", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Yearly" }).click();
  await expect(owner.getByText("$32 a month, billed yearly")).toBeVisible();
  await owner.getByRole("button", { name: "Monthly" }).click();
  await expect(owner.getByText("$39 a month", { exact: true })).toBeVisible();
  await checkpoint(owner, "team-settings-billing-free-plan");
  await owner.getByRole("button", { name: "Upgrade to Pro" }).click();

  // Stripe's page (the fake), then back to Billing on Pro, with its credits for the month.
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?subscribed=1`);
  await expect(owner.getByText("Pro plan", { exact: true })).toBeVisible();
  await expect(owner.getByText(/^\$39 a month · Renews on /)).toBeVisible();
  await expect(owner.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Plan/ })).toContainText("1,000");
  await checkpoint(owner, "team-settings-billing-pro-plan");

  // Cancelled in Stripe's portal, it lasts until the period it's paid for ends.
  await owner.getByRole("button", { name: "Manage plan" }).click();
  await owner.getByRole("button", { name: "Cancel plan" }).click();
  await owner.getByRole("link", { name: "Return to Tuti" }).click();
  await expect(owner.getByText(/^\$39 a month · Ends on /)).toBeVisible();
});
