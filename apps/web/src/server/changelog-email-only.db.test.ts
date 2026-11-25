import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, beforeEach, expect, test } from "vitest";

import { GET as entryMarkdown } from "@/app/portal/[project]/(site)/changelog/[number]/md/route";
import { GET as rss } from "@/app/portal/[project]/(site)/changelog/rss.xml/route";
import { GET as widgetLatest } from "@/app/api/widget/latest/route";
import { SIGNED_OUT } from "@/lib/read-access";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { changelogContents, publishedEntries } from "./changelog-queries";
import { createChangelogEntry, getChangelogEntry, listChangelog, publishChangelogEntry, reactToChangelogEntry, updateChangelogEntry } from "./operations/changelog";
import { addChangelogSubscribers } from "./operations/changelog-subscribers";
import { listChangelogComments } from "./operations/changelog-comments";
import { latestAnnouncement } from "./operations/changelog-seen";
import { call } from "./operations/run";
import { readerOf } from "./portal-access";

/**
 * An email-only entry (docs/plan.md S6), set by changelog.create and changelog.update: emailed to subscribers, listed
 * nowhere, its page the team's only (its email links to none).
 */

// The project's own sender asks SES for its tenant.
const ses = await startSesFake();
afterAll(() => ses.close());

let owner: TestUser;
let reader: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
const as = (user: TestUser) => ({ actor: { kind: "user" as const, userId: user.id }, projectId: project.id });
const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ project: project.slug, ...extra }) }) as never;

beforeEach(async () => {
  owner = await signUp("Owner");
  reader = await signUp("Reader");
  project = await createProject(owner);
  actAs(null);
});

async function published(title: string, emailOnly = false) {
  const entry = await call(createChangelogEntry, as(owner), { title, body: `${title}.`, emailOnly });
  await call(publishChangelogEntry, as(owner), { number: entry.number, announce: true });
  return entry.number;
}

test("an email-only entry is the team's: no reader lists, reads, reacts to or comments on it, anywhere it's listed", async () => {
  const everyone = await published("Public news");
  const before = (await (await widgetLatest(new Request(`http://x/api/widget/latest?project=${project.slug}`))).json()) as { latest: string | null };
  const quiet = await published("Pricing change", true);
  const numbers = async (user: TestUser) => (await call(listChangelog, as(user), {})).entries.map((entry) => entry.number);

  expect(await numbers(owner)).toEqual([quiet, everyone]);
  expect(await numbers(reader)).toEqual([everyone]);
  for (const run of [
    () => call(getChangelogEntry, as(reader), { number: quiet }),
    () => call(reactToChangelogEntry, as(reader), { number: quiet, reaction: "tada", reacted: true }),
    () => call(listChangelogComments, as(reader), { number: quiet }),
  ]) {
    await expect(run()).rejects.toMatchObject({ status: 404 });
  }
  // The team reads it, and sees that it's email-only; readers aren't told of the flag on others either.
  await expect(call(getChangelogEntry, as(owner), { number: quiet })).resolves.toMatchObject({ title: "Pricing change", emailOnly: true });
  expect(await call(getChangelogEntry, as(reader), { number: everyone })).not.toHaveProperty("emailOnly");
  // Listed again once it isn't.
  expect((await call(updateChangelogEntry, as(owner), { number: quiet, emailOnly: false })).emailOnly).toBe(false);
  expect(await numbers(reader)).toEqual([quiet, everyone]);
  await call(updateChangelogEntry, as(owner), { number: quiet, emailOnly: true });

  const asReader = await readerOf(project.id, reader.id);
  for (const who of [asReader, SIGNED_OUT]) {
    expect((await publishedEntries(project.slug, who)).map((entry) => entry.number)).toEqual([everyone]);
    expect((await changelogContents(project.slug, who)).map((entry) => entry.number)).toEqual([everyone]);
    expect((await latestAnnouncement({ id: project.id }, who))?.publishedAt).toEqual((await publishedEntries(project.slug, who))[0]!.publishedAt);
  }
  expect((await publishedEntries(project.slug, null)).map((entry) => entry.number)).toEqual([quiet, everyone]);
  const feed = await (await rss(new Request("http://x/"), params())).text();
  expect(feed).toContain("Public news");
  expect(feed).not.toContain("Pricing change");
  expect((await entryMarkdown(new Request("http://x/"), params({ number: String(quiet) }))).status).toBe(404);
  const latest = (await (await widgetLatest(new Request(`http://x/api/widget/latest?project=${project.slug}`))).json()) as { latest: string | null };
  expect(latest.latest).toBe(before.latest);
  // Nor does one for some groups light the launcher for anyone (`groups` is for announcements someone may read).
  await prisma.readerGroup.create({ data: { projectId: project.id, key: "beta", name: "Beta", conditions: [{ property: "plan", op: "is", value: "beta" }] } });
  const group = await prisma.readerGroup.findFirstOrThrow({ where: { projectId: project.id, key: "beta" } });
  const { id } = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number: quiet } });
  await prisma.changelogEntryGroup.create({ data: { entryId: id, groupId: group.id } });
  expect(await (await widgetLatest(new Request(`http://x/api/widget/latest?project=${project.slug}`))).json()).not.toHaveProperty("groups");
});

test("published with Email subscribers, it's emailed in full, linking to no page (readers have none)", async () => {
  const kim = `e2e-${randomUUID()}@example.com`;
  await call(addChangelogSubscribers, as(owner), { emails: [kim] });
  const entry = await call(createChangelogEntry, as(owner), { title: "Pricing change", body: "Plans cost less from May.", emailOnly: true });
  await call(publishChangelogEntry, as(owner), { number: entry.number, emailSubscribers: true });
  const [email] = mailbox.emails.filter((sent) => sent.to.includes(kim) && sent.subject === `${project.name}: Pricing change`);
  expect(email!.text).toContain("Plans cost less from May.");
  expect(email!.text).not.toContain(`/changelog/${entry.number}`);
  expect(email!.text).not.toContain("Read the update");
});
