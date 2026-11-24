import { prisma } from "@tuti/db";
import { UPLOADS_PER_HOUR_TEAM } from "@tuti/jobs";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";

import { configFile, FAKE_PNG, type S3Fake, startS3Fake, startWebhookReceiver, type WebhookReceiver } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createChangelogEntry,
  deleteChangelogEntry,
  editChangelogSection,
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

  test("Markdown is read as rich text, on create and edit; `content` wins over it", async () => {
    const entry = await call(createChangelogEntry, as(owner), {
      title: "Dark mode",
      markdown: "## New\n\nSwitch themes from your **menu**:\n\n- Light\n- Dark\n\nSee [the docs](https://example.com/themes).",
    });
    expect(entry.content).toMatchObject({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "New" }] },
        { type: "paragraph", content: [{ type: "text", text: "Switch themes from your " }, { type: "text", text: "menu", marks: [{ type: "bold" }] }, { type: "text", text: ":" }] },
        { type: "bulletList", content: [{ type: "listItem" }, { type: "listItem" }] },
        { type: "paragraph", content: [{ type: "text", text: "See " }, { type: "text", text: "the docs", marks: [{ type: "link", attrs: { href: "https://example.com/themes" } }] }, { type: "text", text: "." }] },
      ],
    });
    expect(entry.body).toContain("Switch themes from your menu:");

    const edited = await call(updateChangelogEntry, as(owner), { number: entry.number, markdown: "Now *everywhere*." });
    expect(edited.content).toMatchObject({ content: [{ type: "paragraph", content: [{ type: "text", text: "Now " }, { type: "text", text: "everywhere", marks: [{ type: "italic" }] }, { type: "text", text: "." }] }] });

    const both = await call(updateChangelogEntry, as(owner), {
      number: entry.number,
      markdown: "## Ignored",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Kept" }] }] },
    });
    expect(both.body).toBe("Kept");
  });
});

/**
 * For a describe block: an S3 fake and a local server of images (private addresses allowed, as tests' are), at
 * `images.origin` once started. /shot.png is an image, /big.png 2 MB, /page.png a page served as one; the rest 404.
 */
function imageServer() {
  const images = { origin: "", s3: undefined as unknown as S3Fake };
  let s3: S3Fake;
  const files = createServer((request, response) => {
    if (request.url?.startsWith("/shot.png")) {
      response.writeHead(200, { "content-type": "image/png" }).end(FAKE_PNG);
    } else if (request.url === "/big.png") {
      // Over the team's image limit (1 MB in the size test), under the import's.
      response.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(2 * 1024 * 1024));
    } else if (request.url === "/page.png") {
      response.writeHead(200, { "content-type": "image/png" }).end("<!doctype html><title>Not an image</title>");
    } else {
      response.writeHead(404).end();
    }
  });
  beforeAll(async () => {
    s3 = images.s3 = await startS3Fake();
    await new Promise<void>((resolve) => files.listen(0, "127.0.0.1", resolve));
    images.origin = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
  });
  afterAll(() => Promise.all([s3.close(), new Promise((resolve) => files.close(resolve))]));
  beforeEach(() => {
    for (const [name, value] of Object.entries({ ...s3.env, WEBHOOK_ALLOW_PRIVATE_URLS: "true" })) {
      vi.stubEnv(name, value);
    }
  });
  return images;
}

