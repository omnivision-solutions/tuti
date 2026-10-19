import { prisma } from "@tuti/db";
import { describe, expect, test } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import { addComment, createPost } from "./posts";

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

describe("rich content", () => {
  const doc = (...content: object[]) => JSON.stringify({ type: "doc", content });
  const p = (text: string, marks?: object[]) => ({ type: "paragraph", content: [{ type: "text", text, ...(marks && { marks }) }] });
  const video = { type: "video", attrs: { provider: "youtube", id: "dQw4w9WgXcQ" } };
  const list = { type: "bulletList", content: [{ type: "listItem", content: [p("one")] }] };

  async function setup() {
    const owner = await signUp();
    const project = await createProject(owner);
    actAs(owner);
    return project;
  }

  async function comment(postId: string, fields: Record<string, string>) {
    const form = new FormData();
    form.set("postId", postId);
    for (const [key, value] of Object.entries(fields)) {
      form.set(key, value);
    }
    return addComment({}, form);
  }

  test("a post stores its document and the plain text of it", async () => {
    const project = await setup();
    const form = postForm(project.slug, "Dark mode");
    form.set("content", doc(p("Please", [{ type: "bold" }]), list, video));
    expect(await createPost({}, form)).toEqual({});

    const post = await prisma.post.findFirstOrThrow({ where: { projectId: project.id } });
    expect(post.content).toMatchObject({ type: "doc", content: [{ type: "paragraph" }, { type: "bulletList" }, video] });
    expect(post.body).toBe("Please\none\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  test("plain text still works, as a document", async () => {
    const project = await setup();
    const form = postForm(project.slug, "Dark mode");
    form.set("body", "First\n\nSecond");
    await createPost({}, form);
    const post = await prisma.post.findFirstOrThrow({ where: { projectId: project.id } });
    expect(post.body).toBe("First\nSecond");
    expect(post.content).toMatchObject({ type: "doc", content: [{ type: "paragraph" }, { type: "paragraph" }] });
  });

  test.each([
    ["a heading", doc({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "x" }] }), "This content has something that isn't allowed here."],
    ["a javascript: link", doc(p("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])), "Links must start with http://, https:// or mailto:."],
    ["a video from elsewhere", doc({ type: "video", attrs: { provider: "evil", id: "x" } }), "Only YouTube, Vimeo and Loom videos can be embedded."],
    ["too much text", doc(p("x".repeat(5001))), "Keep it under 5,000 characters"],
  ])("a post with %s is refused", async (_name, content, error) => {
    const project = await setup();
    const form = postForm(project.slug, "Dark mode");
    form.set("content", content);
    expect(await createPost({}, form)).toEqual({ error });
    expect(await prisma.post.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("images must be finished uploads from the same project; their size comes from the upload", async () => {
    const project = await setup();
    const owner = await prisma.teamMember.findFirstOrThrow({ where: { projectId: project.id }, select: { userId: true } });
    const media = (projectId: string, status: "READY" | "PROCESSING") =>
      prisma.media.create({ data: { projectId, uploaderId: owner.userId, size: 100, status, width: 800, height: 600 } });
    const image = (mediaId: string) => ({
      type: "image",
      attrs: { mediaId, width: "50", align: "center", alt: "Screenshot", w: 1, h: 1 },
    });
    const post = (content: string) => {
      const form = postForm(project.slug, `Post ${crypto.randomUUID()}`);
      form.set("content", content);
      return createPost({}, form);
    };

    const ready = await media(project.id, "READY");
    expect(await post(doc(image(ready.id)))).toEqual({});
    const saved = await prisma.post.findFirstOrThrow({ where: { projectId: project.id } });
    expect(saved.content).toEqual(JSON.parse(doc({ ...image(ready.id), attrs: { ...image(ready.id).attrs, w: 800, h: 600 } })));
    expect((await prisma.media.findUniqueOrThrow({ where: { id: ready.id } })).attachedAt).not.toBeNull();

    const error = { error: "An image is still uploading or can't be used here. Wait for it, or remove it." };
    expect(await post(doc(image((await media(project.id, "PROCESSING")).id)))).toEqual(error);
    const elsewhere = await createProject(await signUp());
    expect(await post(doc(image((await media(elsewhere.id, "READY")).id)))).toEqual(error);
    expect(await prisma.post.count({ where: { projectId: project.id } })).toBe(1);
  });

  test("comments allow formatting and links, but not lists or videos, and can't be empty", async () => {
    const project = await setup();
    await createPost({}, postForm(project.slug, "Dark mode"));
    const post = await prisma.post.findFirstOrThrow({ where: { projectId: project.id } });

    expect(await comment(post.id, { content: doc(p("Agreed, see", [{ type: "link", attrs: { href: "https://example.com" } }])) })).toEqual({});
    expect(await comment(post.id, { content: doc(list) })).toEqual({ error: "This content has something that isn't allowed here." });
    expect(await comment(post.id, { content: doc(video) })).toEqual({ error: "This content has something that isn't allowed here." });
    expect(await comment(post.id, { content: doc({ type: "paragraph" }) })).toEqual({ error: "Write something first" });
    expect(await comment(post.id, { body: "  " })).toEqual({ error: "Write something first" });

    const comments = await prisma.comment.findMany({ where: { postId: post.id } });
    expect(comments.map((c) => c.body)).toEqual(["Agreed, see"]);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).commentCount).toBe(1);
  });
});
