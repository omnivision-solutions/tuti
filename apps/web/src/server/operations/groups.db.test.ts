import { readFileSync } from "node:fs";

import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";
import type { z } from "zod";

import type { Properties } from "@/lib/user-properties";
import { actAs, addMember, createProject, inGroupNamed, signUp, type TestUser } from "@/test/helpers";

import { deleteGroup as deleteGroupAction, previewGroup, saveGroup, setPropertyFormats } from "../groups";
import { syncUsers } from "../project-users";
import { createCollection, updateCollection } from "./docs";
import { createGroup, deleteGroup, listGroups, propertiesInUse, propertyNames, updateGroup } from "./groups";
import { updateProject, updatePropertyFormats } from "./more";
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

/** One of the project's users, with `properties`. */
async function ssoReader(name: string, properties: Properties = {}, projectId = project.id) {
  const user = await signUp(name);
  await prisma.ssoIdentity.create({ data: { projectId, externalId: crypto.randomUUID(), userId: user.id, properties } });
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.set(name, value);
  }
  return data;
};

const plan = (value: string) => [{ property: "plan", op: "is" as const, value }];

test("groups have a name, a key from it, conditions and a description; listed by name", async () => {
  expect(await create({ name: "  Enterprise customers ", conditions: plan("enterprise"), description: " On the Enterprise plan " })).toEqual({
    key: "enterprise-customers",
    name: "Enterprise customers",
    description: "On the Enterprise plan",
    conditions: plan("enterprise"),
    readers: 0,
    sample: [],
  });
  expect(
    await create({ name: "Pro", conditions: [{ property: " plan ", op: "is_any_of", value: ["pro", " pro", "Pro"] }, { property: "role", op: "is_not", value: "guest" }] }),
  ).toMatchObject({
    key: "pro",
    conditions: [
      { property: "plan", op: "is_any_of", value: ["pro", "Pro"] },
      { property: "role", op: "is_not", value: "guest" },
    ],
  });
  expect(await create({ name: "Beta", conditions: inGroupNamed("beta") })).toMatchObject({ key: "beta", description: "" });
  expect((await list()).map((g) => g.name)).toEqual(["Beta", "Enterprise customers", "Pro"]);
  await expect(create({ name: " ", conditions: plan("pro") })).rejects.toMatchObject({ status: 400, message: "Name is required" });
});

test("a group needs a condition, and its conditions must make sense", async () => {
  const nobody = { status: 400, message: "A group needs a condition" };
  await expect(create({ name: "Nobody", conditions: [] })).rejects.toMatchObject(nobody);
  await expect(create({ name: "Nobody" } as never)).rejects.toMatchObject({ status: 400 });
  for (const conditions of [
    [{ property: "plan", op: "is", value: " " }],
    [{ property: " ", op: "is", value: "pro" }],
    [{ property: "plan", op: "is_any_of", value: [] }],
    [{ property: "plan", op: "is", value: ["pro"] }],
    [{ property: "plan", op: "matches", value: "pro" }],
    [{ property: "a".repeat(65), op: "is", value: "pro" }],
    [{ property: "plan", op: "is", value: "x".repeat(201) }],
    Array.from({ length: 11 }, (_, i) => ({ property: `a${i}`, op: "is", value: "x" })),
  ]) {
    await expect(create({ name: "Bad", conditions: conditions as never })).rejects.toMatchObject({ status: 400 });
  }
  expect(await list()).toEqual([]);
  // Changes keep at least one.
  await create({ name: "Enterprise", conditions: plan("enterprise") });
  await expect(update({ group: "enterprise", conditions: [] })).rejects.toMatchObject(nobody);
  // A claim from before is no longer taken (and changes nothing).
  expect(await update({ group: "enterprise", claim: "enterprise" } as never)).toMatchObject({ conditions: plan("enterprise") });
});

test("keys come from the name, the next free one if it's taken, and never change", async () => {
  expect((await create({ name: "Pro", conditions: plan("pro") })).key).toBe("pro");
  expect((await create({ name: "Pro!", conditions: plan("pro") })).key).toBe("pro-2");
  expect((await create({ name: "日本", conditions: plan("japan") })).key).toBe("group");
  expect((await create({ name: "x".repeat(50), conditions: plan("long") })).key).toBe("x".repeat(45));
  expect(await update({ group: "pro", name: "Gold", conditions: plan("gold") })).toMatchObject({ key: "pro", name: "Gold", conditions: plan("gold") });
  await expect(update({ group: "gold", name: "Gone" })).rejects.toMatchObject({ status: 404 });
  // Two at once with the same name: one each.
  const both = await Promise.all([create({ name: "Twin", conditions: plan("a") }), create({ name: "Twin", conditions: plan("b") })]);
  expect(both.map((g) => g.key).sort()).toEqual(["twin", "twin-2"]);
  // Another project's are its own.
  const other = await createProject(owner);
  expect(await call(createGroup, team(other.id), { name: "Pro", conditions: plan("pro") })).toMatchObject({ key: "pro" });
});

