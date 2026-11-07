import { prisma } from "@tuti/db";
import { CHANGELOG_PAGE, importsSettled, portalAddress } from "@tuti/jobs";
import { FAKE_FERNDESK_KEY, type FerndeskFake, ferndeskFixtures, type S3Fake, startFerndeskFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { syncUsersOperation } from "@/server/operations/users";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** Imports from Ferndesk (docs/plan.md, Import from Ferndesk): its help center, changelog, users and AI conversations, against its fake. */

let fake: FerndeskFake;
let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [fake, s3] = await Promise.all([startFerndeskFake(), startS3Fake()]);
});
afterAll(() => Promise.all([fake.close(), s3.close()]));
const limits = { ...CHANGELOG_PAGE };
afterEach(() => {
  vi.unstubAllEnvs();
  Object.assign(CHANGELOG_PAGE, limits);
});
beforeEach(async () => {
  vi.stubEnv("FERNDESK_API_URL", fake.url);
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  // The fake serves its files on this machine.
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  Object.assign(fake, { fixtures: ferndeskFixtures(), pageSize: 100, requests: [], forbidden: new Set() });
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const start = (parts: string[], key = FAKE_FERNDESK_KEY, options: { publishArticles?: boolean } = {}) => call(startImport, asOwner(), { source: "ferndesk", key, parts, ...options } as never);
/** Imports these parts, start to end; its view. */
async function importParts(parts: string[], options: { publishArticles?: boolean } = {}) {
  await start(parts, FAKE_FERNDESK_KEY, options);
  await importsSettled();
  return (await call(getImport, asOwner(), {})).import!;
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { status: number; code: string; message: string }) => ({ status: error.status, code: error.code, message: error.message }));
const collections = () =>
  prisma.collection.findMany({ where: { projectId: project.id }, orderBy: [{ parentId: { sort: "asc", nulls: "first" } }, { order: "asc" }], select: { name: true, slug: true, description: true, order: true, parent: { select: { name: true } } } });
const article = (title: string) =>
  prisma.article.findFirstOrThrow({
    where: { projectId: project.id, title },
    select: { slug: true, body: true, content: true, publishedAt: true, createdAt: true, collection: { select: { name: true } }, changes: { select: { body: true } }, _count: { select: { revisions: true } } },
  });
type Node = { type: string; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[]; content?: Node[]; text?: string };
const nodesOf = (node: Node): Node[] => [node, ...(node.content ?? []).flatMap(nodesOf)];
const linksIn = (doc: unknown) => nodesOf(doc as Node).flatMap((node) => (node.marks ?? []).filter((mark) => mark.type === "link").map((mark) => ({ text: node.text, href: mark.attrs?.href })));
const entries = () =>
  prisma.changelogEntry.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" }, select: { title: true, body: true, tags: true, publishedAt: true, subscribersEmailedAt: true } });
const conversations = () =>
  prisma.conversation.findMany({
    where: { projectId: project.id },
    orderBy: { number: "asc" },
    select: { subject: true, status: true, user: { select: { name: true } }, messages: { orderBy: { createdAt: "asc" }, select: { author: true, body: true, importId: true } } },
  });

test("a start is refused, nothing made, for a key Ferndesk refuses or one that can't read a part", async () => {
  expect(await refusal(start(["docs"], "fdsk_wrong"))).toEqual({ status: 400, code: "bad_key", message: "Ferndesk didn't accept this API key. Check you copied all of it, or make a new one." });
  // A read-only key can't list drafts.
  fake.forbidden.add("/v1/articles");
  expect(await refusal(start(["docs"]))).toEqual({ status: 400, code: "cant_read", message: "This key can't read Help center in Ferndesk. Use a key that can, or leave Help center out." });
  fake.forbidden.clear();
  fake.forbidden.add("/v1/users");
  expect(await refusal(start(["contacts"]))).toEqual({ status: 400, code: "cant_read", message: "This key can't read Contacts in Ferndesk. Use a key that can, or leave Contacts out." });
  // A read-only key can't list a changelog's drafts.
  fake.forbidden.clear();
  fake.forbidden.add("/v1/changelogs/col_changelog/entries");
  expect(await refusal(start(["changelog"]))).toEqual({ status: 400, code: "cant_read", message: "This key can't read Changelog in Ferndesk. Use a key that can, or leave Changelog out." });
  // Ferndesk has no team or feedback.
  expect(await refusal(start(["feedback"]))).toMatchObject({ status: 400, code: "invalid_input" });
  // Only a source that can't say who may read each article is asked how its published ones come.
  expect(await refusal(call(startImport, asOwner(), { source: "featurebase", key: "sk_any", parts: ["docs"], publishArticles: true }))).toMatchObject({
    status: 400,
    code: "invalid_input",
    message: "Featurebase says who may read each article: its articles come as they were",
  });
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);
});

