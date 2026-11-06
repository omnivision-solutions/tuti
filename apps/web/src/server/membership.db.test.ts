import { imageKey } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { startS3Fake } from "@tuti/testkit";
import { expect, test, vi } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { listMyProjects } from "./membership";
import { lastingMediaUrl } from "./media-urls";

test("each project counts where work waits: open conversations, posts to triage, Autopilot's posts and articles to review", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const [board] = project.boards;
  const post = (number: number, status: "OPEN" | "PLANNED", duplicateOfId?: string) =>
    prisma.post.create({
      data: { projectId: project.id, boardId: board!.id, authorId: owner.id, number, title: `Post ${number}`, status, duplicateOfId },
    });
  const open = await post(1, "OPEN");
  const other = await post(2, "OPEN");
  await post(3, "PLANNED");
  await post(4, "OPEN", open.id); // merged into #1: not to triage
  const change = (number: number, status: "PENDING" | "STALE" | "SCHEDULED" | "APPLIED", postId = open.id) =>
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
        actions: { create: [{ kind: "MOVES_FORWARD", postId, probability: 0.9, status }] },
      },
    });
  // Two pull requests' updates on one post: one to review. One going out by itself is to review too; one applied isn't.
  await change(1, "PENDING");
  await change(2, "STALE");
  await change(3, "SCHEDULED", other.id);
  await change(4, "APPLIED", other.id);
  // A Verify run's fix waiting on an article: to review too. One on sample content isn't counted (Home leaves it out).
  const article = async (sample: boolean) => {
    const created = await prisma.article.create({ data: { projectId: project.id, slug: `a-${sample}`, title: "Plans", body: "", sample } });
    const run = await prisma.articleVerification.create({ data: { projectId: project.id, articleId: created.id, state: "DONE" } });
    await prisma.codeChangeAction.create({ data: { verificationId: run.id, articleId: created.id, kind: "ARTICLE_EDIT", probability: 1 } });
  };
  await article(false);
  await article(true);
  await prisma.conversation.create({ data: { projectId: project.id, number: 1, subject: "Help", status: "OPEN", origin: "API", lastMessageAt: new Date() } });

  const [mine] = await listMyProjects(owner.id);
  expect(mine).toMatchObject({ slug: project.slug, openConversations: 1, toTriage: 2, changesWaiting: 3 });
});

test("each project's logos from Customize → Branding, for the project switcher; none without one", async () => {
  const s3 = await startS3Fake();
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  try {
    const owner = await signUp("Owner");
    const project = await createProject(owner);
    expect((await listMyProjects(owner.id))[0]).toMatchObject({ logo: null, logoDark: null });

    const logo = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 10, status: "READY", width: 600, height: 200 } });
    await prisma.project.update({ where: { id: project.id }, data: { brandLogoId: logo.id } });
    expect((await listMyProjects(owner.id))[0]).toMatchObject({ logo: lastingMediaUrl(imageKey(logo.id, 480)), logoDark: null });
  } finally {
    vi.unstubAllEnvs();
    await s3.close();
  }
});
