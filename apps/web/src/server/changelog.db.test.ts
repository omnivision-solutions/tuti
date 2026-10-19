import { prisma } from "@tuti/db";
import { startWebhookReceiver, type WebhookReceiver } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createChangelogEntry,
  deleteChangelogEntry,
  getChangelogEntry,
  listChangelog,
  publishChangelogEntry,
  unpublishChangelogEntry,
  updateChangelogEntry,
} from "@/server/operations/changelog";
import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";
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
      posts: [{ number: dark.number, title: "Dark mode", url: expect.stringContaining("/p/dark-mode-") }],
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

  test("text a changelog can't hold is refused", async () => {
    await expect(
      call(createChangelogEntry, as(owner), {
        title: "Bad",
        content: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "x", marks: [{ type: "highlight" }] }] }] },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
