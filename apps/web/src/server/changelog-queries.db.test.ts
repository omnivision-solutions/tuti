import { prisma } from "@tuti/db";
import { addToRunningDraft, autopilotLines, closeRunningDraft, onlyPullRequestTitles, setChangelogLine } from "@tuti/jobs";
import type { Doc } from "@tuti/content";
import { startS3Fake } from "@tuti/testkit";
import { describe, expect, test, vi } from "vitest";

import { createChangelogEntry, publishChangelogEntry, unpublishChangelogEntry, updateChangelogEntry } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { createProject, signUp } from "@/test/helpers";

import { draftToWrite, entryPosts, generatorSources, publishedEntries } from "./changelog-queries";

test("an entry's editor gets the posts it lists, however old, but not merged ones", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  const board = project.boards[0]!;
  const create = (number: number, data: object = {}) =>
    prisma.post.create({
      data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title: `Post ${number}`, body: "", ...data },
    });
  const old = await create(1, { status: "OPEN", updatedAt: new Date("2020-01-01") });
  await create(2, { status: "PLANNED", duplicateOfId: old.id });
  await create(3, { status: "PLANNED" });

  const numbers = (await entryPosts(project.id, [1, 2])).map((p) => p.number);
  expect(numbers).toEqual([1]); // listed, old and Open; not #2 (merged away) nor #3 (not listed)
});

test("published entries come a page at a time, newest first", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  for (let n = 1; n <= 5; n++) {
    await prisma.changelogEntry.create({
      data: { projectId: project.id, number: n, title: `Entry ${n}`, publishedAt: new Date(Date.UTC(2026, 0, n)) },
    });
  }
  const titles = async (skip: number) => (await publishedEntries(project.slug, null, { take: 2, skip })).map((e) => e.title);
  expect(await titles(0)).toEqual(["Entry 5", "Entry 4"]);
  expect(await titles(2)).toEqual(["Entry 3", "Entry 2"]);
  expect(await titles(4)).toEqual(["Entry 1"]);
  // Some of them by number, in one query, newest first (What's new's older unread ones).
  expect((await publishedEntries(project.slug, null, { numbers: [1, 4, 9] })).map((e) => e.title)).toEqual(["Entry 4", "Entry 1"]);
  // With a number too, both apply.
  expect((await publishedEntries(project.slug, null, { number: 4, numbers: [1, 4] })).map((e) => e.title)).toEqual(["Entry 4"]);
  expect(await publishedEntries(project.slug, null, { number: 4, numbers: [1] })).toEqual([]);
});

