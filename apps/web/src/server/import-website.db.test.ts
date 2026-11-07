import { prisma } from "@tuti/db";
import { crawlBudget, crawlPace, importJob, IMPORT_KEY, IMPORT_PARTS as STEPS, importsSettled, importStep, portalAddress } from "@tuti/jobs";
import { sealValue } from "@tuti/shared/signed";
import { type HelpCenterFake, type S3Fake, startHelpCenterFake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { importSummary } from "@/lib/import-parts";
import { getImport, startImport } from "@/server/operations/imports";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

// The machine's resolver is never asked: one name that doesn't exist, the rest as they are (these tests' addresses are IPs).
vi.mock("node:dns/promises", async (original) => {
  const dns = await original<typeof import("node:dns/promises")>();
  return {
    ...dns,
    lookup: (async (host: string, options: object) => {
      if (host === "help.invalid") {
        throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      }
      return dns.lookup(host, options as never);
    }) as typeof dns.lookup,
  };
});

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
afterEach(() => {
  vi.unstubAllEnvs();
  crawlBudget.fetches = Infinity;
});
beforeEach(async () => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  // The site is on this machine.
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  site.requests = [];
  site.failing.clear();
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
    "2 collections, 5 articles, 4 old addresses redirected brought across. Left out: 1 article gone from your help center (left as empty drafts); 1 old address taken by the portal's own pages (not redirected).",
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
  // Content straight in <main> is the page's, not a related article beside it.
  expect(all.find((a) => a.title === "Plans")!.body).toBe("Free and Pro. See refunds.");
  const install = all.find((a) => a.title === "Install Acme")!;
  // The page's main content only, under its own heading: no navigation, breadcrumbs, table of contents or footer.
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

test("old paths never take a redirect the portal has, nor one past its 200", async () => {
  // A rule of the team's for one of the old paths, and 198 others: room for one more.
  await prisma.portalRedirect.createMany({
    data: [{ from: "/docs/billing/plans", to: "/docs" }, ...Array.from({ length: 198 }, (_, i) => ({ from: `/old/${i}`, to: "/docs" }))].map((rule) => ({ ...rule, projectId: project.id })),
  });
  const done = await importSite();

  expect(done.counts.oldAddresses).toEqual({ imported: 1, leftOut: {} });
  expect(done.counts.notRedirected?.leftOut).toEqual({
    "taken by the portal's own pages (not redirected)": 1,
    "already part of another redirect (not redirected)": 1,
    "past the portal's 200 redirects (not redirected)": 2,
  });
  expect(await prisma.portalRedirect.findUniqueOrThrow({ where: { projectId_from: { projectId: project.id, from: "/docs/billing/plans" } }, select: { to: true } })).toEqual({ to: "/docs" });
  expect(await prisma.portalRedirect.count({ where: { projectId: project.id } })).toBe(200);
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

/** An import by address, made by hand at its first step (as one started, before its first page ran); its row. */
const runningImport = (address: string, sourceState?: object) =>
  prisma.dataImport.create({
    data: { projectId: project.id, source: "WEBSITE", startedById: owner.id, apiKey: sealValue(IMPORT_KEY, address), parts: ["docs"], step: "docs-collections", sourceState },
  });
const log = { info: () => {}, warn: () => {} };

test("the list of pages is found once and kept on the import: every later step pages through it, not a list found again", async () => {
  // As kept by the import's first step: one page, not the sitemap's five.
  const install = `${site.origin}/docs/getting-started/install`;
  const folder = `${site.origin}/docs/getting-started`;
  const row = await runningImport(site.url, { list: { pages: [{ id: install, collection: folder }], collections: [{ id: folder, parent: null, name: "Getting started" }] } });
  for (let step = 0; step < 8 && (await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).state === "RUNNING"; step++) {
    await importStep({ importId: row.id }, log);
  }

  expect((await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).state).toBe("DONE");
  expect((await articles()).map((a) => a.title)).toEqual(["Install Acme"]);
  expect(site.requests).not.toContain("/sitemap.xml");
});

test("an import's first step keeps the list it found for the steps after it", async () => {
  const row = await runningImport(site.url);
  await importStep({ importId: row.id }, log);
  const kept = (await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).sourceState as { list: { pages: { id: string }[] } };
  expect(kept.list.pages.map((page) => new URL(page.id).pathname)).toEqual([
    "/docs/getting-started",
    "/docs/getting-started/install",
    "/docs/getting-started/first-project",
    "/docs/billing/plans",
    "/docs/billing/refunds",
    "/docs/moved",
  ]);
});

test("a robots.txt the site can't answer for means nothing is read: the start is refused, and nothing else asked for", async () => {
  site.failing.set("/robots.txt", 500);
  await expect(call(startImport, asOwner(), { source: "website", key: site.url, parts: ["docs"] })).rejects.toThrow("127.0.0.1's robots.txt couldn't be read, so Tuti doesn't read the site yet.");
  expect(site.requests).toEqual(["/robots.txt"]);
  expect(await prisma.dataImport.count({ where: { projectId: project.id } })).toBe(0);
});

test("a sitemap that fails while the import runs fails it, saying why, rather than bringing a short list across", async () => {
  const row = await runningImport(site.url);
  site.failing.set("/sitemap.xml", 500);
  await importStep({ importId: row.id }, log);

  expect(await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id }, select: { state: true, error: true } })).toMatchObject({ state: "FAILED", error: expect.stringMatching(/^127\.0\.0\.1 answered 500\. /) });
  expect(await prisma.article.count({ where: { projectId: project.id } })).toBe(0);
});

test("a link crawl the step had no time to finish goes on in the next step from where it got to, not from the start", async () => {
  const bare = await startHelpCenterFake();
  bare.sitemap = false;
  try {
    const at = (path: string) => `${bare.origin}${path}`;
    // As kept by a step that ran out of time after fetching the start page's first link.
    const row = await runningImport(bare.url, { crawl: { found: [at("/docs/getting-started"), at("/docs/billing"), at("/docs/getting-started/install")], fetched: 1, gone: [] } });
    // The first step's page alone (the next steps would read the pages for their content).
    const page = await STEPS.docs.steps[0]!.page(importJob(row)!, null);
    await prisma.$transaction((tx) => page.save(tx));

    expect(bare.requests).not.toContain("/docs/getting-started");
    expect(bare.requests).toEqual(expect.arrayContaining(["/docs/billing", "/docs/getting-started/install"]));
    const kept = (await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).sourceState as { list: { pages: { id: string }[] } };
    expect(kept.list.pages.map((page) => new URL(page.id).pathname)).toEqual(["/docs/getting-started", "/docs/getting-started/install", "/docs/getting-started/first-project"]);
  } finally {
    await bare.close();
  }
});

test("a robots.txt that answers with a 4xx (a 403, say) is none: everything may be read", async () => {
  site.failing.clear();
  const forbidden = await startHelpCenterFake();
  forbidden.forbidRobots = true;
  try {
    expect((await importSite(forbidden.url)).state).toBe("done");
    expect(await prisma.article.count({ where: { projectId: project.id } })).toBeGreaterThan(0);
    expect(forbidden.requests).toContain("/docs/private/secret");
  } finally {
    await forbidden.close();
  }
});

test("a link crawl cut short keeps where it got to and goes on in the next page of the step, each link fetched once", async () => {
  const bare = await startHelpCenterFake();
  bare.sitemap = false;
  try {
    crawlBudget.fetches = 1;
    let row = await runningImport(bare.url);
    const step = STEPS.docs.steps[0]!;
    const first = await step.page(importJob(row)!, null);
    expect(first.next).toBe("find:1");
    await prisma.$transaction((tx) => first.save(tx));
    row = await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } });
    expect(row.sourceState).toMatchObject({ crawl: { fetched: 1 } });

    crawlBudget.fetches = Infinity;
    const rest = await step.page(importJob(row)!, first.next);
    expect(rest.next).toBeNull();
    expect(bare.requests.filter((path) => path === "/docs/getting-started")).toHaveLength(1);
  } finally {
    await bare.close();
  }
});

