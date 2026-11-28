import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { updateAiFirst } from "./ai-first";
import { updateCodeChangesTuning } from "./code-changes-tuning";
import { type Actor, runOperation } from "./define";

/**
 * runOperation (define.ts), for trusted server code running an operation: it keeps the context it's given but checks the
 * operation's input and its own access, scope and owner rule against that actor, so an outer operation can never do
 * what its caller couldn't do directly.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
});

const as = (actor: Actor) => ({ actor, projectId: project.id });
const asUser = (user: { id: string }) => as({ kind: "user", userId: user.id });
const key = async (scope: "READ" | "WRITE", createdById = owner.id) => {
  const created = await prisma.apiKey.create({ data: { projectId: project.id, name: scope, scope, keyHash: crypto.randomUUID(), prefix: "tuti_t", createdById } });
  return as({ kind: "apiKey", keyId: created.id, projectId: project.id, scope: scope === "WRITE" ? "write" : "read", createdById });
};
const saved = () => prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { emailAiFirst: true, aiName: true } });

test("refuses what its actor couldn't run directly: a read-only key's write, a member where admins are needed, someone off the team", async () => {
  const before = await saved();
  await expect(runOperation(updateAiFirst, await key("READ"), { email: true })).rejects.toMatchObject({ status: 403 });
  await expect(runOperation(updateAiFirst, asUser(await addMember(project.id, "MEMBER")), { email: true })).rejects.toMatchObject({ status: 403 });
  await expect(runOperation(updateAiFirst, asUser(await signUp("Outsider")), { email: true })).rejects.toMatchObject({ status: 403 });
  // A key whose creator left the team.
  const admin = await addMember(project.id, "ADMIN");
  const leftKey = await key("WRITE", admin.id);
  await prisma.teamMember.delete({ where: { id: admin.memberId } });
  await expect(runOperation(updateAiFirst, leftKey, { email: true })).rejects.toMatchObject({ status: 403 });
  // Another project's key.
  const other = await createProject(owner);
  await expect(runOperation(updateAiFirst, { ...(await key("WRITE")), projectId: other.id }, { email: true })).rejects.toMatchObject({ status: 403 });
  expect(await saved()).toEqual(before);

  // Its input is checked too.
  await expect(runOperation(updateAiFirst, asUser(owner), { name: "x".repeat(51) })).rejects.toMatchObject({ status: 400, code: "invalid_input" });
  await expect(runOperation(updateAiFirst, asUser(await addMember(project.id, "ADMIN")), { email: true, name: "Ada" })).resolves.toMatchObject({ email: true, name: "Ada" });
  await expect(runOperation(updateAiFirst, await key("WRITE"), { email: false })).resolves.toMatchObject({ email: false });
});

test("an owner operation runs for owners only, recording which owner (for a key, whoever created it)", async () => {
  await expect(runOperation(updateCodeChangesTuning, asUser(await addMember(project.id, "ADMIN")), { "decide.rounds": 6 })).rejects.toMatchObject({ status: 403 });
  const admin = await addMember(project.id, "ADMIN");
  await expect(runOperation(updateCodeChangesTuning, await key("WRITE", admin.id), { "decide.rounds": 6 })).rejects.toMatchObject({ status: 403 });
  await runOperation(updateCodeChangesTuning, await key("WRITE"), { "decide.rounds": 6 });
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { tuningUpdatedBy: true } })).toEqual({ tuningUpdatedBy: owner.id });
});
