import { billingFile } from "@tuti/testkit";
import { prisma } from "@tuti/db";
import { resetCodeChangesSettings } from "@tuti/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { PATCH } from "@/app/api/v1/[...path]/route";
import { createApiKey } from "@/server/api-keys";
import { saveCodeChangesTuning } from "@/server/code-changes-tuning";
import { getCodeChangesTuning, updateCodeChangesTuning } from "@/server/operations/code-changes-tuning";
import { call } from "@/server/operations/run";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

/**
 * Autopilot's Advanced tuning (docs/plan.md, Autopilot's docs agent, D6): owners change it, admins see it, on Business;
 * each value inside the server's range. (docs-agent.db.test.ts has an analysis using and recording it.)
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetCodeChangesSettings();
});

const as = (user: TestUser) => ({ actor: { kind: "user" as const, userId: user.id }, projectId: project.id });
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
};
const stored = async () => (await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { codeChangesTuning: true } })).codeChangesTuning;

test("each value starts as the server's; an owner changes some, says who and when, and null goes back to the server's", async () => {
  vi.stubEnv("CODE_CHANGES_DECIDE_ROUNDS", "20");
  resetCodeChangesSettings();
  const before = await call(getCodeChangesTuning, as(owner), {});
  expect(before).toMatchObject({ available: true, updatedBy: null, updatedAt: null });
  expect(before.values["decide.rounds"]).toEqual({ value: 20, default: 20, saved: null, clamped: false, range: { kind: "integer", min: 1, max: 50 } });
  expect(before.values["propose.edit.maybe"].range).toEqual({ kind: "probability", min: 0, max: 0.75 });

  const after = await call(updateCodeChangesTuning, as(owner), { "decide.rounds": 6, "propose.edit.maybe": 0.3, "decide.reasoning": "low" });
  expect(after.values["decide.rounds"]).toMatchObject({ value: 6, default: 20, saved: 6 });
  expect(after.values["decide.reasoning"]).toMatchObject({ value: "low", default: "off", saved: "low" });
  expect(after).toMatchObject({ updatedBy: "Olive Owner", updatedAt: expect.any(String) as string });
  expect(await stored()).toEqual({ "decide.rounds": 6, "propose.edit.maybe": 0.3, "decide.reasoning": "low" });

  // Nothing given: nothing changes, nor who changed it last.
  const other = await addMember(project.id, "OWNER");
  expect(await call(updateCodeChangesTuning, as(other), {})).toMatchObject({ updatedBy: "Olive Owner", updatedAt: after.updatedAt });

  // Left out keeps its value; null is the server's again.
  await call(updateCodeChangesTuning, as(owner), { "decide.rounds": null });
  expect(await stored()).toEqual({ "propose.edit.maybe": 0.3, "decide.reasoning": "low" });

  // The form: probabilities in percent, "" for the server's (Reset).
  expect(await saveCodeChangesTuning(project.slug, {}, form({ "propose.newArticle.maybe": "35", "propose.edit.maybe": "" }))).toEqual({});
  expect(await stored()).toEqual({ "propose.newArticle.maybe": 0.35, "decide.reasoning": "low" });
});

test("values outside the server's range, or not one of its options, are refused and nothing is saved", async () => {
  for (const input of [{ "decide.rounds": 0 }, { "decide.rounds": 2.5 }, { "context.diffChars": 600_000 }, { "propose.edit.maybe": 0.8 }, { "decide.reasoning": "lots" }]) {
    await expect(call(updateCodeChangesTuning, as(owner), { ...input, "write.rounds": 4 })).rejects.toMatchObject({ status: 400, code: "invalid_input" });
  }
  await expect(call(updateCodeChangesTuning, as(owner), { "propose.edit.maybe": 0.8 })).rejects.toThrow(
    "Fix an article from (propose.edit.maybe) must be a probability from 0% to 75%",
  );
  expect(await stored()).toEqual({});
});

test("owners only: an admin sees the values and can't change them, a member neither; a key works while whoever created it owns the project", async () => {
  const admin = await addMember(project.id, "ADMIN");
  const member = await addMember(project.id, "MEMBER");
  await expect(call(updateCodeChangesTuning, as(admin), { "decide.rounds": 6 })).rejects.toMatchObject({ status: 403 });
  actAs(admin);
  expect(await saveCodeChangesTuning(project.slug, {}, form({ "decide.rounds": "6" }))).toEqual({ error: "Only project owners can change Autopilot's tuning" });
  actAs(member);
  expect(await saveCodeChangesTuning(project.slug, {}, form({ "decide.rounds": "6" }))).toEqual({ error: "Only project owners can change Autopilot's tuning" });
  expect(await stored()).toEqual({});

  // An admin's read and write key can't do what only owners do; an owner's can.
  actAs(admin);
  const adminKey = (await createApiKey(project.slug, "Admin's", "WRITE")).key!;
  actAs(owner);
  const ownerKey = (await createApiKey(project.slug, "Owner's", "WRITE")).key!;
  const patch = (key: string) =>
    PATCH(
      new Request("http://tuti.localhost:3100/api/v1/code-changes-tuning", {
        method: "PATCH",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ "decide.rounds": 6 }),
      }),
      { params: Promise.resolve({ path: ["code-changes-tuning"] }) },
    );
  expect((await patch(adminKey)).status).toBe(403);
  expect(await stored()).toEqual({});
  expect((await patch(ownerKey)).status).toBe(200);
  expect(await stored()).toEqual({ "decide.rounds": 6 });
  // Once its creator is an admin, an owner's key can't either.
  await prisma.teamMember.updateMany({ where: { projectId: project.id, userId: owner.id }, data: { role: "ADMIN" } });
  expect((await patch(ownerKey)).status).toBe(403);
});

test("on Business only: Free and Pro are told so (402); after a downgrade the values are kept and not used, and Business uses them again", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile());
  for (const plan of ["FREE", "PRO"] as const) {
    await prisma.project.update({ where: { id: project.id }, data: { plan } });
    await expect(call(updateCodeChangesTuning, as(owner), { "decide.rounds": 6 })).rejects.toMatchObject({
      status: 402,
      message: "Advanced tuning needs the Business plan. See Settings → Billing.",
    });
  }
  await prisma.project.update({ where: { id: project.id }, data: { plan: "BUSINESS" } });
  expect((await call(updateCodeChangesTuning, as(owner), { "decide.rounds": 6 })).values["decide.rounds"].value).toBe(6);

  await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
  const downgraded = await call(getCodeChangesTuning, as(owner), {});
  expect(downgraded.available).toBe(false);
  expect(downgraded.values["decide.rounds"]).toMatchObject({ value: 12, default: 12, saved: 6 });

  await prisma.project.update({ where: { id: project.id }, data: { plan: "BUSINESS" } });
  expect((await call(getCodeChangesTuning, as(owner), {})).values["decide.rounds"]).toMatchObject({ value: 6, saved: 6 });
});

test("a saved value outside a range the server narrowed since is shown clamped", async () => {
  await call(updateCodeChangesTuning, as(owner), { "propose.edit.maybe": 0.7 });
  vi.stubEnv("CODE_CHANGES_PROPOSE_EDIT_LIKELY", "0.6");
  resetCodeChangesSettings();
  expect((await call(getCodeChangesTuning, as(owner), {})).values["propose.edit.maybe"]).toEqual({
    value: 0.6,
    default: 0.5,
    saved: 0.6,
    clamped: true,
    range: { kind: "probability", min: 0, max: 0.6 },
  });
  // Kept as it was saved: the server's range may widen again.
  expect(await stored()).toEqual({ "propose.edit.maybe": 0.7 });
});