test("a link crawl's page the site can't answer for fails the step, rather than counting the page gone", async () => {
  const bare = await startHelpCenterFake();
  bare.sitemap = false;
  bare.failing.set("/docs/getting-started", 500);
  try {
    const row = await runningImport(bare.url);
    await expect(STEPS.docs.steps[0]!.page(importJob(row)!, null)).rejects.toThrow("answered 500");
  } finally {
    await bare.close();
  }
});

test("an address whose name doesn't exist is a mistake in it, said so, not something to try again", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "");
  await expect(call(startImport, asOwner(), { source: "website", key: "https://help.invalid/docs", parts: ["docs"] })).rejects.toMatchObject({
    status: 400,
    code: "bad_address",
    message: "Tuti couldn't find help.invalid. Check the address.",
  });
});

test("the site's own 422 is an answer to try again, not Tuti's refusal of the address", async () => {
  site.failing.set("/docs", 422);
  await expect(call(startImport, asOwner(), { source: "website", key: site.url, parts: ["docs"] })).rejects.toMatchObject({
    status: 502,
    code: "unavailable",
    message: "127.0.0.1 answered 422. Try again in a moment.",
  });
});

test("a page whose address has a malformed escape comes across, titled from it as it is", async () => {
  const at = (path: string) => `${site.origin}${path}`;
  const odd = at("/docs/getting-started/100%-uptime");
  const row = await runningImport(site.url, { list: { pages: [{ id: odd, collection: at("/docs/getting-started") }], collections: [{ id: at("/docs/getting-started"), parent: null, name: "Getting started" }] } });
  for (let step = 0; step < 8 && (await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).state === "RUNNING"; step++) {
    await importStep({ importId: row.id }, log);
  }
  expect((await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).state).toBe("DONE");
  // Gone from the site (the fake has no such page): an empty draft under its address's title.
  expect((await articles()).map((a) => a.title)).toEqual(["100% uptime"]);
});

