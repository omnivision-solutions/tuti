import { prisma } from "@tuti/db";
import { expect, onTestFinished, test, vi } from "vitest";

import { isArticleSlug } from "@/server/docs-queries";
import { actAs, createProject, signUp } from "@/test/helpers";

import { GET as entryMarkdown } from "./changelog/[number]/md/route";
import { generateMetadata as entryMetadata } from "./changelog/[number]/page";
import { GET as markdown } from "./docs/[slug]/md/route";
import { GET as postMarkdown } from "./feedback/[board]/[post]/md/route";
import { generateMetadata as postMetadata } from "./feedback/[board]/[post]/page";
import { GET as llmsFull } from "./llms-full.txt/route";
import { generateMetadata } from "./docs/[slug]/page";
import { GET as llms } from "./llms.txt/route";
import { GET as robots } from "./robots.txt/route";
import { GET as sitemap } from "./sitemap.xml/route";

/** Serving the portal to search engines and AI tools: /docs/<slug>.md, /changelog/<number>.md, <a post's path>.md, /llms.txt, /llms-full.txt, /sitemap.xml and /robots.txt. */

const request = new Request("http://x");
const doc = (...content: object[]) => ({ type: "doc", content });
const text = (value: string, marks?: object[]) => ({ type: "text", text: value, ...(marks && { marks }) });

async function docsContents() {
  const owner = await signUp();
  const project = await createProject(owner);
  const projectId = project.id;
  const collection = await prisma.collection.create({
    data: { projectId, slug: "getting-started", name: "Getting started", description: "The basics." },
  });
  const article = (slug: string, title: string, publishedAt: Date | null, extra: object = {}) =>
    prisma.article.create({ data: { projectId, slug, title, publishedAt, ...extra } });
  await article("inviting-your-team", "Inviting *your* team", new Date("2026-03-01T10:00:00Z"), {
    collectionId: collection.id,
    content: doc(
      { type: "heading", attrs: { level: 2 }, content: [text("Who can invite")] },
      { type: "paragraph", content: [text("Owners and "), text("admins", [{ type: "bold" }]), text(".")] },
    ),
    updatedAt: new Date("2026-03-02T10:00:00Z"),
  });
  await article("billing", "Billing", new Date("2026-03-01T10:00:00Z"), { body: "Plans and invoices." });
  await article("secret-draft", "Secret draft", null);
  return project;
}

test("a published article is served as Markdown at its .md URL; drafts, missing articles and other projects' aren't", async () => {
  const project = await docsContents();
  const other = await createProject(await signUp());
  const get = (projectSlug: string, slug: string) => markdown(request, { params: Promise.resolve({ project: projectSlug, slug }) });

  const response = await get(project.slug, "inviting-your-team");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(response.headers.get("link")).toBe(`<http://${project.slug}.localhost:3100/docs/inviting-your-team>; rel="canonical"`);
  expect(await response.text()).toBe("# Inviting \\*your\\* team\n\n## Who can invite\n\nOwners and **admins**.\n");
  // Articles from before rich text are their plain text.
  expect(await (await get(project.slug, "billing")).text()).toBe("# Billing\n\nPlans and invoices.\n");

  expect((await get(project.slug, "secret-draft")).status).toBe(404);
  expect((await get(project.slug, "no-such-article")).status).toBe(404);
  expect((await get(other.slug, "inviting-your-team")).status).toBe(404);
});

