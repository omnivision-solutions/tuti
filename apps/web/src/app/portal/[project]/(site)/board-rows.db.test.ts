import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp } from "@/test/helpers";

import BoardPage from "./feedback/[board]/page";

// The idea box's router and the tabs' links.
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/feedback/feature-requests",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

/** A row's comment count (and a board's default line): the icon and the number for the eye, "3 comments" (or "1 comment") for screen readers. */
test("a board's rows say how many comments in words to screen readers, the number alone hidden from them", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const actor = { actor: { kind: "user" as const, userId: owner.id }, projectId: project.id };
  const many = await call(createPost, actor, { board: "feature-requests", title: "Dark mode" });
  const one = await call(createPost, actor, { board: "feature-requests", title: "Offline mode" });
  await prisma.post.updateMany({ where: { projectId: project.id, number: many.number }, data: { commentCount: 3 } });
  await prisma.post.updateMany({ where: { projectId: project.id, number: one.number }, data: { commentCount: 1 } });

  actAs(null);
  const html = renderToStaticMarkup(
    await BoardPage({ params: Promise.resolve({ project: project.slug, board: "feature-requests" }), searchParams: Promise.resolve({}) } as never),
  );
  expect(html).toContain('<span aria-hidden="true">3</span><span class="sr-only">3 comments</span>');
  expect(html).toContain('<span aria-hidden="true">1</span><span class="sr-only">1 comment</span>');
  // A board with no description of its own says how it works under its name.
  expect(html).toContain("Vote for the ideas you want most, or share your own.");
  // No label on a role-less span (screen readers mostly skip those).
  expect(html).not.toMatch(/<span[^>]*aria-label="\d+ comments?"/);
});
