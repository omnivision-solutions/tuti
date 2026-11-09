import { prisma } from "@tuti/db";
import { expect, test, vi } from "vitest";

import { createComment, createPost, orNoSuchComment } from "@/server/operations/create";
import { mergePost } from "@/server/operations/manage";
import { likeComment } from "@/server/operations/more";
import { listComments } from "@/server/operations/read";
import { call } from "@/server/operations/run";
import { setCommentLike } from "@/server/posts";
import { actAs, createProject, signUp } from "@/test/helpers";

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const reader = await signUp("Rae Reader");
  const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
  const post = await call(createPost, as(reader.id), { board: "feature-requests", title: "Dark mode" });
  return { owner, project, reader, as, post };
}

test("replies: one level deep, under their comment oldest first whichever way the thread is sorted, and counted", async () => {
  const { owner, project, reader, as, post } = await setup();
  const first = await call(createComment, as(reader.id), { number: post.number, body: "Please!" });
  await call(createComment, as(reader.id), { number: post.number, body: "Also on phones" });
  const reply = await call(createComment, as(owner.id), { number: post.number, body: "On it", replyTo: first.id });
  expect(reply).toMatchObject({ replyTo: first.id });
  // A reply to a reply goes under the comment it answers.
  const deeper = await call(createComment, as(reader.id), { number: post.number, body: "Thanks!", replyTo: reply.id });
  expect(deeper).toMatchObject({ replyTo: first.id });
  // Not a comment on this post, nor with a note.
  const other = await call(createPost, as(reader.id), { board: "feature-requests", title: "Night theme" });
  await expect(call(createComment, as(reader.id), { number: other.number, body: "Wrong post", replyTo: first.id })).rejects.toThrow("There's no such comment on this post");
  await expect(call(createComment, as(owner.id), { number: post.number, body: "Note", internal: true, replyTo: first.id })).rejects.toThrow("can't reply");

  const order = async (sort: "oldest" | "newest") =>
    (await call(listComments, as(reader.id), { number: post.number, sort })).comments.map((c) => [c.body, c.replyTo]);
  expect(await order("oldest")).toEqual([
    ["Please!", null],
    ["On it", first.id],
    ["Thanks!", first.id],
    ["Also on phones", null],
  ]);
  expect(await order("newest")).toEqual([
    ["Also on phones", null],
    ["Please!", null],
    ["On it", first.id],
    ["Thanks!", first.id],
  ]);
  expect((await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } })).commentCount).toBe(4);

  // Its comment gone (its author's account deleted, Autopilot's comment undone): its replies stay, as comments of their own.
  await prisma.comment.delete({ where: { id: first.id } });
  expect(await order("oldest")).toEqual([
    ["Also on phones", null],
    ["On it", null],
    ["Thanks!", null],
  ]);
});

test("likes: one each, taken back, counted for everyone, and only on comments the caller may see", async () => {
  const { owner, reader, as, post } = await setup();
  const comment = await call(createComment, as(reader.id), { number: post.number, body: "Please!" });
  expect(await call(likeComment, as(owner.id), { number: post.number, id: comment.id, liked: true })).toEqual({ id: comment.id, liked: true, likes: 1 });
  // Twice is once.
  expect((await call(likeComment, as(reader.id), { number: post.number, id: comment.id, liked: true })).likes).toBe(2);
  expect((await call(likeComment, as(reader.id), { number: post.number, id: comment.id, liked: true })).likes).toBe(2);
  const seen = async (userId: string) => (await call(listComments, as(userId), { number: post.number })).comments[0];
  expect(await seen(reader.id)).toMatchObject({ likes: 2, liked: true });
  expect((await call(likeComment, as(reader.id), { number: post.number, id: comment.id, liked: false })).likes).toBe(1);
  expect(await seen(reader.id)).toMatchObject({ likes: 1, liked: false });
  expect(await seen(owner.id)).toMatchObject({ likes: 1, liked: true });

  // An internal note isn't a comment: nobody likes one.
  const note = await call(createComment, as(owner.id), { number: post.number, body: "Big customer", internal: true });
  await expect(call(likeComment, as(owner.id), { number: post.number, id: note.id, liked: true })).rejects.toThrow("There's no such comment on this post");

  // Merged into another post, its comments' likes go with them.
  const other = await call(createPost, as(reader.id), { board: "feature-requests", title: "Night theme" });
  await call(mergePost, as(owner.id), { number: post.number, into: other.number });
  // Liked through the post it was merged from: refused, and nothing written (its comments are the other post's now).
  await expect(call(likeComment, as(owner.id), { number: post.number, id: comment.id, liked: false })).rejects.toThrow("merged");
  expect((await call(listComments, as(reader.id), { number: other.number })).comments[0]).toMatchObject({ body: "Please!", likes: 1 });

  // The portal's action: signed out, asked to sign in; signed in, it likes.
  actAs(null);
  expect(await setCommentLike(comment.id, true)).toEqual({ error: "Sign in to like comments" });
  const fan = await signUp("Fay Fan");
  actAs(fan);
  expect(await setCommentLike(comment.id, true)).toEqual({});
  expect(await prisma.commentLike.count({ where: { commentId: comment.id } })).toBe(2);
});

