import { prisma } from "@tuti/db";
import { claimProjectEmail, grantLicenseCredits } from "@tuti/jobs";
import { billingFile, FAKE_STRIPE_KEY, FAKE_STRIPE_WEBHOOK_SECRET, withAppsumoPlans } from "@tuti/testkit";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";

import { formatShortDate } from "@/lib/format";
import { actAs, createProject, signUp } from "@/test/helpers";

import BillingSettingsPage from "./page";

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
// Each month's AI use, an async server component a static render can't run: not what these tests check.
vi.mock("@/components/usage-months", () => ({ UsageMonths: () => null }));

let slug: string;
let projectId: string;
beforeEach(async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", FAKE_STRIPE_KEY);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", FAKE_STRIPE_WEBHOOK_SECRET);
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  ({ slug, id: projectId } = project);
  actAs(owner);
});
afterEach(() => vi.unstubAllEnvs());

const billing = async () =>
  renderToStaticMarkup(
    (await BillingSettingsPage({ params: Promise.resolve({ project: slug }), searchParams: Promise.resolve({}) } as PageProps<"/app/[project]/settings/billing">)) as React.ReactElement,
  ).replaceAll("&#x27;", "'").replaceAll("&quot;", '"');

test("on the default plan, its own card says so; the plans for sale have Upgrade, one sold by quote neither a price nor Upgrade", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  let page = await billing();
  expect(page.match(/>Your plan</g)).toHaveLength(1);
  expect(page).toContain("Upgrade to Pro");
  expect(page).toContain("Upgrade to Business");

  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.prices = {}; }));
  page = await billing();
  // By quote: a way to ask, as on the pricing page.
  expect(page).toContain("By quote");
  expect(page).toMatch(/href="mailto:[^"]*"[^>]*>Contact us</);
  expect(page).not.toContain("Upgrade to Business");
  expect(page.match(/>Your plan</g)).toHaveLength(1);
});

test("a plan sold only yearly is shown and bought yearly, though Monthly is picked", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.prices = { year: pro.prices!.year }; }));
  const page = await billing();
  expect(page).toContain("$384 billed yearly");
  expect(page).toContain("Upgrade to Pro");
});

test("every feature: Tuti's pricing page in a new tab on Tuti's cloud; elsewhere each plan's lines, opened here", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("APP_URL", "https://tuti.so");
  let page = await billing();
  expect(page).toMatch(/<a href="https:\/\/tuti.so\/pricing" target="_blank" rel="noopener"[^>]*>Compare all features.*\(opens in a new tab\)<\/span><\/a>/);
  expect(page).not.toContain("<details");

  vi.stubEnv("APP_URL", "https://feedback.example.com");
  page = await billing();
  expect(page).not.toContain("tuti.so/pricing");
  expect(page).toMatch(/<details[^>]*><summary[^>]*>Compare all features/);
  // What the cards leave out, such as each plan's team members.
  expect(page).toContain("3 team members");
});

test("the add-on's card shows only where it's sold", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  expect(await billing()).toContain('Hide "Powered by tuti"');
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { delete config.badge; }));
  expect(await billing()).not.toContain('Hide "Powered by tuti"');
});

test("a project on a plan sold by quote sees its plan, with no price", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.prices = {}; }));
  await prisma.project.update({ where: { id: projectId }, data: { plan: "business", planStatus: "active" } });
  const page = await billing();
  expect(page).toContain("Business plan");
  expect(page).not.toContain("Not billed");
});

test("an add-on that's on shows no amount: it may be billed at an older price than the file's", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await prisma.project.update({ where: { id: projectId }, data: { plan: "pro", planInterval: "month", planStatus: "active", badgeAddOn: true, stripeSubscriptionId: `sub_${projectId}` } });
  const page = await billing();
  expect(page).toContain("Hidden on this project's plan. It ends with the plan.");
  expect(page).toContain("Show the badge again");
});