test("readers counts the project's users in a group now, and names the first 3", async () => {
  await create({ name: "Enterprise", conditions: inGroupNamed("enterprise") });
  await create({ name: "Pro", conditions: [{ property: "plan", op: "is_any_of", value: ["pro", "enterprise"] }] });
  await create({ name: "Big pro", conditions: [{ property: "plan", op: "is", value: "pro" }, { property: "seats", op: "is", value: "50" }] });
  await ssoReader("Ada", { groups: ["enterprise"], plan: "enterprise" });
  await ssoReader("Bea", { plan: "pro", seats: 50 });
  await ssoReader("Cy", { groups: ["big"], plan: "free" });
  await ssoReader("Dee", { plan: "pro", seats: 5 });
  await ssoReader("Eve", { plan: "Pro" });
  await ssoReader("Flo", { groups: ["enterprise"] });
  // Another project's people don't count, nor does the team.
  const other = await createProject(owner);
  await ssoReader("Gus", { groups: ["enterprise"], plan: "pro" }, other.id);
  await signUp("Stranger");
  expect((await list()).map((g) => [g.key, g.readers, g.sample])).toEqual([
    ["big-pro", 1, ["Bea"]],
    ["enterprise", 2, ["Ada", "Flo"]],
    ["pro", 3, ["Ada", "Bea", "Dee"]],
  ]);
  expect(await update({ group: "enterprise", name: "Enterprise plan", conditions: inGroupNamed("plan:enterprise"), description: "Paying" })).toEqual({
    key: "enterprise",
    name: "Enterprise plan",
    description: "Paying",
    conditions: inGroupNamed("plan:enterprise"),
    readers: 0,
    sample: [],
  });
});

