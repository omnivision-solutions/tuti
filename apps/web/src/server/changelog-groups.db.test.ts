import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";

import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { GET as entryMarkdown } from "@/app/portal/[project]/(site)/changelog/[number]/md/route";
import { GET as rss } from "@/app/portal/[project]/(site)/changelog/rss.xml/route";
import { GET as widgetLatest } from "@/app/api/widget/latest/route";
import { GET as widgetSeen } from "@/app/api/widget/seen/route";
import { GET as shareImage } from "@/app/portal/[project]/(site)/og/[[...path]]/route";
import { GET as postMarkdown } from "@/app/portal/[project]/(site)/feedback/[board]/[post]/md/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { SIGNED_OUT } from "@/lib/read-access";
import { generateSsoSecret } from "@/lib/sso";
import { actAs, createProject, inGroupNamed, signUp, type TestUser, untilWaitingOnLock } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { changelogContents, changelogDates, publishedEntries } from "./changelog-queries";
import { createChangelogEntry, getChangelogEntry, listChangelog, publishChangelogEntry, reactToChangelogEntry } from "./operations/changelog";
import { createPost } from "./operations/create";
import { listChangelogComments } from "./operations/changelog-comments";
import { addChangelogSubscribers } from "./operations/changelog-subscribers";
import { hasUnseenAnnouncement, latestAnnouncement } from "./operations/changelog-seen";
import { deleteGroup } from "./operations/groups";
import { call } from "./operations/run";
import { readerOf } from "./portal-access";
import { whatsNewSeen } from "./widget-home";

/**
 * An entry for some reader groups only (docs/plan.md S4): their readers and the team see it; everyone else doesn't, anywhere
 * it's listed, and (for now) no subscriber is emailed it. Nothing sets its groups yet (a later release's API will), so the
 * tests set them in the database.
 */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
/** In the enterprise group, and in none. */
let ada: TestUser;
let bob: TestUser;

// The project's own sender (SUPPORT_EMAIL_DOMAIN) asks SES for its tenant.
const ses = await startSesFake();
afterAll(() => ses.close());

const log = { info: () => {}, warn: () => {} };
const as = (user: TestUser) => ({ actor: { kind: "user" as const, userId: user.id }, projectId: project.id });
const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ project: project.slug, ...extra }) }) as never;

async function reader(groups: string[]) {
  const user = await signUp("Reader");
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: `user-${user.id}`, userId: user.id, properties: { groups } } });
  return user;
}

/** Entry `number` for these groups only (the API sets them in a later release). */
async function forGroups(number: number, keys: string[]) {
  const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } });
  const groups = await prisma.readerGroup.findMany({ where: { projectId: project.id, key: { in: keys } } });
  await prisma.changelogEntryGroup.deleteMany({ where: { entryId: entry.id } });
  await prisma.changelogEntryGroup.createMany({ data: groups.map((group) => ({ entryId: entry.id, groupId: group.id })) });
  return entry.id;
}

/** A published, announced entry, `groups` its groups, completing `posts`. */
async function published(title: string, groups: string[] = [], posts: number[] = []) {
  const entry = await call(createChangelogEntry, as(owner), { title, body: `${title}.`, posts });
  await forGroups(entry.number, groups);
  await call(publishChangelogEntry, as(owner), { number: entry.number, announce: true });
  return entry.number;
}

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
  actAs(null);
  await prisma.readerGroup.createMany({
    data: ["enterprise", "beta"].map((key) => ({ projectId: project.id, key, name: key[0]!.toUpperCase() + key.slice(1), conditions: inGroupNamed(key) })),
  });
  ada = await reader(["enterprise"]);
  bob = await reader([]);
});

