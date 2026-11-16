import { prisma } from "@tuti/db";
import { startS3Fake } from "@tuti/testkit";
import { expect, onTestFinished, test, vi } from "vitest";

import { generateMetadata as changelogEntryMetadata } from "@/app/portal/[project]/(site)/changelog/[number]/page";
import { generateMetadata as postMetadata } from "@/app/portal/[project]/(site)/feedback/[board]/[post]/page";
import { generateMetadata as boardMetadata } from "@/app/portal/[project]/(site)/feedback/[board]/page";
import { generateMetadata as layoutMetadata } from "@/app/portal/[project]/(site)/layout";
import { metadata as signInMetadata } from "@/app/portal/[project]/(site)/sign-in/page";
import { portalUrl } from "@/lib/hosts";
import { PREVIEW } from "@/lib/portal-base";
import { request } from "@/test/next-headers";
import { createArticle, createCollection, publishArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp } from "@/test/helpers";

import { shareCard } from "@/server/share-card";

import { GET as shareImage } from "./[[...path]]/route";

// Drawn as usual, with what each card says kept to check.
vi.mock("@/server/share-card", async (original) => {
  const actual = await original<typeof import("@/server/share-card")>();
  return { ...actual, shareCard: vi.fn(actual.shareCard) };
});

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

test("a changelog entry with a featured image has it as its link card: a lasting 1200px JPEG on the app's address, not the card made for it", async () => {
  const s3 = await startS3Fake();
  onTestFinished(() => s3.close());
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  const { owner, project, portal } = await portalWithPost();
  const cover = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 10, status: "READY", width: 2400, height: 1260 } });
  // Still processing: no image yet, so the card made for it.
  const processing = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 10, status: "PROCESSING" } });
  await prisma.changelogEntry.createMany({
    data: [
      { projectId: project.id, createdById: owner.id, number: 3, title: "Dark mode is here", body: "", publishedAt: new Date(), coverId: cover.id },
      { projectId: project.id, createdById: owner.id, number: 4, title: "Faster search", body: "", publishedAt: new Date(), coverId: processing.id },
    ],
  });
  const metadata = (number: string) => changelogEntryMetadata({ params: Promise.resolve({ project: project.slug, number }) } as never);
  const [card] = (await metadata("3")).openGraph?.images as { url: string; width: number; height: number; alt: string }[];
  expect(card).toEqual({ url: expect.stringMatching(new RegExp(`^${process.env.APP_URL}/api/media/${cover.id}/email\\.jpg\\?s=`)), width: 1200, height: 630, alt: "Dark mode is here" });
  expect(card!.url).not.toMatch(/X-Amz-Expires/i);
  expect((await metadata("4")).openGraph?.images).toEqual([expect.objectContaining({ url: `${portal}/og/changelog/4` })]);
});

test("a post only its author may see has no title in its metadata and no card for anyone else", async () => {
  const { project, board } = await portalWithPost("PRIVATE");
  expect(await postMetadata({ params: Promise.resolve({ project: project.slug, board: board.slug, post: "dark-mode-7" }) } as never)).toEqual({});
  expect((await image(project.slug, ["feedback", board.slug, "dark-mode-7"])).status).toBe(404);
});

