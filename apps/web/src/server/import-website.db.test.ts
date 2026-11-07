import { prisma } from "@tuti/db";
import { crawlPace, importJob, IMPORT_KEY, IMPORT_PARTS as STEPS, importsSettled, portalAddress } from "@tuti/jobs";
import { sealValue } from "@tuti/shared/signed";
import { type HelpCenterFake, type S3Fake, startHelpCenterFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** Importing a public help center by its address (docs/plan.md, Import a public help center by URL), against a local static site. */

let site: HelpCenterFake;
let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  [site, s3] = await Promise.all([startHelpCenterFake(), startS3Fake()]);
  crawlPace.ms = 0;
});
afterAll(() => Promise.all([site.close(), s3.close()]));
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  // The site is on this machine.
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  site.requests = [];
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
async function importSite(address = site.url) {
  await call(startImport, asOwner(), { source: "website", key: address, parts: ["docs"] });
  await importsSettled();
  return (await call(getImport, asOwner(), {})).import!;
}
const articles = () =>
  prisma.article.findMany({
    where: { projectId: project.id },
    orderBy: [{ collection: { name: "asc" } }, { order: "asc" }],
    select: { title: true, slug: true, description: true, body: true, content: true, publishedAt: true, collection: { select: { name: true } } },
  });

type Node = { type: string; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[]; content?: Node[]; text?: string };
const nodesOf = (node: Node): Node[] => [node, ...(node.content ?? []).flatMap(nodesOf)];

test("a help center's pages come across as drafts, in collections from its folders, with their images and links; old paths redirect; robots.txt and the site's bounds kept", async () => {
  const done = await importSite();

  expect(done.state).toBe("done");
  expect(importSummary(done)).toBe(
    "2 collections, 5 articles, 4 old addresses redirected brought across. Left out: 1 article gone from your help center (left as empty drafts).",
  );
  // Named as the start page's links name them.
  expect(await prisma.collection.findMany({ where: { projectId: project.id }, orderBy: { order: "asc" }, select: { name: true, slug: true, parentId: true } })).toEqual([
    { name: "Getting started", slug: "getting-started", parentId: null },
    { name: "Billing & plans", slug: "billing", parentId: null },
  ]);
  const all = await articles();
  // Drafts, every one: the team reviews them before they're live. A folder's own page first in it.
  expect(all.map((a) => [a.collection?.name, a.title, a.publishedAt])).toEqual([
    ["Billing & plans", "Plans", null],
    ["Billing & plans", "Refunds", null],
    ["Getting started", "Getting started", null],
    ["Getting started", "Install Acme", null],
    ["Getting started", "Your first project", null],
    // The sitemap's page that redirects to a metadata address: not followed, an empty draft.
    [undefined, "Moved", null],
  ]);
  const install = all.find((a) => a.title === "Install Acme")!;
  // The page's main content only, under its own heading: no navigation, breadcrumbs or footer.
  expect(install).toMatchObject({ slug: "install", body: "Download the app, then make your first project.\nThe installer" });
  const nodes = nodesOf(install.content as Node);
  const image = nodes.find((node) => node.type === "image")!;
  expect(await prisma.media.findUniqueOrThrow({ where: { id: image.attrs!.mediaId as string }, select: { status: true, width: true } })).toEqual({ status: "READY", width: 96 });
  // A relative link to another article goes to its new page.
  const portal = await portalAddress(project.slug);
  expect(nodes.flatMap((node) => node.marks ?? []).find((mark) => mark.type === "link")?.attrs?.href).toBe(`${portal}/docs/first-project`);

  // Old paths redirect to the new pages (one that's the same address already needs none).
  expect(await prisma.portalRedirect.findMany({ where: { projectId: project.id }, orderBy: { from: "asc" }, select: { from: true, to: true } })).toEqual([
    { from: "/docs/billing/plans", to: "/docs/plans" },
    { from: "/docs/billing/refunds", to: "/docs/refunds" },
    { from: "/docs/getting-started/first-project", to: "/docs/first-project" },
    { from: "/docs/getting-started/install", to: "/docs/install" },
  ]);
  // robots.txt's closed folder, and pages outside the address, aren't read.
  expect(site.requests).not.toContain("/docs/private/secret");
  expect(site.requests).not.toContain("/blog/launch");
});

test("importing again brings nothing twice", async () => {
  await importSite();
  const again = await importSite();

  expect(again.state).toBe("done");
  expect(again.counts.articles?.imported ?? 0).toBe(0);
  expect(again.counts.collections?.imported ?? 0).toBe(0);
  expect(importSummary(again)).toContain("Skipped what was already brought across earlier.");
  expect(await prisma.article.count({ where: { projectId: project.id } })).toBe(6);
  expect(await prisma.collection.count({ where: { projectId: project.id } })).toBe(2);
  expect(await prisma.portalRedirect.count({ where: { projectId: project.id } })).toBe(4);
});

test("without a sitemap, the start page's links (and theirs) are followed; a link that's gone isn't an article", async () => {
  const bare = await startHelpCenterFake();
  bare.sitemap = false;
  try {
    expect((await importSite(bare.url)).state).toBe("done");
    expect((await articles()).map((a) => a.title)).toEqual(["Getting started", "Install Acme", "Your first project"]);
  } finally {
    await bare.close();
  }
});

test("a private address is refused when it's entered, and before each fetch", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "");
  const port = new URL(site.origin).port;
  await expect(call(startImport, asOwner(), { source: "website", key: "https://169.254.169.254/latest/meta-data/", parts: ["docs"] })).rejects.toThrow(
    "169.254.169.254 isn't a public address: Tuti only reads help centers anyone can open.",
  );
  await expect(call(startImport, asOwner(), { source: "website", key: `${site.url}`, parts: ["docs"] })).rejects.toThrow("Tuti reads help centers at https:// addresses only.");
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);

  // One whose address is private by the time it runs: refused before anything is asked of it.
  const address = `https://127.0.0.1:${port}/docs`;
  const row = await prisma.dataImport.create({ data: { projectId: project.id, source: "WEBSITE", startedById: owner.id, apiKey: sealValue(IMPORT_KEY, address), parts: ["docs"], step: "docs-collections" } });
  await expect(STEPS.docs.steps[0]!.page(importJob(row)!, null)).rejects.toThrow("127.0.0.1 isn't a public address");
  expect(site.requests).toEqual([]);
});
