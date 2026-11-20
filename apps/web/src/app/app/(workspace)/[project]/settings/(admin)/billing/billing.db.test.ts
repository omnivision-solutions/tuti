import { prisma } from "@tuti/db";
import { claimProjectEmail, grantLicenseCredits } from "@tuti/jobs";
import { billingFile, FAKE_STRIPE_KEY, FAKE_STRIPE_WEBHOOK_SECRET, withAppsumoPlans } from "@tuti/testkit";
import { defaultPlanKey } from "@tuti/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";

import { PlanPicker } from "@/components/plan-picker";
import { formatShortDate } from "@/lib/format";
import { plansWithFacts, pricingPage } from "@/lib/pricing-plans";
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

/** The plans "Upgrade" opens (its dialog is closed in the page's markup), from the billing file as the page gives them. */
const picker = () =>
  renderToStaticMarkup(createElement(PlanPicker, { projectSlug: slug, plans: plansWithFacts(), pricingPage: pricingPage(), current: defaultPlanKey()! }))
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');

test("on the default plan, one row says the plan and what it gives, with Upgrade; the plans it opens have their own Upgrade, one sold by quote neither a price nor Upgrade", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  const row = await billing();
  expect(row).toMatch(/>Free<\/span><span[^>]*>Your plan<\/span>/);
  expect(row).toContain(">1,000 emails a month · 2 feedback boards</p>");
  expect(row).toMatch(/<button[^>]*data-plans-control[^>]*>Upgrade<\/button>/);
  // The plans themselves wait behind it.
  expect(row).not.toContain("Upgrade to Pro");
  let page = picker();
  expect(page.match(/>Your plan</g)).toHaveLength(1);
  expect(page).toContain("Upgrade to Pro");
  expect(page).toContain("Upgrade to Business");

  vi.stubEnv("BILLING_CONFIG", billingFile((_, { business }) => { business.prices = {}; }));
  page = picker();
  // By quote: a way to ask, as on the pricing page.
  expect(page).toContain("By quote");
  expect(page).toMatch(/href="mailto:[^"]*"[^>]*>Contact us</);
  expect(page).not.toContain("Upgrade to Business");
  expect(page.match(/>Your plan</g)).toHaveLength(1);
});

test("a plan sold only yearly is shown and bought yearly, though Monthly is picked", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { pro }) => { pro.prices = { year: pro.prices!.year }; }));
  const page = picker();
  expect(page).toContain("$384 billed yearly");
  expect(page).toContain("Upgrade to Pro");
});

test("every feature: Tuti's pricing page in a new tab on Tuti's cloud; elsewhere each plan's lines, opened here", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("APP_URL", "https://tuti.so");
  let page = picker();
  expect(page).toMatch(/<a href="https:\/\/tuti.so\/pricing" target="_blank" rel="noopener"[^>]*>Compare all features.*\(opens in a new tab\)<\/span><\/a>/);
  expect(page).not.toContain("<details");

  vi.stubEnv("APP_URL", "https://feedback.example.com");
  page = picker();
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
  expect(page).toMatch(/>Business<\/span><span[^>]*>Your plan<\/span>/);
  expect(page).toContain("Manage plan");
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

test("a project on a plan the file no longer lists has Upgrade, as on the default plan", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await prisma.project.update({ where: { id: projectId }, data: { plan: "retired" } });
  const page = await billing();
  expect(page).toContain("data-plans-control");
  expect(page).not.toContain("Manage plan");
});

test("a project still paying for a plan the file no longer lists is offered the add-on at its own billing's price", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => {
    config.plans = config.plans.filter(({ key }) => key !== "pro");
    config.badge!.year!.perMonth = 39;
  }));
  await prisma.project.update({ where: { id: projectId }, data: { plan: "pro", planInterval: "year", planStatus: "active", stripeSubscriptionId: `sub_${projectId}` } });
  expect(await billing()).toContain("$39 a month, added to this project's plan.");
});