test("an add-on that's on keeps its card where it's no longer sold for the plan's billing (sold: false), so it can be removed", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile(({ badge }) => { badge!.year!.sold = false; }));
  await prisma.project.update({ where: { id: projectId }, data: { plan: "pro", planInterval: "year", planStatus: "active", badgeAddOn: true, stripeSubscriptionId: `sub_${projectId}` } });
  const page = await billing();
  expect(page).toContain("Hidden on this project's plan. It ends with the plan.");
  expect(page).toContain("Show the badge again");
  expect(page).not.toContain("Hide the badge");
});

test("a project on a plan the file no longer lists sees the plans to buy, as on the default plan", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await prisma.project.update({ where: { id: projectId }, data: { plan: "retired" } });
  const page = await billing();
  expect(page).toContain("Upgrade to Pro");
  expect(page).not.toContain("Manage plan");
});

test("a project still paying for a plan the file no longer lists is offered the add-on at its own billing's price", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => {
    config.plans = config.plans.filter(({ key }) => key !== "pro");
    config.badge!.year!.perMonth = 39;
  }));
  await prisma.project.update({ where: { id: projectId }, data: { plan: "pro", planInterval: "year", planStatus: "active", stripeSubscriptionId: `sub_${projectId}` } });
  expect(await billing()).toContain("hide it for $39 a month");
});

/** "This month"'s meter `label`, as the page says it. */
const meter = (label: string, text: string) => new RegExp(`>${label}</span><span[^>]*>${text}<`);

test("This month counts down the month's email to the project's users from its plan's limit; without plans, nothing", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  // Mid-month, so the count and the page read the same month.
  const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(month.getTime() + 14 * 24 * 60 * 60_000) });
  onTestFinished(() => void vi.useRealTimers());
  await prisma.projectEmailMonth.create({ data: { projectId, month, emails: 1234 } });
  let page = await billing();
  expect(page).toContain(">This month</h2>");
  expect(page).toMatch(meter("Emails", "0 of 1,000 left"));
  await prisma.projectEmailMonth.update({ where: { projectId_month: { projectId, month } }, data: { emails: 400 } });
  page = await billing();
  expect(page).toMatch(meter("Emails", "600 of 1,000 left"));
  expect(page).toMatch(/aria-valuemax="1000" aria-valuenow="600"[^>]*aria-label="Emails left"/);
  // A calendar month's, as the title says: no date.
  expect(page).not.toContain("Resets");
  await prisma.project.update({ where: { id: projectId }, data: { plan: "business" } });
  expect(await billing()).toMatch(meter("Emails", "400 sent"));
  vi.stubEnv("BILLING_CONFIG", "");
  expect(await billing()).not.toContain("This month");
});

