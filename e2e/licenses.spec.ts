import { randomUUID } from "node:crypto";

import { appsumoWebhook } from "../packages/testkit/src/appsumo-fake";
import { checkpoints } from "./checkpoint";
import { CLOUD_URL, cloudPortalUrl } from "./env";
import { expect, test } from "./fixtures";
import { createProject, fillSignUp, newPerson } from "./helpers";

/** A buyer's code from AppSumo's sign-in (the fake's), for license `key`. */
async function appsumoCode(key: string): Promise<string> {
  const response = await fetch(`${process.env.E2E_APPSUMO_URL}/_fake/code?key=${key}`, { method: "POST" });
  return ((await response.json()) as { code: string }).code;
}

// On Tuti's cloud, whose billing file has AppSumo's tiers.
test("a buyer redeems their AppSumo license, signing up on the way, assigns it to a project and unassigns it; refunded, it's deactivated", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const key = randomUUID();
  // AppSumo says it's bought and activated (tier 2), as its webhook does.
  const { body, headers } = appsumoWebhook({ event: "activate", license_key: key, tier: 2, license_status: "inactive" });
  const answer = await fetch(`${CLOUD_URL}/api/appsumo/webhook`, { method: "POST", body, headers });
  expect(await answer.json()).toEqual({ event: "activate", success: true });

  // Back from AppSumo's sign-in, signed out: to sign up, then back to redeem.
  const buyer = await newPerson(browser, CLOUD_URL);
  await buyer.goto(`/api/appsumo/redirect?code=${await appsumoCode(key)}`);
  await buyer.waitForURL("**/app/auth/sign-up**");
  await fillSignUp(buyer, "Bea Buyer", `e2e-${randomUUID()}@example.com`);
  await buyer.waitForURL("**/app/licenses/redeem**");
  await expect(buyer.getByRole("heading", { name: "Redeem your license" })).toBeVisible();
  await checkpoint(buyer, "redeem");
  await buyer.getByRole("button", { name: "Add to my account" }).click();
  await buyer.waitForURL("**/app/licenses");

  // No project yet: make one, then come back and assign the license to it.
  await expect(buyer.getByText("AppSumo Tier 2 plan")).toBeVisible();
  await expect(buyer.getByText(key)).toBeVisible();
  await expect(buyer.getByText("Not assigned to a project")).toBeVisible();
  await checkpoint(buyer, "licenses-no-project");
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(buyer, "Acme", slug, cloudPortalUrl);
  // In their menu now that they hold one.
  await buyer.getByRole("button", { name: /Bea Buyer/ }).click();
  await buyer.getByRole("menuitem", { name: "Licenses" }).click();
  await buyer.waitForURL("**/app/licenses");
  const license = `AppSumo Tier 2 license ${key}`;
  await expect(buyer.getByRole("combobox", { name: `Project for ${license}` })).toContainText("Acme");
  await checkpoint(buyer, "licenses-unassigned");
  await buyer.getByRole("button", { name: `Assign ${license}`, exact: true }).click();
  await expect(buyer.getByText("License assigned")).toBeVisible();
  await expect(buyer.getByText("On Acme")).toBeVisible();
  // The keyboard's place moves to the row's new control.
  await expect(buyer.getByRole("button", { name: `Unassign ${license}` })).toBeFocused();
  await checkpoint(buyer, "licenses-assigned");

  // Its plan is the project's.
  await buyer.goto(`/app/${slug}/settings/billing`);
  await expect(buyer.getByText("AppSumo Tier 2 plan")).toBeVisible();

  // Unassigned, the project is back on its own plan (its trial's, or the default).
  await buyer.goto("/app/licenses");
  await buyer.getByRole("button", { name: `Unassign ${license}` }).click();
  await expect(buyer.getByText("License unassigned")).toBeVisible();
  await expect(buyer.getByText("Not assigned to a project")).toBeVisible();
  // On the same page, the project is offered again: assign it back, then off for good.
  await expect(buyer.getByRole("combobox", { name: `Project for ${license}` })).toContainText("Acme");
  await buyer.getByRole("button", { name: `Assign ${license}`, exact: true }).click();
  await expect(buyer.getByText("On Acme")).toBeVisible();

  // Refunded on AppSumo: deactivated, still on its project until unassigned, which only Unassign offers.
  const refund = appsumoWebhook({ event: "deactivate", license_key: key });
  await fetch(`${CLOUD_URL}/api/appsumo/webhook`, { method: "POST", body: refund.body, headers: refund.headers });
  await buyer.reload();
  await expect(buyer.getByText("Deactivated · On Acme")).toBeVisible();
  await expect(buyer.getByRole("button", { name: `Assign ${license}`, exact: true })).toBeHidden();
  await checkpoint(buyer, "licenses-deactivated");
  await buyer.getByRole("button", { name: `Unassign ${license}` }).click();
  await expect(buyer.getByText("Deactivated · On Acme")).toBeHidden();
  await expect(buyer.getByText("Deactivated")).toBeVisible();
  // No control left in its row: the keyboard's place is its status.
  await expect(buyer.getByText("Deactivated", { exact: true })).toBeFocused();
  await expect(buyer.getByRole("button", { name: `Unassign ${license}` })).toBeHidden();
  // The project is back on its own plan.
  await buyer.goto(`/app/${slug}/settings/billing`);
  await expect(buyer.getByText("Free plan", { exact: true })).toBeVisible();
});

