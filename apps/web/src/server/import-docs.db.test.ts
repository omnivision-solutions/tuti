import { Prisma, prisma } from "@tuti/db";
import { contentBudget, importJob, IMPORT_KEY, IMPORT_PARTS as STEPS, importsSettled, portalAddress } from "@tuti/jobs";
import { sealValue } from "@tuti/shared/signed";
import { FAKE_FEATUREBASE_KEY, FAKE_OPENAI_KEY, type FeaturebaseFake, featurebaseFixtures, type OpenAIFake, type S3Fake, startFeaturebaseFake, startOpenAIFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { MAX_COLLECTION_DEPTH } from "@/lib/collection-tree";
import { importSummary } from "@/lib/import-parts";
import { deleteArticle, publishArticle, restoreArticle, updateArticle } from "@/server/operations/docs";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** Imports' help center (docs/plan.md, Switching from Featurebase, I4), against the Featurebase, S3 and OpenAI fakes. */

let fake: FeaturebaseFake;
let s3: S3Fake;
let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [fake, s3, openai] = await Promise.all([startFeaturebaseFake(), startS3Fake(), startOpenAIFake()]);
});
afterAll(() => Promise.all([fake.close(), s3.close(), openai.close()]));
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv("FEATUREBASE_API_URL", fake.url);
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  // The fake serves its files on this machine.
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  Object.assign(fake, { fixtures: featurebaseFixtures(fake.url), pageSize: 100, requests: [], onFile: undefined });
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
/** Imports the help center, start to end; its view. */
async function importDocs() {
  await call(startImport, asOwner(), { source: "featurebase", key: FAKE_FEATUREBASE_KEY, parts: ["docs"] });
  await importsSettled();
  return (await call(getImport, asOwner(), {})).import!;
}
const collections = () =>
  prisma.collection.findMany({ where: { projectId: project.id }, orderBy: [{ parentId: { sort: "asc", nulls: "first" } }, { order: "asc" }], select: { name: true, slug: true, description: true, icon: true, order: true, parent: { select: { name: true } } } });
const articles = () =>
  prisma.article.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, slug: true, description: true, body: true, content: true, publishedAt: true, createdAt: true, collection: { select: { name: true } }, createdById: true, changes: { select: { body: true } }, _count: { select: { revisions: true } } },
  });
/** An article, with its author's name. */
const article = async (title: string) => {
  const { createdById, ...found } = (await articles()).find((a) => a.title === title)!;
  return { ...found, createdBy: createdById ? await prisma.user.findUniqueOrThrow({ where: { id: createdById }, select: { name: true } }) : null };
};

type Node = { type: string; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[]; content?: Node[]; text?: string };
/** Every node in a document, depth first. */
const nodesOf = (node: Node): Node[] => [node, ...(node.content ?? []).flatMap(nodesOf)];
const linksIn = (doc: unknown) => nodesOf(doc as Node).flatMap((node) => (node.marks ?? []).filter((mark) => mark.type === "link").map((mark) => ({ text: node.text, href: mark.attrs?.href })));

/** The help center's first pass by hand (collections, then articles made empty), as an import that stopped after it did. */
async function structureOnly() {
  const row = await prisma.dataImport.create({ data: { projectId: project.id, source: "FEATUREBASE", startedById: owner.id, apiKey: sealValue(IMPORT_KEY, FAKE_FEATUREBASE_KEY), parts: ["docs"], step: "docs-collections" } });
  const job = importJob(row)!;
  for (const step of STEPS.docs!.steps.slice(0, 2)) {
    let cursor: string | null = null;
    do {
      const page = await step.page(job, cursor);
      await prisma.$transaction((tx) => page.save(tx));
      cursor = page.next;
    } while (cursor);
  }
  await prisma.dataImport.update({ where: { id: row.id }, data: { state: "FAILED", apiKey: null, finishedAt: new Date() } });
}

