import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";

import { prisma } from "@tuti/db";
import { handlers, subscriberCount, subscribersLeft } from "@tuti/jobs";
import { billingFile } from "@tuti/testkit";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

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
import { createChangelogEntry, getChangelogEntry, listChangelog, publishChangelogEntry, reactToChangelogEntry, updateChangelogEntry } from "./operations/changelog";
import { createPost } from "./operations/create";
import { listChangelogComments } from "./operations/changelog-comments";
import { addChangelogSubscribers } from "./operations/changelog-subscribers";
import { hasUnseenAnnouncement, latestAnnouncement } from "./operations/changelog-seen";
import { deleteGroup } from "./operations/groups";
import { call } from "./operations/run";
import { readerOf } from "./portal-access";
import { whatsNewSeen } from "./widget-home";

/**
 * An entry for some reader groups only (docs/plan.md S4), set by changelog.create and changelog.update: their readers and
 * the team see it; everyone else doesn't, anywhere it's listed, and it's emailed only to subscribers in them.
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

/** One of the project's users, in these groups, at `email` as the project's app gave it. */
async function reader(groups: string[], email?: string) {
  const user = await signUp("Reader");
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: `user-${user.id}`, userId: user.id, email, properties: { groups } } });
  return user;
}

/** Entry `number` for these groups only (none: everyone), as the team sets it. */
const forGroups = (number: number, groups: string[]) => call(updateChangelogEntry, as(owner), { number, groups });

/** A published, announced entry, `groups` its groups, completing `posts`. */
async function published(title: string, groups: string[] = [], posts: number[] = []) {
  const entry = await call(createChangelogEntry, as(owner), { title, body: `${title}.`, posts, groups });
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
  // Only the project's groups, each once.
  await expect(forGroups(enterprise, ["nope"])).rejects.toMatchObject({ status: 400, message: expect.stringContaining("nope") });
  expect((await forGroups(enterprise, ["beta", "enterprise", "beta"])).groups).toEqual(["beta", "enterprise"]);
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
  // Said only that a newer one is for some groups (not which, or what), so the script asks for the signed-in person's.
  expect(latest).toMatchObject({ groups: true });
  expect(before).not.toHaveProperty("groups");
});

test("the widget's latest with only a group entry new: no latest for everyone, but `groups`; one older than 30 days doesn't count", async () => {
  const ask = async () => (await (await widgetLatest(new Request(`http://x/api/widget/latest?project=${project.slug}`))).json()) as Record<string, unknown>;
  const number = await published("Enterprise news", ["enterprise"]);
  expect(await ask()).toMatchObject({ latest: null, groups: true });
  await prisma.changelogEntry.updateMany({ where: { projectId: project.id, number }, data: { publishedAt: new Date(Date.now() - 31 * 86_400_000) } });
  expect(await ask()).not.toHaveProperty("groups");
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
  // On a public portal too: the newest one each may read, their groups' included.
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PUBLIC" } });
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

  test("an entry for some groups is emailed only to subscribers in them: not to others, nor to an address the team's app never named", async () => {
    const [kim, lee, anon] = [address(), address(), address()];
    await reader(["enterprise"], kim);
    await reader(["beta"], lee);
    await call(addChangelogSubscribers, as(owner), { emails: [kim, lee, anon] });
    const entry = await call(createChangelogEntry, as(owner), { title: "Enterprise news", body: "Hi.", groups: ["enterprise"] });
    const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: entry.number } });
    // Published with Email subscribers but not sent yet (the job runs inline on publishing): the editor's count, then the job.
    await prisma.changelogEntry.update({ where: { id }, data: { publishedAt: new Date(), subscribersEmailedAt: new Date(), subscribersEmailDueAt: new Date() } });

    // The editor's counts: all three for an entry for everyone, one for this.
    expect(await subscriberCount(project.id)).toBe(3);
    expect(await subscriberCount(project.id, id)).toBe(1);
    expect(await subscribersLeft(id)).toBe(1);
    expect(await handlers.changelogEmailed({ entryId: id }, log)).toEqual({ emailed: 1 });
    expect(entryEmailsTo(kim)).toHaveLength(1);
    expect([...entryEmailsTo(lee), ...entryEmailsTo(anon)]).toEqual([]);
    // Done: all it's for have it.
    expect(await prisma.changelogEntry.findUniqueOrThrow({ where: { id }, select: { subscribersEmailDueAt: true } })).toEqual({ subscribersEmailDueAt: null });
  });

  test("on a plan without reader groups, an entry for some is emailed to nobody (its groups don't count there)", async () => {
    vi.stubEnv("BILLING_CONFIG", billingFile());
    try {
      const kim = address();
      await reader(["enterprise"], kim);
      await call(addChangelogSubscribers, as(owner), { emails: [kim] });
      await prisma.project.update({ where: { id: project.id }, data: { plan: "business" } });
      const entry = await call(createChangelogEntry, as(owner), { title: "Enterprise news", body: "Hi.", groups: ["enterprise"] });
      await prisma.project.update({ where: { id: project.id }, data: { plan: "pro" } });
      const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: entry.number } });
      expect(await subscriberCount(project.id, id)).toBe(0);
      await call(publishChangelogEntry, as(owner), { number: entry.number, emailSubscribers: true });
      expect(entryEmailsTo(kim)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("an entry for everyone is emailed to every subscriber, whatever their groups", async () => {
    const [kim, anon] = [address(), address()];
    await reader([], kim);
    await call(addChangelogSubscribers, as(owner), { emails: [kim, anon] });
    const entry = await call(createChangelogEntry, as(owner), { title: "News", body: "Hi." });
    await call(publishChangelogEntry, as(owner), { number: entry.number, emailSubscribers: true });
    expect(entryEmailsTo(kim)).toHaveLength(1);
    expect(entryEmailsTo(anon)).toHaveLength(1);
  });

  test("changing its groups waits for a claim on the project (as publishing does), so an edit checked against its time can't deadlock with one", async () => {
    const entry = await call(createChangelogEntry, as(owner), { title: "News", body: "Hi." });
    const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: entry.number } });
    // A claim or a publish: the project's row, then the entry's.
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM project WHERE id = ${project.id} FOR SHARE`;
      locked();
      await released;
      await tx.$queryRaw`SELECT 1 FROM changelog_entry WHERE id = ${id} FOR SHARE`;
    });
    await holding;
    const update = call(updateChangelogEntry, as(owner), { number: entry.number, groups: ["enterprise"], expectedUpdatedAt: entry.updatedAt });
    await untilWaitingOnLock();
    release();
    await held;
    expect((await update).groups).toEqual(["enterprise"]);
  });

  test("made for some groups while its emails are going out, the rest go only to those in them", async () => {
    const kim = address();
    await call(addChangelogSubscribers, as(owner), { emails: [kim] });
    const entry = await call(createChangelogEntry, as(owner), { title: "News", body: "Hi." });
    const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: entry.number } });
    // Published with Email subscribers but not sent yet: the job below runs it.
    await prisma.changelogEntry.update({ where: { id }, data: { publishedAt: new Date(), subscribersEmailedAt: new Date(), subscribersEmailDueAt: new Date() } });

    // The project's row held while the job reads who to email (everyone); the groups land before its first claim
    // (which waits for the row), as changelog.update sets them holding it.
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