test("an article's page links its Markdown for AI tools; a collection's or tab's page has none", async () => {
  const project = await docsContents();
  await prisma.docsTab.create({ data: { projectId: project.id, slug: "guides", name: "Guides" } });
  const alternates = async (slug: string) =>
    (await generateMetadata({ params: Promise.resolve({ project: project.slug, slug }) } as never)).alternates;
  expect(await alternates("billing")).toEqual({
    canonical: `http://${project.slug}.localhost:3100/docs/billing`,
    types: { "text/markdown": `http://${project.slug}.localhost:3100/docs/billing.md` },
  });
  expect((await alternates("getting-started"))?.types).toBeUndefined();
  expect((await alternates("guides"))?.types).toBeUndefined();

  // So only an article's address (or an old one of it) is sent to its Markdown when an AI agent asks for that.
  await prisma.docsRedirect.create({ data: { projectId: project.id, slug: "old-billing", articleId: (await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "billing" } })).id } });
  const collection = await prisma.collection.findFirstOrThrow({ where: { projectId: project.id } });
  await prisma.docsRedirect.create({ data: { projectId: project.id, slug: "old-basics", collectionId: collection.id } });
  const articles = await Promise.all(["billing", "old-billing", "old-basics", "getting-started", "guides", "secret-draft", "nothing"].map((slug) => isArticleSlug(project.slug, slug)));
  expect(articles).toEqual([true, true, false, false, false, false, false]);
  expect(await isArticleSlug((await createProject(await signUp())).slug, "billing")).toBe(false);
});

