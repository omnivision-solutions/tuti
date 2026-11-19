import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { appsumoWebhook } from "../packages/testkit/src/appsumo-fake";
import { checkpoints } from "./checkpoint";
import { useUpLicenseEmails } from "./email-days";
import { CLOUD_URL, cloudEnv, cloudPortalUrl, SUPPORT_EMAIL_DOMAIN } from "./env";
import { expect, test } from "./fixtures";
import { createProject, fillSignUp, newPerson } from "./helpers";
import { rawEmail, receive } from "./inbound";

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

  // No project yet: the project they make next gets the license, not a trial.
  await expect(buyer.getByText("AppSumo Tier 2 plan")).toBeVisible();
  await expect(buyer.getByText(key)).toBeVisible();
  await expect(buyer.getByText("Not assigned to a project")).toBeVisible();
  await checkpoint(buyer, "licenses-no-project");
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(buyer, "Acme", slug, cloudPortalUrl);
  await buyer.goto(`/app/${slug}/settings/billing`);
  await expect(buyer.getByRole("heading", { name: "AppSumo Tier 2", exact: true })).toBeVisible();
  await expect(buyer.getByText(/left in your trial/)).toBeHidden();
  // In their menu now that they hold one.
  await buyer.getByRole("button", { name: /Bea Buyer/ }).click();
  await buyer.getByRole("menuitem", { name: "Licenses" }).click();
  await buyer.waitForURL("**/app/licenses");
  const license = `AppSumo Tier 2 license ${key}`;
  await expect(buyer.getByText("On Acme")).toBeVisible();
  await checkpoint(buyer, "licenses-assigned");

  // Unassigned, the project is back on its own plan (its trial's, or the default).
  await buyer.goto("/app/licenses");
  await buyer.getByRole("button", { name: `Unassign ${license}` }).click();
  await expect(buyer.getByText("License unassigned")).toBeVisible();
  await expect(buyer.getByText("Not assigned to a project")).toBeVisible();
  // On the same page, the project is offered again: assign it back, then off for good.
  await expect(buyer.getByRole("combobox", { name: `Project for ${license}` })).toContainText("Acme");
  // A second tab left showing it unassigned (used once the license is refunded, below).
  const stale = await buyer.context().newPage();
  await stale.goto("/app/licenses");
  await expect(stale.getByRole("button", { name: `Assign ${license}`, exact: true })).toBeVisible();
  await checkpoint(buyer, "licenses-unassigned");
  await buyer.getByRole("button", { name: `Assign ${license}`, exact: true }).click();
  await expect(buyer.getByText("License assigned")).toBeVisible();
  await expect(buyer.getByText("On Acme")).toBeVisible();
  // The keyboard's place moves to the row's new control.
  await expect(buyer.getByRole("button", { name: `Unassign ${license}` })).toBeFocused();

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
  // The stale tab still offers Assign: refused, and its row shows the license as it is now, the keyboard on its status.
  await stale.getByRole("button", { name: `Assign ${license}`, exact: true }).click();
  await expect(stale.getByText("This license was revoked by where it came from, so it gives no plan")).toBeVisible();
  await expect(stale.getByRole("button", { name: `Assign ${license}`, exact: true })).toBeHidden();
  await expect(stale.getByText("Deactivated", { exact: true })).toBeFocused();
  await stale.close();
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

/** Billing's page, whatever its query (`?badge=1` after Stripe): where its actions post. */
const billingPage = (url: URL) => url.pathname.endsWith("/settings/billing");

