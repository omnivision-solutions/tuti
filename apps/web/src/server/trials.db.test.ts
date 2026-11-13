import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { creditBalance, projectWith } from "@tuti/jobs";
import { billingFile, type FakeStripeEvent, startStripeFake, type StripeFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { createBoard } from "@/server/boards";
import { getPlan, requirePlan, subscribePlan } from "@/server/operations/plan";
import { call } from "@/server/operations/run";
import { createProject } from "@/server/projects";
import { actAs, redirectTarget, signUp, type TestUser } from "@/test/helpers";

/** Free trials (docs/plan.md, Plans): an account's first project is on the trial's plan until it ends, then on the default plan unless it bought one. */

let stripe: StripeFake;
let owner: TestUser;

beforeAll(async () => {
  stripe = await startStripeFake();
});
afterAll(() => stripe.close());
beforeEach(async () => {
  const billing = billingFile((config) => {
    config.trial = { plan: "pro", days: 7, credits: 500, emails: 1000 };
  });
  for (const [name, value] of Object.entries({ ...stripe.env, BILLING_CONFIG: billing, AI_CREDITS: "on", APP_URL: "https://app.tuti.example" })) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Owner");
  actAs(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A project `owner` makes in the app, as Create project does. */
async function newProject() {
  const slug = `p-${randomUUID().slice(0, 8)}`;
  const form = new FormData();
  form.set("name", `Project ${slug}`);
  form.set("slug", slug);
  expect(await redirectTarget(createProject(null as never, form))).toBe(`/app/${slug}/setup`);
  return prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true, slug: true, trialEndsAt: true } });
}

const as = (projectId: string) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });
const addBoard = (slug: string) => {
  const form = new FormData();
  form.set("name", `Board ${randomUUID().slice(0, 4)}`);
  form.set("slug", `b-${randomUUID().slice(0, 8)}`);
  return createBoard(slug, null as never, form);
};
const endTrial = (id: string) => prisma.project.update({ where: { id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
const deliver = async (...events: FakeStripeEvent[]) => {
  for (const { body, headers } of events) {
    expect((await webhook(new Request("https://app.tuti.example/api/stripe/webhook", { method: "POST", body, headers }))).status).toBe(200);
  }
};

test("an account's first project starts a trial of the trial's plan, with its credits until it ends; its next project doesn't", async () => {
  const first = await newProject();
  const days = (first.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.99);
  expect(days).toBeLessThanOrEqual(7);
  expect(await call(getPlan, as(first.id), {})).toMatchObject({ plan: "pro", trial: { endsAt: first.trialEndsAt, ended: false } });
  const { grants } = await creditBalance(first.id);
  expect(grants.filter(({ source }) => source === "PLAN")).toMatchObject([{ credits: 500, remaining: 500, expiresAt: first.trialEndsAt }]);

  const second = await newProject();
  expect(second.trialEndsAt).toBeNull();
  expect(await call(getPlan, as(second.id), {})).toMatchObject({ plan: "free", trial: null });
  expect((await creditBalance(second.id)).grants.filter(({ source }) => source === "PLAN")).toEqual([]);
});

test("during the trial the project has the trial plan's features and limits, read anywhere; after it, the default plan's", async () => {
  const project = await newProject();
  // Free has 2 boards, Pro 5: the project has one.
  expect(await addBoard(project.slug)).toEqual({});
  expect(await addBoard(project.slug)).toEqual({});
  await expect(requirePlan(project.id, "customDomain")).resolves.toBe("pro");
  // Through a relation too, and without the field it reads to know.
  const board = await prisma.board.findFirstOrThrow({ where: { projectId: project.id }, select: { project: { select: { plan: true } } } });
  expect(board.project).toEqual({ plan: "pro" });
  expect(await prisma.project.count({ where: { id: project.id, ...projectWith("customDomain") } })).toBe(1);

  await endTrial(project.id);
  expect(await addBoard(project.slug)).toMatchObject({ error: expect.stringMatching(/boards/) });
  await expect(requirePlan(project.id, "customDomain")).rejects.toThrow(/needs the Pro plan/);
  expect(await call(getPlan, as(project.id), {})).toMatchObject({ plan: "free", trial: { ended: true } });
  expect(await prisma.project.count({ where: { id: project.id, ...projectWith("customDomain") } })).toBe(0);
});

test("an ended trial never gives its plan, though nothing ran when it ended", async () => {
  const project = await newProject();
  await endTrial(project.id);
  const read = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  expect([read.plan, (await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } })).plan]).toEqual([null, null]);
  // Two boards already (the first, and one more): Free's limit.
  expect(await addBoard(project.slug)).toEqual({});
  expect(await addBoard(project.slug)).toMatchObject({ error: expect.stringMatching(/boards/) });
});

test("a plan bought during the trial ends it: the paid plan holds, and once it ends the trial doesn't come back", async () => {
  const project = await newProject();
  await call(subscribePlan, as(project.id), { plan: "business", interval: "month" });
  const session = stripe.sessions.at(-1)!;
  await deliver(...stripe.pay(session.id));
  expect(await call(getPlan, as(project.id), {})).toMatchObject({ plan: "business", status: "active", trial: null });
  expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { trialEndsAt: true } })).trialEndsAt).toBeNull();

  await deliver(stripe.update(session.subscription!, { status: "canceled" }));
  expect(await call(getPlan, as(project.id), {})).toMatchObject({ plan: "free", status: null, trial: null });
});
