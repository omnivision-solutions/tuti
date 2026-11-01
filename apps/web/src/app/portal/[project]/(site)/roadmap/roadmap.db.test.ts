import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp } from "@/test/helpers";

import RoadmapPage from "./page";

// "Sign in to vote" links back to the page with its query.
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), useSearchParams: () => new URLSearchParams() }));

/** The cards' vote buttons, as the vote itself decides: someone from another project's single sign-on can't vote here. */
test("votes from the cards only for those who may vote here", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const other = await createProject(owner);
  const post = await call(createPost, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { board: "feature-requests", title: "Dark mode" });
  await prisma.post.updateMany({ where: { projectId: project.id, number: post.number }, data: { status: "PLANNED" } });
  const page = async () => renderToStaticMarkup(await RoadmapPage({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({}) } as never));
  const voteButton = (html: string) => html.match(/<button[^>]*aria-label="(Upvote|Remove vote)[^"]*"[^>]*>/)![0];

  actAs(await signUp("Ada"));
  expect(voteButton(await page())).not.toContain(' disabled=""');

  const fromSso = await signUp("From another app");
  await prisma.ssoIdentity.create({ data: { projectId: other.id, externalId: "user-1", userId: fromSso.id } });
  actAs(fromSso);
  const html = await page();
  expect(voteButton(html)).toContain(' disabled=""');
  expect(voteButton(html)).toContain('title="Sign in to vote"');
  expect(html).toContain(">Sign in</a> to vote");
});
