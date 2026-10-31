import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { SignJWT } from "jose";
import { beforeEach, expect, test } from "vitest";
import type { z } from "zod";

import { generateSsoSecret, verifySsoToken } from "@/lib/sso";
import { createProject, signUp, type TestUser } from "@/test/helpers";

import { createGroup } from "./groups";
import { call } from "./run";
import { getUser, listUsers, MAX_USERS_PER_SYNC, syncUsersOperation } from "./users";

/** The project's users (users.*): what the team's app sends, and what reader groups match. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const team = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });
const sync = (users: z.input<typeof syncUsersOperation.input>["users"], projectId = project.id) => call(syncUsersOperation, team(projectId), { users });
const get = (user: string) => call(getUser, team(), { user });
const list = (input: z.input<typeof listUsers.input> = {}) => call(listUsers, team(), input);

test("sync adds users by their id in the app, with their name, email (lowercase), avatar and properties", async () => {
  expect(
    await sync([
      { id: "user-1", name: "Ada", email: "Ada@Example.com", avatar: "https://example.com/ada.png", properties: { plan: "pro", seats: 3, beta: true, features: ["sso"] } },
      { id: "user-2", email: "e2e-bea@example.com" },
      { id: "user-3" },
    ]),
  ).toEqual({ created: 3, updated: 0 });
  expect(await get("user-1")).toMatchObject({
    id: "user-1",
    name: "Ada",
    email: "ada@example.com",
    avatar: "https://example.com/ada.png",
    properties: { plan: "pro", seats: 3, beta: true, features: ["sso"] },
    groups: [],
  });
  // Named after their email, or not at all.
  expect(await get("user-2")).toMatchObject({ name: "e2e-bea", email: "e2e-bea@example.com", avatar: null, properties: {} });
  expect(await get("user-3")).toMatchObject({ name: "Anonymous", email: null });
  await expect(get("user-4")).rejects.toMatchObject({ status: 404 });
});

test("a later sync changes only what it gives: properties named are set, null ones removed, the rest kept", async () => {
  await sync([{ id: "user-1", name: "Ada", email: "e2e-ada@example.com", properties: { plan: "free", seats: 3, trial: true } }]);
  expect(await sync([{ id: "user-1", properties: { plan: "pro", trial: null, features: ["audit"] } }])).toEqual({ created: 0, updated: 1 });
  expect(await get("user-1")).toMatchObject({ name: "Ada", email: "e2e-ada@example.com", properties: { plan: "pro", seats: 3, features: ["audit"] } });
  await sync([{ id: "user-1", name: "Ada Lovelace", email: null, avatar: null }]);
  expect(await get("user-1")).toMatchObject({ name: "Ada Lovelace", email: null, avatar: null, properties: { plan: "pro", seats: 3, features: ["audit"] } });
});

test("all or nothing: a user past 50 properties, a bad value or the same id twice refuses the whole sync", async () => {
  const fortyNine = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`p${i}`, i]));
  await sync([
    { id: "almost", name: "Original", properties: fortyNine },
    { id: "full", properties: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, i])) },
  ]);
  // A change to "almost" and a new user come first; "full" going past 50 undoes both.
  await expect(
    sync([
      { id: "almost", name: "Changed", properties: { extra: 1 } },
      { id: "new", properties: { plan: "pro" } },
      { id: "full", properties: { extra: 1 } },
    ]),
  ).rejects.toMatchObject({ status: 400, message: "“full” would have more than 50 properties" });
  expect(await get("almost")).toMatchObject({ name: "Original", properties: fortyNine });
  // Changing or removing the ones there is fine.
  await sync([{ id: "full", properties: { p0: "changed", p1: null } }]);
  for (const bad of [
    [{ id: "new", properties: { nested: { a: 1 } } }],
    [{ id: "new", properties: { mixed: ["a", 1] } }],
    [{ id: "new", email: "not an email" }],
    [{ id: "new", avatar: "javascript:alert(1)" }],
    [{ id: "" }],
    [{ id: "new" }, { id: "new" }],
    [],
    Array.from({ length: MAX_USERS_PER_SYNC + 1 }, (_, i) => ({ id: `u${i}` })),
  ]) {
    await expect(sync(bad as never)).rejects.toMatchObject({ status: 400 });
  }
  expect((await list()).users.map((user) => user.id)).toEqual(["full", "almost"]);
});

test(`up to ${MAX_USERS_PER_SYNC} users at once, new and known together`, async () => {
  await sync(Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, properties: { plan: "free" } })));
  const users = Array.from({ length: MAX_USERS_PER_SYNC }, (_, i) => ({ id: `u${i}`, name: `User ${String(i).padStart(4, "0")}`, properties: { plan: "pro", n: i } }));
  expect(await sync(users)).toEqual({ created: MAX_USERS_PER_SYNC - 10, updated: 10 });
  expect(await prisma.ssoIdentity.count({ where: { projectId: project.id, properties: { path: ["plan"], equals: "pro" } } })).toBe(MAX_USERS_PER_SYNC);
});

test("two syncs at once that both add someone: one user, with both syncs' properties", async () => {
  for (let i = 0; i < 5; i++) {
    const id = `racer-${i}`;
    await Promise.all([sync([{ id, properties: { a: 1 } }]), sync([{ id, properties: { b: 2 } }])]);
    expect(await prisma.ssoIdentity.count({ where: { projectId: project.id, externalId: id } })).toBe(1);
    expect((await get(id)).properties).toEqual({ a: 1, b: 2 });
  }
});

test("new users are added in id order, whatever order a sync gives them in, so two syncs adding the same ones can't deadlock", async () => {
  await sync(["user-c", "user-a", "user-b"].map((id) => ({ id })));
  // In the order the rows were written.
  const written = await prisma.$queryRaw<{ externalId: string }[]>`SELECT "externalId" FROM sso_identity WHERE "projectId" = ${project.id} ORDER BY ctid`;
  expect(written.map((row) => row.externalId)).toEqual(["user-a", "user-b", "user-c"]);
  const ids = Array.from({ length: 50 }, (_, j) => `pair-${String(j).padStart(2, "0")}`);
  await Promise.all([sync(ids.map((id) => ({ id, properties: { a: 1 } }))), sync([...ids].reverse().map((id) => ({ id, properties: { b: 2 } })))]);
  expect((await get(ids[0]!)).properties).toEqual({ a: 1, b: 2 });
});

test("listed by name, with the groups they're in; found by name, email or id, or by group; a page at a time", async () => {
  await call(createGroup, team(), { name: "Pro", conditions: [{ property: "plan", op: "is", value: "pro" }] });
  await sync([
    { id: "user-b", name: "Bea", email: "e2e-bea@acme.example", properties: { plan: "pro" } },
    { id: "user-a", name: "Ada", email: "e2e-ada@other.example", properties: { plan: "free" } },
    { id: "user-c", name: "Cy", email: "e2e-cy@acme.example" },
  ]);
  const { users, nextCursor } = await list();
  expect(users.map((user) => [user.id, user.groups])).toEqual([
    ["user-a", []],
    ["user-b", ["pro"]],
    ["user-c", []],
  ]);
  expect(nextCursor).toBeNull();
  expect((await list({ q: "ACME.example" })).users.map((user) => user.id)).toEqual(["user-b", "user-c"]);
  expect((await list({ q: "bea" })).users.map((user) => user.id)).toEqual(["user-b"]);
  expect((await list({ q: "user-c" })).users.map((user) => user.id)).toEqual(["user-c"]);
  // Ids match whole: "user" isn't one.
  expect((await list({ q: "user" })).users).toEqual([]);
  // By group: whoever's in it now, by the same rules as reading.
  expect((await list({ group: "pro" })).users.map((user) => user.id)).toEqual(["user-b"]);
  await call(createGroup, team(), { name: "No plan", conditions: [{ property: "plan", op: "is_not_set" }] });
  await call(createGroup, team(), { name: "Acme", conditions: [{ property: "plan", op: "is_none_of", value: ["pro"] }, { property: "plan", op: "is_set" }] });
  expect((await list({ group: "no-plan" })).users.map((user) => user.id)).toEqual(["user-c"]);
  expect((await list({ group: "acme" })).users.map((user) => user.id)).toEqual(["user-a"]);
  expect((await list({ group: "no-plan", q: "bea" })).users).toEqual([]);
  await expect(list({ group: "nobody" })).rejects.toMatchObject({ status: 404 });
  // % and _ in a search are plain text.
  expect((await list({ q: "%" })).users).toEqual([]);
  const first = await list({ limit: 2 });
  expect([first.users.map((user) => user.id), first.nextCursor]).toEqual([["user-a", "user-b"], "2"]);
  expect((await list({ limit: 2, cursor: 2 })).users.map((user) => user.id)).toEqual(["user-c"]);
  // Whoever has the id searched for comes first, whatever their name.
  await sync([{ id: "acme", name: "Zed", email: "e2e-zed@zed.example" }]);
  expect((await list({ q: "acme" })).users.map((user) => user.id)).toEqual(["acme", "user-b", "user-c"]);
  // Found by their id however long it is (up to 255 characters).
  const long = "x".repeat(255);
  await sync([{ id: long, name: "Lou" }]);
  expect((await list({ q: long })).users.map((user) => user.id)).toEqual([long]);
});

test("a synced user who signs in through the project's SSO is the same user, and keeps what the API set", async () => {
  const secret = generateSsoSecret();
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: secret } });
  await sync([{ id: "user-1", name: "Ada", properties: { plan: "enterprise", seats: 40 } }]);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub: "user-1", jti: randomUUID(), name: "Ada L", properties: { role: "admin" } })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(secret));
  const signedIn = await verifySsoToken({ id: project.id, ssoSecret: secret }, token);
  expect(signedIn).toEqual({ userId: (await prisma.ssoIdentity.findFirstOrThrow({ where: { projectId: project.id, externalId: "user-1" } })).userId });
  expect(await get("user-1")).toMatchObject({ name: "Ada L", properties: { plan: "enterprise", seats: 40, role: "admin" } });
});

test("the same id in another project is someone else, and each project lists only its own", async () => {
  const other = await createProject(owner);
  await sync([{ id: "user-1", properties: { plan: "pro" } }]);
  await sync([{ id: "user-1", properties: { plan: "free" } }], other.id);
  expect((await get("user-1")).properties).toEqual({ plan: "pro" });
  expect((await list()).users).toHaveLength(1);
  expect((await call(getUser, team(other.id), { user: "user-1" })).properties).toEqual({ plan: "free" });
});