test("the API: only the group's readers and the team list, get, react to and read the comments of an entry for the group", async () => {
  const everyone = await published("For everyone");
  const enterprise = await published("For enterprise", ["enterprise"]);
  const numbers = async (user: TestUser) => (await call(listChangelog, as(user), {})).entries.map((entry) => entry.number);

  expect(await numbers(owner)).toEqual([enterprise, everyone]);
  expect(await numbers(ada)).toEqual([enterprise, everyone]);
  expect(await numbers(bob)).toEqual([everyone]);
  expect((await call(getChangelogEntry, as(owner), { number: enterprise })).groups).toEqual(["enterprise"]);
  expect((await call(getChangelogEntry, as(owner), { number: everyone })).groups).toEqual([]);
  // A reader in one of its groups reads it, without being told which groups it's for (nor so of others).
  expect(await call(getChangelogEntry, as(ada), { number: enterprise })).toMatchObject({ title: "For enterprise" });
  expect(await call(getChangelogEntry, as(ada), { number: enterprise })).not.toHaveProperty("groups");
  expect((await call(listChangelog, as(ada), {})).entries.some((entry) => "groups" in entry)).toBe(false);
  for (const run of [
    () => call(getChangelogEntry, as(bob), { number: enterprise }),
    () => call(reactToChangelogEntry, as(bob), { number: enterprise, reaction: "tada", reacted: true }),
    () => call(listChangelogComments, as(bob), { number: enterprise }),
  ]) {
    await expect(run()).rejects.toMatchObject({ status: 404 });
  }
  await expect(call(reactToChangelogEntry, as(ada), { number: enterprise, reaction: "tada", reacted: true })).resolves.toMatchObject({ reacted: true });

  // For everyone again: everyone's.
  await forGroups(enterprise, []);
  expect((await call(getChangelogEntry, as(owner), { number: enterprise })).groups).toEqual([]);
  expect(await numbers(bob)).toEqual([enterprise, everyone]);
});

test("the portal and the widget: the list, its menu and month index, the newest announcement and What's new leave it out for anyone outside its groups", async () => {
  const everyone = await published("For everyone");
  const beta = await published("For beta or enterprise", ["beta", "enterprise"]);
  const [asAda, asBob] = await Promise.all([readerOf(project.id, ada.id), readerOf(project.id, bob.id)]);
  expect(asAda).toEqual({ signedIn: true, groups: ["enterprise"] });

  for (const [who, shown] of [
    [null, [beta, everyone]],
    [asAda, [beta, everyone]],
    [asBob, [everyone]],
    [SIGNED_OUT, [everyone]],
  ] as const) {
    expect((await publishedEntries(project.slug, who)).map((entry) => entry.number)).toEqual(shown);
    expect((await changelogContents(project.slug, who)).map((entry) => entry.number)).toEqual(shown);
    expect((await changelogDates(project.slug, who)).map((entry) => entry.number)).toEqual(shown);
    expect((await whatsNewSeen(project.id, null, who)).fresh.map((entry) => entry.number)).toEqual(shown);
    expect((await latestAnnouncement({ id: project.id }, who))?.publishedAt).toEqual((await publishedEntries(project.slug, who))[0]!.publishedAt);
  }
  // Bob's latest is the one he may read, which he's seen.
  await prisma.changelogSeen.create({
    data: { projectId: project.id, userId: bob.id, seenAt: (await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: everyone } })).publishedAt! },
  });
  expect(await hasUnseenAnnouncement(project.id, bob.id, asBob)).toBe(false);
  expect(await hasUnseenAnnouncement(project.id, bob.id, asAda)).toBe(true);
});

test("what's kept in shared caches or read by machines (RSS, the sitemap, llms.txt, its and a post's Markdown copy, the widget's latest) is everyone's only", async () => {
  const post = await call(createPost, as(owner), { board: "feature-requests", title: "Audit log" });
  const everyone = await published("Public news");
  const before = (await (await widgetLatest(new Request(`http://x/api/widget/latest?project=${project.slug}`))).json()) as { latest: string | null };
  const enterprise = await published("Enterprise news", ["enterprise"], [post.number]);
  const text = async (response: Response | Promise<Response>) => (await response).text();

  const feed = await text(rss(new Request("http://x/"), params()));
  expect(feed).toContain("Public news");
  expect(feed).not.toContain("Enterprise news");
  const map = await text(sitemap(new Request("http://x/"), params()));
  expect(map).toContain(`/changelog/${everyone}<`);
  expect(map).not.toContain(`/changelog/${enterprise}<`);
  const agents = await text(llms(new Request("http://x/"), params()));
  expect(agents).toContain("Public news");
  expect(agents).not.toContain("Enterprise news");
  expect((await entryMarkdown(new Request("http://x/"), params({ number: String(everyone) }))).status).toBe(200);
  expect((await entryMarkdown(new Request("http://x/"), params({ number: String(enterprise) }))).status).toBe(404);
  // The post it completed says it's done, not what shipped it.
  const postCopy = await text(postMarkdown(new Request("http://x/"), params({ board: "feature-requests", post: `audit-log-${post.number}` })));
  expect(postCopy).toContain("Audit log");
  expect(postCopy).not.toContain("Shipped in");
  await forGroups(enterprise, []);
  expect(await text(postMarkdown(new Request("http://x/"), params({ board: "feature-requests", post: `audit-log-${post.number}` })))).toContain("Shipped in Enterprise news");
  await forGroups(enterprise, ["enterprise"]);
  // The launcher's newest announcement: everyone's, not the newer one for enterprise.
  const latest = (await (await widgetLatest(new Request(`http://x/api/widget/latest?project=${project.slug}`))).json()) as { latest: string | null };
  expect(latest.latest).not.toBeNull();
  expect(latest.latest).toBe(before.latest);
});