test("a group a collection is for can't be deleted; once no collection is, it can", async () => {
  await create({ name: "Enterprise", conditions: plan("enterprise") });
  await create({ name: "Unused", conditions: plan("unused") });
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
    await create({ name: `Group ${i}`, conditions: plan(`group-${i}`) });
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

test("changing a group's conditions keeps the collections that are for it", async () => {
  await create({ name: "Enterprise", conditions: inGroupNamed("enterprise") });
  await call(createCollection, team(), { name: "Billing", groups: ["enterprise"] });
  await update({ group: "enterprise", conditions: plan("enterprise") });
  const billing = await prisma.collection.findFirstOrThrow({
    where: { projectId: project.id },
    select: { groups: { select: { group: { select: { key: true, conditions: true } } } } },
  });
  expect(billing.groups.map((g) => g.group)).toEqual([{ key: "enterprise", conditions: plan("enterprise") }]);
});

test("in the app: owners and admins only", async () => {
  const denied = { error: "Only project owners and admins can change the groups" };
  const conditions = JSON.stringify(plan("pro"));
  actAs(await addMember(project.id, "MEMBER"));
  expect(await saveGroup(project.slug, null, {}, form({ name: "Enterprise", conditions }))).toEqual(denied);
  expect(await previewGroup(project.slug, plan("pro"))).toEqual(denied);
  actAs(await signUp("Outsider"));
  expect(await saveGroup(project.slug, null, {}, form({ name: "Enterprise", conditions }))).toEqual(denied);
  expect(await list()).toEqual([]);

  actAs(await addMember(project.id, "ADMIN"));
  expect(await saveGroup(project.slug, null, {}, form({ name: "Pro", conditions: "[]" }))).toEqual({ error: "A group needs a condition" });
  expect(await saveGroup(project.slug, null, {}, form({ name: "Pro", conditions: "not json" }))).toMatchObject({ error: expect.any(String) });
  expect(await saveGroup(project.slug, null, {}, form({ name: "Pro", conditions, description: "" }))).toEqual({});
  expect(await saveGroup(project.slug, "pro", {}, form({ name: "Pro plan", conditions: JSON.stringify(plan("gold")), description: "Paying" }))).toEqual({});
  expect(await list()).toEqual([{ key: "pro", name: "Pro plan", description: "Paying", conditions: plan("gold"), readers: 0, sample: [] }]);
  expect(await deleteGroupAction(project.slug, "pro")).toEqual({});
  expect(await list()).toEqual([]);
});

test("the dialog's preview: who a group with these conditions would have now, the first 50 of them", async () => {
  await ssoReader("Ada", { groups: ["enterprise"], plan: "pro" });
  await ssoReader("Bea", { plan: "pro", seats: 3 });
  await ssoReader("Cy", { plan: "free" });
  await ssoReader("Dee", { plan: "pro" });
  await ssoReader("Eve", { plan: "pro" });
  actAs(owner);
  const names = async (conditions: Parameters<typeof previewGroup>[1]) => {
    const result = await previewGroup(project.slug, conditions);
    return "error" in result ? result : { readers: result.readers, users: result.users.map((user) => user.name) };
  };
  expect(await names(plan("pro"))).toEqual({ readers: 4, users: ["Ada", "Bea", "Dee", "Eve"] });
  expect(await names([...inGroupNamed("enterprise"), { property: "plan", op: "is_set" }])).toEqual({ readers: 1, users: ["Ada"] });
  expect(await names([{ property: "seats", op: "is_not_set" }])).toEqual({ readers: 4, users: ["Ada", "Cy", "Dee", "Eve"] });
  expect(await names([])).toEqual({ readers: 0, users: [] });
  // At most 50 of them.
  await syncUsers(project.id, Array.from({ length: 51 }, (_, i) => ({ externalId: `bulk-${i}`, name: `Bulk ${i}`, properties: { plan: "bulk" } })));
  const bulk = await previewGroup(project.slug, plan("bulk"));
  expect("users" in bulk && [bulk.readers, bulk.users.length]).toEqual([51, 50]);
  // Each with their id in the app, email and avatar.
  expect((await previewGroup(project.slug, plan("free"))) as unknown).toEqual({ readers: 1, users: [{ id: expect.any(String), name: "Cy", email: null, avatar: null }] });
  expect(await previewGroup(project.slug, [{ property: "plan", op: "is", value: "" }])).toEqual({ error: "A condition needs a value" });
});

/** Back to before 20261023160000_groups_from_properties: without the triggers that keep the old columns in step. */
const undoGroupsFromProperties = () =>
  prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS "sso_identity_groups_in_step" ON "sso_identity";
    DROP FUNCTION IF EXISTS "sso_identity_groups_in_step"();
    DROP TRIGGER IF EXISTS "reader_group_claim_to_condition" ON "reader_group";
    DROP FUNCTION IF EXISTS "reader_group_claim_to_condition"();`);

test("the migration gives today's groups their claim as their key, no conditions, and SSO users no attributes", async () => {
  const sql = readFileSync(new URL("../../../../../packages/db/prisma/migrations/20261021130000_group_conditions/migration.sql", import.meta.url), "utf8");
  // Back to before it, with a group and an SSO user as they were then.
  // (This file's database is its own: the other tests' groups can go.)
  await undoGroupsFromProperties();
  await prisma.$executeRawUnsafe(`
    DELETE FROM "collection_group";
    DELETE FROM "reader_group";
    DROP INDEX "reader_group_projectId_key_key";
    ALTER TABLE "reader_group" DROP COLUMN "key", DROP COLUMN "conditions", ALTER COLUMN "claim" SET NOT NULL;
    ALTER TABLE "sso_identity" DROP COLUMN "attributes";`);
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", name, claim, "updatedAt") VALUES ('g1', ${project.id}, 'Pro plan', 'plan:pro', now())`;
  await prisma.$executeRaw`INSERT INTO sso_identity (id, "projectId", "externalId", "userId", groups, "updatedAt") VALUES ('s1', ${project.id}, 'user-1', ${owner.id}, '{plan:pro}', now())`;

  await prisma.$executeRawUnsafe(sql);

  expect(await prisma.$queryRaw`SELECT key, claim, conditions FROM reader_group WHERE "projectId" = ${project.id}`).toEqual([
    { key: "plan:pro", claim: "plan:pro", conditions: [] },
  ]);
  expect(await prisma.ssoIdentity.findMany({ where: { projectId: project.id }, select: { properties: true } })).toEqual([{ properties: {} }]);
  // Then groups from properties (20261023160000_groups_from_properties): the claim becomes a condition.
  await prisma.$executeRawUnsafe(
    readFileSync(new URL("../../../../../packages/db/prisma/migrations/20261023160000_groups_from_properties/migration.sql", import.meta.url), "utf8"),
  );
  expect((await list()).map((g) => [g.key, g.readers, g.conditions])).toEqual([["plan:pro", 1, inGroupNamed("plan:pro")]]);
});