test("a public post is served as Markdown at its .md URL: what its page shows a signed-out visitor, comments in order", async () => {
  // Mid-June 2026: an ETA shows from its month on (etaOnPortal), so June is shown and May isn't.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  onTestFinished(() => void vi.useRealTimers());
  const owner = await signUp("Owner");
  const reader = await signUp("Sam *Reader*");
  const project = await createProject(owner);
  const portal = `http://${project.slug}.localhost:3100`;
  const board = project.boards[0]!;
  const post = (number: number, title: string, extra: object = {}) =>
    prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: reader.id, number, title, createdAt: new Date("2026-03-01T10:00:00Z"), ...extra } });
  const dark = await post(1, "Dark mode", { body: "Easier on the eyes.", status: "PLANNED", voteCount: 3, eta: new Date(Date.UTC(2026, 5)) });
  // The changelog entry it shipped in, once published.
  const shipped = (number: number, title: string, publishedAt: Date | null) =>
    prisma.changelogEntry.create({ data: { projectId: project.id, number, title, publishedAt, posts: { create: { postId: dark.id } } } });
  await shipped(1, "Night owls rejoice", new Date("2026-03-05T10:00:00Z"));
  await shipped(2, "Unpublished draft", null);
  const comment = (authorId: string, body: string, at: string, extra: object = {}) =>
    prisma.comment.create({ data: { projectId: project.id, postId: dark.id, authorId, body, createdAt: new Date(at), ...extra } });
  await comment(owner.id, "On our list.", "2026-03-03T10:00:00Z");
  const first = await comment(reader.id, "Me too!", "2026-03-02T10:00:00Z");
  // A reply, later than the next comment: under the comment it answers.
  await comment(owner.id, "Thanks!", "2026-03-05T10:00:00Z", { parentId: first.id });
  await comment(owner.id, "From my reader account.", "2026-03-04T10:00:00Z", { asReader: true });
  await prisma.postNote.create({ data: { postId: dark.id, authorId: owner.id, body: "Internal: big customer asked" } });
  const get = (slug: string, param: string, boardSlug = "feature-requests") =>
    postMarkdown(request, { params: Promise.resolve({ project: slug, board: boardSlug, post: param }) });

  const response = await get(project.slug, "dark-mode-1");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("private, max-age=300");
  expect(response.headers.get("link")).toBe(`<${portal}/feedback/feature-requests/dark-mode-1>; rel="canonical"`);
  expect(response.headers.get("x-robots-tag")).toBeNull();
  expect(await response.text()).toBe(
    [
      "# Dark mode",
      "Status: Planned · Expected June 2026 · 3 votes · Board: Feature requests",
      "Shipped in Night owls rejoice",
      "Posted by Sam \\*Reader\\* on 1 March 2026",
      "Easier on the eyes.",
      "## 4 comments",
      "### Reader: Sam \\*Reader\\* · 2 March 2026",
      "Me too!",
      "#### Reply · Team: Owner · 5 March 2026",
      "Thanks!",
      "### Team: Owner · 3 March 2026",
      "On our list.",
      "### Reader: Owner · 4 March 2026",
      "From my reader account.",
    ].join("\n\n") + "\n",
  );
  // Nor add lines of their own with a newline in a title or name.
  const forger = await signUp("Sam\n\nShipped in v2.0");
  await prisma.post.create({
    data: { projectId: project.id, boardId: board.id, authorId: forger.id, number: 7, title: "Dark mode\n\nStatus: Completed", createdAt: new Date("2026-03-01T10:00:00Z") },
  });
  expect((await (await get(project.slug, "dark-mode-status-completed-7")).text()).split("\n\n").slice(0, 3)).toEqual([
    "# Dark mode Status: Completed",
    "Status: Open · 0 votes · Board: Feature requests",
    "Posted by Sam Shipped in v2.0 on 1 March 2026",
  ]);
  // A reader can't pass for the team by their name.
  await comment((await signUp("Acme (Team)")).id, "This ships next week.", "2026-03-06T10:00:00Z");
  expect(await (await get(project.slug, "dark-mode-1")).text()).toContain("### Reader: Acme (Team) · 6 March 2026");

  // Not a post a signed-out visitor can't see: private, team only, on a board that's off, or another project's.
  await post(2, "Private one", { visibility: "PRIVATE" });
  await post(3, "Team one", { visibility: "TEAM" });
  expect((await get(project.slug, "private-one-2")).status).toBe(404);
  expect((await get(project.slug, "team-one-3")).status).toBe(404);
  expect((await get((await createProject(await signUp())).slug, "dark-mode-1")).status).toBe(404);
  expect((await get(project.slug, "no-such-post")).status).toBe(404);
  // Its page links it for AI tools; a private post's page (for its author) doesn't.
  const alternates = async (param: string) => {
    actAs(reader);
    return (await postMetadata({ params: Promise.resolve({ project: project.slug, board: "feature-requests", post: param }) } as never)).alternates;
  };
  expect((await alternates("dark-mode-1"))?.types).toEqual({ "text/markdown": `${portal}/feedback/feature-requests/dark-mode-1.md` });
  expect((await alternates("private-one-2"))?.types).toBeUndefined();
  actAs(null);

  // Retitled or moved: to its current .md. Merged: to the post it's in now, unless that one's hidden.
  const moved = await get(project.slug, "old-title-1", "elsewhere");
  expect([moved.status, moved.headers.get("location"), moved.headers.get("cache-control")]).toEqual([308, "/feedback/feature-requests/dark-mode-1.md", "private, no-store"]);
  await post(4, "Night theme", { duplicateOfId: dark.id });
  expect((await get(project.slug, "night-theme-4")).headers.get("location")).toBe("/feedback/feature-requests/dark-mode-1.md");
  await post(5, "Into a private one", { duplicateOfId: (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: 2 } })).id });
  expect((await get(project.slug, "into-a-private-one-5")).status).toBe(404);

  // Sample content: kept from search engines.
  await post(6, "A sample", { sample: true });
  expect((await get(project.slug, "a-sample-6")).headers.get("x-robots-tag")).toBe("noindex");

  // When it's expected, only while that's still to come (as on the page).
  await prisma.post.update({ where: { id: dark.id }, data: { status: "COMPLETED" } });
  expect(await (await get(project.slug, "dark-mode-1")).text()).toContain("Status: Completed · 3 votes · Board");
  await prisma.post.update({ where: { id: dark.id }, data: { status: "PLANNED", eta: new Date(Date.UTC(2026, 4)) } });
  expect(await (await get(project.slug, "dark-mode-1")).text()).toContain("Status: Planned · 3 votes · Board");
  await prisma.post.update({ where: { id: dark.id }, data: { eta: new Date(Date.UTC(2026, 5)) } });

  // A Team only board isn't named; a board that's off hides its posts.
  await prisma.board.update({ where: { id: board.id }, data: { postVisibility: "TEAM" } });
  expect(await (await get(project.slug, "dark-mode-1")).text()).toContain("Status: Planned · Expected June 2026 · 3 votes\n");
  await prisma.board.update({ where: { id: board.id }, data: { off: true } });
  expect((await get(project.slug, "dark-mode-1")).status).toBe(404);
});