test("a group an entry is for can't be deleted", async () => {
  const number = await published("Enterprise news", ["enterprise"]);
  await expect(call(deleteGroup, as(owner), { group: "enterprise" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Enterprise news") });
  await forGroups(number, []);
  await expect(call(deleteGroup, as(owner), { group: "enterprise" })).resolves.toEqual({ deleted: "enterprise" });
});

test("a private portal's widget tells a reader the newest announcement they may read; an entry's link card is for whoever may read it", async () => {
  const everyone = await published("Public news");
  const enterprise = await published("Enterprise news", ["enterprise"]);
  const at = async (number: number) => (await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number } })).publishedAt!.toISOString();
  const secret = generateSsoSecret();
  await prisma.project.update({ where: { id: project.id }, data: { ssoSecret: secret, portalAccess: "PRIVATE" } });
  /** /api/widget/seen's `latest` for the page's signed-in `user` (by their id in the team's app). */
  const latestFor = async (user: TestUser) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: `user-${user.id}`, jti: randomUUID() })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(new TextEncoder().encode(secret));
    const response = await widgetSeen(new Request(`http://x/api/widget/seen?project=${project.slug}`, { headers: { authorization: `Bearer ${token}` } }));
    return ((await response.json()) as { latest: string | null }).latest;
  };
  expect(await latestFor(ada)).toBe(await at(enterprise));
  expect(await latestFor(bob)).toBe(await at(everyone));

  // Signed out on a public portal (a card kept in shared caches): everyone's only.
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PUBLIC" } });
  const card = async (number: number) => (await shareImage(new Request("http://x"), { params: Promise.resolve({ project: project.slug, path: ["changelog", String(number)] }) })).status;
  expect(await card(everyone)).toBe(200);
  expect(await card(enterprise)).toBe(404);
});

describe("email", () => {
  const address = () => `e2e-${randomUUID()}@example.com`;
  const entryEmailsTo = (to: string) => mailbox.emails.filter((email) => email.to.includes(to) && email.subject.startsWith(`${project.name}: `));

  test("an entry for some groups isn't emailed to subscribers; made for everyone, it is", async () => {
    const kim = address();
    await call(addChangelogSubscribers, as(owner), { emails: [kim] });
    const entry = await call(createChangelogEntry, as(owner), { title: "Enterprise news", body: "Hi." });
    const id = await forGroups(entry.number, ["enterprise"]);
    await call(publishChangelogEntry, as(owner), { number: entry.number, emailSubscribers: true });

    expect(await handlers.changelogEmailed({ entryId: id }, log)).toEqual({ waiting: "the entry is for some reader groups only" });
    expect(entryEmailsTo(kim)).toEqual([]);
    // Still due: made for everyone, it goes.
    await forGroups(entry.number, []);
    expect(await handlers.changelogEmailed({ entryId: id }, log)).toMatchObject({ emailed: 1 });
    expect(entryEmailsTo(kim)).toHaveLength(1);
  });

  test("made for some groups while its emails are going out, the rest aren't sent", async () => {
    const kim = address();
    await call(addChangelogSubscribers, as(owner), { emails: [kim] });
    const entry = await call(createChangelogEntry, as(owner), { title: "News", body: "Hi." });
    const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: entry.number } });
    // Published with Email subscribers but not sent yet: the job below runs it.
    await prisma.changelogEntry.update({ where: { id }, data: { publishedAt: new Date(), subscribersEmailedAt: new Date(), subscribersEmailDueAt: new Date() } });

    // The project's row held while the job reads who to email; the groups land before its first claim (which waits for the row).
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM project WHERE id = ${project.id} FOR UPDATE`;
      locked();
      await released;
      const group = await tx.readerGroup.findFirstOrThrow({ where: { projectId: project.id, key: "enterprise" } });
      await tx.changelogEntryGroup.create({ data: { entryId: id, groupId: group.id } });
    });
    await holding;
    const run = handlers.changelogEmailed({ entryId: id }, log);
    await untilWaitingOnLock();
    release();
    await held;
    expect(await run).not.toMatchObject({ emailed: 1 });
    expect(entryEmailsTo(kim)).toEqual([]);
  });
});
