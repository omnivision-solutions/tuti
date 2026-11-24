import { prisma } from "@tuti/db";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { commentOnChangelogEntry, deleteChangelogComment as deleteAction, editChangelogComment } from "@/server/changelog";
import { createChangelogEntry, publishChangelogEntry, unpublishChangelogEntry } from "@/server/operations/changelog";
import { createChangelogComment, deleteChangelogComment, listChangelogComments, updateChangelogComment } from "@/server/operations/changelog-comments";
import { call } from "@/server/operations/run";
import { actAs, addMember, createProject, onPortal, signUp, type TestUser } from "@/test/helpers";

/** Comments on changelog entries (changelogComments.*), and the portal's actions for them. */

// Something to happen between a write's reads and its write: run once as the comment's text is read.
const meanwhile = vi.hoisted(() => ({ run: null as null | (() => Promise<unknown>) }));
vi.mock("@/server/content", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/content")>();
  return {
    ...real,
    readContent: async (...args: Parameters<typeof real.readContent>) => {
      const run = meanwhile.run;
      meanwhile.run = null;
      await run?.();
      return real.readContent(...args);
    },
  };
});

let owner: TestUser;
let reader: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  reader = await signUp("Reader");
  project = await createProject(owner);
  await call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x" });
  await call(publishChangelogEntry, as(owner), { number: 1 });
});

const as = (user: TestUser) => ({ actor: { kind: "user" as const, userId: user.id }, projectId: project.id });
const key = { actor: { kind: "apiKey" as const, keyId: "k", projectId: "", scope: "write" as const, createdById: "" }, projectId: "" };
const asKey = () => ({ ...key, actor: { ...key.actor, projectId: project.id, createdById: owner.id }, projectId: project.id });
const comment = (user: TestUser, body = "Love it", number = 1) => call(createChangelogComment, as(user), { number, body });
const list = (user: TestUser) => call(listChangelogComments, as(user), { number: 1 });
const rows = () => prisma.changelogComment.count({ where: { entry: { projectId: project.id } } });
const form = (body: string) => {
  const data = new FormData();
  data.set("body", body);
  return data;
};

describe("operations", () => {
  test("a reader comments on a published entry; everyone reads them, oldest first, the team's marked", async () => {
    const first = await comment(reader, "Love it");
    expect(first).toMatchObject({ author: { name: "Reader", team: false }, body: "Love it", editedAt: null });
    await comment(owner, "Thanks!");
    const other = await signUp("Other");
    expect((await list(other)).comments).toMatchObject([
      { id: first.id, author: { name: "Reader", team: false }, body: "Love it" },
      { author: { name: "Owner", team: true }, body: "Thanks!" },
    ]);
  });

  test("an empty comment is refused", async () => {
    await expect(comment(reader, "  ")).rejects.toMatchObject({ status: 400, message: "Write something first" });
    expect(await rows()).toBe(0);
  });

  test("drafts take none: readers don't see them, the team is told why; unpublishing hides them", async () => {
    await call(createChangelogEntry, as(owner), { title: "Draft", body: "x" });
    await expect(comment(reader, "Hi", 2)).rejects.toMatchObject({ status: 404 });
    await expect(comment(owner, "Hi", 2)).rejects.toMatchObject({ status: 409, message: "Only published entries take comments" });
    expect(await rows()).toBe(0);

    const kept = await comment(reader);
    await call(unpublishChangelogEntry, as(owner), { number: 1 });
    await expect(list(reader)).rejects.toMatchObject({ status: 404 });
    await expect(call(updateChangelogComment, as(reader), { number: 1, id: kept.id, body: "Edit" })).rejects.toMatchObject({ status: 404 });
    // The team still sees them.
    expect((await list(owner)).comments).toHaveLength(1);
  });

  test("only its author edits a comment; the edit is marked", async () => {
    const mine = await comment(reader);
    const member = await addMember(project.id, "ADMIN");
    for (const someone of [owner, member, await signUp("Other")]) {
      await expect(call(updateChangelogComment, as(someone), { number: 1, id: mine.id, body: "Hijacked" })).rejects.toMatchObject({ status: 403 });
    }
    // A key edits its creator's, or the comments of whoever it writes as: not this reader's.
    await expect(call(updateChangelogComment, asKey(), { number: 1, id: mine.id, body: "Hijacked" })).rejects.toMatchObject({ status: 403 });
    const edited = await call(updateChangelogComment, as(reader), { number: 1, id: mine.id, body: "Love it, really" });
    expect(edited).toMatchObject({ body: "Love it, really", editedAt: expect.any(String) });
    expect((await list(reader)).comments).toMatchObject([{ body: "Love it, really" }]);
  });

  test("its author deletes their own; the team (members, keys) deletes any; other readers can't", async () => {
    const [a, b, c] = [await comment(reader, "One"), await comment(reader, "Two"), await comment(reader, "Three")];
    const other = await signUp("Other");
    await expect(call(deleteChangelogComment, as(other), { number: 1, id: a.id })).rejects.toMatchObject({ status: 403 });
    expect(await rows()).toBe(3);

    expect(await call(deleteChangelogComment, as(reader), { number: 1, id: a.id })).toEqual({ deleted: a.id });
    const member = await addMember(project.id, "MEMBER");
    await call(deleteChangelogComment, as(member), { number: 1, id: b.id });
    await call(deleteChangelogComment, asKey(), { number: 1, id: c.id });
    expect(await rows()).toBe(0);
    await expect(call(deleteChangelogComment, as(reader), { number: 1, id: a.id })).rejects.toMatchObject({ status: 404 });
  });

  test("a comment is reached through its own entry only", async () => {
    const mine = await comment(reader);
    await call(createChangelogEntry, as(owner), { title: "Second", body: "x" });
    await call(publishChangelogEntry, as(owner), { number: 2 });
    await expect(call(deleteChangelogComment, as(owner), { number: 2, id: mine.id })).rejects.toMatchObject({ status: 404 });
    // Another project's team can't reach it through their own entry #1.
    const theirs = await createProject(owner);
    await prisma.changelogEntry.create({ data: { projectId: theirs.id, number: 1, title: "Elsewhere", publishedAt: new Date() } });
    await expect(call(deleteChangelogComment, { ...as(owner), projectId: theirs.id }, { number: 1, id: mine.id })).rejects.toMatchObject({ status: 404 });
    expect(await rows()).toBe(1);
  });
});

