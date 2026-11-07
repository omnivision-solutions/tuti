import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { DAILY_INVITE_LIMIT, generateInvitationToken, handlers, hashInvitationToken, IMPORT_KEY, importsSettled, lockProject, UNSENT_EXPIRY } from "@tuti/jobs";
import { sealValue } from "@tuti/shared/signed";
import { FAKE_FEATUREBASE_KEY, type FeaturebaseFake, featurebaseFixtures, startFeaturebaseFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { homeOverview } from "./home";
import { pendingInvitationsFor } from "./invitation-lookup";
import { acceptInvitation, acceptInvitationById, createInvitation, revokeInvitation, sendAllInvitations, sendInvitation } from "./invitations";

// The invite emails, as they are, unless a test runs something before one (to look at the database, or to fail it).
const emailHook = vi.hoisted(() => ({ before: null as null | ((to: string) => Promise<void>) }));
vi.mock("@tuti/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tuti/email")>();
  return {
    ...actual,
    sendEmail: async (...args: Parameters<typeof actual.sendEmail>) => {
      await emailHook.before?.(args[0].to);
      return actual.sendEmail(...args);
    },
  };
});

/**
 * The team from Featurebase (docs/plan.md, Switching from Featurebase, I6): its admins as invitations to the project, not
 * sent, for an owner or admin to send from Team & roles.
 */

const log = { info: () => {}, warn: () => {} };
let fake: FeaturebaseFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  fake = await startFeaturebaseFake();
});
afterAll(() => fake.close());
beforeEach(async () => {
  vi.stubEnv("FEATUREBASE_API_URL", fake.url);
  Object.assign(fake, { fixtures: featurebaseFixtures(), pageSize: 100 });
  fake.forbidden.clear();
  owner = await signUp("Olive Owner");
  await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
  project = await createProject(owner);
  await prisma.project.update({ where: { id: project.id }, data: { plan: "PRO" } });
  actAs(owner);
});

const newAddress = () => `e2e-${randomUUID()}@example.com`;
const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
/** Featurebase's admins: these addresses (null: none), each its own id. */
const admins = (...emails: (string | null)[]) => {
  fake.fixtures.admins = emails.map((email, i) => ({ object: "admin", id: `65f0000000000000000009${String(i).padStart(2, "0")}`, name: `Admin ${i}`, email, profilePicture: null, roleId: "custom" }));
};
const importTeam = async (parts = ["team"]) => {
  const started = await call(startImport, asOwner(), { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: parts as never });
  await importsSettled();
  const { import: run } = await call(getImport, asOwner(), {});
  expect(run!.id).toBe(started.id);
  return run!;
};
const invitationsOf = () =>
  prisma.invitation.findMany({ where: { projectId: project.id }, orderBy: [{ createdAt: "asc" }, { email: "asc" }], select: { id: true, email: true, role: true, sentAt: true, revokedAt: true, createdById: true } });
/** Emails sent to any of these addresses. */
const emailsTo = (...addresses: string[]) => mailbox.emails.filter((email) => addresses.some((address) => email.to.includes(address)));

test("Featurebase's admins become invitations to send, as members, by the person who imported: nobody is emailed", async () => {
  const [ada, bo] = [newAddress(), newAddress()];
  admins(ada, bo.toUpperCase());
  const run = await importTeam();
  expect(run).toMatchObject({ state: "done", counts: { invitations: { imported: 2, leftOut: {} } }, invitationsToSend: 2 });
  expect(importSummary(run)).toBe("2 invitations brought across.");
  // Addresses as Featurebase has them, lowercased.
  expect((await invitationsOf()).toSorted((a, b) => (a.email! < b.email! ? -1 : 1))).toEqual(
    [ada, bo].sort().map((email) => ({ id: expect.any(String), email, role: "MEMBER", sentAt: null, revokedAt: null, createdById: owner.id })),
  );
  expect(emailsTo(ada, bo)).toEqual([]);
  // Not sent, so not yet the team invited: Home's Get set up still has it to do.
  const { setup } = await homeOverview(project.id, project.slug);
  expect(setup?.find((step) => step.key === "team")).toMatchObject({ done: false });
});

