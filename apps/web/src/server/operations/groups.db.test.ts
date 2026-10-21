import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";
import type { z } from "zod";

import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { deleteGroup as deleteGroupAction, saveGroup } from "../groups";
import { createCollection, updateCollection } from "./docs";
import { createGroup, deleteGroup, listGroups, updateGroup } from "./groups";
import { call } from "./run";

/** Reader groups (groups.*, Settings → Groups); what their readers see is in reader-groups.db.test.ts. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp();
  project = await createProject(owner);
});

const team = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });
const list = async (projectId = project.id) => (await call(listGroups, team(projectId), {})).groups;
const create = (input: z.input<typeof createGroup.input>) => call(createGroup, team(), input);
const update = (input: z.input<typeof updateGroup.input>) => call(updateGroup, team(), input);
const remove = (group: string) => call(deleteGroup, team(), { group });

/** Someone the project's SSO signed in, with `groups` in their latest token. */
async function ssoReader(groups: string[], projectId = project.id) {
  const user = await signUp("From the app");
  await prisma.ssoIdentity.create({ data: { projectId, externalId: crypto.randomUUID(), userId: user.id, groups } });
}

test("groups have a name, a claim (from the name unless given) and a description; listed by name", async () => {
  expect(await create({ name: "  Enterprise customers ", description: " On the Enterprise plan " })).toEqual({
    key: "enterprise-customers",
    name: "Enterprise customers",
    claim: "enterprise-customers",
    description: "On the Enterprise plan",
    readers: 0,
  });
  expect(await create({ name: "Beta", claim: "Plan:Beta" })).toMatchObject({ claim: "plan:beta", description: "" });
  expect((await list()).map((g) => g.name)).toEqual(["Beta", "Enterprise customers"]);
  await expect(create({ name: "Bad", claim: "no spaces" })).rejects.toMatchObject({ status: 400 });
  await expect(create({ name: " " })).rejects.toMatchObject({ status: 400, message: "Name is required" });
});

test("a claim is unique in the project, not across projects", async () => {
  await create({ name: "Enterprise" });
  await expect(create({ name: "Enterprise again", claim: "enterprise" })).rejects.toMatchObject({
    status: 409,
    message: "There's already a group “enterprise”",
  });
  await create({ name: "Beta" });
  await expect(update({ group: "beta", claim: "enterprise" })).rejects.toMatchObject({ status: 409 });
  const other = await createProject(owner);
  expect(await call(createGroup, team(other.id), { name: "Enterprise" })).toMatchObject({ claim: "enterprise" });
  expect((await list()).map((g) => [g.name, g.claim])).toEqual([
    ["Beta", "beta"],
    ["Enterprise", "enterprise"],
  ]);
});

test("readers counts the project's SSO users whose latest sign-in names the claim; a new claim counts others", async () => {
  await create({ name: "Enterprise" });
  await create({ name: "Beta" });
  await ssoReader(["enterprise"]);
  await ssoReader(["enterprise", "beta"]);
  await ssoReader([]);
  // Another project's people don't count.
  const other = await createProject(owner);
  await ssoReader(["enterprise"], other.id);
  expect((await list()).map((g) => [g.claim, g.readers])).toEqual([
    ["beta", 1],
    ["enterprise", 2],
  ]);
  expect(await update({ group: "enterprise", name: "Enterprise plan", claim: "plan:enterprise", description: "Paying" })).toEqual({
    key: "enterprise",
    name: "Enterprise plan",
    claim: "plan:enterprise",
    description: "Paying",
    readers: 0,
  });
  // Groups go by their key, which stays; never by the claim.
  await expect(update({ group: "plan:enterprise", name: "Gone" })).rejects.toMatchObject({ status: 404 });
});

test("a group a collection is for can't be deleted; once no collection is, it can", async () => {
  await create({ name: "Enterprise" });
  await create({ name: "Unused" });
  await call(createCollection, team(), { name: "Billing", groups: ["enterprise"] });
  await call(createCollection, team(), { name: "Admin", groups: ["enterprise"] });
  await expect(remove("enterprise")).rejects.toMatchObject({ status: 409, message: "Used by Admin and Billing; remove it from them first" });
  expect(await remove("unused")).toEqual({ deleted: "unused" });
  await call(updateCollection, team(), { slug: "billing", groups: [] });
  await expect(remove("enterprise")).rejects.toMatchObject({ message: "Used by Admin; remove it from them first" });
  await call(updateCollection, team(), { slug: "admin", groups: [] });
  expect(await remove("enterprise")).toEqual({ deleted: "enterprise" });
  expect(await list()).toEqual([]);
  await expect(remove("enterprise")).rejects.toMatchObject({ status: 404 });
});

