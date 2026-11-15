import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { generateMetadata as changelogEntryMetadata } from "@/app/portal/[project]/(site)/changelog/[number]/page";
import { generateMetadata as postMetadata } from "@/app/portal/[project]/(site)/feedback/[board]/[post]/page";
import { generateMetadata as layoutMetadata } from "@/app/portal/[project]/(site)/layout";
import { metadata as signInMetadata } from "@/app/portal/[project]/(site)/sign-in/page";
import { portalUrl } from "@/lib/hosts";
import { actAs, createProject, signUp } from "@/test/helpers";

import { GET as shareImage } from "./[[...path]]/route";

const image = (slug: string, path: string[]) => shareImage(new Request("http://x"), { params: Promise.resolve({ project: slug, path }) });

async function portalWithPost(visibility: "PUBLIC" | "PRIVATE" = "PUBLIC") {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const board = project.boards[0]!;
  await prisma.post.create({
    data: { projectId: project.id, boardId: board.id, authorId: owner.id, number: 7, title: "Dark mode", body: "Easier on the eyes at night.", visibility, voteCount: 12 },
  });
  actAs(null);
  return { owner, project, board, portal: portalUrl(project.slug) };
}

test("a post's link card: its title, description, canonical address, an article's Open Graph and an image made for it, all on the portal's address", async () => {
  const { project, board, portal } = await portalWithPost();
  const path = `/feedback/${board.slug}/dark-mode-7`;
  expect(await postMetadata({ params: Promise.resolve({ project: project.slug, board: board.slug, post: "dark-mode-7" }) } as never)).toMatchObject({
    title: "Dark mode",
    description: "Easier on the eyes at night.",
    alternates: { canonical: `${portal}${path}` },
    openGraph: {
      type: "article",
      url: `${portal}${path}`,
      siteName: project.name,
      publishedTime: expect.any(String),
      images: [{ url: `${portal}/og${path}`, width: 1200, height: 630, alt: "Dark mode" }],
    },
  });
  // Every page: the portal's address as the base of its links, a large Twitter card (its title, text and image come
  // from the page's Open Graph), the portal's name after the page's title, and its own image for pages without one.
  expect(await layoutMetadata({ params: Promise.resolve({ project: project.slug }) } as never)).toMatchObject({
    metadataBase: new URL(portal),
    title: { default: project.name, template: `%s · ${project.name}` },
    twitter: { card: "summary_large_image" },
    openGraph: { siteName: project.name, images: [{ url: `${portal}/og`, width: 1200, height: 630 }] },
  });

  const response = await image(project.slug, ["feedback", board.slug, "dark-mode-7"]);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  // What anyone signed out sees: shared caches may keep it a while.
  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  const png = new Uint8Array(await response.arrayBuffer());
  expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
});

test("a changelog entry's link card is an article's, with its date", async () => {
  const { owner, project, portal } = await portalWithPost();
  const publishedAt = new Date("2026-11-03T10:00:00Z");
  await prisma.changelogEntry.create({ data: { projectId: project.id, createdById: owner.id, number: 3, title: "Dark mode is here", body: "Turn it on in Settings.", publishedAt } });
  expect(await changelogEntryMetadata({ params: Promise.resolve({ project: project.slug, number: "3" }) } as never)).toMatchObject({
    title: "Dark mode is here",
    alternates: { canonical: `${portal}/changelog/3` },
    openGraph: { type: "article", publishedTime: publishedAt.toISOString(), images: [{ url: `${portal}/og/changelog/3` }] },
  });
  expect((await image(project.slug, ["changelog", "3"])).status).toBe(200);
  expect((await image(project.slug, ["changelog", "4"])).status).toBe(404);
});

test("a post only its author may see has no title in its metadata and no card for anyone else", async () => {
  const { project, board } = await portalWithPost("PRIVATE");
  expect(await postMetadata({ params: Promise.resolve({ project: project.slug, board: board.slug, post: "dark-mode-7" }) } as never)).toEqual({});
  expect((await image(project.slug, ["feedback", board.slug, "dark-mode-7"])).status).toBe(404);
});

test("a private portal's cards aren't made for people who may not read it", async () => {
  const { project, board } = await portalWithPost();
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  for (const path of [[], ["feedback", board.slug, "dark-mode-7"], ["feedback", board.slug], ["roadmap"]]) {
    const response = await image(project.slug, path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("image/png");
  }
});

test("a page for the reader alone (signing in) isn't for search engines", () => {
  expect(signInMetadata).toMatchObject({ title: "Sign in", robots: { index: false, follow: false } });
});