test("left out, and said so: the importer, people on the team (verified), people already invited, admins without an address; a repeat import invites nobody again, even one removed", async () => {
  const teammate = await signUp("Tess Teammate");
  await prisma.user.update({ where: { id: teammate.id }, data: { emailVerified: true } });
  await prisma.teamMember.create({ data: { projectId: project.id, userId: teammate.id, role: "MEMBER" } });
  const invited = newAddress();
  await prisma.invitation.create({ data: { projectId: project.id, email: invited, tokenHash: hashInvitationToken(generateInvitationToken()), createdById: owner.id, expiresAt: new Date(Date.now() + 60_000) } });
  const fresh = newAddress();
  admins(owner.email.toUpperCase(), teammate.email, invited, null, fresh);
  const run = await importTeam();
  expect(run.counts).toEqual({
    invitations: {
      imported: 1,
      leftOut: { "for the person who ran the import, already on the team": 1, "for people already on the team": 1, "for people already invited": 1, "for admins without an email": 1 },
    },
  });
  expect(importSummary(run)).toBe(
    "1 invitation brought across. Left out: 1 invitation for people already invited; 1 invitation for admins without an email; 1 invitation for people already on the team; 1 invitation for the person who ran the import, already on the team.",
  );
  const [made] = (await invitationsOf()).filter((invitation) => invitation.email === fresh);
  expect(made).toMatchObject({ sentAt: null });

  // The team removes it; another import doesn't bring it back.
  expect(await revokeInvitation(project.slug, made!.id)).toEqual({});
  const again = await importTeam();
  expect(again.counts.invitations).toMatchObject({ imported: 0, leftOut: { "already brought across earlier": 1 } });
  expect((await invitationsOf()).filter((invitation) => invitation.email === fresh)).toHaveLength(1);
});

test("on the free plan, only the room left is invited (members and pending invites, sent or not); the rest are counted", async () => {
  vi.stubEnv("PLANS", "on");
  await prisma.project.update({ where: { id: project.id }, data: { plan: "FREE" } });
  const sentAlready = newAddress();
  await prisma.invitation.create({ data: { projectId: project.id, email: sentAlready, tokenHash: hashInvitationToken(generateInvitationToken()), createdById: owner.id, expiresAt: new Date(Date.now() + 60_000) } });
  const addresses = [newAddress(), newAddress(), newAddress()];
  admins(...addresses);
  // Three places: the owner, the invite sent, and one more.
  const run = await importTeam();
  expect(run.counts.invitations).toEqual({ imported: 1, leftOut: { "past the plan's team limit (invite them after upgrading)": 2 } });
  expect((await invitationsOf()).filter((invitation) => invitation.sentAt === null).map((invitation) => invitation.email)).toEqual([addresses[0]]);
});

test("the team's page run twice, at once or again later, invites nobody twice", async () => {
  admins(newAddress(), newAddress());
  const row = await prisma.dataImport.create({
    data: { projectId: project.id, source: "FEATUREBASE", startedById: owner.id, apiKey: sealValue(IMPORT_KEY, FAKE_FEATUREBASE_KEY), parts: ["team"], step: "team" },
  });
  await Promise.all([handlers.importStep({ importId: row.id }, log), handlers.importStep({ importId: row.id }, log)]);
  await prisma.dataImport.update({ where: { id: row.id }, data: { state: "RUNNING", apiKey: sealValue(IMPORT_KEY, FAKE_FEATUREBASE_KEY), step: "team", cursor: null, counts: {} } });
  await handlers.importStep({ importId: row.id }, log);
  expect(await invitationsOf()).toHaveLength(2);
  expect(await prisma.importedRecord.count({ where: { projectId: project.id, kind: "invite" } })).toBe(2);
});

