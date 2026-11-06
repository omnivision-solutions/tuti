import { randomUUID } from "node:crypto";

import { type Prisma, Prisma as PrismaNamespace, prisma } from "@tuti/db";
import { adminMember, contactUsers, handlers, importJob, IMPORT_KEY, IMPORT_PARTS as STEPS, importsSettled, loadAdmins, lockProject } from "@tuti/jobs";
import { FAKE_FEATUREBASE_KEY, type FeaturebaseFake, featurebaseFixtures, startFeaturebaseFake } from "@tuti/testkit";
import { openValue, sealValue } from "@tuti/shared/signed";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { auth } from "@/lib/auth";
import { IMPORT_PARTS } from "@/lib/import-parts";
import { generateInvitationToken, hashInvitationToken } from "@tuti/jobs";
import { updateConversation } from "@/server/operations/conversations";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { acceptInvitation, createInvitation } from "./invitations";
import { emailPasswordReset, setNewPassword } from "./password-reset";
import { removeMember } from "./team";

/** Imports (docs/plan.md, Switching from Featurebase, I1): starting one, its chain of pages, Contacts, and who's who, against the Featurebase fake. */

const log = { info: () => {}, warn: () => {} };
let fake: FeaturebaseFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
/** The fixtures' former admin's address (each test's own: they sign up with it). */
let formerEmail: string;

beforeAll(async () => {
  fake = await startFeaturebaseFake();
});
afterAll(() => fake.close());
beforeEach(async () => {
  vi.stubEnv("FEATUREBASE_API_URL", fake.url);
  Object.assign(fake, { fixtures: featurebaseFixtures(), pageSize: 100 });
  fake.forbidden.clear();
  formerEmail = `e2e-${randomUUID()}@example.com`;
  fake.fixtures.admins[1]!.email = formerEmail;
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const start = (input: Partial<{ key: string; parts: string[] }> = {}) =>
  call(startImport, asOwner(), { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: ["contacts"], ...input } as never);
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { status: number; code: string; message: string }) => ({ status: error.status, code: error.code, message: error.message }));
const usersOf = () =>
  prisma.ssoIdentity.findMany({ where: { projectId: project.id }, orderBy: { externalId: "asc" }, select: { externalId: true, email: true, properties: true, user: { select: { name: true, image: true } } } });
/** The fake's key as an import keeps it: sealed (encrypted at rest). */
const sealedKey = () => sealValue(IMPORT_KEY, FAKE_FEATUREBASE_KEY);
/** An import's row, as if one had started (running, with the key), at `step`. */
const running = (data: { apiKey?: string; step?: string; updatedAt?: Date } = {}) =>
  prisma.dataImport.create({ data: { projectId: project.id, source: "FEATUREBASE", startedById: owner.id, apiKey: sealedKey(), parts: ["contacts"], step: "contacts", ...data } });

test("every part the app offers can be imported", () => {
  expect(Object.keys(STEPS)).toEqual(expect.arrayContaining(Object.keys(IMPORT_PARTS)));
});

test("a start is refused, nothing made, for an API key, a key Featurebase refuses, a part it can't read, or a part that isn't there", async () => {
  const key = { actor: { kind: "apiKey" as const, keyId: "k", projectId: project.id, scope: "write" as const, createdById: owner.id }, projectId: project.id };
  expect(await refusal(call(startImport, key, { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: ["contacts"] }))).toMatchObject({ status: 403, code: "people_only" });
  expect(await refusal(start({ key: "sk_wrong" }))).toEqual({ status: 400, code: "bad_key", message: "Featurebase didn't accept this API key. Check you copied all of it, or make a new one." });
  expect(await refusal(start({ parts: ["changelog"] }))).toMatchObject({ status: 400, code: "invalid_input" });
  expect(await refusal(start({ parts: ["feedback"] }))).toEqual({ status: 400, code: "needs_part", message: "Feedback needs Contacts: pick it too." });
  expect(await refusal(start({ parts: [] }))).toEqual({ status: 400, code: "invalid_input", message: "Pick what to bring" });
  fake.forbidden.add("/v2/contacts");
  expect(await refusal(start())).toEqual({ status: 400, code: "cant_read", message: "This key can't read Contacts in Featurebase. Use a key that can, or leave Contacts out." });
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);
});