/** "This month"'s meter `label`, as the page says it. */
const meter = (label: string, text: string) => new RegExp(`>${label}</span><span[^>]*>${text.replace(/ of (.+) left$/, " <span[^>]*>of $1 left")}<`);

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
  expect(page).toMatch(/>Pro<\/span><span[^>]*>Tuti license</);
  expect(page).toContain('aria-label="License options"');
  expect(page).not.toContain("doesn't renew or bill");
  expect(page).toMatch(meter("Emails", "10,000 of 10,000 left"));
  expect(page).toMatch(meter("AI credits", `${monthly} of ${monthly} left`));
  // The rest, without the month's: the trial's alone.
  expect(page).toContain(">Extra AI credits</h3>");
  const table = page.slice(page.indexOf("<table"), page.indexOf("</table>"));
  expect(table.match(/<tr/g)).toHaveLength(2);
  expect(table).toContain(">500</td>");
  // Named for what gave them, not "Plan".
  expect(table).toContain(">Starter trial</td>");
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
  expect(page).toContain(">Extra AI credits</h3>");
  // More owed than is left (the trial's 500): AI is paused, and the page says so.
  expect(page).toContain("AI is paused: this project owes 700 credits.");
  // Less owed than is left: it comes out of what's shown at the next AI use.
  await prisma.project.update({ where: { id: projectId }, data: { aiCreditDebt: 100 } });
  page = await billing();
  expect(page).toContain("100 credits owed, taken at the next AI use.");
  expect(page).not.toContain("AI is paused");
  // Its month over and the next not given yet (the hourly job late): the month's credits can't be spent, so they
  // aren't shown as left, nor as owed, and no day past is given as the reset.
  await prisma.project.update({ where: { id: projectId }, data: { aiCreditDebt: 0 } });
  const past = new Date(Date.now() - 60_000);
  await prisma.creditGrant.update({ where: { id: month.id }, data: { remaining: 300, expiresAt: past } });
  await prisma.creditGrant.updateMany({ where: { planLicenseId: license.id, kind: "EMAIL" }, data: { expiresAt: past } });
  await prisma.planLicense.update({ where: { id: license.id }, data: { creditsThrough: past } });
  page = await billing();
  expect(page).toMatch(meter("AI credits", "500 of 500 left"));
  expect(page).not.toContain(`of ${monthly} left`);
  expect(page).not.toContain("credits owed");
  expect(page).not.toContain(">Resets ");
  await prisma.creditGrant.update({ where: { id: month.id }, data: { remaining: 0, expiresAt: creditsThrough } });
  await prisma.creditGrant.updateMany({ where: { planLicenseId: license.id, kind: "EMAIL" }, data: { expiresAt: creditsThrough } });
  await prisma.planLicense.update({ where: { id: license.id }, data: { creditsThrough } });
  // With no others, no list.
  await prisma.project.update({ where: { id: projectId }, data: { aiCreditDebt: 0 } });
  await prisma.creditGrant.deleteMany({ where: { projectId, planLicenseId: null } });
  await prisma.project.update({ where: { id: projectId }, data: { freeCreditsGrantedAt: new Date() } });
  page = await billing();
  expect(page).not.toContain("Extra AI credits");
  expect(page).not.toContain("<table");
});