test("the help center comes across, asked to come as published: sections and collections in their tree, articles with their content, images and links, published or draft as they were; again, nothing twice", async () => {
  const emailed = mailbox.emails.length;
  // A few to a page, so every list is read past its first.
  fake.pageSize = 2;
  const done = await importParts(["docs"], { publishArticles: true });

  expect(done).toMatchObject({ state: "done", counts: { collections: { imported: 5, leftOut: {} }, articles: { imported: 4, leftOut: {} } } });
  expect(importSummary(done)).toBe("5 collections, 4 articles brought across.");
  // Two sections: each a top-level collection, in their order; collections by name within.
  expect(await collections()).toEqual([
    { name: "Guides", slug: "guides", description: "", order: 0, parent: null },
    { name: "API", slug: "api", description: "", order: 1, parent: null },
    { name: "Billing", slug: "billing", description: "Plans and payments.", order: 0, parent: { name: "Guides" } },
    { name: "Getting started", slug: "getting-started", description: "", order: 1, parent: { name: "Guides" } },
    { name: "Invoices", slug: "invoices", description: "Finding and paying them.", order: 0, parent: { name: "Billing" } },
  ]);

  const portal = await portalAddress(project.slug);
  const welcome = await article("Welcome to Acme");
  expect(welcome).toMatchObject({
    slug: "welcome-to-acme",
    collection: { name: "Getting started" },
    createdAt: new Date("2024-03-01T09:00:00.000Z"),
    publishedAt: new Date("2024-03-02T09:00:00.000Z"),
    // Its stale draft (published past since) isn't its unpublished changes.
    changes: null,
    _count: { revisions: 1 },
  });
  expect(welcome.body).toContain("Acme keeps every invoice in one place.");
  // Links to another article (later in the list) and to a collection, by their public addresses, point at their new
  // pages; others stay as they are.
  expect(linksIn(welcome.content)).toEqual([
    { text: "Paying by card", href: `${portal}/docs/paying-by-card` },
    { text: "Billing", href: `${portal}/docs/billing` },
    { text: "our blog", href: "https://example.com/a-blog-post" },
  ]);
  const image = nodesOf(welcome.content as Node).find((node) => node.type === "image")!;
  expect(await prisma.media.findUniqueOrThrow({ where: { id: image.attrs!.mediaId as string }, select: { status: true, width: true } })).toEqual({ status: "READY", width: 96 });

  // Published with an open draft: the draft is its unpublished changes.
  expect(await article("Paying by card")).toMatchObject({
    collection: { name: "Invoices" },
    publishedAt: expect.any(Date),
    body: "Cards are charged on the 1st. See Welcome to Acme.",
    // With its image (its alt text in the plain text).
    changes: { body: "Cards are charged on the 1st. Amex is coming soon.\nAmex" },
    _count: { revisions: 2 },
  });
  expect(linksIn((await article("Paying by card")).content)).toEqual([{ text: "Welcome to Acme", href: `${portal}/docs/welcome-to-acme` }]);
  // A draft stays one; one in no collection goes in its section's.
  expect(await article("Roadmap notes")).toMatchObject({ slug: "2027-roadmap-notes", publishedAt: null, body: "Not ready yet.", collection: { name: "Getting started" } });
  expect(await article("API keys")).toMatchObject({ publishedAt: expect.any(Date), collection: { name: "API" } });
  expect(mailbox.emails.length).toBe(emailed);

  // Again: nothing twice.
  const again = await importParts(["docs"], { publishArticles: true });
  expect(again).toMatchObject({ state: "done", counts: { collections: { imported: 0, leftOut: { "already brought across earlier": 5 } }, articles: { imported: 0, leftOut: { "already brought across earlier": 4 } } } });
  expect(await collections()).toHaveLength(5);
  expect(await prisma.article.count({ where: { projectId: project.id } })).toBe(4);
});