describe("an entry's text as Markdown", () => {
  const text = "Intro.\n\n## Dark mode\n\nOld text.\n\n### Details\n\nFollows your system.\n\n## Search\n\nFaster.";
  const edit = (input: Parameters<typeof updateChangelogEntry.run>[1]) => call(updateChangelogEntry, as(owner), input);
  const editSection = (input: { number: number; markdown: string; section?: number | string; append?: boolean; expectedUpdatedAt?: string }) => call(editChangelogSection, as(owner), input);

  test("reads back as it's written, with when it last changed; a list goes without the Markdown", async () => {
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", markdown: text });
    expect(entry.markdown).toBe(text);
    const saved = await prisma.changelogEntry.findUniqueOrThrow({ where: { projectId_number: { projectId: project.id, number: entry.number } } });
    expect(entry.updatedAt).toBe(saved.updatedAt.toISOString());
    expect(await call(getChangelogEntry, as(owner), { number: entry.number })).toMatchObject({ markdown: text, updatedAt: entry.updatedAt });
    const [listed] = (await call(listChangelog, as(owner), { status: "draft" })).entries;
    expect(listed).toMatchObject({ number: entry.number, updatedAt: entry.updatedAt });
    expect(listed).not.toHaveProperty("markdown");
    // Sent back as it came, nothing is lost or added.
    expect((await edit({ number: entry.number, markdown: entry.markdown })).content).toEqual(entry.content);
  });

  test("Markdown for one section replaces only it, by its heading or its number; `append` adds at the end", async () => {
    const { number } = await call(createChangelogEntry, as(owner), { title: "Dark mode", markdown: text });

    // A section runs to the next heading at its level or above: its sub-heading goes with it.
    expect((await editSection({ number, section: "dark mode", markdown: "## Dark mode\n\nNew text." })).markdown).toBe("Intro.\n\n## Dark mode\n\nNew text.\n\n## Search\n\nFaster.");
    // By number: 0 is the text before the first heading, 2 the second heading's.
    expect((await editSection({ number, section: 0, markdown: "Hello." })).markdown).toBe("Hello.\n\n## Dark mode\n\nNew text.\n\n## Search\n\nFaster.");
    expect((await editSection({ number, section: 2, markdown: "## Search\n\n- Faster\n- Finds typos" })).markdown).toBe("Hello.\n\n## Dark mode\n\nNew text.\n\n## Search\n\n- Faster\n- Finds typos");
    const appended = await editSection({ number, append: true, markdown: "Thanks for reading!" });
    expect(appended.markdown).toBe("Hello.\n\n## Dark mode\n\nNew text.\n\n## Search\n\n- Faster\n- Finds typos\n\nThanks for reading!");
    // The title and the rest are as they were.
    expect(appended).toMatchObject({ title: "Dark mode", status: "draft" });

    // They say where the Markdown goes: one of them, and a section that's there.
    await expect(editSection({ number, markdown: "Nowhere" })).rejects.toMatchObject({ status: 400, message: "Send `section` or `append: true`, one of them" });
    await expect(editSection({ number, section: 1, append: true, markdown: "Both" })).rejects.toMatchObject({ status: 400, message: "Send `section` or `append: true`, one of them" });
    await expect(editSection({ number, section: "Billing", markdown: "## Billing" })).rejects.toMatchObject({ status: 400, code: "no_section", message: "There's no section “Billing”" });
    await expect(editSection({ number, section: 7, markdown: "## Seven" })).rejects.toMatchObject({ status: 400, code: "no_section" });
    // Not changelog.update's to do: there, `markdown` is the whole text, and the previous release (which reads these
    // fields as nothing) would save it so. A part's edit has an operation of its own, which that release doesn't have.
    expect(Object.keys(updateChangelogEntry.input.shape)).not.toEqual(expect.arrayContaining(["section"]));
    expect(Object.keys(updateChangelogEntry.input.shape)).not.toEqual(expect.arrayContaining(["append"]));
    expect((await call(getChangelogEntry, as(owner), { number })).markdown).toBe(appended.markdown);
  });

  test("`updatedAt` sent back as `expectedUpdatedAt` saves only if nothing changed since", async () => {
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", markdown: text });
    const changed = await edit({ number: entry.number, title: "Dark mode is here" });
    expect(new Date(changed.updatedAt).getTime()).toBeGreaterThan(new Date(entry.updatedAt).getTime());
    await expect(editSection({ number: entry.number, section: "Search", markdown: "## Search\n\nStale.", expectedUpdatedAt: entry.updatedAt })).rejects.toMatchObject({ status: 409, code: "changed" });
    expect((await editSection({ number: entry.number, section: "Search", markdown: "## Search\n\nFresh.", expectedUpdatedAt: changed.updatedAt })).markdown).toContain("Fresh.");
    // The whole text's edit takes it too.
    await expect(edit({ number: entry.number, title: "Stale", expectedUpdatedAt: entry.updatedAt })).rejects.toMatchObject({ status: 409, code: "changed" });
  });
});

