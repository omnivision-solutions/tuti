import { billingFile, creditsOn } from "@tuti/testkit";
import { prisma } from "@tuti/db";
import { cappedProjects, claimProjectEmail, creditBalance, emailsThisMonth, grantCredits, grantLicenseCredits, handlers, releaseProjectEmail, takeBackCredits } from "@tuti/jobs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { UsageMonths } from "@/components/usage-months";

import { createProject, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { createPost } from "./operations/create";
import { updatePost } from "./operations/manage";
import { setVote } from "./operations/more";
import { call } from "./operations/run";
import { aiUsageByMonth } from "./operations/usage";

/**
 * Emails past a paid plan's included ones spend the project's shared credits (credits.perEmail each:
 * packages/jobs/src/email-limits.ts) and go at once; without enough, or on the free plan, they wait.
 */

const log = { info: () => {}, warn: () => {} };
const MID_MONTH = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15, 12));
const nextMonth = () => new Date(Date.UTC(MID_MONTH.getUTCFullYear(), MID_MONTH.getUTCMonth() + 1, 1));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: MID_MONTH });
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", "tuti.email");
  // Credits on: a paid plan's emails past its allowance spend credits.perEmail (0.2 by default) each.
  // No Stripe keys: the worker, which sends most of these, has none (only the web app sells top-ups).
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  vi.stubEnv("TUTI_CONFIG", creditsOn());
  // Each plan includes 1 email a month.
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free, pro, business }) => {
    free.limits.emailsPerMonth = 1;
    pro.limits.emailsPerMonth = 1;
    business.limits.emailsPerMonth = 1;
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const limitEmails = (address: string) => mailbox.emails.filter((email) => email.to.includes(address) && email.subject.endsWith("reached its monthly email limit"));
const balance = async (projectId: string) => (await creditBalance(projectId)).balance;
const thisMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
/** What claimProjectEmail takes: one of the month's included emails, or one paid with `credits`. */
const included = (now = new Date()) => ({ month: thisMonth(now), paid: null });
const paid = (credits: number, now = new Date()) => ({ month: thisMonth(now), paid: credits });

/** A project past its first week, with a verified owner, on `plan`, with `credits` topped up. */
async function setup(plan: string | null, credits: number) {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  await prisma.project.update({ where: { id: project.id }, data: { plan, createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) } });
  if (credits > 0) {
    await grantCredits(project.id, "TOPUP", credits, {});
  }
  return { owner, project };
}

test("past a paid plan's included emails, each spends credits.perEmail (0.2) and goes; Usage lists them", async () => {
  const { owner, project } = await setup("pro", 1);
  expect(await claimProjectEmail(project.id)).toBeTruthy();
  expect(await balance(project.id)).toBe(1);
  expect(await claimProjectEmail(project.id)).toBeTruthy();
  expect(await claimProjectEmail(project.id)).toBeTruthy();
  expect(await balance(project.id)).toBeCloseTo(0.6);
  expect(await emailsThisMonth(project.id)).toMatchObject({ emails: 3, limit: 1, left: 0, perEmail: 0.2, held: false });
  expect(await cappedProjects()).not.toContain(project.id);
  const [month] = await aiUsageByMonth(project.id, 1);
  expect(month!.features).toEqual([expect.objectContaining({ feature: "emails", requests: 2, credits: 0.4 })]);
  // Emails aren't AI requests.
  expect(month).toMatchObject({ requests: 0, credits: 0.4 });
  // Billing's Usage: an Emails row with its count and credits, said in the month's line, in its credits.
  const usage = renderToStaticMarkup((await UsageMonths({ projectId: project.id }))!).replaceAll("&#x27;", "'");
  expect(usage).toMatch(/<td[^>]*>Emails<\/td><td[^>]*>2<\/td><td[^>]*>0<\/td><td[^>]*>0\.4<\/td>/);
  expect(usage).toContain("; 2 emails past the plan's");
  expect(usage).toContain(">0.4 credits<");
  // Spending credits, they're followed by the credits emails: under credits.low (100), the owner hears once.
  const low = mailbox.emails.filter((email) => email.to.includes(owner.email) && email.subject.endsWith("is running low on credits"));
  expect(low).toHaveLength(1);
  // And says the emails past the allowance pause with the AI when they run out.
  expect(low[0]!.text).toContain("Autopilot, Verify, AI images and emails past the plan's monthly allowance pause until it has more.");
});