test("the operators' migration renames conditions' attribute to property and is_one_of to is_any_of, in order", async () => {
  const sql = readFileSync(new URL("../../../../../packages/db/prisma/migrations/20261023140000_condition_operators/migration.sql", import.meta.url), "utf8");
  const old = [
    { attribute: "plan", op: "is_one_of", value: ["pro", "enterprise"] },
    { attribute: "role", op: "is_not", value: "guest" },
  ];
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", key, name, conditions, "updatedAt") VALUES ('g-old', ${project.id}, 'old', 'Old', ${JSON.stringify(old)}::jsonb, now())`;
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", key, name, claim, "updatedAt") VALUES ('g-claim', ${project.id}, 'claimed', 'Claimed', 'beta', now())`;

  await prisma.$executeRawUnsafe(sql);

  expect(await prisma.readerGroup.findMany({ where: { projectId: project.id }, select: { key: true, conditions: true }, orderBy: { key: "asc" } })).toEqual([
    // Since groups from properties, a group named by a claim gets its condition as it's written (see below).
    { key: "claimed", conditions: inGroupNamed("beta") },
    {
      key: "old",
      conditions: [
        { property: "plan", op: "is_any_of", value: ["pro", "enterprise"] },
        { property: "role", op: "is_not", value: "guest" },
      ],
    },
  ]);
});

test("groups from properties: a token's groups become the `groups` property, and a group named by them its condition", async () => {
  const sql = readFileSync(new URL("../../../../../packages/db/prisma/migrations/20261023160000_groups_from_properties/migration.sql", import.meta.url), "utf8");
  // As before it: groups with a claim (one with conditions too) and users with `groups`.
  await undoGroupsFromProperties();
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "reader_group_projectId_claim_key" ON "reader_group"("projectId", "claim")`);
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", key, name, claim, "updatedAt") VALUES (${crypto.randomUUID()}, ${project.id}, 'beta', 'Beta', 'beta', now())`;
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", key, name, claim, conditions, "updatedAt")
    VALUES (${crypto.randomUUID()}, ${project.id}, 'both', 'Both', 'both', ${JSON.stringify(plan("pro"))}::jsonb, now())`;
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", key, name, conditions, "updatedAt") VALUES (${crypto.randomUUID()}, ${project.id}, 'pro', 'Pro', ${JSON.stringify(plan("pro"))}::jsonb, now())`;
  const [ada, bea] = [await signUp("Ada"), await signUp("Bea")];
  await prisma.$executeRaw`INSERT INTO sso_identity (id, "projectId", "externalId", "userId", groups, attributes, "updatedAt")
    VALUES (${crypto.randomUUID()}, ${project.id}, 'ada', ${ada.id}, '{beta,both}', '{"plan": "pro"}', now()), (${crypto.randomUUID()}, ${project.id}, 'bea', ${bea.id}, '{}', '{"plan": "free"}', now())`;
  // One with a `groups` property but none in the column.
  await prisma.$executeRaw`INSERT INTO sso_identity (id, "projectId", "externalId", "userId", groups, attributes, "updatedAt")
    VALUES (${crypto.randomUUID()}, ${project.id}, 'cy', ${(await signUp("Cy")).id}, '{}', '{"groups": ["beta"]}', now())`;

  await prisma.$executeRawUnsafe(sql);

  expect(await prisma.readerGroup.findMany({ where: { projectId: project.id }, select: { key: true, conditions: true }, orderBy: { key: "asc" } })).toEqual([
    { key: "beta", conditions: inGroupNamed("beta") },
    { key: "both", conditions: plan("pro") },
    { key: "pro", conditions: plan("pro") },
  ]);
  expect(await prisma.ssoIdentity.findMany({ where: { projectId: project.id }, select: { externalId: true, properties: true }, orderBy: { externalId: "asc" } })).toEqual([
    { externalId: "ada", properties: { plan: "pro", groups: ["beta", "both"] } },
    { externalId: "bea", properties: { plan: "free" } },
    { externalId: "cy", properties: { groups: ["beta"] } },
  ]);
  expect(await prisma.ssoIdentity.findMany({ where: { projectId: project.id }, select: { externalId: true, legacyGroups: true }, orderBy: { externalId: "asc" } })).toEqual([
    { externalId: "ada", legacyGroups: ["beta", "both"] },
    { externalId: "bea", legacyGroups: [] },
    { externalId: "cy", legacyGroups: ["beta"] },
  ]);
  expect((await list()).map((g) => [g.key, g.readers])).toEqual([
    ["beta", 2],
    ["both", 1],
    ["pro", 1],
  ]);
  // New groups have no claim, so any number of them can be added.
  await create({ name: "One", conditions: plan("x") });
  await create({ name: "Two", conditions: plan("y") });
});