test("Send emails one invitation, once, from whoever sends it, with a link that works; Send all sends the rest; Remove takes one away", async () => {
  const [ada, bo, cy] = [newAddress(), newAddress(), newAddress()];
  admins(ada, bo, cy);
  await importTeam();
  const [first, second, third] = await invitationsOf();
  const admin = await signUp("Avery Admin");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: admin.id, role: "ADMIN" } });
  actAs(admin);

  expect(await sendInvitation(project.slug, first!.id)).toEqual({ sent: 1, waiting: 0 });
  const [email] = emailsTo(first!.email!);
  expect(emailsTo(first!.email!)).toHaveLength(1);
  expect(email!.subject).toBe(`Avery Admin invited you to ${project.name} on Tuti`);
  expect(email!.replyTo).toBe(admin.email);
  expect(await prisma.invitation.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ sentAt: expect.any(Date), createdById: admin.id });
  // Sent: a second Send does nothing.
  expect(await sendInvitation(project.slug, first!.id)).toEqual({ error: "That invite was sent already, or removed" });
  expect(emailsTo(first!.email!)).toHaveLength(1);

  expect(await revokeInvitation(project.slug, third!.id)).toEqual({});
  expect(await sendAllInvitations(project.slug)).toEqual({ sent: 1, waiting: 0 });
  expect(emailsTo(second!.email!)).toHaveLength(1);
  expect(emailsTo(third!.email!)).toHaveLength(0);
  expect(await sendAllInvitations(project.slug)).toEqual({ sent: 0, waiting: 0 });
  expect(emailsTo(first!.email!, second!.email!, third!.email!)).toHaveLength(2);

  // The emailed link joins them.
  const link = /https?:\/\/\S+\/invite\/([\w-]+)/.exec(email!.text)![1]!;
  const ada2 = await signUp("Ada", first!.email!);
  actAs(ada2);
  expect(await redirectTarget(acceptInvitation(link))).toBe(`/app/${project.slug}`);
  expect(await prisma.teamMember.count({ where: { projectId: project.id, userId: ada2.id } })).toBe(1);
});

/** Invitations this project emailed today, `n` of them, as if sent earlier. */
const sentEarlier = (n: number) =>
  prisma.invitation.createMany({
    data: Array.from({ length: n }, () => ({ projectId: project.id, email: newAddress(), tokenHash: hashInvitationToken(generateInvitationToken()), createdById: owner.id, expiresAt: new Date(Date.now() + 60_000) })),
  });

test("on a server without email, Send emails nothing and says so with the links to pass on; a link joins", async () => {
  const [ada, bo, cy] = [newAddress(), newAddress(), newAddress()];
  admins(ada, bo, cy);
  await importTeam();
  vi.stubEnv("SMTP_HOST", "");
  const [first] = (await invitationsOf()).filter((invitation) => invitation.email === ada);
  const one = await sendInvitation(project.slug, first!.id);
  expect(one).toEqual({ sent: 0, waiting: 0, links: [{ email: ada, url: expect.stringMatching(/\/invite\/[\w-]+$/) }] });
  const all = await sendAllInvitations(project.slug);
  expect(all).toMatchObject({ sent: 0, waiting: 0 });
  expect(all.links!.map((link) => link.email).sort()).toEqual([bo, cy].sort());
  expect(emailsTo(ada, bo, cy)).toEqual([]);
  // At the day's cap, the links it could make, and what it held back said.
  admins(ada, bo, cy, newAddress(), newAddress());
  await importTeam();
  await sentEarlier(DAILY_INVITE_LIMIT - 4);
  expect(await sendAllInvitations(project.slug)).toMatchObject({ error: `You can send up to ${DAILY_INVITE_LIMIT} invites a day. Try again tomorrow.`, sent: 0, waiting: 1, links: [expect.anything()] });
  vi.unstubAllEnvs();
  vi.stubEnv("FEATUREBASE_API_URL", fake.url);

  const joiner = await signUp("Ada", ada);
  actAs(joiner);
  expect(await redirectTarget(acceptInvitation(one.links![0]!.url.split("/invite/")[1]!))).toBe(`/app/${project.slug}`);
  expect(await prisma.teamMember.count({ where: { projectId: project.id, userId: joiner.id } })).toBe(1);
});

test("sending stops at the day's cap, counted under the project's lock: two Send alls at once send the one place left once", async () => {
  await sentEarlier(DAILY_INVITE_LIMIT - 1);
  admins(newAddress(), newAddress(), newAddress());
  await importTeam();
  const results = await Promise.all([sendAllInvitations(project.slug), sendAllInvitations(project.slug)]);
  expect(results.map((result) => result.sent).sort()).toEqual([0, 1]);
  expect(results).toContainEqual({ error: `You can send up to ${DAILY_INVITE_LIMIT} invites a day. Try again tomorrow.`, sent: 1, waiting: 2 });
  expect((await invitationsOf()).filter((invitation) => invitation.sentAt === null)).toHaveLength(2);
  const [waiting] = (await invitationsOf()).filter((invitation) => invitation.sentAt === null);
  expect(await sendInvitation(project.slug, waiting!.id)).toEqual({ error: `You can send up to ${DAILY_INVITE_LIMIT} invites a day. Try again tomorrow.` });
  expect(await prisma.invitation.findUniqueOrThrow({ where: { id: waiting!.id } })).toMatchObject({ sentAt: null });
});