test("the help center comes across: collections in their tree and order, articles with their content, media, links, authors and dates, published as they were; nothing emailed", async () => {
  const emailed = mailbox.emails.length;
  const done = await importDocs();

  expect(done).toMatchObject({ state: "done", counts: { collections: { imported: 3, leftOut: {} }, articles: { imported: 3, leftOut: {} }, privateDrafts: { imported: 1, leftOut: {} } } });
  expect(importSummary(done)).toBe("3 collections, 3 articles, 1 article as a draft (only some people could see it) brought across.");
  expect(await collections()).toEqual([
    // An icon with an obvious Lucide one keeps it; one without is left out.
    { name: "Getting started", slug: "getting-started", description: "Your first steps.", icon: "lightbulb", order: 0, parent: null },
    { name: "Billing", slug: "billing", description: "Plans and payments.", icon: null, order: 1, parent: null },
    { name: "Invoices", slug: "invoices", description: "Finding and paying them.", icon: null, order: 0, parent: { name: "Billing" } },
  ]);

  const portal = await portalAddress(project.slug);
  const welcome = await article("Welcome to Acme");
  expect(welcome).toMatchObject({
    slug: "welcome-to-acme",
    description: "What Acme does, in a minute.",
    collection: { name: "Getting started" },
    // Featurebase's admin who isn't on the team: a placeholder in their name.
    createdBy: { name: "Olive Owner" },
    createdAt: new Date("2024-03-01T09:00:00.000Z"),
    publishedAt: new Date("2024-03-02T09:00:00.000Z"),
    _count: { revisions: 1 },
  });
  expect(welcome.body).toContain("Acme keeps every invoice in one place.");
  const nodes = nodesOf(welcome.content as Node);
  expect(nodes.find((node) => node.type === "heading")).toMatchObject({ attrs: { level: 2 }, content: [{ text: "Start here" }] });
  expect(nodes.some((node) => node.marks?.some((mark) => mark.type === "bold"))).toBe(true);
  expect(nodes.filter((node) => node.type === "listItem")).toHaveLength(2);
  // Links to another imported article (later in the order) and to a collection point at their new pages.
  expect(linksIn(welcome.content)).toEqual([
    { text: "Paying by card", href: `${portal}/docs/paying-by-card` },
    { text: "Billing", href: `${portal}/docs/billing` },
  ]);
  // The image and the document are copies in the project's media.
  const image = nodes.find((node) => node.type === "image")!;
  const file = nodes.find((node) => node.type === "file")!;
  const media = await prisma.media.findMany({ where: { projectId: project.id }, orderBy: { filename: { sort: "asc", nulls: "first" } }, select: { id: true, status: true, filename: true, width: true } });
  expect(media).toEqual([
    { id: image.attrs!.mediaId, status: "READY", filename: null, width: 96 },
    { id: file.attrs!.mediaId, status: "READY", filename: "setup-guide.pdf", width: null },
  ]);

  // Published with a draft that differs: the draft is its unpublished changes, a revision each.
  expect(await article("Paying by card")).toMatchObject({
    collection: { name: "Invoices" },
    createdBy: { name: "Fern Former" },
    publishedAt: expect.any(Date),
    body: "Cards are charged on the 1st. See Welcome to Acme.",
    changes: { body: "Cards are charged on the 1st. Amex is coming soon." },
    _count: { revisions: 2 },
  });
  expect(linksIn((await article("Paying by card")).content)).toEqual([{ text: "Welcome to Acme", href: `${portal}/docs/welcome-to-acme` }]);
  // A draft stays one; so does one only some people could see.
  expect(await article("Roadmap notes")).toMatchObject({ publishedAt: null, body: "Not ready yet.", collection: { name: "Getting started" } });
  expect(await article("Single sign-on for Enterprise")).toMatchObject({ publishedAt: null, body: "Only for Enterprise customers.", collection: null, createdBy: null });

  // Indexed for search, the published ones only.
  const chunks = await prisma.articleChunk.groupBy({ by: ["articleId"], where: { projectId: project.id } });
  expect(chunks.map((chunk) => chunk.articleId).sort()).toEqual([welcome.id, (await article("Paying by card")).id].sort());
  expect(mailbox.emails.length).toBe(emailed);
});