test("a published changelog entry is served as Markdown at its .md URL, with its page linking it; drafts, missing entries and other projects' aren't", async () => {
  const project = await createProject(await signUp());
  const other = await createProject(await signUp());
  const entry = (projectId: string, number: number, title: string, publishedAt: Date | null, extra: object = {}) =>
    prisma.changelogEntry.create({ data: { projectId, number, title, publishedAt, ...extra } });
  await entry(project.id, 1, "Dark *mode*", new Date("2026-05-01T10:00:00Z"), {
    content: doc({ type: "paragraph", content: [text("Easy on the "), text("eyes", [{ type: "bold" }]), text(".")] }),
  });
  await entry(project.id, 2, "Plain", new Date("2026-05-02T10:00:00Z"), { body: "Before rich text." });
  await entry(project.id, 3, "A sample", new Date("2026-05-03T10:00:00Z"), { sample: true });
  await entry(project.id, 4, "Draft", null);
  await entry(other.id, 5, "Elsewhere", new Date());
  const get = (projectSlug: string, number: string) => entryMarkdown(request, { params: Promise.resolve({ project: projectSlug, number }) });

  const response = await get(project.slug, "1");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(response.headers.get("link")).toBe(`<http://${project.slug}.localhost:3100/changelog/1>; rel="canonical"`);
  expect(response.headers.get("x-robots-tag")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  expect(await response.text()).toBe("# Dark \\*mode\\*\n\n1 May 2026\n\nEasy on the **eyes**.\n");
  expect(await (await get(project.slug, "2")).text()).toBe("# Plain\n\n2 May 2026\n\nBefore rich text.\n");
  expect((await get(project.slug, "3")).headers.get("x-robots-tag")).toBe("noindex");

  for (const number of ["4", "6", "5", "0", "1x", "99999999999"]) {
    expect((await get(project.slug, number)).status, number).toBe(404);
  }
  expect((await get(other.slug, "1")).status).toBe(404);

  const alternates = async (number: string) => (await entryMetadata({ params: Promise.resolve({ project: project.slug, number }) } as never)).alternates;
  expect(await alternates("1")).toEqual({
    canonical: `http://${project.slug}.localhost:3100/changelog/1`,
    types: { "text/markdown": `http://${project.slug}.localhost:3100/changelog/1.md` },
  });
  expect(await alternates("4")).toBeUndefined();
});

test("llms.txt links the newest 50 published changelog entries' Markdown under the changelog, newest first, without drafts or sample content", async () => {
  const project = await createProject(await signUp());
  const portal = `http://${project.slug}.localhost:3100`;
  await prisma.changelogEntry.createMany({
    data: [
      ...Array.from({ length: 51 }, (_, i) => ({ projectId: project.id, number: i + 1, title: `Entry ${i + 1}`, publishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)) })),
      { projectId: project.id, number: 52, title: "Draft", publishedAt: null },
      { projectId: project.id, number: 53, title: "A sample", publishedAt: new Date(Date.UTC(2026, 5, 1)), sample: true },
    ],
  });
  const body = await (await llms(request, { params: Promise.resolve({ project: project.slug }) })).text();
  const changelog = body.slice(body.indexOf("## Changelog"), body.indexOf("## Feedback")).trim().split("\n").slice(2);
  expect(changelog).toHaveLength(51);
  expect(changelog[0]).toBe(`- [Changelog](${portal}/changelog): What's new, improved and fixed in Project ${project.slug}`);
  expect(changelog[1]).toBe(`- [Entry 51](${portal}/changelog/51.md): 1 January 2026`);
  expect(changelog[50]).toBe(`- [Entry 2](${portal}/changelog/2.md): 1 January 2026`);
});

test("llms.txt describes the portal and links each collection's page, each published article's Markdown, the changelog and the boards", async () => {
  const project = await docsContents();
  const portal = `http://${project.slug}.localhost:3100`;
  const response = await llms(request, { params: Promise.resolve({ project: project.slug }) });
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await response.text()).toBe(
    [
      `# Project ${project.slug}`,
      `> Docs, changelog and feedback for Project ${project.slug}.`,
      `Every docs article's full text: [llms-full.txt](${portal}/llms-full.txt)`,
      `## [Getting started](${portal}/docs/getting-started)`,
      "The basics.",
      `- [Inviting \\*your\\* team](${portal}/docs/inviting-your-team.md)`,
      "## More articles",
      `- [Billing](${portal}/docs/billing.md)`,
      "## Changelog",
      `- [Changelog](${portal}/changelog): What's new, improved and fixed in Project ${project.slug}`,
      "## Feedback",
      `- [Feature requests](${portal}/feedback/feature-requests)\n- [Roadmap](${portal}/roadmap): What's planned, being built and done`,
    ].join("\n\n") + "\n",
  );
  expect((await llms(request, { params: Promise.resolve({ project: "no-such-project" }) })).status).toBe(404);
});