test("a guessed /sitemap.xml that answers 403 (as a bucket behind a CDN does for what it hasn't) is none: the links are read", async () => {
  const bare = await startHelpCenterFake();
  bare.sitemap = false;
  bare.failing.set("/sitemap.xml", 403);
  try {
    expect((await importSite(bare.url)).state).toBe("done");
    expect((await articles()).map((a) => a.title)).toEqual(["Getting started", "Install Acme", "Your first project"]);
  } finally {
    await bare.close();
  }
});

test("a guessed /sitemap.xml the site can't answer for (a 503) fails the step, rather than the links standing in for it", async () => {
  const bare = await startHelpCenterFake();
  bare.sitemap = false;
  bare.failing.set("/sitemap.xml", 503);
  try {
    const row = await runningImport(bare.url);
    await expect(STEPS.docs.steps[0]!.page(importJob(row)!, null)).rejects.toThrow("answered 503");
  } finally {
    await bare.close();
  }
});

test("a page with no content container and no heading of its own is titled by its <title>, not the site banner's heading", async () => {
  const at = (path: string) => `${site.origin}${path}`;
  const row = await runningImport(site.url, { list: { pages: [{ id: at("/docs/status"), collection: at("/docs") }], collections: [{ id: at("/docs"), parent: null, name: "Help" }] } });
  for (let step = 0; step < 8 && (await prisma.dataImport.findUniqueOrThrow({ where: { id: row.id } })).state === "RUNNING"; step++) {
    await importStep({ importId: row.id }, log);
  }
  expect((await articles()).map((a) => [a.title, a.body])).toEqual([["Status | Acme Help", "All systems go."]]);
});