test("imported again, nothing comes twice: not a collection, article, revision, copy or search index", async () => {
  await importDocs();
  const [before, embedded] = [{ collections: await collections(), articles: await articles(), media: await prisma.media.count({ where: { projectId: project.id } }) }, openai.inputs.length];

  const again = await importDocs();
  // Said as what it is: nothing new, everything there from before.
  expect(again.counts).toEqual({ collections: { imported: 0, leftOut: { "already brought across earlier": 3 } }, articles: { imported: 0, leftOut: { "already brought across earlier": 4 } } });
  expect(importSummary(again)).toBe("Nothing brought across. Left out: 3 collections already brought across earlier; 4 articles already brought across earlier.");
  expect({ collections: await collections(), articles: await articles(), media: await prisma.media.count({ where: { projectId: project.id } }) }).toEqual(before);
  expect(openai.inputs.length).toBe(embedded);
});

test("an import stopped between the passes leaves every article made, empty, as a draft; started again it fills them in, links later in the order resolving", async () => {
  await structureOnly();
  const empty = await articles();
  expect(empty).toHaveLength(4);
  expect(empty.every((a) => a.content === null && a.publishedAt === null && a._count.revisions === 0)).toBe(true);
  expect(await prisma.importedRecord.findMany({ where: { projectId: project.id, kind: "article" }, select: { contentLanded: true } })).toEqual(Array(4).fill({ contentLanded: false }));

  // A page of content holds one article: the first links to the second, filled later.
  fake.pageSize = 1;
  const done = await importDocs();
  expect(done.state).toBe("done");
  expect(await articles()).toHaveLength(4);
  expect(await collections()).toHaveLength(3);
  expect(linksIn((await article("Welcome to Acme")).content)[0]).toEqual({ text: "Paying by card", href: `${await portalAddress(project.slug)}/docs/paying-by-card` });
  expect((await articles()).filter((a) => a.publishedAt)).toHaveLength(2);
  expect(await prisma.importedRecord.count({ where: { projectId: project.id, kind: "article", contentLanded: true } })).toBe(4);
});

test("an empty article the team wrote and published while the import was stopped stays theirs when it's started again", async () => {
  await structureOnly();
  // A draft's address follows its title.
  const { slug } = await call(updateArticle, asOwner(), { slug: (await article("Paying by card")).slug, title: "Card payments", body: "Our own words." });
  await call(publishArticle, asOwner(), { slug });
  await call(updateArticle, asOwner(), { slug, body: "Our own words, still being written." });

  const done = await importDocs();
  // The team's article is there from before, as theirs.
  expect(done).toMatchObject({ state: "done", counts: { articles: { imported: 2, leftOut: { "already brought across earlier": 1 } }, privateDrafts: { imported: 1 } } });
  expect(await article("Card payments")).toMatchObject({ body: "Our own words.", changes: { body: "Our own words, still being written." }, publishedAt: expect.any(Date) });
  expect(await article("Welcome to Acme")).toMatchObject({ publishedAt: expect.any(Date), body: expect.stringContaining("every invoice") });
});

test("a page of content out of time saves the articles it converted and reads the same page again for the rest, counting each once", async () => {
  const budget = contentBudget.ms;
  contentBudget.ms = -1;
  try {
    const done = await importDocs();
    expect(done).toMatchObject({ state: "done", counts: { articles: { imported: 3 }, privateDrafts: { imported: 1 } } });
  } finally {
    contentBudget.ms = budget;
  }
  // One article converted a page: the list's one page of content read four times.
  expect(fake.requests.filter((r) => r.includes("/help_center/articles?") && r.includes("limit=20"))).toHaveLength(4);
  expect(await prisma.importedRecord.count({ where: { projectId: project.id, kind: "article", contentLanded: true } })).toBe(4);
  expect((await articles()).filter((a) => a.publishedAt)).toHaveLength(2);
});