test("llms-full.txt has the full text of every article llms.txt links, each with where it's from", async () => {
  const project = await docsContents();
  const portal = `http://${project.slug}.localhost:3100`;
  const left = (slug: string, extra: object) =>
    prisma.article.create({ data: { projectId: project.id, slug, title: slug, body: "Not for AI tools.", publishedAt: new Date(), ...extra } });
  await left("noindexed", { noindex: true });
  await left("unlisted", { listing: "UNLISTED" });
  await left("for-members", { access: "SIGNED_IN" });
  await left("a-sample", { sample: true });
  // In a collection in another: after its parent's articles. In a collection for signed-in readers: left out, though it's for everyone.
  const parent = await prisma.collection.findFirstOrThrow({ where: { projectId: project.id, slug: "getting-started" } });
  const nested = await prisma.collection.create({ data: { projectId: project.id, parentId: parent.id, slug: "advanced", name: "Advanced" } });
  await prisma.article.create({ data: { projectId: project.id, collectionId: nested.id, slug: "roles", title: "Roles", body: "Owners and admins.", publishedAt: new Date() } });
  const members = await prisma.collection.create({ data: { projectId: project.id, slug: "members", name: "Members", access: "SIGNED_IN" } });
  await left("in-members", { collectionId: members.id });

  const response = await llmsFull(request, { params: Promise.resolve({ project: project.slug }) });
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("private, max-age=300");
  expect(await response.text()).toBe(
    [
      `# Project ${project.slug}\n`,
      `# Inviting \\*your\\* team\nSource: ${portal}/docs/inviting-your-team\n\n## Who can invite\n\nOwners and **admins**.\n`,
      `# Roles\nSource: ${portal}/docs/roles\n\nOwners and admins.\n`,
      `# Billing\nSource: ${portal}/docs/billing\n\nPlans and invoices.\n`,
    ].join("\n"),
  );
  expect((await llmsFull(request, { params: Promise.resolve({ project: "no-such-project" }) })).status).toBe(404);
});

