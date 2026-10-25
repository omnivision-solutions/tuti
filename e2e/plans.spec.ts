import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { CLOUD_URL, cloudPortalUrl } from "./env";
import { createProject, signUp } from "./helpers";

// On Tuti's cloud, which sells plans.
test("an owner starts Pro on Stripe, gets its month's AI credits, hides \"Powered by tuti\" with the add-on, and cancels the plan in Stripe's portal", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);

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

  // The "Powered by tuti" add-on: added to the plan, the badge is gone from the portal.
  await owner.getByRole("button", { name: "Hide the badge" }).click();
  const confirm = owner.getByRole("alertdialog", { name: 'Hide "Powered by tuti"?' });
  await expect(confirm).toContainText("$49 a month is added to this project's plan.");
  await confirm.getByRole("button", { name: "Hide the badge" }).click();
  await expect(owner.getByText('"Powered by tuti" is hidden')).toBeVisible();
  await expect(owner.getByText("Hidden: $49 a month on this project's plan. It ends with the plan.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Show the badge again" })).toBeVisible();
  await checkpoint(owner, "team-settings-billing-badge-add-on");
  const reader = await owner.context().newPage();
  await reader.goto(cloudPortalUrl(slug));
  await expect(reader.getByRole("banner")).toBeVisible();
  await expect(reader.getByRole("link", { name: /Powered by/ })).toHaveCount(0);
  await reader.close();
  await owner.goto(`/app/${slug}/customize/powered-by`);
  await expect(owner.getByText("Hidden with the add-on on this project's plan.")).toBeVisible();
  await expect(owner.getByLabel('Show "Powered by tuti" in the footer')).not.toBeChecked();
  await owner.goto(`/app/${slug}/settings/billing`);

  // Cancelled in Stripe's portal, it lasts until the period it's paid for ends.
  await owner.getByRole("button", { name: "Manage plan" }).click();
  await owner.getByRole("button", { name: "Cancel plan" }).click();
  await owner.getByRole("link", { name: "Return to Tuti" }).click();
  await expect(owner.getByText(/^\$39 a month · Ends on /)).toBeVisible();
});

test("on Tuti's cloud, hiding \"Powered by tuti\" on the free plan points to Billing, where paid plans can add it", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/customize/powered-by`);
  await expect(owner.getByText("Hiding it is an add-on to a paid plan.")).toBeVisible();
  await owner.getByLabel('Show "Powered by tuti" in the footer').click();
  const dialog = owner.getByRole("dialog", { name: 'Keep "Powered by tuti"?' });
  await expect(dialog).toContainText("add it to its plan in Billing: $49 a month, on Pro or Business.");
  await expect(dialog.getByRole("link", { name: "Get a licence" })).toHaveCount(0);
  await dialog.getByRole("link", { name: "See Billing" }).click();
  await expect(owner).toHaveURL(`${CLOUD_URL}/app/${slug}/settings/billing`);
  await expect(owner.getByText("Paid plans can hide the badge at the foot of the portal for $49 a month.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Hide the badge" })).toHaveCount(0);
});