test("a post only its author may see: their card isn't kept by shared caches", async () => {
  const { owner, project, board } = await portalWithPost("PRIVATE");
  actAs(owner);
  const response = await image(project.slug, ["feedback", board.slug, "dark-mode-7"]);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

test("a Team only board's name is in neither its metadata nor a card", async () => {
  const { project, board } = await portalWithPost();
  await prisma.board.update({ where: { id: board.id }, data: { postVisibility: "TEAM" } });
  expect(await boardMetadata({ params: Promise.resolve({ project: project.slug, board: board.slug }) } as never)).toEqual({});
  expect((await image(project.slug, ["feedback", board.slug])).status).toBe(404);
});

test("the docs' cards follow who may read them: a collection for people signed in has none for anyone else", async () => {
  const { owner, project } = await portalWithPost();
  const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
  const { slug: collection } = await call(createCollection, as(), { name: "Billing" });
  const { slug } = await call(createArticle, as(), { title: "Changing your plan", body: "From Settings.", collection });
  await call(publishArticle, as(), { slug });
  const article = await image(project.slug, ["docs", slug]);
  expect(article.status).toBe(200);
  expect(article.headers.get("cache-control")).toBe("public, max-age=3600");
  expect((await image(project.slug, ["docs", collection])).status).toBe(200);
  expect((await image(project.slug, ["docs"])).status).toBe(200);
  await prisma.collection.update({ where: { projectId_slug: { projectId: project.id, slug: collection } }, data: { access: "SIGNED_IN", noAccess: "HIDE" } });
  expect((await image(project.slug, ["docs", collection])).status).toBe(404);
  expect((await image(project.slug, ["docs", slug])).status).toBe(404);
});

test("the portal's own card, its sections' and a title in any script: made here, with nothing fetched", async () => {
  const { owner, project, board } = await portalWithPost();
  await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: 7 } }, data: { title: "Łódź, 東京 and Привет 🎉" } });
  await prisma.changelogEntry.create({ data: { projectId: project.id, createdById: owner.id, number: 1, title: "Hello", body: "", publishedAt: new Date() } });
  const fetches = vi.spyOn(globalThis, "fetch");
  for (const path of [[], ["feedback"], ["roadmap"], ["changelog"], ["feedback", board.slug, "dark-mode-7"]]) {
    expect((await image(project.slug, path)).status).toBe(200);
  }
  expect(fetches).not.toHaveBeenCalled();
  expect((await image(project.slug, ["nothing-here"])).status).toBe(404);
});

test("a public post on a Team only board: its card doesn't name the board", async () => {
  const { project, board } = await portalWithPost();
  await prisma.board.update({ where: { id: board.id }, data: { postVisibility: "TEAM", name: "Secret plans" } });
  vi.mocked(shareCard).mockClear();
  expect((await image(project.slug, ["feedback", board.slug, "dark-mode-7"])).status).toBe(200);
  expect(vi.mocked(shareCard).mock.calls[0]?.[1]).toEqual({ eyebrow: "Feedback", title: "Dark mode", facts: ["Open", "12 votes"], picture: { votes: 12 } });
});

test("the page the portal opens on has the team's own description and share image; every other page has its card", async () => {
  const s3 = await startS3Fake();
  onTestFinished(() => s3.close());
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  const { owner, project, board, portal } = await portalWithPost();
  const media = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 10, status: "READY", width: 1200, height: 630 } });
  await prisma.project.update({ where: { id: project.id }, data: { seoImageId: media.id } });
  await prisma.project.update({ where: { id: project.id }, data: { seoDescription: "Ideas for Acme." } });
  // One board: the portal opens on it.
  const home = await boardMetadata({ params: Promise.resolve({ project: project.slug, board: board.slug }) } as never);
  expect(home.description).toBe("Ideas for Acme.");
  expect(home.openGraph?.images).toEqual([expect.objectContaining({ url: expect.stringContaining(media.id), width: 1200, height: 630 })]);
  expect(await postMetadata({ params: Promise.resolve({ project: project.slug, board: board.slug, post: "dark-mode-7" }) } as never)).toMatchObject({
    description: "Easier on the eyes at night.",
    openGraph: { images: [{ url: `${portal}/og/feedback/${board.slug}/dark-mode-7` }] },
  });
});

