import { prisma } from "@tuti/db";
import { startWebhookReceiver, type WebhookReceiver } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createChangelogEntry,
  deleteChangelogEntry,
  getChangelogEntry,
  listChangelog,
  publishChangelogEntry,
  reactToChangelogEntry,
  unpublishChangelogEntry,
  updateChangelogEntry,
} from "@/server/operations/changelog";
import { reactToChangelogEntry as reactAction } from "@/server/changelog";
import { entryTold, publishedEntries } from "@/server/changelog-queries";
import { createPost } from "@/server/operations/create";
import { OperationError } from "@/server/operations/define";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

// Saving the changelog.published delivery can be made to fail, to check publishing is all or nothing.
const failing = vi.hoisted(() => ({ event: false }));
vi.mock("@tuti/jobs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tuti/jobs")>();
  return {
    ...real,
    recordEvent: (...args: Parameters<typeof real.recordEvent>) =>
      failing.event && args[2] === "changelog.published" ? Promise.reject(new Error("database down")) : real.recordEvent(...args),
  };
});

let owner: TestUser;
let visitor: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let receiver: WebhookReceiver;

beforeAll(async () => {
  receiver = await startWebhookReceiver();
});
afterAll(() => receiver.close());
afterEach(() => vi.unstubAllEnvs());

beforeEach(async () => {
  owner = await signUp("Owner");
  visitor = await signUp("Visitor");
  project = await createProject(owner);
});

const as = (user: TestUser) => ({ actor: { kind: "user" as const, userId: user.id }, projectId: project.id });
const post = (title: string) => call(createPost, as(visitor), { board: "feature-requests", title });
const status = async (number: number) =>
  (await prisma.post.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number } } })).status;

