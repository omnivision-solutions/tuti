import { prisma } from "@tuti/db";
import { newestRevision } from "@tuti/jobs";
import { beforeEach, expect, test } from "vitest";

import { createArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { GET } from "./route";

/** What the article editor asks while its screenshots are being taken: only the project's team gets an answer. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const ask = (articleSlug: string, slug = project.slug) =>
  GET(new Request(`http://tuti.localhost:3100/app/${slug}/docs/${articleSlug}/screenshots`), { params: Promise.resolve({ project: slug, slug: articleSlug }) });

test("says whether the article's latest run is running and its newest version; nobody off the team, nor an article gone, gets an answer", async () => {
  const { slug } = await call(createArticle, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { title: "Billing", body: "[Screenshot: The billing page]" });
  const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug }, select: { id: true } });
  await prisma.screenshotRun.create({ data: { projectId: project.id, startedById: owner.id, articleId: article.id, startedAt: new Date() } });
  actAs(owner);
  const running = await ask(slug);
  expect(running.headers.get("cache-control")).toBe("private, no-store");
  expect(await running.json()).toEqual({ running: true, savedAt: await newestRevision(article.id) });
  await prisma.screenshotRun.updateMany({ where: { articleId: article.id }, data: { state: "DONE" } });
  expect(await (await ask(slug)).json()).toMatchObject({ running: false });
  // Gone (deleted while a run went): a 404, so the editor stops asking.
  expect((await ask("no-such-article")).status).toBe(404);
  actAs(await signUp("Outsider"));
  expect((await ask(slug)).status).toBe(404);
});