test("an article's draft is read before its media is copied, so a slow copy can't put that read past the page's time with Featurebase", async () => {
  await structureOnly();
  // First on the page: an article with a draft that differs, and an image.
  const image = `<img src="${fake.url}/files/welcome.png?X-Amz-Signature=x" alt="Card form">`;
  const [, paying] = fake.fixtures.articles;
  paying!.body = `${image}${paying!.body}`;
  fake.fixtures.articleDrafts[0]!.body = `${image}${fake.fixtures.articleDrafts[0]!.body}`;
  fake.fixtures.articles = [paying!];

  const row = await prisma.dataImport.create({ data: { projectId: project.id, source: "FEATUREBASE", startedById: owner.id, apiKey: sealValue(IMPORT_KEY, FAKE_FEATUREBASE_KEY), parts: ["docs"], step: "docs-content" } });
  const job = importJob(row)!;
  // The copy is as slow as can be: once the image is asked for, the clock is an hour on, past the page's read deadline.
  const now = Date.now.bind(Date);
  let copying = false;
  fake.onFile = () => void (copying = true);
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + (copying ? 60 * 60_000 : 0));
  const page = await STEPS.docs!.steps[2]!.page(job, null).finally(() => clock.mockRestore());
  expect(copying).toBe(true);
  await prisma.$transaction((tx) => page.save(tx));
  expect(await article("Paying by card")).toMatchObject({ publishedAt: expect.any(Date), changes: { body: expect.stringContaining("Amex is coming soon.") } });
});

test("an empty article the team only retitled while the import was stopped stays theirs too", async () => {
  await structureOnly();
  const paying = await article("Paying by card");
  await call(updateArticle, asOwner(), { slug: paying.slug, title: "Card payments" });

  const done = await importDocs();
  expect(done.counts.articles).toMatchObject({ leftOut: { "already brought across earlier": 1 } });
  expect(await prisma.article.findUniqueOrThrow({ where: { id: paying.id }, select: { title: true, content: true, publishedAt: true } })).toEqual({ title: "Card payments", content: null, publishedAt: null });
  // Nothing of Featurebase's landed in it: not marked so; told as theirs by its title each time.
  expect(await prisma.importedRecord.findFirstOrThrow({ where: { projectId: project.id, kind: "article", localId: paying.id }, select: { contentLanded: true } })).toEqual({ contentLanded: false });
  expect((await importDocs()).counts.articles).toMatchObject({ leftOut: { "already brought across earlier": 4 } });
  expect(await prisma.article.findUniqueOrThrow({ where: { id: paying.id }, select: { title: true, content: true } })).toEqual({ title: "Card payments", content: null });
});

test("an article renamed in Featurebase between the passes isn't taken for the team's: its content comes in under the new name", async () => {
  await structureOnly();
  const paying = await article("Paying by card");
  fake.fixtures.articles[1]!.title = "Card payments";

  await importDocs();
  expect(await prisma.article.findUniqueOrThrow({ where: { id: paying.id }, select: { title: true, body: true, publishedAt: true } })).toEqual({
    title: "Card payments",
    body: "Cards are charged on the 1st. See Welcome to Acme.",
    publishedAt: expect.any(Date),
  });
  expect(await prisma.importedRecord.findFirstOrThrow({ where: { projectId: project.id, kind: "article", localId: paying.id }, select: { contentLanded: true } })).toEqual({ contentLanded: true });
});