test("an import with a part this worker doesn't have (a newer web started it mid-deploy) fails, its key cleared, rather than ending done without it", async () => {
  const row = await prisma.dataImport.create({
    data: { projectId: project.id, source: "FEATUREBASE", startedById: owner.id, apiKey: sealedKey(), parts: ["contacts", "a-part-from-the-future"], step: "contacts" },
  });
  await handlers.importStep({ importId: row.id }, log);
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
    state: "FAILED",
    apiKey: null,
    error: "Tuti was updating as it started. Start it again to go on: what came across already is skipped.",
  });
  expect(await prisma.ssoIdentity.count({ where: { projectId: project.id } })).toBe(0);
});

test("a Featurebase that's slow or rate limited is said at once on starting, not waited out", async () => {
  // The answer asks for a minute's wait: the start doesn't wait it out, it says try again at once.
  fake.requests.length = 0;
  fake.failNext(429, 1, { "retry-after": "60" });
  expect(await refusal(start())).toMatchObject({ status: 502, code: "unavailable" });
  // Asked once: neither waited the minute out nor tried again (without the deadline it waits, and the test times out).
  expect(fake.requests.filter((request) => request.startsWith("GET /v2/admins"))).toHaveLength(1);
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);
});

test("Contacts come across as the project's users, page after page: their app's id, details, properties and company; the key is cleared at the end", async () => {
  fake.pageSize = 2;
  const started = await start();
  expect(started).toMatchObject({ state: "running", parts: ["contacts"], step: "contacts", startedBy: "Olive Owner" });
  await importsSettled();

  const { import: done } = await call(getImport, asOwner(), {});
  expect(done).toMatchObject({ id: started.id, state: "done", step: null, error: null, counts: { contacts: { imported: 3, leftOut: {} } }, finishedAt: expect.any(String) });
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: started.id } })).toMatchObject({ state: "DONE", apiKey: null });
  expect(await usersOf()).toEqual([
    {
      externalId: "app-user-1",
      email: "e2e-mira@example.com",
      // What Tuti's properties don't take (a nested object, text past 200 characters) is left out; the first company is `company`.
      properties: { company: "Fenwick Labs", plan: "pro", seats: 12, beta: true, features: ["sso", "audit"] },
      user: { name: "Mira Fenwick", image: `${fake.url}/files/mira.png` },
    },
    // Featurebase's placeholder avatar is left out: Tuti draws its own.
    { externalId: "app-user-2", email: "e2e-tobias@example.com", properties: { plan: "free", company: "Globex" }, user: { name: "Tobias Quill", image: null } },
    // A lead with no id of their own in the app.
    { externalId: "featurebase:65f000000000000000000003", email: null, properties: {}, user: { name: "Juno Park", image: null } },
  ]);
  expect(await prisma.importedRecord.count({ where: { projectId: project.id, kind: "contact" } })).toBe(3);

  // Imported again: nothing twice, and its summary says they were here already.
  const again = await start();
  await importsSettled();
  expect(await usersOf()).toHaveLength(3);
  expect(await prisma.importedRecord.count({ where: { projectId: project.id } })).toBe(3);
  expect((await call(getImport, asOwner(), {})).import).toMatchObject({ id: again.id, state: "done", counts: { contacts: { imported: 0, leftOut: { "already brought across earlier": 3 } } } });
});

test("the key is kept encrypted while the import runs, and a worker that can't open it fails the import, saying why", async () => {
  const row = await running();
  expect(row.apiKey).not.toContain(FAKE_FEATUREBASE_KEY);
  expect(openValue(IMPORT_KEY, row.apiKey!)).toBe(FAKE_FEATUREBASE_KEY);
  vi.stubEnv("BETTER_AUTH_SECRET", "another-secret-at-least-32-characters-long");
  await handlers.importStep({ importId: row.id }, log);
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
    state: "FAILED",
    apiKey: null,
    error: "The worker couldn't read the API key: give it the web app's BETTER_AUTH_SECRET. Start it again to go on: what came across already is skipped.",
  });
});

test("one import runs per project at a time: starting again returns it, and its view never has the key", async () => {
  const row = await running();
  const again = await start();
  expect(again.id).toBe(row.id);
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(1);
  expect(JSON.stringify(await call(getImport, asOwner(), {}))).not.toContain(FAKE_FEATUREBASE_KEY);
});