test("while a deploy overlaps, what instances from before write in the old columns is kept in step with properties and conditions", async () => {
  await create({ name: "Beta", conditions: inGroupNamed("beta") });
  const ada = await signUp("Ada");
  // An instance from before signs someone in with `groups` (an insert, then a change), and takes them away.
  await prisma.$executeRaw`INSERT INTO sso_identity (id, "projectId", "externalId", "userId", groups, attributes, "updatedAt")
    VALUES (${crypto.randomUUID()}, ${project.id}, 'ada', ${ada.id}, '{beta}', '{"plan": "pro"}', now())`;
  const properties = async () => (await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "ada" } })).properties;
  expect(await properties()).toEqual({ plan: "pro", groups: ["beta"] });
  expect((await list()).map((g) => g.readers)).toEqual([1]);
  await prisma.$executeRaw`UPDATE sso_identity SET groups = '{beta,gamma}' WHERE "externalId" = 'ada'`;
  expect(await properties()).toEqual({ plan: "pro", groups: ["beta", "gamma"] });
  await prisma.$executeRaw`UPDATE sso_identity SET groups = '{}' WHERE "externalId" = 'ada'`;
  expect(await properties()).toEqual({ plan: "pro" });
  expect((await list()).map((g) => g.readers)).toEqual([0]);
  // Other changes there leave the property alone.
  await syncUsers(project.id, [{ externalId: "ada", properties: { groups: ["beta"] } }]);
  await prisma.$executeRaw`UPDATE sso_identity SET email = 'e2e-ada@example.com' WHERE "externalId" = 'ada'`;
  expect(await properties()).toEqual({ plan: "pro", groups: ["beta"] });
  // New instances write the old column too, so instances from before see the same groups.
  const legacy = async () => (await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "ada" } })).legacyGroups;
  expect(await legacy()).toEqual(["beta"]);
  await syncUsers(project.id, [{ externalId: "ada", properties: { groups: null } }]);
  expect([await legacy(), await properties()]).toEqual([[], { plan: "pro" }]);
  await syncUsers(project.id, [{ externalId: "bea", properties: { groups: ["beta"] } }]);
  expect((await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "bea" } })).legacyGroups).toEqual(["beta"]);
  // And an instance from before that changes only the property (its users.sync) moves the column with it.
  await prisma.$executeRaw`UPDATE sso_identity SET attributes = attributes - 'groups' WHERE "externalId" = 'bea'`;
  expect((await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "bea" } })).legacyGroups).toEqual([]);
  await prisma.$executeRaw`UPDATE sso_identity SET attributes = attributes || '{"groups": "solo"}' WHERE "externalId" = 'bea'`;
  expect((await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "bea" } })).legacyGroups).toEqual(["solo"]);
  await prisma.$executeRaw`INSERT INTO sso_identity (id, "projectId", "externalId", "userId", attributes, "updatedAt")
    VALUES (${crypto.randomUUID()}, ${project.id}, 'cy', ${(await signUp("Cy")).id}, '{"groups": ["beta"]}', now())`;
  expect((await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "cy" } })).legacyGroups).toEqual(["beta"]);

  // An instance from before adds a group by claim, or changes its claim: it gets the condition.
  await prisma.$executeRaw`INSERT INTO reader_group (id, "projectId", key, name, claim, "updatedAt") VALUES (${crypto.randomUUID()}, ${project.id}, 'old', 'Old', 'partner', now())`;
  const conditions = async () => (await prisma.readerGroup.findFirstOrThrow({ where: { projectId: project.id, key: "old" } })).conditions;
  expect(await conditions()).toEqual(inGroupNamed("partner"));
  await prisma.$executeRaw`UPDATE reader_group SET claim = 'partner-2' WHERE key = 'old'`;
  expect(await conditions()).toEqual(inGroupNamed("partner-2"));
  // Conditions of its own stay; changed here, the claim goes, so it can't let anyone in after a rollback.
  await update({ group: "old", conditions: plan("pro") });
  expect(await prisma.readerGroup.findFirstOrThrow({ where: { projectId: project.id, key: "old" } })).toMatchObject({ legacyClaim: null, conditions: plan("pro") });
  await prisma.$executeRaw`UPDATE reader_group SET name = 'Renamed' WHERE key = 'old'`;
  expect(await conditions()).toEqual(plan("pro"));
});

