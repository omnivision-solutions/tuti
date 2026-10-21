import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";
import type { z } from "zod";

import type { Attributes } from "@/lib/group-conditions";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { deleteGroup as deleteGroupAction, previewGroup, saveGroup } from "../groups";
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

/** Someone the project's SSO signed in, with `groups` and `attributes` in their latest token. */
async function ssoReader(name: string, groups: string[], attributes: Attributes = {}, projectId = project.id) {
  const user = await signUp(name);
  await prisma.ssoIdentity.create({ data: { projectId, externalId: crypto.randomUUID(), userId: user.id, groups, attributes } });
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.set(name, value);
  }
  return data;
};

test("groups have a name, a key from it, a claim, conditions or both, and a description; listed by name", async () => {
  expect(await create({ name: "  Enterprise customers ", claim: "enterprise", description: " On the Enterprise plan " })).toEqual({
    key: "enterprise-customers",
    name: "Enterprise customers",
    claim: "enterprise",
    description: "On the Enterprise plan",
    conditions: [],
    readers: 0,
    sample: [],
  });
  expect(
    await create({ name: "Pro", conditions: [{ attribute: " plan ", op: "is_one_of", value: ["pro", " pro", "Pro"] }, { attribute: "role", op: "is_not", value: "guest" }] }),
  ).toMatchObject({
    key: "pro",
    claim: null,
    conditions: [
      { attribute: "plan", op: "is_one_of", value: ["pro", "Pro"] },
      { attribute: "role", op: "is_not", value: "guest" },
    ],
  });
  expect(await create({ name: "Beta", claim: "Plan:Beta" })).toMatchObject({ key: "beta", claim: "plan:beta", description: "" });
  expect((await list()).map((g) => g.name)).toEqual(["Beta", "Enterprise customers", "Pro"]);
  await expect(create({ name: "Bad", claim: "no spaces" })).rejects.toMatchObject({ status: 400 });
  await expect(create({ name: " ", claim: "blank" })).rejects.toMatchObject({ status: 400, message: "Name is required" });
});

test("a group needs a claim or a condition, and its conditions must make sense", async () => {
  const nobody = { status: 400, message: "A group needs an SSO group name or a condition" };
  await expect(create({ name: "Nobody" })).rejects.toMatchObject(nobody);
  await expect(create({ name: "Nobody", claim: null, conditions: [] })).rejects.toMatchObject(nobody);
  for (const conditions of [
    [{ attribute: "plan", op: "is", value: " " }],
    [{ attribute: " ", op: "is", value: "pro" }],
    [{ attribute: "plan", op: "is_one_of", value: [] }],
    [{ attribute: "plan", op: "is", value: ["pro"] }],
    [{ attribute: "plan", op: "contains", value: "pro" }],
    [{ attribute: "a".repeat(65), op: "is", value: "pro" }],
    [{ attribute: "plan", op: "is", value: "x".repeat(201) }],
    Array.from({ length: 11 }, (_, i) => ({ attribute: `a${i}`, op: "is", value: "x" })),
  ]) {
    await expect(create({ name: "Bad", conditions: conditions as never })).rejects.toMatchObject({ status: 400 });
  }
  expect(await list()).toEqual([]);

  // Changes keep one or the other.
  await create({ name: "Enterprise", claim: "enterprise" });
  await expect(update({ group: "enterprise", claim: null })).rejects.toMatchObject(nobody);
  expect(await update({ group: "enterprise", claim: null, conditions: [{ attribute: "plan", op: "is", value: "enterprise" }] })).toMatchObject({ claim: null });
  await expect(update({ group: "enterprise", conditions: [] })).rejects.toMatchObject(nobody);
  // Two changes at once can't take away both.
  const [claimGone, conditionsGone] = await Promise.allSettled([
    update({ group: "enterprise", claim: "enterprise", conditions: [] }),
    update({ group: "enterprise", claim: null }),
  ]);
  expect([claimGone.status, conditionsGone.status]).toContain("fulfilled");
  const [group] = await list();
  expect(group!.claim !== null || group!.conditions.length > 0).toBe(true);
});