test("Billing says a project's plan comes from its license and unassigns it, asking first while it gives its plan", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const key = randomUUID();
  const webhook = (payload: Record<string, unknown>) => {
    const { body, headers } = appsumoWebhook(payload);
    return fetch(`${CLOUD_URL}/api/appsumo/webhook`, { method: "POST", body, headers });
  };
  const owner = await newPerson(browser, CLOUD_URL);
  await owner.goto("/app/auth/sign-up");
  await fillSignUp(owner, "Otto Owner", `e2e-${randomUUID()}@example.com`);
  await owner.waitForURL((url) => url.pathname !== "/app/auth/sign-up");
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/api/appsumo/redirect?code=${await appsumoCode(key)}`);
  // Before AppSumo's activation arrives: refused, and the keyboard stays on the button to try again.
  const add = owner.getByRole("button", { name: "Add to my account" });
  await add.focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("alert").filter({ hasText: "We haven't heard from AppSumo about this license yet. Try again in a minute." })).toBeVisible();
  await expect(add).toBeFocused();
  await webhook({ event: "activate", license_key: key, tier: 1 });
  await add.click();
  await owner.waitForURL("**/app/licenses");
  await owner.getByRole("button", { name: `Assign AppSumo Tier 1 license ${key}`, exact: true }).click();
  await expect(owner.getByText("License assigned")).toBeVisible();

  // Billing: the license's plan, nothing to manage in Stripe; the add-on is bought on its own.
  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByRole("heading", { name: "AppSumo Tier 1", exact: true })).toBeVisible();
  await expect(owner.getByText("Lifetime", { exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Manage plan" })).toBeHidden();
  await expect(owner.getByText("$49 a month, billed monthly on its own.")).toBeVisible();
  // This month: what's left of the license's month's emails, and when the month resets.
  await expect(owner.getByText(/^Resets \d{1,2} [A-Z][a-z]+( \d{4})?$/)).toBeVisible();
  await expect(owner.getByText("4,000 of 4,000 left")).toBeVisible();
  await expect(owner.getByRole("progressbar", { name: "Emails left" })).toHaveAttribute("aria-valuenow", "4000");
  await checkpoint(owner, "team-settings-billing-license");
  await owner.getByRole("button", { name: "Hide the badge" }).click();
  const confirm = owner.getByRole("alertdialog", { name: 'Hide "Powered by tuti"?' });
  await expect(confirm).toContainText("$49 a month, billed monthly on its own until you show the badge again or the license is unassigned.");
  await confirm.getByRole("button", { name: "Hide the badge" }).click();
  // Stripe's page (the fake), then back to Billing with the badge hidden; the license still gives the plan.
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?badge=1`);
  await expect(owner.getByText("Hidden on this project, billed on its own. It ends with the license.")).toBeVisible();
  await expect(owner.getByRole("heading", { name: "AppSumo Tier 1", exact: true })).toBeVisible();
  // Its card and invoices are in Stripe's portal.
  await expect(owner.getByRole("button", { name: "Manage plan" })).toBeVisible();
  await checkpoint(owner, "team-settings-billing-license-badge");
  // Showing the badge again asks first: the add-on stops at once, with no refund.
  await owner.getByRole("button", { name: "Show the badge again" }).click();
  const show = owner.getByRole("alertdialog", { name: 'Show "Powered by tuti" again?' });
  await expect(show).toContainText("The add-on stops now. What's left of the month or year you paid for isn't refunded.");
  await checkpoint(owner, "team-settings-billing-license-show-badge", { fullPage: false });
  await show.getByRole("button", { name: "Cancel" }).click();
  await expect(show).toBeHidden();
  await expect(owner.getByText("Hidden on this project, billed on its own. It ends with the license.")).toBeVisible();
  // Confirmed: the badge is back, no dialog is left open, and the keyboard is on the offer to hide it.
  await owner.getByRole("button", { name: "Show the badge again" }).click();
  await show.getByRole("button", { name: "Show the badge again" }).click();
  await expect(owner.getByText('"Powered by tuti" is back on your portal')).toBeVisible();
  await expect(owner.getByRole("alertdialog")).toHaveCount(0);
  await expect(owner.getByText("$49 a month, billed monthly on its own.")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Hide the badge" })).toBeFocused();
  // Hidden again, for what follows. While Stripe's page is made (held here), the dialog's button is off and keeps the keyboard.
  await owner.getByRole("button", { name: "Hide the badge" }).click();
  let opened!: () => void;
  const opening = new Promise<void>((resolve) => (opened = resolve));
  await owner.route(billingPage, async (route) => {
    if (route.request().method() === "POST") {
      await opening;
    }
    await route.fallback();
  });
  await confirm.getByRole("button", { name: "Hide the badge" }).focus();
  await owner.keyboard.press("Enter");
  await expect(confirm.getByRole("button", { name: "Opening Stripe…" })).toBeDisabled();
  await expect(confirm.getByRole("button", { name: "Opening Stripe…" })).toBeFocused();
  opened();
  await owner.unroute(billingPage);
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?badge=1`);
  await expect(owner.getByText("Hidden on this project, billed on its own. It ends with the license.")).toBeVisible();
  // Unassigning it from Licenses says the add-on stops with it, and asks first.
  await owner.goto("/app/licenses");
  await owner.getByRole("button", { name: `Unassign AppSumo Tier 1 license ${key}`, exact: true }).click();
  const fromLicenses = owner.getByRole("alertdialog", { name: "Unassign this license?" });
  await expect(fromLicenses).toContainText(`Acme's "Powered by tuti" add-on stops now, and what's left of the month or year isn't refunded.`);
  await fromLicenses.getByRole("button", { name: "Cancel" }).click();
  await expect(fromLicenses).toBeHidden();
  // Confirmed, it's unassigned and the add-on ends; assigned and hidden again, for what follows.
  await owner.getByRole("button", { name: `Unassign AppSumo Tier 1 license ${key}`, exact: true }).click();
  await fromLicenses.getByRole("button", { name: "Unassign" }).click();
  await expect(owner.getByText("License unassigned")).toBeVisible();
  await expect(fromLicenses).toBeHidden();
  await owner.getByRole("button", { name: `Assign AppSumo Tier 1 license ${key}`, exact: true }).click();
  await expect(owner.getByText("License assigned")).toBeVisible();
  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByText("$49 a month, billed monthly on its own.")).toBeVisible();
  await owner.getByRole("button", { name: "Hide the badge" }).click();
  await confirm.getByRole("button", { name: "Hide the badge" }).click();
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?badge=1`);
  await expect(owner.getByText("Hidden on this project, billed on its own. It ends with the license.")).toBeVisible();
  // Unassigning it here (behind "⋯") asks first: only its holder can assign it again.
  await owner.getByRole("button", { name: "License options" }).click();
  await owner.getByRole("menuitem", { name: "Unassign license" }).click();
  const dialog = owner.getByRole("alertdialog", { name: "Unassign this license?" });
  await expect(dialog).toContainText(`This project loses the license's plan until the license's holder assigns it again. Its "Powered by tuti" add-on stops now, and what's left of the month or year isn't refunded.`);
  await checkpoint(owner, "team-settings-billing-unassign-license", { fullPage: false });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(owner.getByRole("heading", { name: "AppSumo Tier 1", exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "License options" }).click();
  await owner.getByRole("menuitem", { name: "Unassign license" }).click();
  // While it runs (its request held here), the dialog's button is off: a second press can't send it again.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await owner.route(billingPage, async (route) => {
    if (route.request().method() === "POST") {
      await held;
    }
    await route.fallback();
  });
  // Pressed from the keyboard, it keeps the keyboard's place while it runs (a refusal leaves the dialog open on it).
  await dialog.getByRole("button", { name: "Unassign license" }).focus();
  await owner.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Unassigning…" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Unassigning…" })).toBeFocused();
  release();
  await owner.unroute(billingPage);
  await expect(owner.getByText("Free plan", { exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Upgrade to Pro" })).toBeFocused();
  // The add-on ended with it.
  await expect(owner.getByRole("link", { name: "Choose a plan" })).toBeVisible();
  // Its holder assigns it again.
  await owner.goto("/app/licenses");
  await owner.getByRole("button", { name: `Assign AppSumo Tier 1 license ${key}`, exact: true }).click();
  await expect(owner.getByText("License assigned")).toBeVisible();
  await owner.goto(`/app/${slug}/settings/billing`);

  // Refunded on AppSumo: the project is on the free plan, and says why it can't buy one yet.
  await webhook({ event: "deactivate", license_key: key });
  await owner.reload();
  await expect(owner.getByText("This project's AppSumo license was deactivated. Unassign it to choose a plan.")).toBeVisible();
  await checkpoint(owner, "team-settings-billing-license-deactivated");
  // Deactivated, it gives no plan: unassigning it doesn't ask.
  await owner.getByRole("button", { name: "Unassign license" }).click();
  await expect(owner.getByText("License unassigned")).toBeVisible();
  await expect(owner.getByText("Free plan", { exact: true })).toBeVisible();
  // The plans take its place, and the keyboard's place moves to the first.
  await expect(owner.getByRole("button", { name: "Upgrade to Pro" })).toBeFocused();

  // Deactivated by an upgrade's old key (its new key not here yet), the add-on is kept: unassigning then asks first, about it alone.
  const next = randomUUID();
  await webhook({ event: "activate", license_key: next, tier: 1 });
  await owner.goto(`/api/appsumo/redirect?code=${await appsumoCode(next)}`);
  await owner.getByRole("button", { name: "Add to my account" }).click();
  await owner.waitForURL("**/app/licenses");
  await owner.getByRole("button", { name: `Assign AppSumo Tier 1 license ${next}`, exact: true }).click();
  await expect(owner.getByText("License assigned")).toBeVisible();
  await owner.goto(`/app/${slug}/settings/billing`);
  await owner.getByRole("button", { name: "Hide the badge" }).click();
  await confirm.getByRole("button", { name: "Hide the badge" }).click();
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await expect(owner.getByText("Hidden on this project, billed on its own. It ends with the license.")).toBeVisible();
  await webhook({ event: "deactivate", license_key: next, tier: 1, extra: { reason: "Upgraded by the customer" } });
  await owner.reload();
  await owner.getByRole("button", { name: "Unassign license" }).click();
  await expect(dialog).toHaveAccessibleDescription(`Its "Powered by tuti" add-on stops now, and what's left of the month or year isn't refunded.`);
  await dialog.getByRole("button", { name: "Unassign license" }).click();
  await expect(owner.getByText("License unassigned")).toBeVisible();
});

// A license Tuti hands out itself (scripts/plan-license.mjs), straight onto a project: no lifetime deal.
test("a license Tuti issues to a project gives its plan, named as Tuti's", async ({ browser }) => {
  const owner = await newPerson(browser, CLOUD_URL);
  const email = `e2e-${randomUUID()}@example.com`;
  await owner.goto("/app/auth/sign-up");
  await fillSignUp(owner, "Tia Team", email);
  await owner.waitForURL((url) => url.pathname !== "/app/auth/sign-up");
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  const { stdout } = await promisify(execFile)("node", ["scripts/plan-license.mjs", "issue", email, "appsumo-2", slug, "e2e"], {
    env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL, BILLING_CONFIG: cloudEnv.BILLING_CONFIG },
  });
  const key = /tuti-[0-9a-f-]+/.exec(stdout)![0];

  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByRole("heading", { name: "AppSumo Tier 2", exact: true })).toBeVisible();
  await expect(owner.getByText("Tuti license", { exact: true })).toBeVisible();
  await owner.goto("/app/licenses");
  await expect(owner.getByText("Plan licenses on your account, such as AppSumo lifetime deals.", { exact: false })).toBeVisible();
  await expect(owner.getByText(`Tuti · ${key}`)).toBeVisible();
  await expect(owner.getByText("On Acme")).toBeVisible();
});

test("a licensed project whose month's emails are used: Billing says none are left, and a reply waits for the license's next month", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const key = randomUUID();
  const owner = await newPerson(browser, CLOUD_URL);
  await owner.goto("/app/auth/sign-up");
  await fillSignUp(owner, "Una Used", `e2e-${randomUUID()}@example.com`);
  await owner.waitForURL((url) => url.pathname !== "/app/auth/sign-up");
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  const { body, headers } = appsumoWebhook({ event: "activate", license_key: key, tier: 1 });
  await fetch(`${CLOUD_URL}/api/appsumo/webhook`, { method: "POST", body, headers });
  await owner.goto(`/api/appsumo/redirect?code=${await appsumoCode(key)}`);
  await owner.getByRole("button", { name: "Add to my account" }).click();
  await owner.waitForURL("**/app/licenses");
  await owner.getByRole("button", { name: `Assign AppSumo Tier 1 license ${key}`, exact: true }).click();
  await expect(owner.getByText("License assigned")).toBeVisible();
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByText("No email received yet.")).toBeVisible();
  await receive(`support@${slug}.${SUPPORT_EMAIL_DOMAIN}`, rawEmail("Kim Lee <e2e-kim@example.com>", "Invoice missing", "Where's my October invoice?"));
  await useUpLicenseEmails(slug);

  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByText("0 of 4,000 left", { exact: true })).toBeVisible();
  // Billing and the inbox write the day alike, short as en-GB has it ("5 Sept").
  const until = /^Resets (\d{1,2} [A-Z][a-z]+)( \d{4})?$/;
  await expect(owner.getByText(until)).toBeVisible();
  const [, day] = until.exec((await owner.getByText(until).textContent())!)!;
  await owner.goto(`/app/${slug}/inbox/1`);
  await expect(owner.locator(".inbox-email-waits")).toHaveText(`This month's emails from your license are used: replies are emailed on ${day}. Billing`);
  await checkpoint(owner, "reply-waits-for-license-month");
  // Sent, it's saved, its email held: said as it's sent, and under the reply, short, with the whole reason as its title.
  const why = `Emailed ${day}: your license's emails for this month are used (Settings → Billing)`;
  await owner.getByRole("textbox", { name: "Reply" }).fill("It's under Billing.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByRole("region", { name: /Notifications/ })).toContainText(why);
  await owner.goto(`/app/${slug}/inbox/1?view=waiting`);
  await expect(owner.getByTitle(why).locator("[aria-hidden]")).toHaveText(`Emailed ${day}`);
  await expect(owner.getByTitle(why).locator(".sr-only")).toHaveText(why);
});
