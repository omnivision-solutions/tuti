import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { emailedOnCompletion } from "@/server/operations/code-changes";
import { createPost } from "@/server/operations/create";
import { mergePost, updatePost } from "@/server/operations/manage";
import { setSubscription, setVote } from "@/server/operations/more";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { setPostSubscription } from "./posts";

const verified = async (name: string) => {
  const user = await signUp(name);
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  return user;
};
// Sign-up sends a verification email; these are the rest.
const emailsTo = (address: string) => mailbox.emails.filter((e) => e.to.includes(address) && !e.subject.startsWith("Verify your email"));

async function fixture() {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
  const author = await verified("Author");
  const post = await call(createPost, as(author.id), { board: "feature-requests", title: "Dark mode" });
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  const subscribers = () => prisma.postSubscription.findMany({ where: { postId }, select: { userId: true } });
  return { owner, project, as, post, postId, subscribers };
}

test("Subscribe and Unsubscribe on a post, signed in; signed out it asks to sign in", async () => {
  const { postId, subscribers } = await fixture();
  const reader = await verified("Reader");

  actAs(null);
  expect(await setPostSubscription(postId, true)).toEqual({ error: "Sign in to subscribe" });
  expect(await subscribers()).toEqual([]);

  actAs(reader);
  expect(await setPostSubscription(postId, true)).toEqual({});
  // Twice is still once.
  expect(await setPostSubscription(postId, true)).toEqual({});
  expect(await subscribers()).toEqual([{ userId: reader.id }]);
  expect(await setPostSubscription(postId, false)).toEqual({});
  expect(await subscribers()).toEqual([]);
});

test("the shipped email reaches a subscriber who didn't vote, a voter who also subscribed once, and nobody who unsubscribed from the project's email", async () => {
  const { owner, project, as, post, postId } = await fixture();
  const [follower, voter, optedOut] = [await verified("Follower"), await verified("Voter"), await verified("Opted out")];
  for (const user of [follower, voter, optedOut]) {
    await call(setSubscription, as(user.id), { number: post.number, subscribed: true });
  }
  await call(setVote, as(voter.id), { number: post.number, voted: true });
  await prisma.emailOptOut.create({ data: { userId: optedOut.id, projectId: project.id } });

  // The team is told first who completing it emails: the author, the follower and the voter, each once.
  expect(await emailedOnCompletion(project.id, [postId])).toEqual(new Map([[postId, 3]]));
  await call(updatePost, as(owner.id), { number: post.number, status: "completed" });

  expect(emailsTo(follower.email).map((email) => email.subject)).toEqual(["Done: Dark mode"]);
  // Why it came, theirs among the reasons.
  expect(emailsTo(follower.email)[0]!.text).toContain("posted, voted, commented on or subscribed to it");
  expect(emailsTo(voter.email).map((email) => email.subject)).toEqual(["Done: Dark mode"]);
  expect(emailsTo(optedOut.email)).toEqual([]);
});

test("a merge moves its subscribers to the post it's merged into (each once), and a merged post takes no more", async () => {
  const { as, post, project, owner, postId, subscribers } = await fixture();
  const [both, onlyHere] = [await verified("Both"), await verified("Only here")];
  const target = await call(createPost, as(owner.id), { board: "feature-requests", title: "Night theme" });
  await call(setSubscription, as(both.id), { number: target.number, subscribed: true });
  for (const user of [both, onlyHere]) {
    await call(setSubscription, as(user.id), { number: post.number, subscribed: true });
  }

  await call(mergePost, as(owner.id), { number: post.number, into: target.number });

  expect(await subscribers()).toEqual([]);
  const moved = await prisma.postSubscription.findMany({ where: { post: { projectId: project.id, number: target.number } }, select: { userId: true } });
  expect(moved.map((s) => s.userId).sort()).toEqual([both.id, onlyHere.id].sort());
  actAs(both);
  expect(await setPostSubscription(postId, true)).toEqual({ error: "This post was merged into another one; follow that one instead" });
});