describe("changelog entries", () => {
  test("a draft is the team's until it's published", async () => {
    const dark = await post("Dark mode");
    const entry = await call(createChangelogEntry, as(owner), {
      title: "Dark mode is here",
      content: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "New" }] },
          { type: "paragraph", content: [{ type: "text", text: "Switch themes from your menu." }] },
        ],
      },
      tags: ["new"],
      posts: [dark.number],
    });
    expect(entry).toMatchObject({
      number: 1,
      status: "draft",
      tags: ["new"],
      body: "New\nSwitch themes from your menu.",
      posts: [{ number: dark.number, title: "Dark mode", url: expect.stringContaining("/feedback/feature-requests/dark-mode-") }],
      url: expect.stringMatching(/\/changelog\/1$/),
    });

    // Visitors see neither the draft nor the list of drafts.
    await expect(call(getChangelogEntry, as(visitor), { number: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(call(listChangelog, as(visitor), { status: "draft" })).rejects.toMatchObject({ status: 403 });
    expect((await call(listChangelog, as(visitor), {})).entries).toEqual([]);
    expect((await call(listChangelog, as(owner), { status: "draft" })).entries).toHaveLength(1);
  });

  test("edits change only what's sent; the posts list is replaced, and must be this project's", async () => {
    const [a, b] = [await post("Export to CSV"), await post("Import from CSV")];
    await call(createChangelogEntry, as(owner), { title: "CSV", body: "Export your data.", posts: [a.number] });
    const edited = await call(updateChangelogEntry, as(owner), { number: 1, tags: ["improved", "fixed"], posts: [b.number] });
    expect(edited).toMatchObject({ title: "CSV", body: "Export your data.", tags: ["improved", "fixed"], posts: [{ number: b.number }] });
    await expect(call(updateChangelogEntry, as(owner), { number: 1, posts: [999] })).rejects.toMatchObject({
      status: 400,
      message: "There's no post #999",
    });
  });

  test("publishing completes its posts once and tells webhooks; unpublishing and deleting take it down", async () => {
    const [open, done] = [await post("Dark mode"), await post("Night theme")];
    await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: done.number } }, data: { status: "COMPLETED" } });
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true"); // the receiver is local
    const webhook = await prisma.webhook.create({
      data: { projectId: project.id, url: receiver.url, secret: "whsec_x", events: ["changelog.published"], createdById: owner.id },
    });
    await call(createChangelogEntry, as(owner), { title: "Themes", body: "Dark and night.", posts: [open.number, done.number] });

    await prisma.user.update({ where: { id: visitor.id }, data: { emailVerified: true } });
    const published = await call(publishChangelogEntry, as(owner), { number: 1 });
    expect(published).toMatchObject({ status: "published", publishedAt: expect.any(String) });
    expect(await status(open.number)).toBe("COMPLETED");
    // Its author hears it shipped (and nothing is left due for the resubmit job).
    expect(mailbox.emails.filter((e) => e.to.includes(visitor.email)).map((e) => e.subject)).toContain("Done: Dark mode");
    const due = await prisma.post.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: open.number } } });
    expect(due.shippedEmailsDueAt).toBeNull();
    // A second publish changes nothing: same date, no second event.
    expect(await call(publishChangelogEntry, as(owner), { number: 1 })).toMatchObject({ publishedAt: published.publishedAt });
    const deliveries = await prisma.webhookDelivery.findMany({ where: { webhookId: webhook.id }, select: { event: true, payload: true } });
    expect(deliveries).toEqual([{ event: "changelog.published", payload: expect.objectContaining({ data: expect.objectContaining({ number: 1, title: "Themes" }) }) }]);
    expect(receiver.received.map((r) => r.headers["tuti-event-type"])).toEqual(["changelog.published"]);

    // Everyone sees it now.
    expect((await call(listChangelog, as(visitor), {})).entries.map((e) => e.title)).toEqual(["Themes"]);
    expect(await call(getChangelogEntry, as(visitor), { number: 1 })).toMatchObject({ title: "Themes" });

    await call(unpublishChangelogEntry, as(owner), { number: 1 });
    expect((await call(listChangelog, as(visitor), {})).entries).toEqual([]);
    expect(await status(open.number)).toBe("COMPLETED"); // posts keep their status
    await call(deleteChangelogEntry, as(owner), { number: 1 });
    await expect(call(getChangelogEntry, as(owner), { number: 1 })).rejects.toMatchObject({ status: 404 });
  });

  test("publishing is all or nothing: if saving its event fails, nothing is published or completed", async () => {
    const dark = await post("Dark mode");
    await prisma.webhook.create({
      data: { projectId: project.id, url: receiver.url, secret: "whsec_x", events: ["changelog.published"], createdById: owner.id },
    });
    await call(createChangelogEntry, as(owner), { title: "Themes", body: "Dark.", posts: [dark.number] });

    failing.event = true;
    try {
      await expect(call(publishChangelogEntry, as(owner), { number: 1 })).rejects.toThrow("database down");
    } finally {
      failing.event = false;
    }
    expect(await call(getChangelogEntry, as(owner), { number: 1 })).toMatchObject({ status: "draft" });
    expect(await status(dark.number)).toBe("OPEN");

    // Tried again, it all happens.
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
    expect(await call(publishChangelogEntry, as(owner), { number: 1 })).toMatchObject({ status: "published" });
    expect(await status(dark.number)).toBe("COMPLETED");
  });

  test("publishing goes by each post's status at that moment, not as first read", async () => {
    const dark = await post("Dark mode");
    const where = { projectId_number: { projectId: project.id, number: dark.number } };
    await prisma.post.update({ where, data: { status: "COMPLETED" } });
    await call(createChangelogEntry, as(owner), { title: "Themes", body: "Dark.", posts: [dark.number] });
    // The team reopens the post just after publishing has read the entry.
    const read = prisma.changelogEntry.findUnique.bind(prisma.changelogEntry);
    vi.spyOn(prisma.changelogEntry, "findUnique").mockImplementationOnce((async (args: never) => {
      const entry = await read(args);
      await prisma.post.update({ where, data: { status: "OPEN" } });
      return entry;
    }) as never);

    await call(publishChangelogEntry, as(owner), { number: 1 });
    expect(await status(dark.number)).toBe("COMPLETED");
  });

  test("a published entry keeps the posts it completed: changing them means unpublishing first", async () => {
    const [a, b] = [await post("Export"), await post("Import")];
    await call(createChangelogEntry, as(owner), { title: "CSV", body: "x", posts: [a.number] });
    await call(publishChangelogEntry, as(owner), { number: 1 });
    await expect(call(updateChangelogEntry, as(owner), { number: 1, posts: [a.number, b.number] })).rejects.toMatchObject({
      status: 409,
      message: "Unpublish the entry to change the posts it completes",
    });
    // The same list (as a full form re-sends it) and other fields are fine.
    expect(await call(updateChangelogEntry, as(owner), { number: 1, title: "CSV export", posts: [a.number] })).toMatchObject({
      title: "CSV export",
    });
    await call(unpublishChangelogEntry, as(owner), { number: 1 });
    expect(await call(updateChangelogEntry, as(owner), { number: 1, posts: [a.number, b.number] })).toMatchObject({
      posts: [expect.anything(), expect.anything()],
    });
  });

  test("a change of posts racing a publish waits for it, then is refused: the posts it completed stay linked", async () => {
    const [dark, night] = [await post("Dark mode"), await post("Night theme")];
    await call(createChangelogEntry, as(owner), { title: "Themes", body: "x", posts: [dark.number] });
    const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id } });
    let changed: Promise<unknown> = Promise.resolve();
    // A publish, as publishChangelogEntry takes it: the project's lock, then the entry published.
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM project WHERE id = ${project.id} FOR UPDATE`;
        await tx.changelogEntry.update({ where: { id: entry.id }, data: { publishedAt: new Date(), collecting: false } });
        // Read before this publish commits (a draft then), so its own check lets it through.
        let settled = false;
        changed = call(updateChangelogEntry, as(owner), { number: 1, posts: [night.number] })
          .catch((error: unknown) => error)
          .finally(() => (settled = true));
        // Until it's done, or waits for a lock (this publish's): then the publish commits.
        await expect
          .poll(
            async () =>
              settled ||
              (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n > 0,
            { timeout: 5000 },
          )
          .toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(await changed).toEqual(new OperationError(409, "published", "Unpublish the entry to change the posts it completes"));
    const links = await prisma.changelogEntryPost.findMany({ where: { entryId: entry.id }, select: { post: { select: { number: true } } } });
    expect(links.map(({ post }) => post.number)).toEqual([dark.number]);
  });

  test("publishing announces by default; quietly, it doesn't", async () => {
    await call(createChangelogEntry, as(owner), { title: "Loud", body: "x" });
    await call(createChangelogEntry, as(owner), { title: "Quiet", body: "x" });
    expect(await call(publishChangelogEntry, as(owner), { number: 1 })).toMatchObject({ announced: true });
    expect(await call(publishChangelogEntry, as(owner), { number: 2, announce: false })).toMatchObject({ announced: false });
  });

  test("text a changelog can't hold is refused", async () => {
    await expect(
      call(createChangelogEntry, as(owner), {
        title: "Bad",
        content: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "x", marks: [{ type: "highlight" }] }] }] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("the cover and who was told", () => {
  const upload = (projectId = project.id) =>
    prisma.media.create({ data: { projectId, uploaderId: owner.id, size: 10, status: "READY", width: 1200, height: 600 } });
  const coverOf = async (number: number) =>
    (await prisma.changelogEntry.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number } } })).coverId;

  test("a cover is this project's finished upload, kept attached; replaced or removed by an edit, and shown with its title on the portal", async () => {
    const [first, second] = [await upload(), await upload()];
    await call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover: first.id });
    expect(await coverOf(1)).toBe(first.id);
    expect((await prisma.media.findUniqueOrThrow({ where: { id: first.id } })).attachedAt).not.toBeNull();

    // Edits that don't send it keep it; another upload replaces it.
    await call(updateChangelogEntry, as(owner), { number: 1, tags: ["new"] });
    expect(await coverOf(1)).toBe(first.id);
    await call(updateChangelogEntry, as(owner), { number: 1, cover: second.id });
    expect(await coverOf(1)).toBe(second.id);
    expect((await prisma.media.findUniqueOrThrow({ where: { id: second.id } })).attachedAt).not.toBeNull();

    // On the portal: an image of it, the entry's title its text.
    await call(publishChangelogEntry, as(owner), { number: 1 });
    const [shown] = await publishedEntries(project.slug);
    expect(shown!.cover).toEqual({ type: "doc", content: [{ type: "image", attrs: { mediaId: second.id, w: 1200, h: 600, alt: "Dark mode" } }] });

    await call(updateChangelogEntry, as(owner), { number: 1, cover: null });
    expect(await coverOf(1)).toBeNull();
    expect((await publishedEntries(project.slug))[0]!.cover).toBeNull();
  });

  test("an upload of another project's, one still processing or none at all can't be a cover", async () => {
    const other = await createProject(owner);
    const theirs = await upload(other.id);
    const processing = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 10 } });
    for (const cover of [theirs.id, processing.id, "nothing-by-this-id"]) {
      await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover })).rejects.toMatchObject({ status: 409 });
    }
    await call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x" });
    await expect(call(updateChangelogEntry, as(owner), { number: 1, cover: theirs.id })).rejects.toMatchObject({ status: 409 });
    expect(await coverOf(1)).toBeNull();
  });

  test("a published entry tells how many people its posts' shipped emails reached, each once (0 with nobody to tell); unknown when it completed none", async () => {
    const [dark, night] = [await post("Dark mode"), await post("Night theme")];
    const voter = await signUp("Voter");
    await prisma.user.updateMany({ where: { id: { in: [visitor.id, voter.id] } }, data: { emailVerified: true } });
    // The visitor wrote both and the voter voted on both: two people, each emailed about each post.
    for (const { number } of [dark, night]) {
      const postId = (await prisma.post.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number } } })).id;
      await prisma.vote.create({ data: { postId, userId: voter.id, projectId: project.id } });
    }
    await call(createChangelogEntry, as(owner), { title: "Themes", body: "x", posts: [dark.number, night.number] });
    await call(createChangelogEntry, as(owner), { title: "Faster search", body: "x" });
    // A post only the team asked for: completing it emails nobody.
    const exports = await call(createPost, as(owner), { board: "feature-requests", title: "Exports" });
    await call(createChangelogEntry, as(owner), { title: "Exports", body: "x", posts: [exports.number] });
    const [themes, search, exported] = await prisma.changelogEntry.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } });

    for (const number of [1, 2, 3]) {
      await call(publishChangelogEntry, as(owner), { number });
    }
    expect(mailbox.emails.filter((e) => e.subject.startsWith("Done: ") && [visitor.email, voter.email].some((to) => e.to.includes(to)))).toHaveLength(4);
    expect(await entryTold(themes!.id)).toBe(2);
    expect(await entryTold(search!.id)).toBeNull();
    expect(await entryTold(exported!.id)).toBe(0);
  });
});

describe("reactions", () => {
  const react = (user: TestUser, reaction: "thumbs_up" | "heart" | "tada", reacted = true, number = 1) =>
    call(reactToChangelogEntry, as(user), { number, reaction, reacted });
  const reactionRows = () => prisma.changelogReaction.count({ where: { entry: { projectId: project.id } } });
  const published = async () => {
    await call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x" });
    await call(publishChangelogEntry, as(owner), { number: 1 });
  };

  test("one of each per reader, toggled on and off; counts show in the reads", async () => {
    await published();
    const other = await signUp("Other reader");
    expect(await react(visitor, "tada")).toMatchObject({ reacted: true, reactions: { thumbs_up: 0, heart: 0, tada: 1 } });
    // Again changes nothing; another kind and another reader count separately.
    await react(visitor, "tada");
    await react(visitor, "heart");
    expect(await react(other, "tada")).toMatchObject({ reactions: { thumbs_up: 0, heart: 1, tada: 2 } });

    expect(await call(getChangelogEntry, as(visitor), { number: 1 })).toMatchObject({ reactions: { heart: 1, tada: 2 } });
    expect((await call(listChangelog, as(visitor), {})).entries[0]).toMatchObject({ reactions: { heart: 1, tada: 2 } });
    const [entry] = await publishedEntries(project.slug, { userId: visitor.id });
    expect(entry).toMatchObject({ reactions: { thumbs_up: 0, heart: 1, tada: 2 } });
    expect(entry!.reacted.sort()).toEqual(["heart", "tada"]);

    expect(await react(visitor, "tada", false)).toMatchObject({ reacted: false, reactions: { heart: 1, tada: 1 } });
    // Taking back one that isn't there changes nothing.
    expect(await react(visitor, "tada", false)).toMatchObject({ reactions: { heart: 1, tada: 1 } });
  });

  test("a double submit counts once", async () => {
    await published();
    await Promise.all([react(visitor, "thumbs_up"), react(visitor, "thumbs_up"), react(visitor, "thumbs_up")]);
    expect(await reactionRows()).toBe(1);
    expect(await call(getChangelogEntry, as(visitor), { number: 1 })).toMatchObject({ reactions: { thumbs_up: 1 } });
  });

  test("drafts take no reactions; unpublished entries keep theirs, and deleted ones lose them", async () => {
    await call(createChangelogEntry, as(owner), { title: "Draft", body: "x" });
    // A draft is as good as missing to readers; the team is told why.
    await expect(react(visitor, "tada")).rejects.toMatchObject({ status: 404 });
    await expect(react(owner, "tada")).rejects.toMatchObject({ status: 409, message: "Only published entries take reactions" });
    expect(await reactionRows()).toBe(0);

    await call(publishChangelogEntry, as(owner), { number: 1 });
    await react(visitor, "tada");
    await call(unpublishChangelogEntry, as(owner), { number: 1 });
    await expect(react(visitor, "heart")).rejects.toMatchObject({ status: 404 });
    expect(await call(getChangelogEntry, as(owner), { number: 1 })).toMatchObject({ reactions: { tada: 1, heart: 0 } });

    await call(deleteChangelogEntry, as(owner), { number: 1 });
    expect(await reactionRows()).toBe(0);
  });

  test("a reaction lands on this project's entry only", async () => {
    await published();
    const otherProject = await createProject(owner);
    await prisma.changelogEntry.create({ data: { projectId: otherProject.id, number: 1, title: "Elsewhere", publishedAt: new Date() } });
    await react(visitor, "heart");
    const entries = await prisma.changelogEntry.findMany({
      where: { projectId: { in: [project.id, otherProject.id] } },
      select: { title: true, _count: { select: { reactions: true } } },
    });
    expect(entries).toEqual(
      expect.arrayContaining([
        { title: "Dark mode", _count: { reactions: 1 } },
        { title: "Elsewhere", _count: { reactions: 0 } },
      ]),
    );
    await expect(react(visitor, "heart", true, 2)).rejects.toMatchObject({ status: 404 });
  });

  test("on the portal: signed out sees the way to sign in; another project's SSO users can't react", async () => {
    await published();
    actAs(null);
    expect(await reactAction(project.slug, 1, "tada", true)).toEqual({ error: "Sign in to react" });
    const ssoUser = await signUp("SSO user");
    const otherProject = await createProject(owner);
    await prisma.ssoIdentity.create({ data: { projectId: otherProject.id, externalId: "ext-1", userId: ssoUser.id } });
    actAs(ssoUser);
    expect(await reactAction(project.slug, 1, "tada", true)).toEqual({ error: "Entry not found" });
    expect(await reactionRows()).toBe(0);

    actAs(visitor);
    expect(await reactAction(project.slug, 1, "tada", true)).toEqual({});
    expect(await reactionRows()).toBe(1);
  });
});