test("the charge is the paid emails times credits.perEmail, as it's set: no dollar rate turns it", async () => {
  // perTopupDollar and perUsageDollar far from their defaults change nothing.
  vi.stubEnv("TUTI_CONFIG", creditsOn({ perEmail: 0.35, perTopupDollar: 7, perUsageDollar: 900 }));
  const { project } = await setup("pro", 10);
  expect(await emailsThisMonth(project.id)).toMatchObject({ perEmail: 0.35 });
  for (let n = 0; n < 4; n++) {
    expect(await claimProjectEmail(project.id)).toBeTruthy();
  }
  // 1 included, 3 paid.
  expect(await balance(project.id)).toBeCloseTo(10 - 3 * 0.35);
  // Changed: the next ones spend the new rate.
  vi.stubEnv("TUTI_CONFIG", creditsOn({ perEmail: 1 }));
  expect(await claimProjectEmail(project.id)).toEqual(paid(1));
  expect(await balance(project.id)).toBeCloseTo(10 - 3 * 0.35 - 1);
  expect((await aiUsageByMonth(project.id, 1))[0]!.features).toEqual([expect.objectContaining({ feature: "emails", requests: 4, credits: 2.05 })]);
  // One not sent gives back what it was charged, not the month's average.
  const claim = await claimProjectEmail(project.id);
  expect(claim).toEqual(paid(1));
  await releaseProjectEmail(project.id, claim!);
  expect(await balance(project.id)).toBeCloseTo(10 - 3 * 0.35 - 1);
  expect((await aiUsageByMonth(project.id, 1))[0]!.features).toEqual([expect.objectContaining({ feature: "emails", requests: 4, credits: 2.05 })]);
});

test("a paid email's credits given back go to the grant lasting longest, never one about to expire", async () => {
  const { project } = await setup("pro", 1);
  // A plan's month's credits, spent, expiring soon, beside the top-up (lasting for good) that pays.
  const month = await grantCredits(project.id, "PLAN", 1, { days: 5 });
  await prisma.creditGrant.update({ where: { id: month.id }, data: { remaining: 0 } });
  expect(await claimProjectEmail(project.id)).toEqual(included());
  const claim = await claimProjectEmail(project.id);
  expect(claim).toEqual(paid(0.2));
  await releaseProjectEmail(project.id, claim!);
  expect((await prisma.creditGrant.findUniqueOrThrow({ where: { id: month.id } })).remaining.toNumber()).toBe(0);
  expect((await prisma.creditGrant.findFirstOrThrow({ where: { projectId: project.id, source: "TOPUP" } })).remaining.toNumber()).toBe(1);
});

test("a paid email leaving the balance above credits.low skips the low-credits check; one taking it under emails once", async () => {
  vi.stubEnv("TUTI_CONFIG", creditsOn({ low: 9.7 }));
  const { owner, project } = await setup("pro", 10);
  expect(await claimProjectEmail(project.id)).toEqual(included());
  // emailIfCreditsLow's first read is the project's grants (creditBalance), outside any transaction: none above the mark.
  const reads = vi.spyOn(prisma.creditGrant, "findMany");
  expect(await claimProjectEmail(project.id)).toEqual(paid(0.2));
  expect(reads).not.toHaveBeenCalled();
  // 9.8 → 9.6: under the mark, the owner hears, once.
  expect(await claimProjectEmail(project.id)).toEqual(paid(0.2));
  expect(reads).toHaveBeenCalled();
  expect(await claimProjectEmail(project.id)).toEqual(paid(0.2));
  reads.mockRestore();
  expect(mailbox.emails.filter((email) => email.to.includes(owner.email) && email.subject.endsWith("is running low on credits"))).toHaveLength(1);
});