test("inviting someone and sending an import's invites at once share the day's last place: one of them gets it", async () => {
  await sentEarlier(DAILY_INVITE_LIMIT - 1);
  admins(newAddress());
  await importTeam();
  // Both start while the project's lock is held elsewhere, so each has read what it reads before the lock by the time it
  // waits: the invite's cap is only right if it's read under the lock, after the Send all took the last place.
  let release!: () => void;
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const lock = prisma.$transaction(
    async (tx) => {
      await lockProject(tx, project.id);
      held();
      await new Promise<void>((resolve) => (release = resolve));
    },
    { timeout: 20_000 },
  );
  await holding;
  // Waits on the project's row only (lockProject's, inviting's): nothing else waiting can count.
  const lockWaits = () =>
    prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM project WHERE id =%FOR UPDATE%'`.then(([row]) => row!.n);
  // Send all queues for the lock first, then the invite: Postgres hands it on in that order.
  const sending$ = sendAllInvitations(project.slug);
  await expect.poll(lockWaits, { timeout: 4_000 }).toBe(1);
  const made$ = createInvitation(project.slug, newAddress(), "MEMBER");
  await expect.poll(lockWaits, { timeout: 4_000 }).toBe(2);
  release();
  await lock;
  const both = Promise.all([made$, sending$]);
  const [made, sending] = await both;
  expect(await prisma.invitation.count({ where: { projectId: project.id, sentAt: { gt: new Date(Date.now() - 24 * 60 * 60_000) } } })).toBe(DAILY_INVITE_LIMIT);
  expect([made.error, sending.error].filter(Boolean)).toEqual([`You can send up to ${DAILY_INVITE_LIMIT} invites a day. Try again tomorrow.`]);
});

test("a later import without Team still says how many invitations wait to be sent", async () => {
  admins(newAddress(), newAddress());
  await importTeam();
  expect((await importTeam(["contacts"])).invitationsToSend).toBe(2);
});

test("an invite whose email fails goes back to not sent, said so, to be sent again", async () => {
  const ada = newAddress();
  admins(ada);
  await importTeam();
  const [invitation] = await invitationsOf();
  mailbox.refuseNext(ada, { code: 554 });
  expect(await sendInvitation(project.slug, invitation!.id)).toEqual({ error: "Couldn't email an invite: try again in a moment.", sent: 0, waiting: 1 });
  // Unsent again, expired too: the release before (which doesn't know sentAt) can't take it as live.
  expect(await prisma.invitation.findUniqueOrThrow({ where: { id: invitation!.id } })).toMatchObject({ sentAt: null, revokedAt: null, expiresAt: UNSENT_EXPIRY });
  expect(await sendInvitation(project.slug, invitation!.id)).toEqual({ sent: 1, waiting: 0 });
  expect(emailsTo(ada)).toHaveLength(1);
});

test("Send all claims and emails one invite at a time: one whose email throws goes back to unsent, the run stops, and the rest, never claimed, can still be sent", async () => {
  admins(newAddress(), newAddress(), newAddress());
  await importTeam();
  const order = await prisma.invitation.findMany({ where: { projectId: project.id, sentAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, email: true } });
  let calls = 0;
  let thirdWhileSecond: Date | null | undefined;
  emailHook.before = async () => {
    if (++calls === 2) {
      // Not claimed yet: a restart now would leave it waiting to be sent.
      thirdWhileSecond = (await prisma.invitation.findUniqueOrThrow({ where: { id: order[2]!.id } })).sentAt;
      throw new Error("The mail server went away");
    }
  };
  let result;
  try {
    result = await sendAllInvitations(project.slug);
  } finally {
    emailHook.before = null;
  }
  expect(thirdWhileSecond).toBeNull();
  expect(result).toEqual({ error: "Couldn't email an invite: try again in a moment.", sent: 1, waiting: 2 });
  const after = await prisma.invitation.findMany({ where: { id: { in: order.map((invitation) => invitation.id) } }, select: { id: true, sentAt: true, expiresAt: true } });
  const of = (id: string) => after.find((invitation) => invitation.id === id)!;
  expect(of(order[0]!.id).sentAt).not.toBeNull();
  expect(of(order[1]!.id)).toMatchObject({ sentAt: null, expiresAt: UNSENT_EXPIRY });
  expect(of(order[2]!.id).sentAt).toBeNull();
  expect(emailsTo(order[0]!.email!)).toHaveLength(1);
  expect(await sendAllInvitations(project.slug)).toEqual({ sent: 2, waiting: 0 });
  expect(emailsTo(order[1]!.email!, order[2]!.email!)).toHaveLength(2);
});

