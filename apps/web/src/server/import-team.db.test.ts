import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { DAILY_INVITE_LIMIT, generateInvitationToken, handlers, hashInvitationToken, IMPORT_KEY, importsSettled } from "@tuti/jobs";
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
  const { setup } = await homeOverview(project.id, project.slug, { emailVerified: true });
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
      leftOut: { "for you (you ran the import)": 1, "for people already on the team": 1, "for people already invited": 1, "for admins without an email": 1 },
    },
  });
  expect(importSummary(run)).toBe(
    "1 invitation brought across. Left out: 1 invitation for people already invited; 1 invitation for admins without an email; 1 invitation for you (you ran the import); 1 invitation for people already on the team.",
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

test("an invite whose email fails goes back to not sent, said so, to be sent again", async () => {
  const ada = newAddress();
  admins(ada);
  await importTeam();
  const [invitation] = await invitationsOf();
  mailbox.refuseNext(ada, { code: 554 });
  expect(await sendInvitation(project.slug, invitation!.id)).toEqual({ error: "Couldn't email an invite: try again in a moment.", sent: 0, waiting: 1 });
  expect(await prisma.invitation.findUniqueOrThrow({ where: { id: invitation!.id } })).toMatchObject({ sentAt: null, revokedAt: null });
  expect(await sendInvitation(project.slug, invitation!.id)).toEqual({ sent: 1, waiting: 0 });
  expect(emailsTo(ada)).toHaveLength(1);
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
  actAs(joiner);
  expect(await redirectTarget(acceptInvitation(token))).toBe(`/app/${project.slug}`);
  expect(await prisma.post.findMany({ where: { id: { in: theirs.map((post) => post.id) } }, select: { authorId: true } })).toEqual(theirs.map(() => ({ authorId: joiner.id })));
  expect(await prisma.user.findUnique({ where: { id: placeholder.id } })).toBeNull();
});