test("a page run twice, at once or again later, brings nothing twice", async () => {
  const row = await running();
  const results = await Promise.all([handlers.importStep({ importId: row.id }, log), handlers.importStep({ importId: row.id }, log)]);
  expect(results).toContainEqual({ skipped: true });
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "DONE", counts: { contacts: { imported: 3, leftOut: {} } } });
  // As if its save had been lost: the page again.
  await prisma.dataImport.update({ where: { id: row.id }, data: { state: "RUNNING", apiKey: sealedKey(), step: "contacts", cursor: null, counts: {} } });
  await handlers.importStep({ importId: row.id }, log);
  expect(await usersOf()).toHaveLength(3);
  expect(await prisma.importedRecord.count({ where: { projectId: project.id } })).toBe(3);
});

test("a page's save that loses a race to someone's first sign-in is tried again, its contacts counted once", async () => {
  const row = await running();
  const transaction = prisma.$transaction.bind(prisma) as (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => Promise<unknown>;
  // Its first save runs to the end, then fails as if a sign-in had made one of them at the same moment.
  vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) =>
    transaction(async (tx) => {
      await fn(tx);
      throw new PrismaNamespace.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    }, options)) as never);
  await handlers.importStep({ importId: row.id }, log);
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "DONE", counts: { contacts: { imported: 3, leftOut: {} } } });
  expect(await usersOf()).toHaveLength(3);
});

test("a page Featurebase refuses fails the import, saying so, and clears its key", async () => {
  const row = await running({ apiKey: sealValue(IMPORT_KEY, "sk_revoked") });
  expect(await handlers.importStep({ importId: row.id }, log)).toEqual({ failed: true });
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
    state: "FAILED",
    apiKey: null,
    error: "Featurebase stopped accepting the API key (Invalid API key). Start it again to go on: what came across already is skipped.",
    finishedAt: expect.any(Date),
  });
  expect(await usersOf()).toEqual([]);
});

test("a stuck import goes on when it's looked at; one that hasn't moved for a day is failed by the daily job, its key cleared", async () => {
  const stuck = await running({ updatedAt: new Date(Date.now() - 10 * 60_000) });
  expect((await call(getImport, asOwner(), {})).import).toMatchObject({ id: stuck.id, state: "running" });
  await importsSettled();
  expect((await call(getImport, asOwner(), {})).import).toMatchObject({ state: "done", counts: { contacts: { imported: 3 } } });

  const stale = await running({ updatedAt: new Date(Date.now() - 25 * 60 * 60_000) });
  const recent = await running({ updatedAt: new Date(Date.now() - 60 * 60_000) });
  expect(await handlers.failStaleImports({}, log)).toEqual({ failed: 1 });
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ state: "FAILED", apiKey: null, error: "It stopped moving for a day. Start it again to go on: what came across already is skipped." });
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: recent.id } })).toMatchObject({ state: "RUNNING", apiKey: recent.apiKey });
});

test("one that hasn't moved for a day is failed when it's looked at, not resumed: inline installs run no daily job", async () => {
  const stale = await running({ updatedAt: new Date(Date.now() - 25 * 60 * 60_000) });
  // With the step it stopped at, so its progress says where.
  expect((await call(getImport, asOwner(), {})).import).toMatchObject({
    id: stale.id,
    state: "failed",
    step: "contacts",
    error: "It stopped moving for a day. Start it again to go on: what came across already is skipped.",
  });
  await importsSettled();
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ state: "FAILED", apiKey: null });
  expect(await usersOf()).toEqual([]);
});

test("a page's save that Postgres aborts for its locks (a deadlock with a first sign-in) is tried again, not failed", async () => {
  const row = await running();
  vi.spyOn(prisma, "$transaction").mockImplementationOnce((() =>
    Promise.reject(new PrismaNamespace.PrismaClientKnownRequestError("deadlock detected (40P01)", { code: "P2034", clientVersion: "test" }))) as never);
  await handlers.importStep({ importId: row.id }, log);
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "DONE", counts: { contacts: { imported: 3 } } });
});