test("an article deleted here before its content came stays deleted; restored, the next import fills it in", async () => {
  await structureOnly();
  const roadmap = await article("Roadmap notes");
  await call(deleteArticle, asOwner(), { slug: roadmap.slug });

  const done = await importDocs();
  expect(done.counts.articles).toMatchObject({ leftOut: { "deleted here since": 1 } });
  expect(await prisma.article.findUniqueOrThrow({ where: { id: roadmap.id }, select: { deletedAt: true, content: true } })).toEqual({ deletedAt: expect.any(Date), content: null });
  expect(await prisma.importedRecord.findFirstOrThrow({ where: { projectId: project.id, kind: "article", localId: roadmap.id }, select: { contentLanded: true } })).toEqual({ contentLanded: false });

  await call(restoreArticle, asOwner(), { slug: roadmap.slug });
  const again = await importDocs();
  expect(again.counts.articles).toEqual({ imported: 1, leftOut: { "already brought across earlier": 3 } });
  expect(await article("Roadmap notes")).toMatchObject({ body: "Not ready yet.", publishedAt: null });
});

test("an article whose content didn't land is filled in by the next import; the others stay as they are", async () => {
  await importDocs();
  const welcome = await article("Welcome to Acme");
  await prisma.articleRevision.deleteMany({ where: { articleId: welcome.id } });
  await prisma.article.update({ where: { id: welcome.id }, data: { content: Prisma.DbNull, body: "", publishedAt: null } });
  await prisma.importedRecord.updateMany({ where: { projectId: project.id, kind: "article", localId: welcome.id }, data: { contentLanded: false } });

  const again = await importDocs();
  expect(again.counts.articles).toEqual({ imported: 1, leftOut: { "already brought across earlier": 3 } });
  expect(await article("Welcome to Acme")).toMatchObject({ publishedAt: new Date("2024-03-02T09:00:00.000Z"), body: expect.stringContaining("every invoice"), _count: { revisions: 1 } });
  expect(await article("Paying by card")).toMatchObject({ _count: { revisions: 2 } });
});

test("collections deeper than five levels fold into their fifth-level ancestor, with what's in them", async () => {
  const levels = MAX_COLLECTION_DEPTH + 2;
  fake.fixtures.collections = Array.from({ length: levels }, (_, n) => ({ id: `09000${n}`, parentId: n === 0 ? null : `09000${n - 1}`, name: `Level ${n + 1}`, slug: `09000${n}-level-${n + 1}`, order: 0 })).reverse();
  fake.fixtures.articles = [
    { id: "0300001", parentId: `09000${levels - 1}`, title: "At the bottom", slug: "0300001-at-the-bottom", state: "live", isPublished: true, visibleBy: ["everyone"], body: "<p>Deep.</p>" },
    { id: "0300002", parentId: `09000${MAX_COLLECTION_DEPTH - 1}`, title: "At the fifth", slug: "0300002-at-the-fifth", state: "live", isPublished: true, visibleBy: ["everyone"], body: "<p>Fifth.</p>" },
  ];

  const done = await importDocs();
  expect(done.counts.collections).toEqual({ imported: MAX_COLLECTION_DEPTH, leftOut: { "more than five levels deep (what was in them is in the fifth level)": 2 } });
  expect((await collections()).map((c) => [c.name, c.parent?.name ?? null])).toEqual(
    expect.arrayContaining(Array.from({ length: MAX_COLLECTION_DEPTH }, (_, n) => [`Level ${n + 1}`, n === 0 ? null : `Level ${n}`])),
  );
  expect(await collections()).toHaveLength(MAX_COLLECTION_DEPTH);
  expect((await articles()).map((a) => [a.title, a.collection?.name])).toEqual([
    ["At the bottom", `Level ${MAX_COLLECTION_DEPTH}`],
    ["At the fifth", `Level ${MAX_COLLECTION_DEPTH}`],
  ]);
});

