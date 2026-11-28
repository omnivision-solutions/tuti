import { isValidElement, type ReactNode } from "react";
import { expect, test } from "vitest";

import { InOrderProvider } from "@/components/trpc";
import { actAs, createProject, signUp } from "@/test/helpers";

import BoardsPage from "./boards/page";
import FeedbackPage from "./page";
import RoadmapPage from "./roadmap/page";

/**
 * Saves through tRPC don't wait for each other as server actions did: each Feedback page that saves from more than one
 * component gives them one queue (useInOrder). On the list, a post's row menu and the open post's Status; on the
 * Roadmap, a card's drag and its menu; on Boards, a board's Turn on and its menu's Turn off.
 */
function contains(node: ReactNode, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => contains(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return false;
  return node.type === type || contains(node.props.children, type);
}

test("Feedback's list (a post open beside it), its Roadmap and its Boards keep their saves in one queue", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  actAs(owner);
  const props = (searchParams: Record<string, string>) => ({ params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve(searchParams) }) as never;
  const list = await FeedbackPage(props({ post: "1" }));
  // The whole page: its rows and the open post's pane.
  expect(isValidElement(list) && list.type).toBe(InOrderProvider);
  expect(contains(await RoadmapPage(props({})), InOrderProvider)).toBe(true);
  expect(contains(await BoardsPage(props({})), InOrderProvider)).toBe(true);
});

test("the Roadmap with a board in its address no board has (too long for any) shows every board, not an error", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  actAs(owner);
  const props = { params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({ board: "x".repeat(300) }) } as never;
  await expect(RoadmapPage(props)).resolves.toBeTruthy();
});

test("Feedback's list with an address past what it reads (a page past the last, a board and group too long for any) shows the list, not an error", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  actAs(owner);
  const props = { params: Promise.resolve({ project: project.slug }), searchParams: Promise.resolve({ page: "1001", board: "x".repeat(300), group: "y".repeat(300) }) } as never;
  await expect(FeedbackPage(props)).resolves.toBeTruthy();
});