test("the same page failing in another run while this one saves it waits for the save, then fails nothing", async () => {
  const row = await running();
  const claim = { id: row.id, state: "RUNNING" as const, step: "contacts", cursor: null };
  const transaction = prisma.$transaction.bind(prisma) as (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => Promise<unknown>;
  let other: Promise<unknown> | undefined;
  // As the page's save writes its records (its claim checked), another run of the same page fails it, as its
  // importStep's catch does, and gets as far as it can (done, or waiting on the import's row) before the save goes on.
  vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) =>
    transaction(async (tx) => {
      const records = tx.importedRecord;
      const watched = new Proxy(tx, {
        get: (target, key) =>
          key === "importedRecord"
            ? {
                ...records,
                createMany: async (args: Parameters<typeof records.createMany>[0]) => {
                  other ??= prisma.dataImport.updateMany({ where: claim, data: { state: "FAILED", apiKey: null, error: "Featurebase couldn't be reached.", finishedAt: new Date() } });
                  // One poll for either outcome (the other run done, or waiting on the row), so nothing is left polling.
                  let settled = false;
                  void other.finally(() => (settled = true));
                  await expect.poll(async () => settled || (await locksWaited()) > 0, { timeout: 10_000 }).toBe(true);
                  return records.createMany(args);
                },
              }
            : (Reflect.get(target, key) as unknown),
      });
      return fn(watched);
    }, options)) as never);
  await handlers.importStep({ importId: row.id }, log);
  await other;
  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "DONE", error: "", counts: { contacts: { imported: 3, leftOut: {} } } });
});

/** How many queries in this database are waiting on a lock now. */
const locksWaited = async () =>
  (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n;


/** A page's work, for the helpers later parts use. */
const pageJob = async () => {
  const job = importJob(await running())!;
  await loadAdmins(job);
  return job;
};
const inPage = <T,>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async (tx) => {
    await lockProject(tx, project.id);
    return fn(tx);
  });

test("a contact the contacts step didn't bring is brought when a page needs them; one Featurebase doesn't have is missing", async () => {
  const job = await pageJob();
  const { save } = await contactUsers(job, ["65f000000000000000000002", "65f0000000000000000000ff"]);
  const users = await inPage((tx) => save(tx));
  expect([...users.keys()]).toEqual(["65f000000000000000000002"]);
  expect(await usersOf()).toMatchObject([{ externalId: "app-user-2", user: { name: "Tobias Quill" } }]);
  // Known now: the same user, without asking Featurebase again.
  fake.requests.length = 0;
  expect(await inPage(async (tx) => (await contactUsers(job, ["65f000000000000000000002"]).then((c) => c.save(tx))).get("65f000000000000000000002"))).toBe(users.get("65f000000000000000000002"));
  expect(fake.requests).toEqual([]);
});

test("a Featurebase admin is the team member with their verified email, else a placeholder person of the project's under their name, made once", async () => {
  fake.fixtures.admins[0]!.email = owner.email.toUpperCase();
  const job = await pageJob();
  // Not verified yet: anyone could have signed up with it.
  expect(await inPage((tx) => adminMember(tx, job, "65f0000000000000000000a1"))).toMatchObject({ member: false });
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  await prisma.importedRecord.deleteMany({ where: { projectId: project.id, kind: "admin" } });
  expect(await inPage((tx) => adminMember(tx, job, "65f0000000000000000000a1"))).toEqual({ userId: owner.id, member: true });
  const former = await inPage((tx) => adminMember(tx, job, "65f0000000000000000000a2"));
  expect(former.member).toBe(false);
  expect(await prisma.user.findUniqueOrThrow({ where: { id: former.userId } })).toMatchObject({
    name: "Fern Former",
    email: expect.stringMatching(/^imported-\w+@users\.tuti\.invalid$/),
    placeholderProjectId: project.id,
    placeholderFor: formerEmail,
    sampleProjectId: null,
  });
  // No way to sign in, and not one of the project's users.
  expect(await prisma.account.count({ where: { userId: former.userId } })).toBe(0);
  expect(await prisma.ssoIdentity.count({ where: { userId: former.userId } })).toBe(0);
  expect(await inPage((tx) => adminMember(tx, job, "65f0000000000000000000a2"))).toEqual(former);
  // One Featurebase no longer lists, by what the page saw of them.
  const gone = await inPage((tx) => adminMember(tx, job, "65f0000000000000000000a9", { name: "Gil Gone" }));
  expect(await prisma.user.findUniqueOrThrow({ where: { id: gone.userId } })).toMatchObject({ name: "Gil Gone", placeholderFor: null });
});

