import { prisma } from "@tuti/db";
import { importsSettled, portalAddress, upsertProjectUser } from "@tuti/jobs";
import { FAKE_INTERCOM_TOKEN, FAKE_OPENAI_KEY, type IntercomFake, intercomFixtures, type OpenAIFake, type S3Fake, startIntercomFake, startOpenAIFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

/** Imports from Intercom (docs/plan.md, Import from Intercom): Contacts and the help center, against the Intercom, S3 and OpenAI fakes. */

let fake: IntercomFake;
let s3: S3Fake;
let openai: OpenAIFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [fake, s3, openai] = await Promise.all([startIntercomFake(), startS3Fake(), startOpenAIFake()]);
});
afterAll(() => Promise.all([fake.close(), s3.close(), openai.close()]));
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv("INTERCOM_API_URL", fake.url);
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  // The fake serves its files on this machine.
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  Object.assign(fake, { fixtures: intercomFixtures(), pageSize: 150, requests: [], onRequest: undefined });
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const start = (input: Partial<{ key: string; parts: string[] }> = {}) =>
  call(startImport, asOwner(), { source: "intercom", key: FAKE_INTERCOM_TOKEN, parts: ["contacts"], ...input } as never);
/** Imports, start to end; its view. */
async function run(parts: string[]) {
  await start({ parts });
  await importsSettled();
  return (await call(getImport, asOwner(), {})).import!;
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { status: number; code: string; message: string }) => ({ status: error.status, code: error.code, message: error.message }));
const usersOf = () =>
  prisma.ssoIdentity.findMany({ where: { projectId: project.id }, orderBy: { externalId: "asc" }, select: { externalId: true, email: true, properties: true, user: { select: { name: true, image: true } } } });

test("a token Intercom refuses is refused, nothing started; Intercom has no Feedback to bring", async () => {
  expect(await refusal(start({ key: "not_a_token" }))).toEqual({ status: 400, code: "bad_key", message: "Intercom didn't accept this API key. Check you copied all of it, or make a new one." });
  expect(await refusal(start({ parts: ["contacts", "feedback"] }))).toMatchObject({ status: 400, code: "invalid_input", message: "Intercom has no Feedback to bring" });
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);
});

test("Contacts come across as users, page after page: their app's id or intercom:<id>, details, custom attributes and company; again, nothing twice", async () => {
  fake.pageSize = 2;
  // A company Intercom deleted since (404) is left out, never failing the page.
  fake.fixtures.contacts[2]!.companies = { data: [{ type: "company", id: "c-gone" }] };
  // Someone here already has the lead's address: a lead's address proves nothing, so the lead isn't them.
  const signedIn = await upsertProjectUser(project.id, "signed-in-leo", { name: "Leo", email: "e2e-leo-intercom@example.com" });
  const done = await run(["contacts"]);
  expect(done).toMatchObject({ source: "intercom", state: "done", counts: { contacts: { imported: 3, leftOut: {} } } });
  expect(importSummary(done)).toBe("3 contacts brought across.");
  expect(await usersOf()).toEqual([
    { externalId: "app-user-1", email: "e2e-mira-intercom@example.com", properties: { company: "Initech", plan: "Pro", seats: 12 }, user: { name: "Mira Patel", image: `${fake.url}/files/mira.png` } },
    { externalId: "intercom:6650000000000000000000a2", email: "e2e-leo-intercom@example.com", properties: {}, user: { name: "Leo Lead", image: null } },
    { externalId: "intercom:6650000000000000000000a3", email: "e2e-tobias-intercom@example.com", properties: { team: "Design" }, user: { name: "Tobias Weber", image: null } },
    { externalId: "signed-in-leo", email: "e2e-leo-intercom@example.com", properties: {}, user: { name: "Leo", image: null } },
  ]);
  const lead = await prisma.importedRecord.findMany({ where: { projectId: project.id, kind: "lead" }, select: { externalId: true, localId: true } });
  expect(lead).toEqual([{ externalId: "6650000000000000000000a2", localId: expect.any(String) }]);
  expect(lead[0]!.localId).not.toBe(signedIn);
  // The company read once, by its id; the token at each region's address isn't tried (INTERCOM_API_URL).
  expect(fake.requests.filter((r) => r.startsWith("GET /companies/"))).toEqual(["GET /companies/c-1", "GET /companies/c-gone"]);

  const again = await run(["contacts"]);
  expect(again).toMatchObject({ state: "done", counts: { contacts: { imported: 0, leftOut: { "already brought across earlier": 3 } } } });
  expect(await usersOf()).toHaveLength(4);
});