describe("Markdown's images", () => {
  const images = imageServer();

  test("read back as lasting links, and sent back they're the same uploads: nothing is copied again, in the whole text or one section", async () => {
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", markdown: `## Themes\n\n![The menu](${images.origin}/shot.png)\n\n## Search\n\nFaster.` });
    const imagesIn = (content: unknown) => (content as { content: { type: string; attrs?: { mediaId?: string } }[] }).content.filter((node) => node.type === "image").map((node) => node.attrs!.mediaId);
    const [mediaId] = imagesIn(entry.content);
    // Its link is this server's, for as long as the image is in use.
    expect(entry.markdown).toMatch(new RegExp(`!\\[The menu\\]\\(${process.env.APP_URL!.replace(/\/$/, "")}/api/media/${mediaId}/[^)]+\\)`));
    const uploads = () => prisma.media.count({ where: { projectId: project.id } });
    expect(await uploads()).toBe(1);

    const again = await call(updateChangelogEntry, as(owner), { number: entry.number, markdown: `${entry.markdown}\n\nMore.` });
    expect(imagesIn(again.content)).toEqual([mediaId]);
    const section = await call(editChangelogSection, as(owner), { number: entry.number, section: "Search", markdown: "## Search\n\nMuch faster." });
    expect(imagesIn(section.content)).toEqual([mediaId]);
    // The section's own image by its link too.
    const themes = /## Themes[^#]+/.exec(section.markdown!)![0].trim();
    expect(imagesIn((await call(editChangelogSection, as(owner), { number: entry.number, section: "Themes", markdown: `${themes}\n\nPick one.` })).content)).toEqual([mediaId]);
    expect(await uploads()).toBe(1);

    // Markdown can't say an image's size or alignment, nor that a link is a video's player: sent back, the text keeps them.
    const video = { type: "video", attrs: { provider: "youtube", id: "dQw4w9WgXcQ" } };
    const small = { type: "image", attrs: { mediaId, width: "50", align: "left", alt: "The menu" } };
    const laidOut = await call(updateChangelogEntry, as(owner), { number: entry.number, content: { type: "doc", content: [small, video, { type: "paragraph", content: [{ type: "text", text: "Watch it." }] }] } });
    expect(laidOut.markdown).toContain("[Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)");
    const back = await call(updateChangelogEntry, as(owner), { number: entry.number, markdown: `${laidOut.markdown}\n\nAnd more.` });
    expect((back.content as { content: object[] }).content.slice(0, 2)).toMatchObject([small, video]);
    // The same image twice, laid out two ways: each keeps its own, in the whole text and in the one section sent back.
    const wide = { type: "image", attrs: { mediaId, width: "100", align: "center", alt: "The menu" } };
    const heading = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: value }] });
    const twice = await call(updateChangelogEntry, as(owner), { number: entry.number, content: { type: "doc", content: [heading("First"), small, heading("Second"), wide, small] } });
    const layouts = (content: unknown) => (content as { content: { type: string; attrs?: { width?: string } }[] }).content.filter((node) => node.type === "image").map((node) => node.attrs!.width);
    expect(layouts((await call(updateChangelogEntry, as(owner), { number: entry.number, markdown: twice.markdown })).content)).toEqual(["50", "100", "50"]);
    const second = /## Second[^#]+/.exec(twice.markdown!)![0].trim();
    expect(layouts((await call(editChangelogSection, as(owner), { number: entry.number, section: "Second", markdown: `${second}\n\nMore.` })).content)).toEqual(["50", "100", "50"]);
    // Brought in from another part of the text (appended, by its link), an image takes the layout it has there, and the
    // text's own video is its player.
    await call(updateChangelogEntry, as(owner), { number: entry.number, content: { type: "doc", content: [small, video] } });
    const copied = await call(editChangelogSection, as(owner), { number: entry.number, append: true, markdown: `${/!\[[^\]]*\]\(\S+\)/.exec(twice.markdown!)![0]}\n\n[Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)` });
    expect((copied.content as { content: object[] }).content).toMatchObject([small, video, small, video]);
    await call(updateChangelogEntry, as(owner), { number: entry.number, content: { type: "doc", content: [small, video] } });
    // A link that only looks like one (another video, other words) is a link.
    const linked = await call(editChangelogSection, as(owner), { number: entry.number, append: true, markdown: "[Video](https://www.youtube.com/watch?v=aaaaaaaaaaa)" });
    expect((linked.content as { content: { type: string }[] }).content.at(-1)!.type).toBe("paragraph");
    // And the text's own video named inside a list item is a link there: a list item can't hold a player, and the edit saves.
    const listed = await call(editChangelogSection, as(owner), { number: entry.number, append: true, markdown: "- [Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)" });
    expect((listed.content as { content: { type: string }[] }).content.at(-1)!.type).toBe("bulletList");
    expect((listed.content as { content: { type: string }[] }).content.filter((node) => node.type === "video")).toHaveLength(1);
    expect(await uploads()).toBe(1);

    // Another project's image isn't this one's to reuse by its link, nor is a link with a signature that isn't ours: neither is taken as an upload.
    const other = await createProject(owner);
    const ours = /\((\S+)\)/.exec(entry.markdown!)![1]!;
    const theirs = await call(createChangelogEntry, { ...as(owner), projectId: other.id }, { title: "Theirs", markdown: `![Ours](${ours})` });
    expect(imagesIn(theirs.content)).not.toContain(mediaId);
    // In its own project too, an upload isn't had by its id alone: a signature that isn't ours, or ours on another
    // server's address, is an address to fetch like any other (these answer with no image: left out, nothing uploaded).
    const forged = await call(createChangelogEntry, as(owner), {
      title: "Forged",
      markdown: `![Forged](${ours.replace(/s=[\w-]+/, "s=forged")})\n\n![Elsewhere](${ours.replace(new URL(ours).origin, images.origin)})\n\nText.`,
    });
    expect(imagesIn(forged.content)).toEqual([]);
    expect(await uploads()).toBe(1);
    expect(await prisma.media.count({ where: { id: mediaId, projectId: project.id } })).toBe(1);
  });

  test("are copied into the project and kept attached; one that can't be fetched is left out", async () => {
    const entry = await call(createChangelogEntry, as(owner), {
      title: "Dark mode",
      markdown: `Before:\n\n![The menu](${images.origin}/shot.png)\n\n![Gone](${images.origin}/gone.png)\n\nAfter.`,
    });
    const copied = (entry.content as { content: { type: string; attrs?: { mediaId?: string } }[] }).content.filter((node) => node.type === "image");
    expect(copied).toHaveLength(1);
    const media = await prisma.media.findUniqueOrThrow({ where: { id: copied[0]!.attrs!.mediaId! } });
    expect(media).toMatchObject({ projectId: project.id, uploaderId: owner.id, status: "READY", attachedAt: expect.any(Date) });
    expect(entry.body).toContain("After.");
  });

  test("a section's edit is saved only if the entry didn't change while its images were copied, asked or not", async () => {
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", markdown: "## Themes\n\nOld.\n\n## Search\n\nFaster." });
    // A merged pull request's line lands in the text (the running draft's job) as the edit's image is being kept.
    let changed = false;
    images.s3.beforeGet = async () => {
      if (!changed) {
        changed = true;
        await call(editChangelogSection, as(owner), { number: entry.number, append: true, markdown: "- A line added meanwhile" });
      }
    };
    await expect(
      call(editChangelogSection, as(owner), { number: entry.number, section: "Themes", markdown: `## Themes\n\n![The menu](${images.origin}/shot.png)` }),
    ).rejects.toMatchObject({ status: 409, code: "changed" });
    images.s3.beforeGet = undefined;
    // What landed meanwhile is still there, and the section is as it was.
    expect((await call(getChangelogEntry, as(owner), { number: entry.number })).markdown).toBe("## Themes\n\nOld.\n\n## Search\n\nFaster.\n\n- A line added meanwhile");
  });

  test("count as the member's uploads: past their hourly limit, an image is left out", async () => {
    await prisma.media.createMany({
      data: Array.from({ length: UPLOADS_PER_HOUR_TEAM }, () => ({ projectId: project.id, uploaderId: owner.id, size: 1, status: "READY" as const })),
    });
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", markdown: `![The menu](${images.origin}/shot.png)\n\nAfter.` });
    expect((entry.content as { content: { type: string }[] }).content.map((node) => node.type)).not.toContain("image");
    expect(await prisma.media.count({ where: { uploaderId: owner.id } })).toBe(UPLOADS_PER_HOUR_TEAM);
  });

  test("are held to the team's image size, not the import's", async () => {
    vi.stubEnv("TUTI_CONFIG", configFile({ media: { maxMb: { teamImage: 1 } } }));
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", markdown: `![Huge](${images.origin}/big.png)\n\nAfter.` });
    expect((entry.content as { content: { type: string }[] }).content.map((node) => node.type)).not.toContain("image");
    expect(await prisma.media.count({ where: { uploaderId: owner.id } })).toBe(0);
  });

  test("aren't copied for a request refused anyway", async () => {
    const markdown = `![The menu](${images.origin}/shot.png)`;
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", markdown, posts: [999] })).rejects.toMatchObject({ status: 400 });
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", markdown, cover: "not-an-upload" })).rejects.toMatchObject({ status: 409 });
    const sample = await post("A sample idea");
    await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: sample.number } }, data: { sample: true } });
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", markdown, posts: [sample.number] })).rejects.toMatchObject({ status: 400 });
    await expect(call(createChangelogEntry, as(owner), { title: "Long", markdown: `${markdown}\n\n${"word ".repeat(5_000)}` })).rejects.toMatchObject({ status: 400 });
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x" });
    await expect(
      call(updateChangelogEntry, as(owner), { number: entry.number, markdown, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await prisma.media.count({ where: { uploaderId: owner.id } })).toBe(0);
  });
});