/** A placeholder for the fixtures' former admin, who wrote a post and a comment, voted for two posts, and held four conversations. */
async function placeholderWithHistory() {
  const job = await pageJob();
  const { userId: placeholder } = await inPage((tx) => adminMember(tx, job, "65f0000000000000000000a2"));
  const board = project.boards[0]!.id;
  const [theirs, both] = await Promise.all(
    [1, 2].map((number) => prisma.post.create({ data: { projectId: project.id, boardId: board, authorId: number === 1 ? placeholder : owner.id, number, title: `Post ${number}` } })),
  );
  await prisma.comment.create({ data: { projectId: project.id, postId: both!.id, authorId: placeholder, body: "Thanks!" } });
  await prisma.vote.createMany({ data: [theirs!, both!].map((post) => ({ projectId: project.id, postId: post.id, userId: placeholder })) });
  await prisma.post.updateMany({ where: { projectId: project.id }, data: { voteCount: 1 } });
  const conversations = await Promise.all(
    [1, 2, 3, 4].map((number) => prisma.conversation.create({ data: { projectId: project.id, number, subject: `Question ${number}`, status: "OPEN", origin: "API", lastMessageAt: new Date(), heldById: placeholder } })),
  );
  return { placeholder, theirs: theirs!, both: both!, conversations };
}

/** The placeholder's admin, invited to the team (to their address); `accept` joins. */
async function invite() {
  actAs(owner);
  const { url } = await createInvitation(project.slug, formerEmail, "MEMBER");
  const joiner = await signUp("Fern Former", formerEmail);
  return {
    joiner,
    accept: () => {
      actAs(joiner);
      return redirectTarget(acceptInvitation(url!.split("/invite/")[1]!));
    },
  };
}

test("verifying an address by accepting an emailed invite to another project hands over the placeholders in the projects they're on", async () => {
  const { placeholder, theirs } = await placeholderWithHistory();
  // On this project already, by a link (unverified): nothing handed over.
  const joiner = await signUp("Fern Former", formerEmail);
  await prisma.teamMember.create({ data: { projectId: project.id, userId: joiner.id, role: "MEMBER" } });
  // An emailed invite to another project verifies the address.
  const other = await createProject(owner);
  actAs(owner);
  const { url } = await createInvitation(other.slug, formerEmail, "MEMBER");
  actAs(joiner);
  expect(await redirectTarget(acceptInvitation(url!.split("/invite/")[1]!))).toBe(`/app/${other.slug}`);
  expect(await prisma.post.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ authorId: joiner.id });
  expect(await prisma.user.findUnique({ where: { id: placeholder } })).toBeNull();
});

test("a placeholder's admin who joins the team takes over what they wrote, their votes (theirs win a clash) and the conversations they still hold; the placeholder goes", async () => {
  const { placeholder, theirs, both, conversations } = await placeholderWithHistory();
  const [kept, taken, unassigned, olderRelease] = conversations;
  const teammate = await signUp("Tess Teammate");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: teammate.id, role: "MEMBER" } });
  // Assigned to a teammate, and one assigned then unassigned, before they join: the team's decision stands.
  await call(updateConversation, asOwner(), { number: kept!.number, assignee: teammate.email });
  await call(updateConversation, asOwner(), { number: unassigned!.number, assignee: teammate.email });
  await call(updateConversation, asOwner(), { number: unassigned!.number, assignee: null });
  // Assigned by the release before heldById, which left it set.
  await prisma.conversation.update({ where: { id: olderRelease!.id }, data: { assigneeId: teammate.id } });

  const { joiner, accept } = await invite();
  // They had voted for the second post already, as themselves.
  await prisma.vote.create({ data: { projectId: project.id, postId: both.id, userId: joiner.id } });
  await prisma.post.update({ where: { id: both.id }, data: { voteCount: 2 } });
  expect(await accept()).toBe(`/app/${project.slug}`);

  expect(await prisma.user.findUnique({ where: { id: placeholder } })).toBeNull();
  expect(await prisma.post.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ authorId: joiner.id, voteCount: 1 });
  expect(await prisma.post.findUniqueOrThrow({ where: { id: both.id } })).toMatchObject({ authorId: owner.id, voteCount: 1 });
  expect(await prisma.vote.findMany({ where: { projectId: project.id }, orderBy: { postId: "asc" }, select: { postId: true, userId: true } })).toEqual(
    [theirs, both].map((post) => ({ postId: post.id, userId: joiner.id })).sort((a, b) => (a.postId < b.postId ? -1 : 1)),
  );
  expect(await prisma.comment.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ authorId: joiner.id });
  const after = await prisma.conversation.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" }, select: { number: true, assigneeId: true, heldById: true } });
  expect(after).toEqual([
    { number: kept!.number, assigneeId: teammate.id, heldById: null },
    { number: taken!.number, assigneeId: joiner.id, heldById: null },
    { number: unassigned!.number, assigneeId: null, heldById: null },
    { number: olderRelease!.number, assigneeId: teammate.id, heldById: null },
  ]);
  // Later imports find them as the team member they are.
  expect(await prisma.importedRecord.findFirstOrThrow({ where: { projectId: project.id, kind: "admin" } })).toMatchObject({ externalId: "65f0000000000000000000a2", localId: joiner.id });
});

