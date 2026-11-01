import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp } from "@/test/helpers";

import BoardPage from "./feedback/[board]/page";
import PostPage from "./feedback/[board]/[post]/page";
import RoadmapPage from "./roadmap/page";

// Links that come back to the page with its query ("Sign in to vote", the board's tabs), and the idea box's router.
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

/** Vote buttons, as the vote itself decides: someone from another project's single sign-on can't vote here. */
test("the roadmap's, a board's and a post's vote buttons only for those who may vote here", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const other = await createProject(owner);
  const post = await call(createPost, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { board: "feature-requests", title: "Dark mode" });
  await prisma.post.updateMany({ where: { projectId: project.id, number: post.number }, data: { status: "PLANNED" } });
  const render = async (page: (props: never) => Promise<React.ReactNode>, params: object) =>
    renderToStaticMarkup(await page({ params: Promise.resolve({ project: project.slug, ...params }), searchParams: Promise.resolve({}) } as never));
  const pages = async () => [
    await render(RoadmapPage, {}),
    await render(BoardPage, { board: "feature-requests" }),
    await render(PostPage, { board: "feature-requests", post: `dark-mode-${post.number}` }),
  ];
  const voteButton = (html: string) => html.match(/<button[^>]*aria-label="(Upvote|Remove vote)[^"]*"[^>]*>/)![0];

  actAs(await signUp("Ada"));
  for (const html of await pages()) {
    expect(voteButton(html)).not.toContain(' disabled=""');
  }

  const fromSso = await signUp("From another app");
  await prisma.ssoIdentity.create({ data: { projectId: other.id, externalId: "user-1", userId: fromSso.id } });
  actAs(fromSso);
  for (const html of await pages()) {
    expect(voteButton(html)).toContain(' disabled=""');
    expect(voteButton(html)).toContain('title="Sign in to vote"');
  }
  // The roadmap says so where it shows, too.
  expect((await pages())[0]).toContain(">Sign in</a> to vote");
});