test("the sitemap lists the portal's public pages with when they changed, and nothing a visitor can't see", async () => {
  const project = await docsContents();
  const other = await createProject(await signUp());
  const portal = `http://${project.slug}.localhost:3100`;
  const board = await prisma.board.update({ where: { id: project.boards[0]!.id }, data: { updatedAt: new Date("2026-01-01T10:00:00Z") } });
  const post = (projectId: string, boardId: string, number: number, title: string, extra: object = {}) =>
    prisma.post.create({ data: { projectId, boardId, authorId: project.team[0]!.userId, number, title, ...extra } });
  const original = await post(project.id, board.id, 1, "Dark mode", { updatedAt: new Date("2026-04-01T10:00:00Z") });
  await post(project.id, board.id, 2, "Night theme", { duplicateOfId: original.id });
  await post(other.id, other.boards[0]!.id, 1, "Another project's post");
  const entry = (projectId: string, number: number, title: string, publishedAt: Date | null) =>
    prisma.changelogEntry.create({ data: { projectId, number, title, publishedAt, updatedAt: new Date("2026-05-01T10:00:00Z") } });
  await entry(project.id, 1, "Dark mode is here", new Date("2026-05-01T10:00:00Z"));
  await entry(project.id, 2, "Unpublished", null);
  await prisma.article.create({ data: { projectId: other.id, slug: "elsewhere", title: "Elsewhere", publishedAt: new Date() } });
  // A collection's date: the newest of itself and the listed articles in it, the ones in collections in it too, never a hidden one's.
  const gettingStarted = await prisma.collection.update({ where: { projectId_slug: { projectId: project.id, slug: "getting-started" } }, data: { updatedAt: new Date("2026-01-01T10:00:00Z") } });
  const roles = await prisma.collection.create({
    data: { projectId: project.id, parentId: gettingStarted.id, slug: "roles", name: "Roles", updatedAt: new Date("2026-01-01T10:00:00Z") },
  });
  const inRoles = (slug: string, extra: object) =>
    prisma.article.create({ data: { projectId: project.id, collectionId: roles.id, slug, title: slug, publishedAt: new Date("2026-03-01T10:00:00Z"), ...extra } });
  await inRoles("admins", { updatedAt: new Date("2026-03-05T10:00:00Z") });
  await inRoles("hidden-from-search", { noindex: true, updatedAt: new Date("2026-06-01T10:00:00Z") });
  await inRoles("roles-draft", { publishedAt: null, updatedAt: new Date("2026-06-01T10:00:00Z") });

  const response = await sitemap(request, { params: Promise.resolve({ project: project.slug }) });
  expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
  const xml = await response.text();
  const urls = Object.fromEntries([...xml.matchAll(/<url><loc>(.*?)<\/loc>(?:<lastmod>(.*?)<\/lastmod>)?<\/url>/g)].map((m) => [m[1], m[2]]));
  expect(urls).toEqual({
    [portal]: "2026-04-01T10:00:00.000Z",
    [`${portal}/feedback/feature-requests`]: "2026-04-01T10:00:00.000Z",
    [`${portal}/feedback/feature-requests/dark-mode-1`]: "2026-04-01T10:00:00.000Z",
    [`${portal}/roadmap`]: "2026-04-01T10:00:00.000Z",
    [`${portal}/changelog`]: "2026-05-01T10:00:00.000Z",
    [`${portal}/changelog/1`]: "2026-05-01T10:00:00.000Z",
    [`${portal}/docs`]: expect.any(String),
    // Collections' pages: Roles' article bubbles up to Getting started.
    [`${portal}/docs/getting-started`]: "2026-03-05T10:00:00.000Z",
    [`${portal}/docs/roles`]: "2026-03-05T10:00:00.000Z",
    [`${portal}/docs/admins`]: "2026-03-05T10:00:00.000Z",
    [`${portal}/docs/billing`]: expect.any(String),
    [`${portal}/docs/inviting-your-team`]: "2026-03-02T10:00:00.000Z",
  });
  expect((await sitemap(request, { params: Promise.resolve({ project: "no-such-project" }) })).status).toBe(404);
});

test("the sitemap never lists more than 50,000 URLs: past that, the oldest posts are left out, never the docs", async () => {
  const project = await docsContents();
  const portal = `http://${project.slug}.localhost:3100`;
  await prisma.$executeRaw`
    INSERT INTO post (id, "projectId", "boardId", "authorId", number, title, "updatedAt")
    SELECT 'sitemap-' || n, ${project.id}, ${project.boards[0]!.id}, ${project.team[0]!.userId}, n, 'Post', timestamp '2026-01-01' + n * interval '1 second'
    FROM generate_series(1, 50000) AS n`;

  const xml = await (await sitemap(request, { params: Promise.resolve({ project: project.slug }) })).text();
  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  expect(urls).toHaveLength(50_000);
  expect(urls).toContain(`${portal}/docs/inviting-your-team`);
  expect(urls).toContain(`${portal}/feedback/feature-requests/post-50000`);
  expect(urls).not.toContain(`${portal}/feedback/feature-requests/post-1`);
  // 50,000 rows inserted and a 50,000-URL sitemap built: 3–5 s on a busy runner, at the 5 s default.
}, 20_000);

test("robots.txt welcomes crawlers and points to the sitemap", async () => {
  const project = await docsContents();
  const response = await robots(request, { params: Promise.resolve({ project: project.slug }) });
  expect(await response.text()).toBe(`User-agent: *\nAllow: /\n\nSitemap: http://${project.slug}.localhost:3100/sitemap.xml\n`);
  expect((await robots(request, { params: Promise.resolve({ project: "no-such-project" }) })).status).toBe(404);
});