test("by default, articles published in Ferndesk come as drafts for the team to check and publish: Ferndesk doesn't say which were private", async () => {
  const done = await importParts(["docs"]);

  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: done.id }, select: { publishArticles: true } })).toEqual({ publishArticles: false });
  expect(done.counts).toMatchObject({ articles: { imported: 1, leftOut: {} }, heldDrafts: { imported: 3, leftOut: {} }, unpublishedChanges: { imported: 0, leftOut: { "(the article came as a draft of its published text)": 1 } } });
  expect(importSummary(done)).toBe(
    "5 collections, 1 article, 3 articles as drafts (published there; publish them once you've checked them) brought across. Left out: 1 article's unpublished changes (the article came as a draft of its published text).",
  );
  expect(await prisma.article.count({ where: { projectId: project.id, publishedAt: { not: null } } })).toBe(0);
  // One open draft is counted: API keys' is the same as what's published.
  // Its content and links all the same. One with an open draft keeps what readers saw, so publishing it once checked puts that live.
  expect(await article("Welcome to Acme")).toMatchObject({ publishedAt: null, changes: null, body: expect.stringContaining("Acme keeps every invoice in one place.") });
  expect(await article("Paying by card")).toMatchObject({ publishedAt: null, changes: null, body: "Cards are charged on the 1st. See Welcome to Acme." });
  // Its draft's image isn't copied for nothing: only the published one's is in the project's media.
  expect(await prisma.media.count({ where: { projectId: project.id } })).toBe(1);
});

test("a help center of one section is its collections themselves", async () => {
  fake.fixtures.sections = fake.fixtures.sections.slice(0, 1);
  fake.fixtures.articles = fake.fixtures.articles.filter((a) => a.id !== "art_keys");
  await importParts(["docs"]);
  expect((await collections()).map((c) => [c.name, c.parent?.name ?? null])).toEqual([
    ["Billing", null],
    ["Getting started", null],
    ["Invoices", "Billing"],
  ]);
});

test("a help center whose other section is its changelog is its own section's collections, the changelog and its entries left out", async () => {
  fake.fixtures.sections = fake.fixtures.sections.filter((s) => s.id !== "sect_api");
  fake.fixtures.articles = fake.fixtures.articles.filter((a) => a.id !== "art_keys");
  const done = await importParts(["docs"], { publishArticles: true });
  expect(done.counts).toMatchObject({ collections: { imported: 3, leftOut: {} }, articles: { imported: 3, leftOut: {} } });
  expect((await collections()).map((c) => [c.name, c.parent?.name ?? null])).toEqual([
    ["Billing", null],
    ["Getting started", null],
    ["Invoices", "Billing"],
  ]);
  expect((await prisma.article.findMany({ where: { projectId: project.id }, orderBy: { title: "asc" }, select: { title: true } })).map((a) => a.title)).toEqual(["Paying by card", "Roadmap notes", "Welcome to Acme"]);
  expect(await prisma.changelogEntry.count({ where: { projectId: project.id } })).toBe(0);
});

test("the changelog comes across: entries oldest first, a page at a time, published at their dates and drafts as drafts with their draft's text, tags as tags, images; nothing emailed; again, nothing twice", async () => {
  const emailed = mailbox.emails.length;
  // One to a list page and two to an import page, so both are read past their first.
  fake.pageSize = 1;
  CHANGELOG_PAGE.entries = 2;
  const done = await importParts(["changelog"]);
  expect(done).toMatchObject({ state: "done", counts: { changelogEntries: { imported: 3, leftOut: {} }, changelogImages: { imported: 1, leftOut: {} } } });
  expect(importSummary(done)).toBe("3 changelog entries, 1 image in the changelog brought across.");
  expect(await entries()).toEqual([
    // Shown on the day before it went live: that day.
    { title: "Exports", body: "Exports take half the time.", tags: ["IMPROVED", "FIXED"], publishedAt: new Date("2024-04-02T00:00:00.000Z"), subscribersEmailedAt: null },
    { title: "Faster search", body: "Search results load twice as fast.\nSearch", tags: ["NEW"], publishedAt: new Date("2024-04-10T15:00:00.000Z"), subscribersEmailedAt: null },
    { title: "Single sign-on (beta)", body: "Coming soon.", tags: [], publishedAt: null, subscribersEmailedAt: null },
  ]);
  expect(await prisma.media.findMany({ where: { projectId: project.id }, select: { status: true, width: true } })).toEqual([{ status: "READY", width: 96 }]);
  // Nothing in the help center.
  expect(await prisma.article.count({ where: { projectId: project.id } })).toBe(0);
  expect(mailbox.emails.length).toBe(emailed);

  const again = await importParts(["changelog"]);
  expect(again.counts).toMatchObject({ changelogEntries: { imported: 0, leftOut: { "already brought across earlier": 3 } } });
  expect(await prisma.changelogEntry.count({ where: { projectId: project.id } })).toBe(3);
  expect(await prisma.media.count({ where: { projectId: project.id } })).toBe(1);
});

