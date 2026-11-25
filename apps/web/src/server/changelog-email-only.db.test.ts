import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { GET as entryMarkdown } from "@/app/portal/[project]/(site)/changelog/[number]/md/route";
import { GET as rss } from "@/app/portal/[project]/(site)/changelog/rss.xml/route";
import { GET as widgetLatest } from "@/app/api/widget/latest/route";
import { SIGNED_OUT } from "@/lib/read-access";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { changelogContents, publishedEntries } from "./changelog-queries";
import { createChangelogEntry, getChangelogEntry, listChangelog, publishChangelogEntry, reactToChangelogEntry } from "./operations/changelog";
import { listChangelogComments } from "./operations/changelog-comments";
import { latestAnnouncement } from "./operations/changelog-seen";
import { call } from "./operations/run";
import { readerOf } from "./portal-access";

/**
 * An email-only entry (docs/plan.md S6): emailed to subscribers, listed nowhere, its page the team's only. Nothing sets
 * it yet (the next release's API and editor will: the previous release, beside this one in a deploy, would list it), so
 * the tests set it in the database.
 */

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
  const entry = await call(createChangelogEntry, as(owner), { title, body: `${title}.` });
  await prisma.changelogEntry.updateMany({ where: { projectId: project.id, number: entry.number }, data: { emailOnly } });
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
  await expect(call(getChangelogEntry, as(owner), { number: quiet })).resolves.toMatchObject({ title: "Pricing change" });

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
});