describe("races", () => {
  test("an edit to a comment deleted meanwhile says it's gone", async () => {
    const mine = await comment(reader);
    meanwhile.run = () => prisma.changelogComment.delete({ where: { id: mine.id } });
    await expect(call(updateChangelogComment, as(reader), { number: 1, id: mine.id, body: "Edit" })).rejects.toMatchObject({
      status: 404,
      message: "There's no such comment on this entry",
    });
  });

  test("a comment or an edit on an entry unpublished meanwhile is refused, and nothing's saved", async () => {
    const mine = await comment(reader);
    meanwhile.run = () => call(unpublishChangelogEntry, as(owner), { number: 1 });
    await expect(comment(reader, "Late")).rejects.toMatchObject({ status: 409, message: "Only published entries take comments" });
    expect(await rows()).toBe(1);

    await call(publishChangelogEntry, as(owner), { number: 1 });
    meanwhile.run = () => call(unpublishChangelogEntry, as(owner), { number: 1 });
    await expect(call(updateChangelogComment, as(reader), { number: 1, id: mine.id, body: "Edit" })).rejects.toMatchObject({ status: 409 });
    expect((await prisma.changelogComment.findUniqueOrThrow({ where: { id: mine.id } })).body).toBe("Love it");
  });

  test("a comment on an entry deleted meanwhile says the entry's gone", async () => {
    meanwhile.run = () => prisma.changelogEntry.deleteMany({ where: { projectId: project.id, number: 1 } });
    await expect(comment(reader)).rejects.toMatchObject({ status: 404, message: "There's no changelog entry #1" });
  });
});

describe("on the portal", () => {
  test("a reader comments, edits and deletes their own; signed out is asked to sign in", async () => {
    actAs(null);
    expect(await commentOnChangelogEntry(project.slug, 1, {}, form("Hi"))).toEqual({ error: "Sign in to comment" });

    actAs(reader);
    expect(await commentOnChangelogEntry(project.slug, 1, {}, form("Hi"))).toEqual({});
    const { id } = await prisma.changelogComment.findFirstOrThrow({ where: { entry: { projectId: project.id } } });
    expect(await editChangelogComment(project.slug, 1, id, {}, form("Hello"))).toEqual({});
    expect((await list(reader)).comments).toMatchObject([{ body: "Hello" }]);
    expect(await deleteAction(project.slug, 1, id)).toEqual({});
    expect(await rows()).toBe(0);
  });

  test("a team member on the portal is a reader: their comment isn't the team's, and they delete only their own there", async () => {
    const readerComment = await comment(reader);
    actAs(owner);
    await onPortal(owner, project);
    expect(await commentOnChangelogEntry(project.slug, 1, {}, form("As a reader"))).toEqual({});
    expect((await list(reader)).comments).toMatchObject([{}, { body: "As a reader", author: { team: false } }]);
    expect(await deleteAction(project.slug, 1, readerComment.id)).toEqual({ error: "Only its author or the team can delete a comment" });
    expect(await rows()).toBe(2);
  });

  test("another project's SSO users, and those a private portal isn't for, can't comment", async () => {
    const ssoUser = await signUp("SSO user");
    const otherProject = await createProject(owner);
    await prisma.ssoIdentity.create({ data: { projectId: otherProject.id, externalId: "ext-1", userId: ssoUser.id } });
    actAs(ssoUser);
    expect(await commentOnChangelogEntry(project.slug, 1, {}, form("Hi"))).toEqual({ error: "Entry not found" });

    await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
    actAs(reader);
    expect(await commentOnChangelogEntry(project.slug, 1, {}, form("Hi"))).toEqual({ error: "Entry not found" });
    expect(await rows()).toBe(0);
    // One of its readers may.
    await prisma.portalReader.create({ data: { projectId: project.id, email: reader.email } });
    expect(await commentOnChangelogEntry(project.slug, 1, {}, form("Hi"))).toEqual({});
    expect(await rows()).toBe(1);
  });
});