test("a reply or a like whose comment is deleted as it's written (its foreign key fails): \"There's no such comment\", not a crash", async () => {
  const { owner, project, reader, as, post } = await setup();
  const comment = await call(createComment, as(reader.id), { number: post.number, body: "Please!" });
  await prisma.comment.delete({ where: { id: comment.id } });
  // What the database says when the comment went between the read and the write.
  await expect(orNoSuchComment(comment.id, () => prisma.commentLike.create({ data: { commentId: comment.id, userId: owner.id } }))).rejects.toThrow(
    "There's no such comment on this post",
  );
  const postId = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id } })).id;
  await expect(
    orNoSuchComment(comment.id, () => prisma.comment.create({ data: { projectId: project.id, postId, authorId: owner.id, body: "Late", parentId: comment.id } })),
  ).rejects.toThrow("There's no such comment on this post");
  // A reply to a reply names the top-level comment: that one deleted between the read and the write (the reply it
  // answers kept, by a writer that doesn't lock the post, like an account's deletion), still "no such comment".
  const top = await call(createComment, as(reader.id), { number: post.number, body: "Top" });
  const answer = await call(createComment, as(owner.id), { number: post.number, body: "Answer", replyTo: top.id });
  const transaction = prisma.$transaction.bind(prisma);
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((run: (tx: typeof prisma) => Promise<unknown>) =>
    transaction((tx) =>
      run(
        new Proxy(tx, {
          get: (target, key) =>
            key === "comment"
              ? {
                  ...target.comment,
                  create: async (args: Parameters<typeof target.comment.create>[0]) => {
                    await prisma.comment.delete({ where: { id: top.id } });
                    return target.comment.create(args);
                  },
                }
              : Reflect.get(target, key),
        }) as typeof prisma,
      ),
    )) as unknown as typeof prisma.$transaction);
  try {
    await expect(call(createComment, as(owner.id), { number: post.number, body: "Late", replyTo: answer.id })).rejects.toThrow(
      "There's no such comment on this post",
    );
  } finally {
    spy.mockRestore();
  }
  expect(await prisma.comment.count({ where: { id: answer.id } })).toBe(1);
  // A failure that isn't about the comment is left as it is.
  const kept = await call(createComment, as(reader.id), { number: post.number, body: "Still here" });
  await expect(orNoSuchComment(kept.id, () => prisma.commentLike.create({ data: { commentId: kept.id, userId: "no-such-user" } }))).rejects.toMatchObject({ code: "P2003" });
  // And through the operations, once it's gone.
  await expect(call(likeComment, as(owner.id), { number: post.number, id: comment.id, liked: true })).rejects.toThrow("There's no such comment on this post");
  await expect(call(createComment, as(owner.id), { number: post.number, body: "Late", replyTo: comment.id })).rejects.toThrow("There's no such comment on this post");
});