describe("a cover given by URL", () => {
  const images = imageServer();
  const ready = () => prisma.media.count({ where: { uploaderId: owner.id, status: "READY" } });

  test("is copied into the project as the member's upload, on create and edit", async () => {
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover: `${images.origin}/shot.png` });
    const media = await prisma.media.findUniqueOrThrow({ where: { id: entry.cover!.id } });
    expect(media).toMatchObject({ projectId: project.id, uploaderId: owner.id, status: "READY", filename: null, attachedAt: expect.any(Date) });

    const edited = await call(updateChangelogEntry, as(owner), { number: entry.number, cover: `${images.origin}/shot.png?v=2`, markdown: `![Shot](${images.origin}/shot.png)` });
    expect(edited.cover!.id).not.toBe(entry.cover!.id);
    expect(await ready()).toBe(3);
  });

  test("that can't be fetched, isn't an image or is private is a 400, and nothing is saved", async () => {
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x" });
    for (const [cover, message] of [
      [`${images.origin}/gone.png`, "Couldn't fetch the cover"],
      [`${images.origin}/page.png`, "The cover's URL isn't an image"],
      ["ftp://example.com/cover.png", "Couldn't fetch the cover"],
    ]) {
      await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover })).rejects.toMatchObject({ status: 400, code: "invalid_cover", message: expect.stringContaining(message) });
      await expect(call(updateChangelogEntry, as(owner), { number: entry.number, title: "Changed", cover })).rejects.toMatchObject({ status: 400, code: "invalid_cover" });
    }
    // Off the test's allowance: a private address is refused, as webhooks' are (https, so it's the address that's refused,
    // not the scheme; refused before connecting, so nothing is fetched).
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "false");
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover: "https://10.0.0.1/cover.png" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_cover",
      message: expect.stringContaining("Couldn't fetch the cover"),
    });
    expect(await prisma.changelogEntry.count({ where: { projectId: project.id } })).toBe(1);
    expect((await call(getChangelogEntry, as(owner), { number: entry.number })).title).toBe("Dark mode");
    expect(await ready()).toBe(0);
  });

  test("that couldn't be kept on our side is a 503 to try again, not a bad URL", async () => {
    vi.stubEnv("MEDIA_S3_ENDPOINT", "http://127.0.0.1:1");
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover: `${images.origin}/shot.png` })).rejects.toMatchObject({ status: 503, code: "copy_failed" });
    expect(await ready()).toBe(0);
  });

  test("over the team's image size is a 400; without storage, a 503", async () => {
    vi.stubEnv("TUTI_CONFIG", configFile({ media: { maxMb: { teamImage: 1 } } }));
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover: `${images.origin}/big.png` })).rejects.toMatchObject({
      status: 400,
      code: "invalid_cover",
      message: "The cover can be up to 1 MB",
    });
    vi.stubEnv("MEDIA_S3_BUCKET", "");
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover: `${images.origin}/shot.png` })).rejects.toMatchObject({
      status: 503,
      code: "uploads_unavailable",
    });
    expect(await prisma.media.count({ where: { uploaderId: owner.id } })).toBe(0);
  });

  test("past the member's hourly uploads is a 409", async () => {
    await prisma.media.createMany({
      data: Array.from({ length: UPLOADS_PER_HOUR_TEAM }, () => ({ projectId: project.id, uploaderId: owner.id, size: 1, status: "READY" as const })),
    });
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover: `${images.origin}/shot.png` })).rejects.toMatchObject({ status: 409, code: "no_room" });
  });

  test("isn't copied for a request refused anyway", async () => {
    const cover = `${images.origin}/shot.png`;
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover, posts: [999] })).rejects.toMatchObject({ status: 400 });
    const sample = await post("A sample idea");
    await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: sample.number } }, data: { sample: true } });
    await expect(call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x", cover, posts: [sample.number] })).rejects.toMatchObject({ status: 400 });
    await expect(call(createChangelogEntry, as(owner), { title: "Long", markdown: "word ".repeat(5_000), cover })).rejects.toMatchObject({ status: 400 });
    await expect(call(createChangelogEntry, as(owner), { title: "Bad", content: { type: "nope" }, cover })).rejects.toMatchObject({ status: 400 });
    const entry = await call(createChangelogEntry, as(owner), { title: "Dark mode", body: "x" });
    await expect(call(updateChangelogEntry, as(owner), { number: entry.number, cover, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.media.count({ where: { uploaderId: owner.id } })).toBe(0);
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
    expect(await entryTold(themes!.id)).toEqual({ asked: 2, subscribers: 0 });
    expect(await entryTold(search!.id)).toBeNull();
    expect(await entryTold(exported!.id)).toEqual({ asked: 0, subscribers: 0 });
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