describe("the draft whose notes wait to be written", () => {
  const setup = async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    const context = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
    let pr = 0;
    /** A pull request merging: into the running draft (a new one after a release). */
    const merge = () => {
      pr += 1;
      return addToRunningDraft(project.id, { repo: "acme/app", number: pr, url: `https://github.com/acme/app/pull/${pr}`, title: `Change ${pr}` });
    };
    const named = async () => (await draftToWrite(project.id))?.title ?? null;
    return { project, context, merge, named };
  };

  test("the draft the newest release closed comes first, before the running one; editing an older one doesn't move it", async () => {
    const { project, context, merge, named } = await setup();
    expect(await named()).toBeNull();
    await merge();
    expect(await named()).toBe("Next release");
    await closeRunningDraft(project.id, "v1.3");
    await merge();
    await closeRunningDraft(project.id, "v1.4");
    // A new running draft, with a merge in it: the released v1.4 still comes first.
    await merge();
    expect(await draftToWrite(project.id)).toMatchObject({ number: 2, title: "v1.4", _count: { pullRequests: 1 } });
    // Edited since, the older release's draft is the latest changed; the newest release still comes first.
    await call(updateChangelogEntry, context, { number: 1, title: "v1.3: faster search" });
    expect(await named()).toBe("v1.4");
    // Written and published, v1.4 is done: the older release's draft is next, then the running one.
    await call(publishChangelogEntry, context, { number: 2 });
    expect(await named()).toBe("v1.3: faster search");
    await call(publishChangelogEntry, context, { number: 1 });
    expect(await named()).toBe("Next release");
  });

  test("releases handled out of order: the one GitHub published last is named, not the one handled last", async () => {
    const { project, merge, named } = await setup();
    // v1.5 (published second) is handled first, closing the draft it shipped; v1.4 (published first) is handled after a new merge.
    await merge();
    await closeRunningDraft(project.id, "v1.5", new Date("2026-11-01T12:00:00Z"));
    await merge();
    await closeRunningDraft(project.id, "v1.4", new Date("2026-11-01T11:00:00Z"));
    expect(await named()).toBe("v1.5");
  });

  test("an entry that was published and taken down again isn't waiting on a release, released or not", async () => {
    const { project, context, merge, named } = await setup();
    // The running draft published by hand, then unpublished: a draft with pull requests, not collecting, never released.
    await merge();
    await call(publishChangelogEntry, context, { number: 1 });
    await call(unpublishChangelogEntry, context, { number: 1 });
    expect(await named()).toBeNull();
    // A released draft, published (which ends its wait) and unpublished: not named either.
    await merge();
    await closeRunningDraft(project.id, "v2.0");
    expect(await named()).toBe("v2.0");
    // Unpublishing it while it's still a draft (say, from the API) changes nothing: it still waits to be written.
    await call(unpublishChangelogEntry, context, { number: 2 });
    expect(await named()).toBe("v2.0");
    await call(publishChangelogEntry, context, { number: 2 });
    await call(unpublishChangelogEntry, context, { number: 2 });
    expect(await named()).toBeNull();
    // Published by the release before this one (during a deploy), which leaves `releasedAt` set: unpublished, still not named.
    await merge();
    await closeRunningDraft(project.id, "v2.1");
    expect(await named()).toBe("v2.1");
    await prisma.changelogEntry.update({ where: { projectId_number: { projectId: project.id, number: 3 } }, data: { publishedAt: new Date(), collecting: false } });
    await call(unpublishChangelogEntry, context, { number: 3 });
    expect(await named()).toBeNull();
  });
});

test("a draft's text is still its pull requests' titles until someone writes it", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  const context = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const pr = (number: number) => ({ repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, title: `Change ${number}` });
  const titlesOnly = async (number: number) => {
    const entry = await prisma.changelogEntry.findUniqueOrThrow({
      where: { projectId_number: { projectId: project.id, number } },
      select: { content: true, pullRequests: { select: { repo: true, number: true, title: true } } },
    });
    return onlyPullRequestTitles(entry.content, entry.pullRequests);
  };
  // As merges write it: "Change 1 (acme/app#1)", one bullet each.
  await addToRunningDraft(project.id, pr(1));
  await addToRunningDraft(project.id, pr(2));
  expect(await titlesOnly(1)).toBe(true);
  // A bullet's text deleted by hand (its empty bullet left), saved with the empty paragraph the editor ends on: still only titles.
  const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id }, select: { content: true } });
  const doc = entry.content as { type: "doc"; content: { type: string; content: unknown[] }[] };
  const list = { ...doc.content[0]!, content: [doc.content[0]!.content[0], { type: "listItem", content: [{ type: "paragraph" }] }] };
  await call(updateChangelogEntry, context, { number: 1, content: { ...doc, content: [list, { type: "paragraph" }] } });
  expect(await titlesOnly(1)).toBe(true);
  // A code change's line that's only the title (the model wrote none): still a title.
  await setChangelogLine(project.id, pr(1), "Change 1");
  expect(await titlesOnly(1)).toBe(true);
  // A code change's line for one of them: written, not a title.
  await setChangelogLine(project.id, pr(1), "Dark mode, everywhere");
  expect(await titlesOnly(1)).toBe(false);
  // Written by hand.
  await closeRunningDraft(project.id, "v1");
  await addToRunningDraft(project.id, pr(3));
  expect(await titlesOnly(2)).toBe(true);
  // Emptied (failed analyses take their titles out): not written either.
  await call(updateChangelogEntry, context, { number: 2, body: "" });
  expect(await titlesOnly(2)).toBe(true);
  await call(updateChangelogEntry, context, { number: 2, body: "Search is faster." });
  expect(await titlesOnly(2)).toBe(false);
  // An entry without pull requests never is.
  await call(createChangelogEntry, context, { title: "Hello", body: "" });
  expect(await titlesOnly(3)).toBe(false);
});