test("a paid email claimed just before a month ends and given back after it: the charged month's row and credits are restored", async () => {
  const { project } = await setup("pro", 1);
  const endOfMonth = new Date(Date.UTC(MID_MONTH.getUTCFullYear(), MID_MONTH.getUTCMonth() + 1, 1) - 1000);
  vi.setSystemTime(endOfMonth);
  expect(await claimProjectEmail(project.id)).toEqual(included());
  const claim = await claimProjectEmail(project.id);
  expect(claim).toEqual(paid(0.2));
  expect(await balance(project.id)).toBeCloseTo(0.8);
  // The send fails after midnight, in the next month (which has a paid email of its own).
  vi.setSystemTime(nextMonth());
  await prisma.projectEmailMonth.create({ data: { projectId: project.id, month: nextMonth(), paidEmails: 1, paidCredits: 0.2 } });
  await releaseProjectEmail(project.id, claim!);
  expect(await balance(project.id)).toBe(1);
  const rows = await prisma.projectEmailMonth.findMany({ where: { projectId: project.id }, orderBy: { month: "asc" }, select: { emails: true, paidEmails: true, paidCredits: true } });
  expect(rows.map((row) => ({ ...row, paidCredits: row.paidCredits.toNumber() }))).toEqual([
    { emails: 1, paidEmails: 0, paidCredits: 0 },
    { emails: 0, paidEmails: 1, paidCredits: 0.2 },
  ]);
});

test("two paid emails at once can't both spend the last credits: never on credit", async () => {
  const { project } = await setup("pro", 0.3);
  expect(await claimProjectEmail(project.id)).toEqual(included());
  const claims = await Promise.all([claimProjectEmail(project.id), claimProjectEmail(project.id)]);
  expect(claims.filter((claim) => claim !== null)).toEqual([paid(0.2)]);
  expect(await balance(project.id)).toBeCloseTo(0.1);
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).aiCreditDebt.toNumber()).toBe(0);
});

test("without enough credits, email past the allowance waits as before, and the team is told once", async () => {
  const { owner, project } = await setup("pro", 0.3);
  expect([await claimProjectEmail(project.id), await claimProjectEmail(project.id), await claimProjectEmail(project.id)]).toEqual([included(), paid(0.2), null]);
  // Never on credit: what's left stays.
  expect(await balance(project.id)).toBeCloseTo(0.1);
  expect(await emailsThisMonth(project.id)).toMatchObject({ emails: 2, held: true });
  expect(await cappedProjects()).toContain(project.id);
  expect(limitEmails(owner.email)).toHaveLength(1);
  // What's missing is credits, not a bigger plan: buying them sends it now.
  expect(limitEmails(owner.email)[0]!.text).toContain("Past them, each email spends 0.2 credits, and this project doesn't have enough: buy credits on Billing to send it now.");
  expect(limitEmails(owner.email)[0]!.text).not.toContain("Upgrade");
  // More credits: it goes.
  await grantCredits(project.id, "TOPUP", 10, {});
  expect(await cappedProjects()).not.toContain(project.id);
  expect(await claimProjectEmail(project.id)).toBeTruthy();
});

test("paid emails never take included ones: an included one given back while others were paid frees its slot", async () => {
  const { project } = await setup("pro", 1);
  // A takes the included one; B, at once, is paid; A's send fails.
  expect(await claimProjectEmail(project.id)).toEqual(included());
  expect(await claimProjectEmail(project.id)).toEqual(paid(0.2));
  await releaseProjectEmail(project.id, included());
  expect(await emailsThisMonth(project.id)).toMatchObject({ emails: 1, limit: 1, left: 1 });
  // The next one takes the included slot back, charging nothing.
  expect(await claimProjectEmail(project.id)).toEqual(included());
  expect(await balance(project.id)).toBeCloseTo(0.8);
  // An upgrade's room is the included ones it has left: paid ones don't count against it.
  expect(await claimProjectEmail(project.id)).toEqual(paid(0.2));
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free, pro, business }) => {
    free.limits.emailsPerMonth = 1;
    pro.limits.emailsPerMonth = 1;
    business.limits.emailsPerMonth = 10;
  }));
  await prisma.project.update({ where: { id: project.id }, data: { plan: "business" } });
  expect(await emailsThisMonth(project.id)).toMatchObject({ emails: 3, limit: 10, left: 9 });
});