test("a join while an import page writes waits for the page, then takes over what it wrote", async () => {
  const job = await pageJob();
  // Invited first: inviting takes the project's lock too.
  const { joiner, accept } = await invite();
  let release!: () => void;
  let wrote!: (placeholder: string) => void;
  const written = new Promise<string>((resolve) => (wrote = resolve));
  // A page holding the project's lock: it makes the placeholder and writes a post as them.
  const page = prisma.$transaction(
    async (tx) => {
      await lockProject(tx, project.id);
      const { userId } = await adminMember(tx, job, "65f0000000000000000000a2");
      await tx.post.create({ data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: userId, number: 1, title: "Imported" } });
      wrote(userId);
      await new Promise<void>((resolve) => (release = resolve));
    },
    { timeout: 20_000 },
  );
  // The placeholder only exists once the page commits: joining before then waits on the lock.
  const placeholder = await written;
  const joining = accept();
  let joined = false;
  void joining.then(() => (joined = true));
  // Waiting on the page's lock, as Postgres tells.
  await expect.poll(async () => (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n, { timeout: 10_000 }).toBe(1);
  expect(joined).toBe(false);
  release();
  await page;
  await joining;
  expect(await prisma.post.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ authorId: joiner.id });
  expect(await prisma.user.findUnique({ where: { id: placeholder } })).toBeNull();
});

test("someone with the admin's address whose address isn't verified takes over nothing on joining by a link; verifying it later hands over", async () => {
  const { placeholder, theirs } = await placeholderWithHistory();
  const token = generateInvitationToken();
  await prisma.invitation.create({ data: { projectId: project.id, tokenHash: hashInvitationToken(token), createdById: owner.id, expiresAt: new Date(Date.now() + 60 * 60_000) } });
  const joiner = await signUp("Fern Former", formerEmail);
  actAs(joiner);
  expect(await redirectTarget(acceptInvitation(token))).toBe(`/app/${project.slug}`);
  expect(await prisma.teamMember.count({ where: { projectId: project.id, userId: joiner.id } })).toBe(1);
  expect(await prisma.post.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ authorId: placeholder });
  expect(await prisma.user.findUnique({ where: { id: placeholder } })).not.toBeNull();

  // The link in the email sent on signing up.
  const link = /https?:\/\/\S+\/api\/auth\/verify-email\?[^\s)"<]+/.exec((await mailbox.latestTo(formerEmail)).text)![0].replaceAll("&amp;", "&");
  expect((await auth.handler(new Request(link))).status).toBe(302);
  expect(await prisma.post.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ authorId: joiner.id });
  expect(await prisma.user.findUnique({ where: { id: placeholder } })).toBeNull();
});

test("an address verified any other way (a sign-in link, Google or GitHub: Better Auth's update) hands over too", async () => {
  const { placeholder, theirs } = await placeholderWithHistory();
  const joiner = await signUp("Fern Former", formerEmail);
  await prisma.teamMember.create({ data: { projectId: project.id, userId: joiner.id, role: "MEMBER" } });
  // Changing something else on an unverified account hands nothing over.
  const { internalAdapter } = await auth.$context;
  await internalAdapter.updateUser(joiner.id, { name: "Fern" });
  expect(await prisma.post.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ authorId: placeholder });
  await internalAdapter.updateUser(joiner.id, { emailVerified: true });
  expect(await prisma.post.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ authorId: joiner.id });
  expect(await prisma.user.findUnique({ where: { id: placeholder } })).toBeNull();
});

