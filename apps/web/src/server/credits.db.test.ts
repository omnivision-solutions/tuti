import { prisma } from "@tuti/db";
import { aiFor, creditBalance, grantCredits } from "@tuti/jobs";
import type { AiUsage } from "@tuti/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { getCredits } from "@/server/operations/credits";
import { call } from "@/server/operations/run";
import { getUsage } from "@/server/operations/usage";
import { createProject, signUp, type TestUser } from "@/test/helpers";

/** AI credits (docs/plan.md, AI usage per project): what each answered request is charged, from which grants, and the balance. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  vi.stubEnv("AI_CREDITS", "on");
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const chat = (cost: number | null): AiUsage => ({ kind: "chat", model: "acme/writer", inputTokens: 100, outputTokens: 10, cost });
/** A request the provider answered, for `projectId`'s AI answers, as a feature's meter records it. */
const answered = async (cost: number | null, projectId = project.id) => (await aiFor(projectId, "answers")).meter(chat(cost));
const balance = async () => (await creditBalance(project.id)).balance;
const left = async () =>
  (await prisma.aiCreditGrant.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { note: true, remaining: true } })).map(
    (grant) => `${grant.note} ${grant.remaining.toNumber()}`,
  );

test("off unless AI_CREDITS=on: requests are recorded without credits, and usage is in dollars", async () => {
  vi.stubEnv("AI_CREDITS", "");
  vi.stubEnv("AI_CREDITS_FREE", "100");
  await answered(0.01);
  expect(await prisma.aiUsage.findMany({ where: { projectId: project.id }, select: { credits: true } })).toEqual([{ credits: null }]);
  expect(await call(getCredits, as(), {})).toEqual({ enabled: false, balance: 0, grants: [] });
  expect(await prisma.aiCreditGrant.count({ where: { projectId: project.id } })).toBe(0);
  const [month] = (await call(getUsage, as(), { months: 1 })).months;
  expect(month).toMatchObject({ cost: 0.01 });
  expect(month).not.toHaveProperty("credits");
});

test("each request is charged its cost at the usage rate; the team's usage is in credits, not dollars", async () => {
  await grantCredits(project.id, "MANUAL", 10, { days: null });
  await answered(0.01);
  // The default: 100 credits per dollar.
  expect(await balance()).toBeCloseTo(9, 6);
  vi.stubEnv("AI_CREDITS_PER_USAGE_DOLLAR", "200");
  await answered(0.01);
  expect(await balance()).toBeCloseTo(7, 6);
  // Charged at the rate of the time: changing it later doesn't rewrite what was charged.
  vi.stubEnv("AI_CREDITS_PER_USAGE_DOLLAR", "50");
  const charged = await prisma.aiUsage.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { credits: true } });
  expect(charged.map((row) => row.credits?.toNumber())).toEqual([1, 2]);
  const [month] = (await call(getUsage, as(), { months: 1 })).months;
  expect(month).toMatchObject({ requests: 2, credits: 3, features: [{ feature: "answers", credits: 3 }] });
  expect(month).not.toHaveProperty("cost");
  expect(month!.features[0]).not.toHaveProperty("cost");
});

test("a request with no price is charged nothing, and stays flagged by its missing cost with its model", async () => {
  await grantCredits(project.id, "MANUAL", 10, { days: null });
  await answered(null);
  expect(await balance()).toBe(10);
  expect(await prisma.aiUsage.findFirst({ where: { projectId: project.id }, select: { cost: true, model: true } })).toEqual({ cost: null, model: "acme/writer" });
});

test("credits that expire soonest are spent first, those for good last; expired ones don't count", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await grantCredits(project.id, "MANUAL", 5, { days: null, note: "for good" });
  await grantCredits(project.id, "TOPUP", 5, { days: 365, note: "a year" });
  await grantCredits(project.id, "PLAN", 5, { days: 30, note: "a month" });
  await grantCredits(project.id, "MANUAL", 5, { days: 1, note: "a day" });
  // 7 credits: the day's 5, then 2 of the month's.
  await answered(0.07);
  expect(await left()).toEqual(["for good 5", "a year 5", "a month 3", "a day 0"]);
  // After a month the month's 3 are gone; the year's go next.
  vi.setSystemTime(Date.now() + 31 * 86_400_000);
  expect(await balance()).toBe(10);
  await answered(0.06);
  expect(await left()).toEqual(["for good 4", "a year 0", "a month 3", "a day 0"]);
  expect((await call(getCredits, as(), {})).grants).toEqual([expect.objectContaining({ source: "MANUAL", credits: 5, remaining: 4, expiresAt: null })]);
});

test("a request past the last credit leaves a debt, which the next credits pay first", async () => {
  await grantCredits(project.id, "MANUAL", 1, { days: null, note: "first" });
  await answered(0.03);
  expect(await balance()).toBe(-2);
  await grantCredits(project.id, "TOPUP", 10, { days: 365, note: "top-up" });
  expect(await balance()).toBe(8);
  await answered(0.01);
  expect(await left()).toEqual(["first 0", "top-up 7"]);
  expect(await balance()).toBe(7);
});

test("requests charged at once all count", async () => {
  await grantCredits(project.id, "MANUAL", 100, { days: null });
  await Promise.all(Array.from({ length: 20 }, () => answered(0.01)));
  expect(await balance()).toBeCloseTo(80, 6);
});

test("every project gets AI_CREDITS_FREE once, lasting like a top-up, however many look at once", async () => {
  vi.stubEnv("AI_CREDITS_FREE", "50");
  vi.stubEnv("AI_CREDITS_TOPUP_EXPIRY_DAYS", "30");
  const results = await Promise.all([creditBalance(project.id), creditBalance(project.id), call(getCredits, as(), {})]);
  expect(results.map((result) => result.balance)).toEqual([50, 50, 50]);
  const grants = await prisma.aiCreditGrant.findMany({ where: { projectId: project.id } });
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ source: "FREE" });
  expect(grants[0]!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
  // Spent, they're not given again.
  await answered(0.5);
  expect(await balance()).toBe(0);
  // Another project gets its own.
  const other = await createProject(owner);
  expect((await creditBalance(other.id)).balance).toBe(50);
});

test("a project's credits go with it", async () => {
  await grantCredits(project.id, "MANUAL", 10, { days: null });
  await prisma.project.delete({ where: { id: project.id } });
  expect(await prisma.aiCreditGrant.count({ where: { projectId: project.id } })).toBe(0);
});