test("on a license, This month has what's left of its month's emails and AI credits and when they reset; the credits under it are the others", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("AI_CREDITS", "on");
  // A trial's, from before the license: not the month's.
  await prisma.creditGrant.create({ data: { projectId, source: "PLAN", credits: 500, remaining: 500, note: "Starter trial", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000) } });
  const holder = (await prisma.teamMember.findFirstOrThrow({ where: { projectId }, select: { userId: true } })).userId;
  const license = await prisma.planLicense.create({
    data: { source: "tuti", externalKey: crypto.randomUUID(), plan: "pro", userId: holder, projectId, claimedAt: new Date(), assignedAt: new Date() },
  });
  await prisma.project.update({ where: { id: projectId }, data: { plan: "pro" } });
  await grantLicenseCredits(license.id);
  const { creditsThrough } = await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } });
  const until = formatShortDate(creditsThrough!);
  const month = await prisma.creditGrant.findFirstOrThrow({ where: { planLicenseId: license.id, kind: "AI" } });
  const monthly = month.credits.toNumber().toLocaleString("en");
  let page = await billing();
  expect(page).toContain(`>Resets ${until}</span>`);
  // The plan, one row: its name, what kind of license, and Unassign behind "⋯".
  expect(page).toMatch(/>Pro plan<\/h2><span[^>]*>Tuti license</);
  expect(page).toContain('aria-label="License options"');
  expect(page).not.toContain("doesn't renew or bill");
  expect(page).toMatch(meter("Emails", "10,000 of 10,000 left"));
  expect(page).toMatch(meter("AI credits", `${monthly} of ${monthly} left`));
  // The rest, without the month's: the trial's alone.
  expect(page).toContain(">Extra AI credits</h2>");
  const table = page.slice(page.indexOf("<table"), page.indexOf("</table>"));
  expect(table.match(/<tr/g)).toHaveLength(2);
  expect(table).toContain(">500</td>");
  expect(page).not.toContain("emails left until");
  expect(await claimProjectEmail(projectId)).toBe(true);
  await prisma.creditGrant.update({ where: { id: month.id }, data: { remaining: 1 } });
  page = await billing();
  expect(page).toMatch(meter("Emails", "9,999 of 10,000 left"));
  expect(page).toMatch(meter("AI credits", `1 of ${monthly} left`));
  // Spent, the month's credits still have their meter; what the project owes is said, as no balance is.
  await prisma.creditGrant.update({ where: { id: month.id }, data: { remaining: 0 } });
  await prisma.project.update({ where: { id: projectId }, data: { aiCreditDebt: 700 } });
  page = await billing();
  expect(page).toMatch(meter("AI credits", `0 of ${monthly} left`));
  expect(page).toContain(">Extra AI credits</h2>");
  expect(page).toContain("700 credits owed: new credits pay that first.");
  // With no others, no list.
  await prisma.project.update({ where: { id: projectId }, data: { aiCreditDebt: 0 } });
  await prisma.creditGrant.deleteMany({ where: { projectId, planLicenseId: null } });
  await prisma.project.update({ where: { id: projectId }, data: { freeCreditsGrantedAt: new Date() } });
  page = await billing();
  expect(page).not.toContain("AI credits</h2>");
  expect(page).not.toContain("<table");
});

test("the credits list says until when each lasts, day first and short", async () => {
  vi.stubEnv("AI_CREDITS", "on");
  await prisma.creditGrant.create({
    data: { projectId, source: "MANUAL", credits: 100, remaining: 100, createdAt: new Date("2026-11-17T12:00:00Z"), expiresAt: new Date("2031-01-05T12:00:00Z") },
  });
  const page = await billing();
  expect(page).toContain(">until 5 Jan 2031</td>");
});

test("on a free trial, the month's email is counted against the trial's own allowance; once it ends, against the default plan's", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.trial = { plan: "pro", days: 7, emails: 500 }; }));
  await prisma.project.update({ where: { id: projectId }, data: { trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60_000) } });
  expect(await billing()).toMatch(meter("Emails", "500 of 500 left"));
  await prisma.project.update({ where: { id: projectId }, data: { trialEndsAt: new Date(Date.now() - 60_000) } });
  expect(await billing()).toMatch(meter("Emails", "1,000 of 1,000 left"));
});

test("where plans can't be bought, a deactivated license's alert says to unassign it, and the line saying so can take the keyboard's place", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile(withAppsumoPlans));
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  const owner = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { team: { select: { userId: true }, take: 1 } } });
  const license = await prisma.planLicense.create({ data: { source: "appsumo", externalKey: crypto.randomUUID(), plan: "appsumo-1", userId: owner.team[0]!.userId, projectId, revokedAt: new Date() } });
  const page = await billing();
  expect(page).toContain("license was deactivated. Unassign it to take it off this project.");
  expect(page).not.toContain("Unassign it to choose a plan.");

  // Unassigned, the plans' line takes the button's place, focusable (UnassignLicense moves the keyboard to it).
  await prisma.planLicense.update({ where: { id: license.id }, data: { projectId: null } });
  expect(await billing()).toMatch(/<p id="plans-unavailable" tabindex="-1"[^>]*>\s*Plans can't be bought here right now\./);
});