test("a private portal's card, previewed as people signed out see it, isn't kept by shared caches", async () => {
  const { owner, project, board } = await portalWithPost();
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  actAs(owner);
  request.headers = { [PREVIEW.header]: PREVIEW.value };
  onTestFinished(() => {
    request.headers = {};
  });
  const response = await image(project.slug, ["feedback", board.slug, "dark-mode-7"]);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
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

test("a board's and the roadmap's counts are of the posts the reader may see, as on their pages", async () => {
  const { owner, project, board } = await portalWithPost();
  const someone = await signUp("Someone");
  const team = await prisma.board.create({ data: { projectId: project.id, slug: "team", name: "Team", postVisibility: "TEAM" } });
  await prisma.post.update({ where: { projectId_number: { projectId: project.id, number: 7 } }, data: { status: "PLANNED" } });
  await prisma.post.createMany({
    data: [
      // Someone else's, only they see: in no count but theirs.
      { projectId: project.id, boardId: board.id, authorId: someone.id, number: 8, title: "Mine alone", visibility: "PRIVATE", status: "PLANNED" },
      // Public, on a Team only board: on the roadmap, as its columns have it.
      { projectId: project.id, boardId: team.id, authorId: owner.id, number: 9, title: "On the roadmap", status: "IN_PROGRESS" },
    ],
  });
  actAs(null);
  const facts = async (path: string[]) => {
    vi.mocked(shareCard).mockClear();
    expect((await image(project.slug, path)).status).toBe(200);
    return vi.mocked(shareCard).mock.calls[0]?.[1].facts;
  };
  expect(await facts(["feedback", board.slug])).toEqual(["1 idea"]);
  expect(await facts(["roadmap"])).toEqual(["1 planned", "1 in progress"]);
  actAs(someone);
  expect(await facts(["feedback", board.slug])).toEqual(["2 ideas"]);
  expect(await facts(["roadmap"])).toEqual(["2 planned", "1 in progress"]);
});

test("the changelog's later pages have cards as far as they have entries, at one address each", async () => {
  const { owner, project } = await portalWithPost();
  await prisma.changelogEntry.createMany({
    data: Array.from({ length: 21 }, (_, i) => ({ projectId: project.id, createdById: owner.id, number: i + 1, title: `Entry ${i + 1}`, body: "", publishedAt: new Date(Date.UTC(2026, 0, i + 1)) })),
  });
  expect((await image(project.slug, ["changelog", "page", "2"])).status).toBe(200);
  for (const page of ["3", "02", "1", "abc", "999"]) {
    expect((await image(project.slug, ["changelog", "page", page])).status).toBe(404);
  }
});

test("a private portal without a share image of the team's names no card: a link's preview is fetched signed out", async () => {
  const { project } = await portalWithPost();
  await prisma.project.update({ where: { id: project.id }, data: { portalAccess: "PRIVATE" } });
  const metadata = await layoutMetadata({ params: Promise.resolve({ project: project.slug }) } as never);
  expect(metadata.openGraph).not.toHaveProperty("images");
});

test("a page for the reader alone (signing in) isn't for search engines", () => {
  expect(signInMetadata).toMatchObject({ title: "Sign in", robots: { index: false, follow: false } });
});

test("each kind of page has its own drawing: a page for the docs, ideas for feedback, columns for the roadmap, a timeline for the changelog, a post's votes", async () => {
  const { owner, project, board } = await portalWithPost();
  await prisma.changelogEntry.create({ data: { projectId: project.id, createdById: owner.id, number: 1, title: "Dark mode", body: "", publishedAt: new Date() } });
  const picture = async (path: string[]) => {
    vi.mocked(shareCard).mockClear();
    expect((await image(project.slug, path)).status).toBe(200);
    return vi.mocked(shareCard).mock.calls[0]?.[1].picture;
  };
  expect(await picture([])).toBe("page");
  expect(await picture(["docs"])).toBe("page");
  expect(await picture(["feedback"])).toBe("board");
  expect(await picture(["feedback", board.slug])).toBe("board");
  expect(await picture(["feedback", board.slug, "dark-mode-7"])).toEqual({ votes: 12 });
  expect(await picture(["roadmap"])).toBe("roadmap");
  expect(await picture(["changelog"])).toBe("changelog");
  expect(await picture(["changelog", "1"])).toBe("changelog");
});