test("Autopilot's lines are those in the draft that it wrote or the team approved as they were: not one the team reworded, nor one waiting, dismissed or undone", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  const lineFor = (number: number, payload: object, status: "APPLIED" | "PENDING" | "DISMISSED" | "UNDONE" = "APPLIED") =>
    prisma.codeChange.create({
      data: {
        projectId: project.id,
        repoId: 1,
        repo: "acme/app",
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        title: `Change ${number}`,
        author: "octo",
        mergedAt: new Date(),
        state: "READY",
        actions: { create: [{ kind: "CHANGELOG_LINE", probability: 1, status, payload }] },
      },
    });
  await lineFor(1, { line: "Dark theme", undo: { previous: "Change 1 (acme/app#1)", added: null } });
  await lineFor(2, { line: "Faster search", edited: false });
  await lineFor(3, { line: "Search, now in every board", edited: true });
  await lineFor(4, { line: "Not in this entry" });
  // Not in the draft: a line the team typed that says the same is theirs.
  await lineFor(5, { line: "Waiting to be approved" }, "PENDING");
  await lineFor(6, { line: "Dismissed by the team" }, "DISMISSED");
  await lineFor(7, { line: "Put back by Undo" }, "UNDONE");
  const urls = [1, 2, 3, 5, 6, 7].map((number) => `https://github.com/acme/app/pull/${number}`);
  expect((await autopilotLines(project.id, urls)).sort()).toEqual(["Dark theme", "Faster search"]);
  // Another project's pull request at the same address isn't this one's.
  expect(await autopilotLines((await createProject(owner)).id, urls)).toEqual([]);
});

test("Generate's images to work from: the text's, in order, and the logo; only this project's finished images, no files", async () => {
  const s3 = await startS3Fake();
  try {
    for (const [name, value] of Object.entries(s3.env)) {
      vi.stubEnv(name, value);
    }
    const owner = await signUp();
    const project = await createProject(owner);
    const other = await createProject(owner);
    const media = (data: object = {}) =>
      prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, status: "READY", width: 800, height: 600, size: 1, ...data } });
    const [second, first, logo, processing, file, elsewhere] = [
      await media(),
      await media(),
      await media(),
      await media({ status: "PROCESSING" }),
      await media({ filename: "a.pdf", width: null, height: null }),
      await media({ projectId: other.id }),
    ];
    await prisma.project.update({ where: { id: project.id }, data: { brandLogoId: logo.id } });
    const image = (id: string) => ({ type: "image", attrs: { mediaId: id, w: 800, h: 600 } });
    const doc = { type: "doc", content: [image(first.id), image(processing.id), { type: "file", attrs: { mediaId: file.id, name: "a.pdf" } }, image(elsewhere.id), image(second.id)] };
    const sources = await generatorSources(project.id, doc as Doc);
    expect(sources.bodyImages.map((each) => each.id)).toEqual([first.id, second.id]);
    expect(sources.bodyImages[0]!.url).toContain(first.id);
    expect(sources.logo?.id).toBe(logo.id);
    // Without a logo: none.
    expect((await generatorSources(other.id, { type: "doc", content: [] })).logo).toBeNull();
  } finally {
    vi.unstubAllEnvs();
    await s3.close();
  }
});