test("someone without licenses is told how to redeem one", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const person = await newPerson(browser, CLOUD_URL);
  await person.goto("/app/auth/sign-up");
  await fillSignUp(person, "Nora None", `e2e-${randomUUID()}@example.com`);
  await person.waitForURL((url) => url.pathname !== "/app/auth/sign-up");
  await person.goto("/app/licenses");
  await expect(person.getByText("No licenses yet")).toBeVisible();
  // Nothing in their menu for it: it's there once they hold one.
  await person.getByRole("button", { name: /Nora None/ }).click();
  await expect(person.getByRole("menuitem", { name: "Account settings" })).toBeVisible();
  await expect(person.getByRole("menuitem", { name: "Licenses" })).toBeHidden();
  await person.keyboard.press("Escape");
  await checkpoint(person, "licenses-empty");
});

test("Billing says a project's plan comes from its license, and an admin unassigns a deactivated one there", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const key = randomUUID();
  const webhook = (payload: Record<string, unknown>) => {
    const { body, headers } = appsumoWebhook(payload);
    return fetch(`${CLOUD_URL}/api/appsumo/webhook`, { method: "POST", body, headers });
  };
  await webhook({ event: "activate", license_key: key, tier: 1 });
  const owner = await newPerson(browser, CLOUD_URL);
  await owner.goto("/app/auth/sign-up");
  await fillSignUp(owner, "Otto Owner", `e2e-${randomUUID()}@example.com`);
  await owner.waitForURL((url) => url.pathname !== "/app/auth/sign-up");
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/api/appsumo/redirect?code=${await appsumoCode(key)}`);
  await owner.getByRole("button", { name: "Add to my account" }).click();
  await owner.waitForURL("**/app/licenses");
  await owner.getByRole("button", { name: `Assign AppSumo Tier 1 license ${key}`, exact: true }).click();
  await expect(owner.getByText("License assigned")).toBeVisible();

  // Billing: the license's plan, nothing to manage in Stripe, no add-on to buy.
  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByText("AppSumo Tier 1 plan")).toBeVisible();
  await expect(owner.getByText("Given by a license from AppSumo, a lifetime deal: it doesn't renew or bill.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Manage plan" })).toBeHidden();
  await expect(owner.getByText('Hide "Powered by tuti"')).toBeHidden();
  await checkpoint(owner, "team-settings-billing-license");

  // Refunded on AppSumo: the project is on the free plan, and says why it can't buy one yet.
  await webhook({ event: "deactivate", license_key: key });
  await owner.reload();
  await expect(owner.getByText("This project's AppSumo license was deactivated. Unassign it to choose a plan.")).toBeVisible();
  await checkpoint(owner, "team-settings-billing-license-deactivated");
  await owner.getByRole("button", { name: "Unassign license" }).click();
  await expect(owner.getByText("License unassigned")).toBeVisible();
  await expect(owner.getByText("Free plan", { exact: true })).toBeVisible();
  // The plans take its place, and the keyboard's place moves to the first.
  await expect(owner.getByRole("button", { name: "Upgrade to Pro" })).toBeFocused();
});