test("one who never verified their address in Ferndesk isn't matched to the user here who has it: anyone can type any address", async () => {
  await call(syncUsersOperation, asOwner(), { users: [{ id: "app-tobias", name: "The real Tobias", email: "e2e-ferndesk-tobias@example.com" }] });
  await importParts(["contacts", "inbox"]);
  expect(await prisma.ssoIdentity.findMany({ where: { projectId: project.id }, orderBy: { externalId: "asc" }, select: { externalId: true, user: { select: { name: true } } } })).toEqual([
    { externalId: "app-tobias", user: { name: "The real Tobias" } },
    { externalId: "ferndesk:hcusr_mira", user: { name: "Mira Fenwick" } },
    { externalId: "ferndesk:hcusr_tobias", user: { name: "Tobias Quill" } },
  ]);
  // Mira's verified address is hers: her conversation is with her user.
  expect((await conversations())[0]).toMatchObject({ user: { name: "Mira Fenwick" } });
});

test("users come across as Contacts, and the AI assistant's conversations as closed ones in the Inbox, by their person or a visitor; again, nothing twice", async () => {
  const emailed = mailbox.emails.length;
  const done = await importParts(["contacts", "inbox"]);

  expect(done).toMatchObject({ state: "done", counts: { contacts: { imported: 2 }, conversations: { imported: 2, leftOut: {} } } });
  expect(await prisma.ssoIdentity.findMany({ where: { projectId: project.id }, orderBy: { email: "asc" }, select: { externalId: true, email: true, properties: true, user: { select: { name: true } } } })).toEqual([
    { externalId: "ferndesk:hcusr_mira", email: "e2e-ferndesk-mira@example.com", properties: { plan: "pro" }, user: { name: "Mira Fenwick" } },
    { externalId: "ferndesk:hcusr_tobias", email: "e2e-ferndesk-tobias@example.com", properties: {}, user: { name: "Tobias Quill" } },
  ]);
  const [mira, visitor] = await conversations();
  expect(mira).toMatchObject({
    // Their own first words, not Ferndesk's summary for the team ("Asked how to export to CSV."): they see the subject.
    subject: "Can I export my data to CSV?",
    status: "CLOSED",
    user: { name: "Mira Fenwick" },
    messages: [
      { author: "USER", body: "Can I export my data to CSV?", importId: done.id },
      { author: "AI", body: expect.stringMatching(/^Yes: Settings → Export\.\n+It takes a minute\.$/), importId: done.id },
    ],
  });
  // Text, not markup.
  expect(visitor).toMatchObject({ subject: "Do you have an <API>?", status: "CLOSED", user: null, messages: [{ author: "USER", body: "Do you have an <API>?" }, { author: "AI" }] });
  expect(mailbox.emails.length).toBe(emailed);

  // Mira asked again later: another import adds only that turn and the answer.
  const later = fake.fixtures.conversations[0]!;
  later.updatedAt = new Date().toISOString();
  (later.transcript as unknown[]).push({ role: "user", text: "And to Excel?" }, { role: "assistant", text: "Open the CSV in Excel." });
  const again = await importParts(["contacts", "inbox"]);
  expect(again.counts).toMatchObject({ conversations: { imported: 0, leftOut: { "already brought across earlier": 2 } }, messages: { imported: 2 } });
  expect(await prisma.conversation.count({ where: { projectId: project.id } })).toBe(2);
  expect((await conversations())[0]!.messages.map((m) => m.body)).toEqual(["Can I export my data to CSV?", expect.stringContaining("Yes: Settings"), "And to Excel?", "Open the CSV in Excel."]);
  expect(await prisma.ssoIdentity.count({ where: { projectId: project.id } })).toBe(2);
});