test("keys come from the name, the next free one if it's taken, and never change", async () => {
  expect((await create({ name: "Pro", claim: "pro" })).key).toBe("pro");
  expect((await create({ name: "Pro!", claim: "pro-plan" })).key).toBe("pro-2");
  expect((await create({ name: "日本", claim: "japan" })).key).toBe("group");
  expect((await create({ name: "x".repeat(50), claim: "long" })).key).toBe("x".repeat(45));
  expect(await update({ group: "pro", name: "Gold", claim: "gold" })).toMatchObject({ key: "pro", name: "Gold", claim: "gold" });
  // Groups go by their key, never by the claim.
  await expect(update({ group: "gold", name: "Gone" })).rejects.toMatchObject({ status: 404 });
  // Two at once with the same name: one each.
  const both = await Promise.all([create({ name: "Twin", claim: "twin-a" }), create({ name: "Twin", claim: "twin-b" })]);
  expect(both.map((g) => g.key).sort()).toEqual(["twin", "twin-2"]);
});

test("a claim is unique in the project, not across projects", async () => {
  await create({ name: "Enterprise", claim: "enterprise" });
  await expect(create({ name: "Enterprise again", claim: "enterprise" })).rejects.toMatchObject({
    status: 409,
    message: "There's already a group “enterprise”",
  });
  await create({ name: "Beta", claim: "beta" });
  await expect(update({ group: "beta", claim: "enterprise" })).rejects.toMatchObject({ status: 409 });
  // Groups without one don't clash.
  await create({ name: "Pro", conditions: [{ attribute: "plan", op: "is", value: "pro" }] });
  await create({ name: "Team", conditions: [{ attribute: "plan", op: "is", value: "team" }] });
  const other = await createProject(owner);
  expect(await call(createGroup, team(other.id), { name: "Enterprise", claim: "enterprise" })).toMatchObject({ claim: "enterprise" });
  expect((await list()).map((g) => [g.name, g.claim])).toEqual([
    ["Beta", "beta"],
    ["Enterprise", "enterprise"],
    ["Pro", null],
    ["Team", null],
  ]);
});

test("readers counts the project's SSO users in a group now (by claim or conditions), and names the first 3", async () => {
  await create({ name: "Enterprise", claim: "enterprise" });
  await create({ name: "Pro", conditions: [{ attribute: "plan", op: "is_one_of", value: ["pro", "enterprise"] }] });
  await create({ name: "Big pro", claim: "big", conditions: [{ attribute: "plan", op: "is", value: "pro" }, { attribute: "seats", op: "is", value: "50" }] });
  await ssoReader("Ada", ["enterprise"], { plan: "enterprise" });
  await ssoReader("Bea", [], { plan: "pro", seats: 50 });
  await ssoReader("Cy", ["big"], { plan: "free" });
  await ssoReader("Dee", [], { plan: "pro", seats: 5 });
  await ssoReader("Eve", [], { plan: "Pro" });
  await ssoReader("Flo", ["enterprise"]);
  // Another project's people don't count, nor does the team.
  const other = await createProject(owner);
  await ssoReader("Gus", ["enterprise"], { plan: "pro" }, other.id);
  await signUp("Stranger");
  expect((await list()).map((g) => [g.key, g.readers, g.sample])).toEqual([
    ["big-pro", 2, ["Bea", "Cy"]],
    ["enterprise", 2, ["Ada", "Flo"]],
    ["pro", 3, ["Ada", "Bea", "Dee"]],
  ]);
  expect(await update({ group: "enterprise", name: "Enterprise plan", claim: "plan:enterprise", description: "Paying" })).toEqual({
    key: "enterprise",
    name: "Enterprise plan",
    claim: "plan:enterprise",
    description: "Paying",
    conditions: [],
    readers: 0,
    sample: [],
  });
});

