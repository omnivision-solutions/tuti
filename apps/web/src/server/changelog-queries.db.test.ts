import { prisma } from "@tuti/db";
import { addToRunningDraft, closeRunningDraft } from "@tuti/jobs";
import { describe, expect, test } from "vitest";

import { publishChangelogEntry, unpublishChangelogEntry, updateChangelogEntry } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { createProject, signUp } from "@/test/helpers";

import { draftToWrite, entryPosts, publishedEntries } from "./changelog-queries";

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
  const titles = async (skip: number) => (await publishedEntries(project.slug, { take: 2, skip })).map((e) => e.title);
  expect(await titles(0)).toEqual(["Entry 5", "Entry 4"]);
  expect(await titles(2)).toEqual(["Entry 3", "Entry 2"]);
  expect(await titles(4)).toEqual(["Entry 1"]);
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
