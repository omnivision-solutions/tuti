import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp } from "@/test/helpers";

import FeedbackOverview from "./page";

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/feedback",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

/** Feedback's overview: a card per board the reader sees with its top three open ideas and how many are still to come, then what shipped; `?q=` searches every board. */
test("the overview lists each board's top open ideas, what shipped, and searches every board it shows", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bug reports", description: "Something broken?", postButton: "Report a bug" } });
  await prisma.board.create({ data: { projectId: project.id, slug: "team", name: "Team notes", postVisibility: "TEAM" } });
  const actor = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  for (const title of ["Dark mode", "Offline mode", "CSV export", "Calendar sync"]) {
    await call(createPost, actor, { board: "feature-requests", title });
  }
  const shipped = await call(createPost, actor, { board: "bugs", title: "Crash on start" });
  await prisma.post.updateMany({ where: { projectId: project.id, number: shipped.number }, data: { status: "COMPLETED" } });
  await call(createPost, actor, { board: "bugs", title: "Slow search" });
  await call(createPost, actor, { board: "team", title: "Secret plan" });
  // A board made Team only since: its posts stay public, yet the portal doesn't show the board, nor finds them.
  await prisma.board.create({ data: { projectId: project.id, slug: "old", name: "Old board" } });
  await call(createPost, actor, { board: "old", title: "Search history" });
  await prisma.board.update({ where: { projectId_slug: { projectId: project.id, slug: "old" } }, data: { postVisibility: "TEAM" } });

  actAs(null);
  const page = async (searchParams: Record<string, string> = {}) =>
    renderToStaticMarkup(await FeedbackOverview({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve(searchParams) } as never));
  const html = await page();
  const words = text(html);
  // Each board shown is a card; a Team only board isn't on the portal.
  expect(words).toContain("Feature requests");
  expect(words).toContain("Bug reports Something broken?");
  expect(words).not.toContain("Team notes");
  expect(words).not.toContain("Secret plan");
  // Three of a board's four open ideas, then how many are still to come.
  expect((html.match(/href="\/feedback\/feature-requests\/[^"]+"/g) ?? []).length).toBe(3);
  expect(words).toContain("4 ideas still to come");
  expect(words).toContain("1 idea still to come");
  // The pills: every board, with counts (the Team only board's not among them).
  expect(words).toContain("All boards 5");
  // What shipped, under the cards; not among the open ideas.
  expect(words).toMatch(/Recently shipped Crash on start \d{1,2} [A-Z][a-z]{2,3}/);

  // A search looks through every board shown, every status.
  const found = text(await page({ q: "s" }));
  expect(found).toContain("Crash on start");
  expect(found).toContain("Slow search");
  expect(found).not.toContain("Secret plan");
  expect(found).not.toContain("Search history");
  expect(found).not.toContain("still to come");
  expect(text(await page({ q: "nothing like it" }))).toContain("No ideas match");
});

/** A post moved to a board the overview doesn't show, between its search's two reads (the ids, then the posts), isn't in it. */
test("the overview's search leaves out a post moved off its boards while it reads", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bug reports" } });
  const hidden = await prisma.board.create({ data: { projectId: project.id, slug: "team", name: "Team notes", postVisibility: "TEAM" } });
  const actor = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  await call(createPost, actor, { board: "feature-requests", title: "Dark mode" });
  const moving = await call(createPost, actor, { board: "bugs", title: "Dark icons" });

  actAs(null);
  // The ids are read; then, before the posts are, the team moves one to its Team only board (its post stays public).
  const findMany = prisma.post.findMany.bind(prisma.post);
  const spy = vi.spyOn(prisma.post, "findMany").mockImplementationOnce((async (args: Parameters<typeof findMany>[0]) => {
    await prisma.post.updateMany({ where: { projectId: project.id, number: moving.number }, data: { boardId: hidden.id } });
    return findMany(args);
  }) as never);
  try {
    const html = renderToStaticMarkup(await FeedbackOverview({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({ q: "dark" }) } as never));
    expect(spy).toHaveBeenCalled();
    expect(text(html)).toContain("Dark mode");
    expect(text(html)).not.toContain("Dark icons");
  } finally {
    spy.mockRestore();
  }
});
