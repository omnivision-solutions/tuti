import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { GET as markdown } from "./docs/[slug]/md/route";
import { GET as llms } from "./llms.txt/route";
import { GET as robots } from "./robots.txt/route";
import { GET as sitemap } from "./sitemap.xml/route";

/** Serving the portal to search engines and AI tools: /help/<slug>.md, /llms.txt, /sitemap.xml and /robots.txt. */

const request = new Request("http://x");
const doc = (...content: object[]) => ({ type: "doc", content });
const text = (value: string, marks?: object[]) => ({ type: "text", text: value, ...(marks && { marks }) });

async function helpCenter() {
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
  const project = await helpCenter();
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

test("llms.txt describes the portal and links each published article's Markdown, the changelog and the boards", async () => {
  const project = await helpCenter();
  const portal = `http://${project.slug}.localhost:3100`;
  const response = await llms(request, { params: Promise.resolve({ project: project.slug }) });
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await response.text()).toBe(
    [
      `# Project ${project.slug}`,
      `> Docs, changelog and feedback for Project ${project.slug}.`,
      "## Getting started",
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

test("the sitemap lists the portal's public pages with when they changed, and nothing a visitor can't see", async () => {
  const project = await helpCenter();
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
    [`${portal}/docs/billing`]: expect.any(String),
    [`${portal}/docs/inviting-your-team`]: "2026-03-02T10:00:00.000Z",
  });
  expect((await sitemap(request, { params: Promise.resolve({ project: "no-such-project" }) })).status).toBe(404);
});

test("the sitemap never lists more than 50,000 URLs: past that, the oldest posts are left out, never the help center", async () => {
  const project = await helpCenter();
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
  const project = await helpCenter();
  const response = await robots(request, { params: Promise.resolve({ project: project.slug }) });
  expect(await response.text()).toBe(`User-agent: *\nAllow: /\n\nSitemap: http://${project.slug}.localhost:3100/sitemap.xml\n`);
  expect((await robots(request, { params: Promise.resolve({ project: "no-such-project" }) })).status).toBe(404);
});