test("deleting a group while a collection is saved with it: one of them is refused, never a collection open to everyone", async () => {
  for (let i = 0; i < 5; i++) {
    await create({ name: `Group ${i}` });
    const [deleted, created] = await Promise.allSettled([
      remove(`group-${i}`),
      call(createCollection, team(), { name: `Collection ${i}`, groups: [`group-${i}`] }),
    ]);
    expect([deleted.status, created.status].sort()).toEqual(["fulfilled", "rejected"]);
    if (created.status === "fulfilled") {
      expect(created.value.groups).toEqual([`group-${i}`]);
    }
  }
});

test("changing a group's claim keeps the collections that are for it", async () => {
  await create({ name: "Enterprise" });
  await call(createCollection, team(), { name: "Billing", groups: ["enterprise"] });
  await update({ group: "enterprise", claim: "plan:enterprise" });
  const billing = await prisma.collection.findFirstOrThrow({
    where: { projectId: project.id },
    select: { groups: { select: { group: { select: { claim: true } } } } },
  });
  expect(billing.groups.map((g) => g.group.claim)).toEqual(["plan:enterprise"]);
});

test("in the app: owners and admins only", async () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      data.set(name, value);
    }
    return data;
  };
  const denied = { error: "Only project owners and admins can change the groups" };
  actAs(await addMember(project.id, "MEMBER"));
  expect(await saveGroup(project.slug, null, {}, form({ name: "Enterprise" }))).toEqual(denied);
  actAs(await signUp("Outsider"));
  expect(await saveGroup(project.slug, null, {}, form({ name: "Enterprise" }))).toEqual(denied);
  expect(await list()).toEqual([]);

  actAs(await addMember(project.id, "ADMIN"));
  // An empty claim on a new group: from the name; on an edit: unchanged.
  expect(await saveGroup(project.slug, null, {}, form({ name: "Enterprise", claim: "", description: "" }))).toEqual({});
  expect(await saveGroup(project.slug, "enterprise", {}, form({ name: "Enterprise plan", claim: "", description: "Paying" }))).toEqual({});
  expect(await list()).toEqual([{ key: "enterprise", name: "Enterprise plan", claim: "enterprise", description: "Paying", readers: 0 }]);
  expect(await deleteGroupAction(project.slug, "enterprise")).toEqual({});
  expect(await list()).toEqual([]);
});

test("the migration gives today's groups their claim as their key, no conditions, and SSO users no attributes", async () => {
  const sql = readFileSync(new URL("../../../../../packages/db/prisma/migrations/20261021120000_group_conditions/migration.sql", import.meta.url), "utf8");
  // Back to before it, with a group and an SSO user as they were then.
  await prisma.$executeRawUnsafe(`
    DROP INDEX "reader_group_projectId_key_key";
    ALTER TABLE "reader_group" DROP COLUMN "key", DROP COLUMN "conditions", ALTER COLUMN "claim" SET NOT NULL;
    ALTER TABLE "sso_identity" DROP COLUMN "attributes";`);
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", name, claim, "updatedAt") VALUES ('g1', ${project.id}, 'Pro plan', 'plan:pro', now())`;
  await prisma.$executeRaw`INSERT INTO sso_identity (id, "projectId", "externalId", "userId", groups, "updatedAt") VALUES ('s1', ${project.id}, 'user-1', ${owner.id}, '{plan:pro}', now())`;

  await prisma.$executeRawUnsafe(sql);

  expect(await prisma.readerGroup.findMany({ where: { projectId: project.id }, select: { key: true, claim: true, conditions: true } })).toEqual([
    { key: "plan:pro", claim: "plan:pro", conditions: [] },
  ]);
  expect(await prisma.ssoIdentity.findMany({ where: { projectId: project.id }, select: { attributes: true } })).toEqual([{ attributes: {} }]);
  expect((await list()).map((g) => [g.key, g.readers])).toEqual([["plan:pro", 1]]);
});
