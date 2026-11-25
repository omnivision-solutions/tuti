import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { GET as entryMarkdown } from "@/app/portal/[project]/(site)/changelog/[number]/md/route";
import { GET as rss } from "@/app/portal/[project]/(site)/changelog/rss.xml/route";
import { GET as llms } from "@/app/portal/[project]/(site)/llms.txt/route";
import { GET as sitemap } from "@/app/portal/[project]/(site)/sitemap.xml/route";
import { SIGNED_OUT } from "@/lib/read-access";
import { actAs, createProject, inGroupNamed, signUp, type TestUser, untilWaitingOnLock } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { changelogContents, changelogDates, publishedEntries } from "./changelog-queries";
import { createChangelogEntry, getChangelogEntry, listChangelog, publishChangelogEntry, reactToChangelogEntry, updateChangelogEntry } from "./operations/changelog";
import { listChangelogComments } from "./operations/changelog-comments";
import { addChangelogSubscribers } from "./operations/changelog-subscribers";
import { hasUnseenAnnouncement, latestAnnouncement } from "./operations/changelog-seen";
import { deleteGroup } from "./operations/groups";
import { call } from "./operations/run";
import { readerOf } from "./portal-access";
import { whatsNewSeen } from "./widget-home";

/**
 * An entry for some reader groups only (docs/plan.md S4): their readers and the team see it; everyone else doesn't, anywhere
 * it's listed, and (for now) no subscriber is emailed it.
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

/** A published, announced entry, `groups` its groups. */
async function published(title: string, groups: string[] = []) {
  const entry = await call(createChangelogEntry, as(owner), { title, body: `${title}.`, groups });
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
  expect((await call(getChangelogEntry, as(ada), { number: enterprise })).title).toBe("For enterprise");
  expect((await call(getChangelogEntry, as(bob), { number: everyone })).groups).toEqual([]);
  for (const run of [
    () => call(getChangelogEntry, as(bob), { number: enterprise }),
    () => call(reactToChangelogEntry, as(bob), { number: enterprise, reaction: "tada", reacted: true }),
    () => call(listChangelogComments, as(bob), { number: enterprise }),
  ]) {
    await expect(run()).rejects.toMatchObject({ status: 404 });
  }
  await expect(call(reactToChangelogEntry, as(ada), { number: enterprise, reaction: "tada", reacted: true })).resolves.toMatchObject({ reacted: true });

  // For everyone again: everyone's.
  expect((await call(updateChangelogEntry, as(owner), { number: enterprise, groups: [] })).groups).toEqual([]);
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

test("what's kept in shared caches or read by machines (RSS, the sitemap, llms.txt, its Markdown copy) is everyone's only", async () => {
  const everyone = await published("Public news");
  const enterprise = await published("Enterprise news", ["enterprise"]);
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
});

test("its groups are the project's: an unknown one is refused, and a group an entry is for can't be deleted", async () => {
  await expect(call(createChangelogEntry, as(owner), { title: "Nope", groups: ["vip"] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("There's no group “vip”") });
  const number = await published("Enterprise news", ["enterprise"]);
  await expect(call(deleteGroup, as(owner), { group: "enterprise" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Enterprise news") });
  await call(updateChangelogEntry, as(owner), { number, groups: [] });
  await expect(call(deleteGroup, as(owner), { group: "enterprise" })).resolves.toEqual({ deleted: "enterprise" });
});

describe("email", () => {
  const address = () => `e2e-${randomUUID()}@example.com`;
  const entryEmailsTo = (to: string) => mailbox.emails.filter((email) => email.to.includes(to) && email.subject.startsWith(`${project.name}: `));

  test("an entry for some groups isn't emailed to subscribers; made for everyone, it is", async () => {
    const kim = address();
    await call(addChangelogSubscribers, as(owner), { emails: [kim] });
    const entry = await call(createChangelogEntry, as(owner), { title: "Enterprise news", body: "Hi.", groups: ["enterprise"] });
    await call(publishChangelogEntry, as(owner), { number: entry.number, emailSubscribers: true });
    const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: entry.number } });

    expect(await handlers.changelogEmailed({ entryId: id }, log)).toEqual({ waiting: "the entry is for some reader groups only" });
    expect(entryEmailsTo(kim)).toEqual([]);
    // Still due: made for everyone, it goes.
    await call(updateChangelogEntry, as(owner), { number: entry.number, groups: [] });
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
    let release!: () => void;
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM project WHERE id = ${project.id} FOR UPDATE`;
      await new Promise<void>((resolve) => (release = resolve));
      const group = await tx.readerGroup.findFirstOrThrow({ where: { projectId: project.id, key: "enterprise" } });
      await tx.changelogEntryGroup.create({ data: { entryId: id, groupId: group.id } });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const run = handlers.changelogEmailed({ entryId: id }, log);
    await untilWaitingOnLock();
    release();
    await held;
    expect(await run).not.toMatchObject({ emailed: 1 });
    expect(entryEmailsTo(kim)).toEqual([]);
  });
});