test("addresses: Featurebase's (without its id) where they're free, the next free one where a page has it", async () => {
  await prisma.collection.create({ data: { projectId: project.id, slug: "getting-started", name: "Getting started" } });
  await prisma.article.create({ data: { projectId: project.id, slug: "welcome-to-acme", title: "Ours" } });
  // Featurebase's address for it isn't its title's.
  fake.fixtures.articles[1]!.slug = "0200002-card-payments";

  await importDocs();
  expect((await collections()).map((c) => c.slug)).toEqual(["getting-started", "getting-started-2", "billing", "invoices"]);
  expect((await articles()).map((a) => a.slug).sort()).toEqual(["card-payments", "roadmap-notes", "single-sign-on-for-enterprise", "welcome-to-acme", "welcome-to-acme-2"]);
  expect((await article("Welcome to Acme")).slug).toBe("welcome-to-acme-2");
  expect(linksIn((await article("Welcome to Acme")).content)[0]!.href).toBe(`${await portalAddress(project.slug)}/docs/card-payments`);
});

test("past the plan's article limit, articles come in as drafts, counted", async () => {
  vi.stubEnv("PLANS", "on");
  vi.stubEnv("ARTICLE_LIMIT_FREE", "1");

  const done = await importDocs();
  expect(done.counts).toMatchObject({ articles: { imported: 2 }, limitDrafts: { imported: 1 }, privateDrafts: { imported: 1 } });
  expect(importSummary(done)).toContain("1 article as a draft (past the plan's article limit)");
  expect((await articles()).filter((a) => a.publishedAt).map((a) => a.title)).toEqual(["Welcome to Acme"]);
  // Kept as a draft, it has the newest text: its draft's.
  expect(await article("Paying by card")).toMatchObject({ publishedAt: null, body: "Cards are charged on the 1st. Amex is coming soon.", changes: null });
});

test("an article longer than Tuti's 50,000 characters comes in as an empty draft under its title, counted, as an article that long can't be saved", async () => {
  fake.fixtures.articles[0]!.body = `<p>${"Long words. ".repeat(4_200)}</p>`;

  const done = await importDocs();
  expect(done.counts.articles).toEqual({ imported: 2, leftOut: { "longer than 50,000 characters, Tuti's most (they're empty drafts)": 1 } });
  expect(importSummary(done)).toContain("Left out: 1 article longer than 50,000 characters, Tuti's most (they're empty drafts).");
  expect(await article("Welcome to Acme")).toMatchObject({ content: null, body: "", publishedAt: null, _count: { revisions: 0 } });
  // The others link to it all the same.
  expect(linksIn((await article("Paying by card")).content)).toEqual([{ text: "Welcome to Acme", href: `${await portalAddress(project.slug)}/docs/welcome-to-acme` }]);
});

test("unpublished changes longer than Tuti's 50,000 characters don't come, counted; the published version does", async () => {
  fake.fixtures.articleDrafts[0]!.body = `<p>${"Long words. ".repeat(4_200)}</p>`;

  const done = await importDocs();
  expect(done.counts.unpublishedChanges).toEqual({ imported: 0, leftOut: { "longer than 50,000 characters, Tuti's most (the published version came in)": 1 } });
  expect(importSummary(done)).toContain("1 article's unpublished changes longer than 50,000 characters, Tuti's most (the published version came in)");
  expect(await article("Paying by card")).toMatchObject({ body: "Cards are charged on the 1st. See Welcome to Acme.", changes: null });
});

test("without media storage, images and files are left out and counted, the article still coming across", async () => {
  for (const name of Object.keys(s3.env)) {
    vi.stubEnv(name, "");
  }
  const done = await importDocs();
  expect(done.counts).toMatchObject({ images: { imported: 0, leftOut: { "with nowhere to keep them": 1 } }, files: { imported: 0, leftOut: { "with nowhere to keep them": 1 } } });
  expect(importSummary(done)).toContain("Left out: 1 image with nowhere to keep them; 1 file with nowhere to keep them.");
  expect((await article("Welcome to Acme")).body).toContain("The dashboard");
});