test("a big team imported doesn't use up the day's invites: they count only once sent", async () => {
  admins(...Array.from({ length: DAILY_INVITE_LIMIT + 5 }, newAddress));
  expect((await importTeam()).invitationsToSend).toBe(DAILY_INVITE_LIMIT + 5);
  expect(await createInvitation(project.slug, newAddress(), "MEMBER")).toMatchObject({ emailSent: true });
});

test("unsent, an invitation never lapses: weeks later it's listed and can be sent; the release before (which doesn't know sentAt) sees it long expired", async () => {
  const ada = newAddress();
  admins(ada);
  await importTeam();
  const [invitation] = await invitationsOf();
  await prisma.invitation.update({ where: { id: invitation!.id }, data: { createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000) } });
  // How the release before lists pending invites, on a dashboard or Team & roles, and joins one: never this one.
  expect(await prisma.invitation.count({ where: { projectId: project.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } })).toBe(0);
  expect((await call(getImport, asOwner(), {})).import).toMatchObject({ invitationsToSend: 1 });
  expect(await sendInvitation(project.slug, invitation!.id)).toEqual({ sent: 1, waiting: 0 });
  expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitation!.id } })).expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
});

test("an invitation not sent yet can't be accepted: it isn't on the admin's dashboard, nor taken by its id", async () => {
  const ada = newAddress();
  admins(ada);
  await importTeam();
  const [invitation] = await invitationsOf();
  const account = await signUp("Ada", ada);
  await prisma.user.update({ where: { id: account.id }, data: { emailVerified: true } });
  expect(await pendingInvitationsFor({ id: account.id, email: ada, emailVerified: true })).toEqual([]);
  actAs(account);
  expect(await acceptInvitationById(invitation!.id)).toEqual({ error: "Invite not found" });
  expect(await prisma.teamMember.count({ where: { projectId: project.id, userId: account.id } })).toBe(0);
});

test("end to end: Team and Feedback imported, the admin's invitation sent and accepted, and what they wrote in Featurebase is theirs", async () => {
  const fern = newAddress();
  fake.fixtures.admins[0]!.email = owner.email;
  fake.fixtures.admins[1]!.email = fern;
  const run = await importTeam(["team", "contacts", "feedback"]);
  expect(run).toMatchObject({ state: "done", invitationsToSend: 1 });
  const placeholder = await prisma.user.findFirstOrThrow({ where: { placeholderProjectId: project.id, placeholderFor: fern } });
  const theirs = await prisma.post.findMany({ where: { projectId: project.id, authorId: placeholder.id }, select: { id: true } });
  expect(theirs.length).toBeGreaterThan(0);
  expect(emailsTo(fern)).toEqual([]);

  const [invitation] = (await invitationsOf()).filter((row) => row.email === fern);
  expect(await sendInvitation(project.slug, invitation!.id)).toEqual({ sent: 1, waiting: 0 });
  const [email] = emailsTo(fern);
  const token = /https?:\/\/\S+\/invite\/([\w-]+)/.exec(email!.text)![1]!;
  const joiner = await signUp("Fern Former", fern);
  await prisma.user.update({ where: { id: joiner.id }, data: { emailVerified: true } }); // accepting doesn't verify it
  actAs(joiner);
  expect(await redirectTarget(acceptInvitation(token))).toBe(`/app/${project.slug}`);
  expect(await prisma.post.findMany({ where: { id: { in: theirs.map((post) => post.id) } }, select: { authorId: true } })).toEqual(theirs.map(() => ({ authorId: joiner.id })));
  expect(await prisma.user.findUnique({ where: { id: placeholder.id } })).toBeNull();
});