test("the free plan's email waits at its limit, credits or not", async () => {
  const { project } = await setup(null, 100);
  expect([await claimProjectEmail(project.id), await claimProjectEmail(project.id)]).toEqual([included(), null]);
  expect(await balance(project.id)).toBe(100);
  expect(await emailsThisMonth(project.id)).toMatchObject({ perEmail: null, held: true });
});

test("a batch partly paid for: what the credits pay for goes, the rest waits for next month", async () => {
  const { owner, project } = await setup("pro", 0.3);
  const voters = [await signUp("Val Voter"), await signUp("Vic Voter"), await signUp("Vera Voter")];
  await prisma.user.updateMany({ where: { id: { in: voters.map((v) => v.id) } }, data: { emailVerified: true } });
  const post = await call(createPost, { actor: { kind: "user", userId: voters[0]!.id }, projectId: project.id }, { board: "feature-requests", title: "Dark mode" });
  for (const voter of voters.slice(1)) {
    await call(setVote, { actor: { kind: "user", userId: voter.id }, projectId: project.id }, { number: post.number, voted: true });
  }
  await call(updatePost, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { number: post.number, status: "completed" });
  const shipped = voters.filter((voter) => mailbox.emails.some((email) => email.to.includes(voter.email) && email.subject.startsWith("Done:")));
  // One included, one paid (0.2 of 0.3), and the third waits.
  expect(shipped).toHaveLength(2);
  expect(await balance(project.id)).toBeCloseTo(0.1);
  expect((await prisma.post.findFirstOrThrow({ where: { projectId: project.id } })).shippedEmailsDueAt).toEqual(nextMonth());
});

test("a paid email that isn't sent gives its credits back: off the debt a refunded top-up left first, never past what a grant holds", async () => {
  const { project } = await setup("pro", 1);
  expect(await claimProjectEmail(project.id)).toEqual(included());
  expect(await claimProjectEmail(project.id)).toEqual(paid(0.2));
  expect(await balance(project.id)).toBeCloseTo(0.8);
  await releaseProjectEmail(project.id, paid(0.2));
  expect(await balance(project.id)).toBe(1);
  expect(await emailsThisMonth(project.id)).toMatchObject({ emails: 1 });
  expect((await aiUsageByMonth(project.id, 1))[0]?.features ?? []).toEqual([]);

  // The top-up refunded in full after an email spent from it: takeBackCredits made the spent 0.2 debt. The email not
  // sent after all pays that off, and puts nothing back in the refunded grant.
  expect(await claimProjectEmail(project.id)).toEqual(paid(0.2));
  const grant = await prisma.creditGrant.findFirstOrThrow({ where: { projectId: project.id, source: "TOPUP" } });
  await takeBackCredits(grant.id, 1);
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).aiCreditDebt.toNumber()).toBeCloseTo(0.2);
  await releaseProjectEmail(project.id, paid(0.2));
  expect((await prisma.creditGrant.findUniqueOrThrow({ where: { id: grant.id } })).remaining.toNumber()).toBe(0);
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).aiCreditDebt.toNumber()).toBe(0);
});