test("an address verified while an import page makes its placeholder hands over once the page commits", async () => {
  const job = await pageJob();
  const joiner = await signUp("Fern Former", formerEmail);
  await prisma.teamMember.create({ data: { projectId: project.id, userId: joiner.id, role: "MEMBER" } });
  let release!: () => void;
  let wrote!: (placeholder: string) => void;
  const written = new Promise<string>((resolve) => (wrote = resolve));
  // The page finds no verified member with the address, so it makes a placeholder, and holds the lock a while.
  const page = prisma.$transaction(
    async (tx) => {
      await lockProject(tx, project.id);
      const { userId } = await adminMember(tx, job, "65f0000000000000000000a2");
      await tx.post.create({ data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: userId, number: 1, title: "Imported" } });
      wrote(userId);
      await new Promise<void>((resolve) => (release = resolve));
    },
    { timeout: 20_000 },
  );
  const placeholder = await written;
  expect(placeholder).not.toBe(joiner.id);
  // Verified meanwhile: the handover waits for the page's lock rather than missing the placeholder it can't see yet.
  const { internalAdapter } = await auth.$context;
  const verifying = internalAdapter.updateUser(joiner.id, { emailVerified: true });
  await expect.poll(async () => (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n, { timeout: 10_000 }).toBe(1);
  release();
  await page;
  await verifying;
  expect(await prisma.post.findFirstOrThrow({ where: { projectId: project.id } })).toMatchObject({ authorId: joiner.id });
  expect(await prisma.user.findUnique({ where: { id: placeholder } })).toBeNull();
});

test("updating a verified team member with no placeholder and no import running never waits on the project's lock", async () => {
  const member = await signUp("Vera Verified", `e2e-vera-${Math.random().toString(36).slice(2, 8)}@example.com`);
  await prisma.teamMember.create({ data: { projectId: project.id, userId: member.id, role: "MEMBER" } });
  const { internalAdapter } = await auth.$context;
  await internalAdapter.updateUser(member.id, { emailVerified: true });
  let release!: () => void;
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  const other = prisma.$transaction(
    async (tx) => {
      await lockProject(tx, project.id);
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    },
    { timeout: 20_000 },
  );
  await holding;
  // A profile change while someone holds the lock finishes without waiting for it.
  await internalAdapter.updateUser(member.id, { name: "Vera" });
  release();
  await other;
});

test("a team member who resets their password by the emailed link has verified their address: the placeholder hands over", async () => {
  const { placeholder, theirs } = await placeholderWithHistory();
  const joiner = await signUp("Fern Former", formerEmail);
  await prisma.teamMember.create({ data: { projectId: project.id, userId: joiner.id, role: "MEMBER" } });
  expect(await prisma.user.findUniqueOrThrow({ where: { id: joiner.id } })).toMatchObject({ emailVerified: false });
  actAs(null);
  request.host = "tuti.localhost:3100";
  try {
    const ask = new FormData();
    ask.set("email", formerEmail);
    expect(await emailPasswordReset(ask)).toEqual({ sentTo: formerEmail });
    const message = await mailbox.latestTo(formerEmail);
    expect(message.subject).toBe("Reset your password");
    const link = new URL(message.text.split(/\s+/).find((word) => word.includes("/reset-password?"))!);
    const reset = new FormData();
    reset.set("token", link.searchParams.get("token")!);
    reset.set("password", "a brand new password");
    reset.set("confirm", "a brand new password");
    expect(await setNewPassword(reset)).toEqual({ location: "/sign-in?reset=done" });
  } finally {
    request.host = "";
  }
  expect(await prisma.post.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ authorId: joiner.id });
  expect(await prisma.user.findUnique({ where: { id: placeholder } })).toBeNull();
});

test("a held conversation assigned to someone who then leaves the team stays unassigned when the placeholder hands over", async () => {
  const { conversations } = await placeholderWithHistory();
  const held = conversations[0]!;
  const teammate = await signUp("Tess Teammate");
  const member = await prisma.teamMember.create({ data: { projectId: project.id, userId: teammate.id, role: "MEMBER" } });
  // Assigned by the release before heldById, which left it set.
  await prisma.conversation.update({ where: { id: held.id }, data: { assigneeId: teammate.id } });
  actAs(owner);
  expect(await removeMember(project.slug, member.id)).toEqual({});
  expect(await prisma.conversation.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ assigneeId: null, heldById: null });

  const { joiner, accept } = await invite();
  await accept();
  expect(await prisma.conversation.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ assigneeId: null, heldById: null });
  // The others it held are theirs.
  expect(await prisma.conversation.count({ where: { projectId: project.id, assigneeId: joiner.id } })).toBe(conversations.length - 1);
});