test("the dialog suggests the names of the properties the project's users have", async () => {
  await ssoReader("Ada", { plan: "pro", seats: 3 });
  await ssoReader("Bea", { plan: "free", groups: ["beta"] });
  await ssoReader("Gus", { region: "eu" }, (await createProject(owner)).id);
  expect(await propertyNames(project.id)).toEqual(["groups", "plan", "seats"]);
});

test("Users' picked columns: those some user has, in their order, even past the 200 names the suggestions stop at", async () => {
  // 210 feature flags push "plan" past the first 200 names, A to Z.
  await ssoReader("Ada", { plan: "pro", ...Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`feature_${String(i).padStart(3, "0")}`, true])) });
  await ssoReader("Gus", { region: "eu" }, (await createProject(owner)).id);
  expect(await propertyNames(project.id)).not.toContain("plan");
  // "company" no user has; "region" only another project's users have.
  expect(await propertiesInUse(project.id, ["plan", "company", "feature_209", "region"])).toEqual(["plan", "feature_209"]);
});

test("User properties saves the rows changed on top of what's kept now: what someone saved since the page opened stays", async () => {
  actAs(owner);
  expect(await setPropertyFormats(project.slug, { mrr: { label: "MRR", format: "money" } })).toEqual({});
  // Saved meanwhile, elsewhere (another admin, the API).
  await prisma.project.update({ where: { id: project.id }, data: { propertyFormats: { mrr: { label: "MRR", format: "money" }, seats: { format: "number" } } } });
  expect(await setPropertyFormats(project.slug, { mrr: { label: "Monthly revenue", format: "money", currency: "EUR" } })).toEqual({});
  const kept = async () => (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).propertyFormats;
  expect(await kept()).toEqual({ mrr: { label: "Monthly revenue", format: "money", currency: "EUR" }, seats: { format: "number" } });
  // A row cleared is one dropped.
  expect(await setPropertyFormats(project.slug, { seats: { label: "", format: "text" } })).toEqual({});
  expect(await kept()).toEqual({ mrr: { label: "Monthly revenue", format: "money", currency: "EUR" } });
});

test("two admins saving User properties at once each keep the other's rows", async () => {
  actAs(owner);
  const saves = await Promise.all(Array.from({ length: 5 }, (_, i) => setPropertyFormats(project.slug, { [`p${i}`]: { label: `P${i}` } })));
  expect(saves).toEqual(Array.from({ length: 5 }, () => ({})));
  const { propertyFormats } = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  expect(Object.keys(propertyFormats as object).sort()).toEqual(["p0", "p1", "p2", "p3", "p4"]);
});

test("formats set all at once (project.update) and some at a time (propertyFormats.update) never lose each other's", async () => {
  for (let round = 0; round < 5; round++) {
    const some = Array.from({ length: 4 }, (_, i) => call(updatePropertyFormats, team(), { formats: { [`p${i}`]: { label: `P${i}` } } }));
    const all = call(updateProject, team(), { propertyFormats: { all: { label: `All ${round}` } } });
    await Promise.all([...some, all]);
    // In any order they could have run one by one: the full set is there, with only what was set some at a time after it.
    const { propertyFormats } = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const kept = propertyFormats as Record<string, { label: string }>;
    expect(kept.all).toEqual({ label: `All ${round}` });
    expect(Object.keys(kept).every((name) => name === "all" || /^p[0-3]$/.test(name))).toBe(true);
  }
});

test("formats set some at a time keep the others exactly as stored, even ones a later release wrote that this one can't read", async () => {
  // A later release's: a currency and a field this one doesn't know.
  const later = { arr: { format: "money", currency: "NZD", decimals: 0 } };
  await prisma.project.update({ where: { id: project.id }, data: { propertyFormats: { ...later, seats: { format: "number" } } } });
  await call(updatePropertyFormats, team(), { formats: { mrr: { label: "MRR" }, seats: { label: "" } } });
  const { propertyFormats } = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  // Seats cleared, MRR added, arr as it was.
  expect(propertyFormats).toEqual({ ...later, mrr: { label: "MRR" } });
});