test("a group a collection is for can't be deleted; once no collection is, it can", async () => {
  await create({ name: "Enterprise", claim: "enterprise" });
  await create({ name: "Unused", claim: "unused" });
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
    await create({ name: `Group ${i}`, claim: `group-${i}` });
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

test("changing a group's claim or conditions keeps the collections that are for it", async () => {
  await create({ name: "Enterprise", claim: "enterprise" });
  await call(createCollection, team(), { name: "Billing", groups: ["enterprise"] });
  await update({ group: "enterprise", claim: null, conditions: [{ attribute: "plan", op: "is", value: "enterprise" }] });
  const billing = await prisma.collection.findFirstOrThrow({
    where: { projectId: project.id },
    select: { groups: { select: { group: { select: { key: true, claim: true } } } } },
  });
  expect(billing.groups.map((g) => g.group)).toEqual([{ key: "enterprise", claim: null }]);
});

test("in the app: owners and admins only", async () => {
  const denied = { error: "Only project owners and admins can change the groups" };
  const conditions = JSON.stringify([{ attribute: "plan", op: "is", value: "pro" }]);
  actAs(await addMember(project.id, "MEMBER"));
  expect(await saveGroup(project.slug, null, {}, form({ name: "Enterprise", claim: "enterprise" }))).toEqual(denied);
  expect(await previewGroup(project.slug, "enterprise", [])).toEqual(denied);
  actAs(await signUp("Outsider"));
  expect(await saveGroup(project.slug, null, {}, form({ name: "Enterprise", claim: "enterprise" }))).toEqual(denied);
  expect(await list()).toEqual([]);

  actAs(await addMember(project.id, "ADMIN"));
  // Without a claim or a condition: refused; an empty claim is none.
  expect(await saveGroup(project.slug, null, {}, form({ name: "Pro", claim: "", conditions: "[]" }))).toEqual({
    error: "A group needs an SSO group name or a condition",
  });
  expect(await saveGroup(project.slug, null, {}, form({ name: "Pro", claim: "", conditions: "not json" }))).toMatchObject({ error: expect.any(String) });
  expect(await saveGroup(project.slug, null, {}, form({ name: "Pro", claim: "", conditions, description: "" }))).toEqual({});
  expect(await saveGroup(project.slug, "pro", {}, form({ name: "Pro plan", claim: "pro", conditions: "[]", description: "Paying" }))).toEqual({});
  expect(await list()).toEqual([{ key: "pro", name: "Pro plan", claim: "pro", description: "Paying", conditions: [], readers: 0, sample: [] }]);
  expect(await deleteGroupAction(project.slug, "pro")).toEqual({});
  expect(await list()).toEqual([]);
});

test("the dialog's preview: who a group with these rules would have now", async () => {
  await ssoReader("Ada", ["enterprise"], { plan: "pro" });
  await ssoReader("Bea", [], { plan: "pro", seats: 3 });
  await ssoReader("Cy", [], { plan: "free" });
  await ssoReader("Dee", [], { plan: "pro" });
  await ssoReader("Eve", [], { plan: "pro" });
  actAs(owner);
  expect(await previewGroup(project.slug, null, [{ attribute: "plan", op: "is", value: "pro" }])).toEqual({ readers: 4, sample: ["Ada", "Bea", "Dee"] });
  expect(await previewGroup(project.slug, "enterprise", [{ attribute: "seats", op: "is", value: "3" }])).toEqual({ readers: 2, sample: ["Ada", "Bea"] });
  expect(await previewGroup(project.slug, null, [])).toEqual({ readers: 0, sample: [] });
  expect(await previewGroup(project.slug, null, [{ attribute: "plan", op: "is", value: "" }])).toEqual({ error: "A condition needs a value" });
});

test("the migration gives today's groups their claim as their key, no conditions, and SSO users no attributes", async () => {
  const sql = readFileSync(new URL("../../../../../packages/db/prisma/migrations/20261021120000_group_conditions/migration.sql", import.meta.url), "utf8");
  // Back to before it, with a group and an SSO user as they were then.
  // (This file's database is its own: the other tests' groups can go.)
  await prisma.$executeRawUnsafe(`
    DELETE FROM "collection_group";
    DELETE FROM "reader_group";
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