test("a send that fails gives its credits back", async () => {
  const { project } = await setup("pro", 1);
  const voters = [await signUp("Val Voter"), await signUp("Vic Voter")];
  await prisma.user.updateMany({ where: { id: { in: voters.map((v) => v.id) } }, data: { emailVerified: true } });
  const post = await call(createPost, { actor: { kind: "user", userId: voters[0]!.id }, projectId: project.id }, { board: "feature-requests", title: "Dark mode" });
  await call(setVote, { actor: { kind: "user", userId: voters[1]!.id }, projectId: project.id }, { number: post.number, voted: true });
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true } });
  await prisma.post.update({ where: { id: postId }, data: { status: "COMPLETED", shippedEmailsDueAt: new Date() } });
  // The first takes the included one; the second, paid for, fails.
  mailbox.refuseNext(voters[1]!.email);
  await expect(handlers.postShipped({ postId }, log)).rejects.toThrow(/failed/);
  expect(await balance(project.id)).toBe(1);
  expect(await emailsThisMonth(project.id)).toMatchObject({ emails: 1 });
});

test("a licensed project uses its license's month's emails first, then the shared credits", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((_, { free, pro }) => {
    free.limits.emailsPerMonth = 1;
    pro.limits.emailsPerMonth = 2;
    pro.monthlyCredits = 0;
  }));
  const { owner, project } = await setup("pro", 1);
  const license = await prisma.planLicense.create({
    data: { source: "tuti", externalKey: `tuti-${project.id}`, plan: "pro", userId: owner.id, projectId: project.id, claimedAt: new Date(), assignedAt: new Date() },
  });
  await grantLicenseCredits(license.id);
  expect([await claimProjectEmail(project.id), await claimProjectEmail(project.id)]).toEqual([included(), included()]);
  expect(await balance(project.id)).toBe(1);
  expect(await claimProjectEmail(project.id)).toEqual(paid(0.2));
  expect(await balance(project.id)).toBeCloseTo(0.8);
  expect(await emailsThisMonth(project.id)).toMatchObject({ emails: 3, limit: 2, left: 0, perEmail: 0.2, held: false });
  // The paid one given back is credits, not one of the license's.
  await releaseProjectEmail(project.id, paid(0.2));
  expect(await balance(project.id)).toBe(1);
  expect(await emailsThisMonth(project.id)).toMatchObject({ left: 0 });

  // The license's next month: an included email not sent gives back the license's email, not credits, though the
  // calendar month has paid ones.
  expect(await claimProjectEmail(project.id)).toEqual(paid(0.2));
  const { creditsThrough } = await prisma.planLicense.findUniqueOrThrow({ where: { id: license.id } });
  vi.setSystemTime(new Date(creditsThrough!.getTime() - 30 * 60_000));
  await grantLicenseCredits(license.id);
  vi.setSystemTime(new Date(creditsThrough!.getTime() + 60_000));
  const now = new Date();
  const left = (await emailsThisMonth(project.id, now))!.left!;
  expect(await claimProjectEmail(project.id, now)).toEqual(included());
  await releaseProjectEmail(project.id, included(now));
  expect(await emailsThisMonth(project.id, now)).toMatchObject({ left });
  expect(await balance(project.id)).toBeCloseTo(0.8);
});

test("a free trial's email waits at its own allowance: its credits were given, not bought", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile((config, { free }) => {
    free.limits.emailsPerMonth = 1;
    config.trial = { plan: "pro", days: 7, credits: 1000, emails: 1 };
  }));
  const { project } = await setup(null, 100);
  await prisma.project.update({ where: { id: project.id }, data: { trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60_000) } });
  expect([await claimProjectEmail(project.id), await claimProjectEmail(project.id)]).toEqual([included(), null]);
  expect(await balance(project.id)).toBe(100);
  expect(await emailsThisMonth(project.id)).toMatchObject({ perEmail: null, held: true });
});

test("without a billing file nothing is counted or charged", async () => {
  vi.stubEnv("BILLING_CONFIG", "");
  const { project } = await setup(null, 1);
  expect(await claimProjectEmail(project.id)).toBeTruthy();
  expect(await emailsThisMonth(project.id)).toBeNull();
  expect(await balance(project.id)).toBe(1);
});
