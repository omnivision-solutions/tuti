import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import { createPost } from "./posts";

function postForm(projectSlug: string, title: string) {
  const form = new FormData();
  form.set("projectSlug", projectSlug);
  form.set("boardSlug", "feature-requests");
  form.set("title", title);
  return form;
}

test("posts created at the same time get distinct numbers, counted per project", async () => {
  const owner = await signUp();
  const [first, second] = [await createProject(owner), await createProject(owner)];
  actAs(owner);

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => createPost({}, postForm(first.slug, `Idea number ${i}`))),
  );
  expect(results).toEqual(Array(10).fill({}));
  await createPost({}, postForm(second.slug, "Another project's idea"));

  const numbers = async (projectId: string) =>
    (await prisma.post.findMany({ where: { projectId }, select: { number: true }, orderBy: { number: "asc" } })).map(
      (p) => p.number,
    );
  expect(await numbers(first.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(await numbers(second.id)).toEqual([1]);
});

test("authors upvote their own post", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  actAs(owner);
  await createPost({}, postForm(project.slug, "Dark mode"));

  const post = await prisma.post.findFirstOrThrow({ where: { projectId: project.id }, include: { votes: true } });
  expect(post.voteCount).toBe(1);
  expect(post.votes.map((v) => v.userId)).toEqual([owner.id]);
});

test("signed-out visitors can't post", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  actAs(null);
  expect(await createPost({}, postForm(project.slug, "Dark mode"))).toEqual({ error: "Sign in to post feedback" });
  expect(await prisma.post.count({ where: { projectId: project.id } })).toBe(0);
});
