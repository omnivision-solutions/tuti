import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { isArticleSlug } from "@/server/docs-queries";
import { actAs, createProject, signUp } from "@/test/helpers";

import { GET as markdown } from "./docs/[slug]/md/route";
import { GET as postMarkdown } from "./feedback/[board]/[post]/md/route";
import { generateMetadata as postMetadata } from "./feedback/[board]/[post]/page";
import { GET as llmsFull } from "./llms-full.txt/route";
import { generateMetadata } from "./docs/[slug]/page";
import { GET as llms } from "./llms.txt/route";
import { GET as robots } from "./robots.txt/route";
import { GET as sitemap } from "./sitemap.xml/route";

/** Serving the portal to search engines and AI tools: /docs/<slug>.md, <a post's path>.md, /llms.txt, /llms-full.txt, /sitemap.xml and /robots.txt. */

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
  const owner = await signUp("Owner");
  const reader = await signUp("Sam *Reader*");
  const project = await createProject(owner);
  const portal = `http://${project.slug}.localhost:3100`;
  const board = project.boards[0]!;
  const post = (number: number, title: string, extra: object = {}) =>
    prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: reader.id, number, title, createdAt: new Date("2026-03-01T10:00:00Z"), ...extra } });
  const dark = await post(1, "Dark mode", { body: "Easier on the eyes.", status: "PLANNED", voteCount: 3 });
  const comment = (authorId: string, body: string, at: string, extra: object = {}) =>
    prisma.comment.create({ data: { projectId: project.id, postId: dark.id, authorId, body, createdAt: new Date(at), ...extra } });
  await comment(owner.id, "On our list.", "2026-03-03T10:00:00Z");
  await comment(reader.id, "Me too!", "2026-03-02T10:00:00Z");
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
      "Status: Planned · 3 votes · Board: Feature requests",
      "Posted by Sam \\*Reader\\* on 1 March 2026",
      "Easier on the eyes.",
      "## 3 comments",
      "### Sam \\*Reader\\* · 2 March 2026",
      "Me too!",
      "### Owner (Team) · 3 March 2026",
      "On our list.",
      "### Owner · 4 March 2026",
      "From my reader account.",
    ].join("\n\n") + "\n",
  );

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

  // A Team only board isn't named; a board that's off hides its posts.
  await prisma.board.update({ where: { id: board.id }, data: { postVisibility: "TEAM" } });
  expect(await (await get(project.slug, "dark-mode-1")).text()).toContain("Status: Planned · 3 votes\n");
  await prisma.board.update({ where: { id: board.id }, data: { off: true } });
  expect((await get(project.slug, "dark-mode-1")).status).toBe(404);
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
    // A collection's page.
    [`${portal}/docs/getting-started`]: undefined,
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
});

test("robots.txt welcomes crawlers and points to the sitemap", async () => {
  const project = await docsContents();
  const response = await robots(request, { params: Promise.resolve({ project: project.slug }) });
  expect(await response.text()).toBe(`User-agent: *\nAllow: /\n\nSitemap: http://${project.slug}.localhost:3100/sitemap.xml\n`);
  expect((await robots(request, { params: Promise.resolve({ project: "no-such-project" }) })).status).toBe(404);
});