test("the help center comes across: collections in their tree and order, articles with content, image, links, authors and dates, published, draft or private as they were; again, nothing twice", async () => {
  fake.pageSize = 2;
  const emailed = mailbox.emails.length;
  const done = await run(["docs"]);
  expect(done).toMatchObject({ state: "done", counts: { collections: { imported: 3, leftOut: {} }, articles: { imported: 3, leftOut: {} }, privateDrafts: { imported: 1, leftOut: {} } } });

  const collections = await prisma.collection.findMany({
    where: { projectId: project.id },
    orderBy: [{ parentId: { sort: "asc", nulls: "first" } }, { order: "asc" }],
    select: { name: true, slug: true, description: true, order: true, parent: { select: { name: true } } },
  });
  expect(collections).toEqual([
    { name: "Getting started", slug: "getting-started", description: "Your first steps.", order: 0, parent: null },
    { name: "Billing", slug: "billing", description: "Plans and payments.", order: 1, parent: null },
    { name: "Invoices", slug: "invoices", description: "Finding and paying them.", order: 0, parent: { name: "Billing" } },
  ]);

  const rows = await prisma.article.findMany({
    where: { projectId: project.id },
    select: { title: true, slug: true, description: true, body: true, content: true, publishedAt: true, createdAt: true, collection: { select: { name: true } }, createdById: true },
  });
  const authors = await prisma.user.findMany({ where: { id: { in: rows.flatMap((a) => a.createdById ?? []) } }, select: { id: true, name: true } });
  const articles = rows.map(({ createdById, ...a }) => ({ ...a, createdBy: authors.find((u) => u.id === createdById) && { name: authors.find((u) => u.id === createdById)!.name } }));
  const article = (title: string) => articles.find((a) => a.title === title)!;
  const welcome = article("Welcome to Acme");
  expect(welcome).toMatchObject({
    slug: "welcome-to-acme",
    description: "What Acme does, in a minute.",
    collection: { name: "Getting started" },
    // Intercom's admin, not on the team: a placeholder in their name.
    createdBy: { name: "Ada Admin" },
    createdAt: new Date("2024-03-01T09:00:00.000Z"),
    publishedAt: new Date("2024-03-04T09:00:00.000Z"),
  });
  expect(welcome.body).toContain("Acme keeps every invoice in one place.");
  const json = JSON.stringify(welcome.content);
  // Links to another article and a collection, at intercom.help/<workspace>/en/…, point at their new pages.
  const portal = await portalAddress(project.slug);
  expect(json).toContain(`"href":"${portal}/docs/paying-by-card"`);
  expect(json).toContain(`"href":"${portal}/docs/billing"`);
  // The image is a copy in the project's media.
  expect(json).not.toContain(fake.url);
  expect(await prisma.media.count({ where: { projectId: project.id } })).toBe(1);
  expect(article("Paying by card")).toMatchObject({ collection: { name: "Invoices" }, createdBy: { name: "Ben Builder" }, publishedAt: expect.any(Date) });
  // Intercom's generic picture for an admin without one isn't kept: Tuti draws their initials.
  expect(await prisma.user.findFirstOrThrow({ where: { name: "Ben Builder", placeholderProjectId: project.id }, select: { image: true } })).toEqual({ image: null });
  expect(article("Refunds (coming soon)")).toMatchObject({ slug: "refunds-coming-soon", collection: { name: "Billing" }, publishedAt: null });
  // Only users could read it in Intercom: a draft here.
  expect(article("Enterprise contracts")).toMatchObject({ publishedAt: null });
  expect(mailbox.emails.length).toBe(emailed);

  const again = await run(["docs"]);
  expect(again).toMatchObject({ state: "done", counts: { collections: { imported: 0, leftOut: { "already brought across earlier": 3 } }, articles: { imported: 0, leftOut: { "already brought across earlier": 4 } } } });
  expect(await prisma.article.count({ where: { projectId: project.id } })).toBe(4);
  expect(await prisma.collection.count({ where: { projectId: project.id } })).toBe(3);
});

test("an article edited while the import reads the list (moving to its front, onto a page already read) still comes across, once", async () => {
  fake.pageSize = 2;
  // Each time the list's second page is asked for, the first article on it is edited: Intercom lists it first now,
  // dated a moment before the first page's answer (Intercom stamps its answer after reading the list).
  fake.onRequest = (url) => {
    if (url.pathname === "/articles" && url.searchParams.get("page") === "2") {
      const [edited] = fake.fixtures.articles.splice(2, 1);
      fake.fixtures.articles.unshift({ ...edited, updated_at: fake.clock - 2 });
    }
  };
  const done = await run(["docs"]);
  expect(done).toMatchObject({ state: "done", counts: { articles: { imported: 3, leftOut: {} }, privateDrafts: { imported: 1, leftOut: {} } } });
  const articles = await prisma.article.findMany({ where: { projectId: project.id }, select: { title: true, body: true } });
  expect(articles.map((a) => a.title).sort()).toEqual(["Enterprise contracts", "Paying by card", "Refunds (coming soon)", "Welcome to Acme"]);
  // Every one with its text: none left an empty draft for want of being read.
  expect(articles.every((a) => a.body)).toBe(true);
  expect(await prisma.importedRecord.count({ where: { projectId: project.id, kind: "article", contentLanded: true } })).toBe(4);
});
