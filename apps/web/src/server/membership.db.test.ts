import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { listMyProjects } from "./membership";

test("each project counts where work waits: open conversations, posts to triage, code changes with updates waiting", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const [board] = project.boards;
  const post = (number: number, status: "OPEN" | "PLANNED", duplicateOfId?: string) =>
    prisma.post.create({
      data: { projectId: project.id, boardId: board!.id, authorId: owner.id, number, title: `Post ${number}`, status, duplicateOfId },
    });
  const open = await post(1, "OPEN");
  await post(2, "OPEN");
  await post(3, "PLANNED");
  await post(4, "OPEN", open.id); // merged into #1: not to triage
  const change = (number: number, status: "PENDING" | "STALE" | "APPLIED") =>
    prisma.codeChange.create({
      data: {
        projectId: project.id,
        repoId: 1,
        repo: "acme/app",
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        title: `PR ${number}`,
        author: "octo",
        mergedAt: new Date(),
        state: "READY",
        actions: { create: [{ kind: "LINKS", postId: open.id, probability: 0.9, status }] },
      },
    });
  await change(1, "PENDING");
  await change(2, "STALE");
  await change(3, "APPLIED");
  await prisma.conversation.create({ data: { projectId: project.id, number: 1, subject: "Help", status: "OPEN", origin: "API", lastMessageAt: new Date() } });

  const [mine] = await listMyProjects(owner.id);
  expect(mine).toMatchObject({ slug: project.slug, openConversations: 1, toTriage: 2, changesWaiting: 2 });
});
