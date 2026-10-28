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
  // Nor under the widget's tabs.
  await reader.goto(`${cloudPortalUrl(slug)}/widget`);
  await expect(reader.getByRole("navigation", { name: "Widget" })).toBeVisible();
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

test("on the free plan, a project has up to 3 team members, invites included, and code changes, its own address and a private portal need a paid plan", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/team`);
  await expect(owner.getByText("Projects on the free plan have up to 3 team members, invites included (1 now)")).toBeVisible();
  const invite = async (email: string) => {
    await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(email);
    await owner.getByRole("button", { name: "Send invite" }).click();
  };
  for (const email of [`e2e-${randomUUID()}@example.com`, `e2e-${randomUUID()}@example.com`]) {
    await invite(email);
    await expect(owner.getByText(`Invite sent to ${email}`)).toBeVisible();
  }
  await invite(`e2e-${randomUUID()}@example.com`);
  await expect(
    owner.getByText("Projects on the free plan have up to 3 team members, invites included. Upgrade to Pro in Settings → Billing to invite more."),
  ).toBeVisible();
  await checkpoint(owner, "team-free-plan-full");

  await owner.goto(`/app/${slug}/code-changes`);
  await expect(owner.getByRole("alert").filter({ hasText: "Code changes need the Pro plan." })).toContainText(
    "Merged pull requests still go into the changelog's running draft",
  );
  await expect(owner.getByRole("alert").getByRole("link", { name: "See Billing" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await expect(owner.getByText("On this project's plan, merged pull requests go into the changelog's running draft only.")).toBeVisible();

  // A domain of its own is on Pro, a path of the team's site on Business.
  await owner.goto(`/app/${slug}/customize/address`);
  const options = owner.getByRole("radiogroup", { name: "Where your portal goes live" });
  await expect(options.getByRole("radio", { name: /Custom domain/ })).toContainText("A custom domain needs the Pro plan.");
  await expect(options.getByRole("radio", { name: /Sub-folder/ })).toContainText("A portal under a path of your site needs the Business plan.");
  await expect(options.getByRole("radio", { name: /Custom domain/ })).toHaveAttribute("aria-disabled", "true");
  await checkpoint(owner, "customize-address-free-plan");

  // A private portal and reader groups are on Business.
  await owner.goto(`/app/${slug}/settings`);
  await expect(owner.getByRole("alert").filter({ hasText: "A private portal and reader groups need the Business plan." })).toHaveText(
    "A private portal and reader groups need the Business plan. Without it, a private portal and content for reader groups are your team's only. Your settings are kept. See Billing",
  );
  await owner.getByRole("combobox", { name: "Portal access" }).click();
  await owner.getByRole("option", { name: "Private" }).click();
  await expect(owner.getByText("A private portal and reader groups need the Business plan. See Settings → Billing.", { exact: true })).toBeVisible();
  await checkpoint(owner, "settings-access-free-plan");
});

test("on Tuti's cloud, the widget launcher's icon is locked on the free plan, its colour isn't", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);

  await owner.goto(`/app/${slug}/customize/widget`);
  await expect(owner.getByText("Choosing the launcher's icon needs the Pro plan.")).toBeVisible();
  await expect(owner.getByRole("radio", { name: "Megaphone" })).toBeDisabled();
  await expect(owner.getByRole("radio", { name: "Chat" })).toBeChecked();
  await owner.getByLabel("Colour", { exact: true }).fill("#5b21b6");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Widget saved")).toBeVisible();
  await checkpoint(owner, "widget-settings-icon-locked");
});