test("a license on a plan with no email limit still has its month: the AI credits' meter and the reset day, beside the emails sent", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  vi.stubEnv("AI_CREDITS", "on");
  // Mid-month, so the month counted and the one the page names are the same.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-19T12:00:00Z") });
  onTestFinished(() => void vi.useRealTimers());
  const holder = (await prisma.teamMember.findFirstOrThrow({ where: { projectId }, select: { userId: true } })).userId;
  const license = await prisma.planLicense.create({
    data: { source: "tuti", externalKey: crypto.randomUUID(), plan: "business", userId: holder, projectId, claimedAt: new Date(), assignedAt: new Date() },
  });
  await prisma.project.update({ where: { id: projectId }, data: { plan: "business" } });
  await grantLicenseCredits(license.id);
  const { creditsThrough } = await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } });
  const month = await prisma.creditGrant.findFirstOrThrow({ where: { planLicenseId: license.id, kind: "AI" } });
  const monthly = month.credits.toNumber().toLocaleString("en");
  const page = await billing();
  // The emails are counted by calendar month, not the license's: said, beside a reset day that isn't theirs.
  expect(page).toMatch(meter("Emails", "0 sent since 1 Nov"));
  expect(page).toMatch(meter("AI credits", `${monthly} of ${monthly} left`));
  expect(creditsThrough).toEqual(new Date("2026-12-19T12:00:00Z"));
  expect(page).toContain(">Resets 19 Dec</span>");
  // With AI credits off too, nothing on the card follows the license's month: no reset day.
  vi.stubEnv("AI_CREDITS", "");
  const emailsOnly = await billing();
  expect(emailsOnly).toMatch(meter("Emails", "0 sent since 1 Nov"));
  expect(emailsOnly).not.toContain(">Resets ");
  vi.stubEnv("AI_CREDITS", "on");
  // Where plans are off, there's no This month: the license's credits are in the list, with the rest.
  vi.stubEnv("BILLING_CONFIG", "");
  const without = await billing();
  expect(without).not.toContain("This month");
  expect(without).toContain(">AI credits</h2>");
  expect(without).toMatch(meter("Balance", `${monthly} of ${monthly} left`));
  expect(without).not.toContain("Extra AI credits");
  expect(without).toContain(`>${monthly}</td>`);
});

test("the credits list says until when each lasts, day first and short, with the year when it isn't this one", async () => {
  vi.stubEnv("AI_CREDITS", "on");
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-19T12:00:00Z") });
  onTestFinished(() => void vi.useRealTimers());
  await prisma.creditGrant.createMany({
    data: [
      { projectId, source: "MANUAL", credits: 100, remaining: 100, note: "Refund for a support case", expiresAt: new Date("2031-01-05T12:00:00Z") },
      { projectId, source: "TOPUP", credits: 50, remaining: 50, expiresAt: new Date("2026-12-18T12:00:00Z") },
    ],
  });
  const page = await billing();
  expect(page).toContain(">until 5 Jan 2031</td>");
  expect(page).toContain(">until 18 Dec</td>");
  // The operator's note on credits given by hand is theirs: not shown.
  expect(page).toContain(">Given by Tuti</td>");
  expect(page).not.toContain("Refund for a support case");
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
  expect(await billing()).toMatch(/<span id="plans-unavailable" tabindex="-1"[^>]*>\s*Plans can't be bought here right now\./);
});

test("the plan's row on a free trial says when it ends, and after it that it ended, each with Upgrade; a paid plan's has its price and Manage plan", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config) => { config.trial = { plan: "pro", days: 7, emails: 500 }; }));
  await prisma.project.update({ where: { id: projectId }, data: { trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60_000) } });
  let page = await billing();
  expect(page).toMatch(/>Pro<\/span><span[^>]*>Trial<\/span>/);
  expect(page).toMatch(/>Ends on \d{1,2} [A-Z][a-z]+ \d{4}<\/p>/);
  expect(page).toContain("data-plans-control");
  await prisma.project.update({ where: { id: projectId }, data: { trialEndsAt: new Date(Date.now() - 60_000) } });
  page = await billing();
  expect(page).toMatch(/>Free<\/span><span[^>]*>Trial ended<\/span>/);
  expect(page).toContain(">1,000 emails a month · 2 feedback boards</p>");
  expect(page).toContain("data-plans-control");
  await prisma.project.update({ where: { id: projectId }, data: { plan: "pro", planInterval: "month", planStatus: "active", stripeSubscriptionId: `sub_${projectId}` } });
  page = await billing();
  expect(page).toMatch(/>Pro<\/span><span[^>]*>Your plan<\/span>/);
  expect(page).toContain(">$39 a month</p>");
  expect(page).toContain("Manage plan");
  expect(page).not.toContain("data-plans-control");
});
