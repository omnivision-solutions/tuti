import { prisma } from "@tuti/db";
import { isValidElement, type ReactNode } from "react";
import { expect, test } from "vitest";

import { CommentList } from "@/components/comments";
import { VoterFaces } from "@/components/voter-faces";
import { actAs, createProject, signUp } from "@/test/helpers";

import PostPage from "./page";

/** The props of the first element of component `type` in the page's tree (components in it aren't run). */
function propsOf<P>(node: ReactNode, type: (props: P) => ReactNode): P | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, type);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return undefined;
  }
  return node.type === type ? (node.props as P) : propsOf(node.props.children, type);
}

test("a portal post's history has its status changes and when, not who made them or how many were emailed; five of its voters' faces, the latest first", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const ada = await signUp("Ada");
  const post = await prisma.post.create({
    data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: ada.id, number: 1, title: "Dark mode", body: "", status: "PLANNED", voteCount: 6 },
  });
  await prisma.postEvent.create({ data: { postId: post.id, actorId: owner.id, from: "OPEN", to: "PLANNED", emailed: 3 } });
  // Six voters, a day apart: Voter 1 first.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const voter = await signUp(`Voter ${n}`);
    await prisma.vote.create({ data: { postId: post.id, userId: voter.id, projectId: project.id, createdAt: new Date(Date.UTC(2026, 9, n)) } });
  }

  actAs(null);
  const page = await PostPage({ params: Promise.resolve({ project: project.slug, board: "feature-requests", post: "dark-mode-1" }), searchParams: Promise.resolve({}) } as never);

  const events = propsOf(page, CommentList)!.events!;
  expect(events).toEqual([{ id: expect.any(String), from: "OPEN", to: "PLANNED", createdAt: expect.any(Date) }]);
  const voters = propsOf(page, VoterFaces)!;
  // All six counted; five faces, the latest first.
  expect(voters.count).toBe(6);
  expect(voters.voters.map((voter) => voter.name)).toEqual(["Voter 6", "Voter 5", "Voter 4", "Voter 3", "Voter 2"]);
});
