import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { emailedOnCompletion } from "@/server/operations/code-changes";
import { createComment, createPost } from "@/server/operations/create";
import { emailPreferences } from "@/server/operations/email-preferences";
import { mergePost, updatePost } from "@/server/operations/manage";
import { setSubscription, setVote } from "@/server/operations/more";
import { call } from "@/server/operations/run";
import { accountPosts, votersToEmail } from "@/server/post-lists";
import { findOptOut } from "@/server/unsubscribe";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

import { setEmailPreference } from "./email-preferences";

const verified = async (name: string) => {
  const user = await signUp(name);
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  return user;
};
// Sign-up sends a verification email; these are the rest.
const subjectsTo = (user: TestUser) =>
  mailbox.emails.filter((e) => e.to.includes(user.email) && !e.subject.startsWith("Verify your email")).map((e) => e.subject);

/** A project with a post by `author`, voted on by `voter`, commented on by `commenter` and followed by `follower`. */
async function fixture() {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
  const [author, voter, commenter, follower] = [await verified("Author"), await verified("Voter"), await verified("Commenter"), await verified("Follower")];
  const post = await call(createPost, as(author.id), { board: "feature-requests", title: "Dark mode" });
  await call(setVote, as(voter.id), { number: post.number, voted: true });
  await call(createComment, as(commenter.id), { number: post.number, body: "Me too" });
  await call(setSubscription, as(follower.id), { number: post.number, subscribed: true });
  const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number }, select: { id: true } });
  const ship = () => call(updatePost, as(owner.id), { number: post.number, status: "completed" });
  const reply = () => call(createComment, as(owner.id), { number: post.number, body: "Shipping next week.", emailVoters: true });
  return { owner, project, as, post, postId, author, voter, commenter, follower, ship, reply };
}

test('"Posts I wrote" off: its author hears nothing about their post, neither the team\'s reply nor that it shipped; everyone else still does', async () => {
  const { project, postId, author, voter, commenter, follower, ship, reply } = await fixture();
  actAs(author);
  expect(await setEmailPreference(project.slug, "ownPosts", false)).toEqual({});
  expect(await emailPreferences(project.id, author.id)).toEqual({ ownPosts: false, followedPosts: true, unsubscribed: false });

  // Their own post isn't "voted on" for this, though writing it upvoted it.
  expect(await votersToEmail(project.id, postId)).toBe(1);
  expect(await emailedOnCompletion(project.id, [postId])).toEqual(new Map([[postId, 3]]));
  await reply();
  await ship();
  expect(subjectsTo(author)).toEqual([]);
  expect(subjectsTo(voter)).toEqual(["Re: Dark mode", "Done: Dark mode"]);
  expect(subjectsTo(commenter)).toEqual(["Done: Dark mode"]);
  expect(subjectsTo(follower)).toEqual(["Done: Dark mode"]);
});

test('"Posts I voted on or follow" off: voters, commenters and followers who turned it off hear nothing; the author of the post still does', async () => {
  const { project, postId, author, voter, commenter, follower, ship, reply } = await fixture();
  for (const user of [voter, commenter, follower, author]) {
    actAs(user);
    expect(await setEmailPreference(project.slug, "followedPosts", false)).toEqual({});
  }

  expect(await votersToEmail(project.id, postId)).toBe(1);
  expect(await emailedOnCompletion(project.id, [postId])).toEqual(new Map([[postId, 1]]));
  await reply();
  await ship();
  for (const user of [voter, commenter, follower]) {
    expect(subjectsTo(user)).toEqual([]);
  }
  expect(subjectsTo(author)).toEqual(["Re: Dark mode", "Done: Dark mode"]);
});

test('"Stop all emails" is the unsubscribe link\'s opt-out, both ways, and only for that project', async () => {
  const { project, voter, ship } = await fixture();
  const other = await createProject(await signUp("Other owner"));
  const { unsubscribeToken } = await prisma.user.findUniqueOrThrow({ where: { id: voter.id }, select: { unsubscribeToken: true } });

  actAs(voter);
  expect(await setEmailPreference(project.slug, "unsubscribed", true)).toEqual({});
  expect((await findOptOut(project.slug, unsubscribeToken))?.optedOut).toBe(true);
  expect((await findOptOut(other.slug, unsubscribeToken))?.optedOut).toBe(false);
  expect(await setEmailPreference(project.slug, "unsubscribed", false)).toEqual({});
  expect((await findOptOut(project.slug, unsubscribeToken))?.optedOut).toBe(false);

  // Unsubscribing by the link shows on the Account, and stops the emails.
  await (await findOptOut(project.slug, unsubscribeToken))!.optOut();
  expect(await emailPreferences(project.id, voter.id)).toEqual({ ownPosts: true, followedPosts: true, unsubscribed: true });
  await ship();
  expect(subjectsTo(voter)).toEqual([]);

  // Signed out: nothing changes.
  actAs(null);
  expect(await setEmailPreference(project.slug, "unsubscribed", false)).toEqual({ error: "Sign in first" });
  expect(await emailPreferences(project.id, voter.id)).toMatchObject({ unsubscribed: true });
});

test("the Account lists the posts they wrote and those they voted on, in this project only, not others' or merged ones", async () => {
  const { project, as, post, owner, voter, author } = await fixture();
  const own = await call(createPost, as(voter.id), { board: "feature-requests", title: "Keyboard shortcuts" });
  const merged = await call(createPost, as(voter.id), { board: "feature-requests", title: "Dark theme" });
  await call(mergePost, as(owner.id), { number: merged.number, into: post.number });
  await call(createPost, as(author.id), { board: "feature-requests", title: "Not voted on" });
  const other = await createProject(await signUp("Other owner"));
  await call(createPost, { actor: { kind: "user", userId: voter.id }, projectId: other.id }, { board: "feature-requests", title: "Elsewhere" });

  const { posts, votes } = await accountPosts(project.id, voter.id);
  expect(posts.map((p) => p.title)).toEqual(["Keyboard shortcuts"]);
  expect(posts[0]).toMatchObject({ number: own.number, board: { slug: "feature-requests" } });
  expect(votes.map((p) => p.title)).toEqual(["Dark mode"]);
});
