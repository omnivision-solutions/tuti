import { prisma } from "@tuti/db";
import { isValidElement, type ReactNode } from "react";
import { expect, onTestFinished, test, vi } from "vitest";

import { CommentList } from "@/components/comments";
import { SubscribeButton } from "@/components/subscribe-button";
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

/** The text of the page's tree (components in it aren't run). */
const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join("")
    : isValidElement<{ children?: ReactNode }>(node)
      ? textOf(node.props.children)
      : typeof node === "string" || typeof node === "number"
        ? String(node)
        : "";

test("a portal post says when the team expects it, from this month on; not a month that's passed, nor once it's completed or closed", async () => {
  // Mid-month, so the test and the page agree on this month (only Date is faked: the database's timers run).
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.UTC(2026, 10, 15, 12)) });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const now = new Date();
  // Months from this one, as the team's ETA saves them (a month's first day, UTC).
  const month = (from: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + from));
  const label = (date: Date) => date.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const post = await prisma.post.create({
    data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "Dark mode", body: "", status: "PLANNED", eta: month(1) },
  });
  actAs(null);
  const shown = async () =>
    textOf(await PostPage({ params: Promise.resolve({ project: project.slug, board: "feature-requests", post: "dark-mode-1" }), searchParams: Promise.resolve({}) } as never));

  expect(await shown()).toContain(`Expected ${label(month(1))}`);
  // This month: still to come.
  await prisma.post.update({ where: { id: post.id }, data: { eta: month(0) } });
  expect(await shown()).toContain(`Expected ${label(month(0))}`);
  // Last month, and the post still Planned: a missed date isn't shown.
  await prisma.post.update({ where: { id: post.id }, data: { eta: month(-1) } });
  expect(await shown()).not.toContain("Expected");
  // Shipped or closed: nothing left to expect, whatever the month.
  for (const status of ["COMPLETED", "CLOSED"] as const) {
    await prisma.post.update({ where: { id: post.id }, data: { eta: month(1), status } });
    expect(await shown()).not.toContain("Expected");
  }
});

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

test("a team member's comment is the team's, with its badge, unless they wrote it signed in on a portal (a reader's then)", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const post = await prisma.post.create({ data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "Dark mode", body: "" } });
  await prisma.comment.create({ data: { projectId: project.id, postId: post.id, authorId: owner.id, body: "From the app" } });
  await prisma.comment.create({ data: { projectId: project.id, postId: post.id, authorId: owner.id, body: "From the portal", asReader: true } });

  actAs(null);
  const page = await PostPage({ params: Promise.resolve({ project: project.slug, board: "feature-requests", post: "dark-mode-1" }), searchParams: Promise.resolve({}) } as never);
  const shown = textOf(CommentList(propsOf(page, CommentList)!));
  expect(shown.match(/Team/g)).toHaveLength(1);
});

test("Subscribe is there while a post may still ship, signed out and for people its email reaches (who posted, voted or commented already follow); not for an unverified address, someone already told it shipped, nor on a completed or closed post", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const post = await prisma.post.create({
    data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: owner.id, number: 1, title: "Dark mode", body: "" },
  });
  const [verified, unverified] = [await signUp("Verified"), await signUp("Unverified")];
  await prisma.user.update({ where: { id: verified.id }, data: { emailVerified: true } });
  const subscribe = async () =>
    propsOf(
      await PostPage({ params: Promise.resolve({ project: project.slug, board: "feature-requests", post: "dark-mode-1" }), searchParams: Promise.resolve({}) } as never),
      SubscribeButton,
    );

  actAs(null);
  expect(await subscribe()).toMatchObject({ signedIn: false });
  actAs(verified);
  expect(await subscribe()).toMatchObject({ signedIn: true, subscribed: false, following: false });
  // Voting with a subscription, they hear anyway: following, so the line, not a toggle.
  await prisma.postSubscription.create({ data: { postId: post.id, userId: verified.id } });
  await prisma.vote.create({ data: { postId: post.id, userId: verified.id, projectId: project.id } });
  expect(await subscribe()).toMatchObject({ subscribed: true, following: true });
  await prisma.vote.deleteMany({ where: { postId: post.id, userId: verified.id } });
  await prisma.postSubscription.deleteMany({ where: { postId: post.id, userId: verified.id } });
  // Commenting, they hear anyway (as its author and voters do).
  await prisma.comment.create({ data: { postId: post.id, projectId: project.id, authorId: verified.id, body: "Me too" } });
  expect(await subscribe()).toMatchObject({ following: true });
  actAs(owner);
  // The team isn't emailed: no Subscribe.
  expect(await subscribe()).toBeUndefined();
  actAs(verified);
  actAs(unverified);
  expect(await subscribe()).toBeUndefined();
  // As voting: signed in through another project's single sign-on, they can't act here, so it says sign in.
  const fromSso = await signUp("From another app");
  await prisma.user.update({ where: { id: fromSso.id }, data: { emailVerified: true } });
  await prisma.ssoIdentity.create({ data: { projectId: (await createProject(owner)).id, externalId: "user-1", userId: fromSso.id } });
  actAs(fromSso);
  expect(await subscribe()).toMatchObject({ signedIn: false });
  // Told it shipped, then reopened: no email comes again, so neither the button nor the line (a claim not sent yet changes nothing).
  await prisma.shippedEmail.create({ data: { postId: post.id, userId: verified.id } });
  actAs(verified);
  expect(await subscribe()).toMatchObject({ signedIn: true });
  await prisma.shippedEmail.update({ where: { postId_userId: { postId: post.id, userId: verified.id } }, data: { sentAt: new Date() } });
  expect(await subscribe()).toBeUndefined();
  // Not for others.
  actAs(null);
  expect(await subscribe()).toMatchObject({ signedIn: false });
  for (const status of ["COMPLETED", "CLOSED"] as const) {
    await prisma.post.update({ where: { id: post.id }, data: { status } });
    actAs(verified);
    expect(await subscribe()).toBeUndefined();
    actAs(null);
    expect(await subscribe()).toBeUndefined();
  }
});

test("Subscribe and \"You'll hear when it ships.\" follow the Account's switches: its author by Posts I wrote, everyone else by Posts I voted on or follow", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  const verified = async (name: string) => {
    const user = await signUp(name);
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    return user;
  };
  const [ada, bo, cy] = [await verified("Ada"), await verified("Bo"), await verified("Cy")];
  // Ada wrote it (and voted for it, as writing one does); Bo voted; Cy didn't.
  const post = await prisma.post.create({
    data: { projectId: project.id, boardId: project.boards[0]!.id, authorId: ada.id, number: 1, title: "Dark mode", body: "", voteCount: 2 },
  });
  for (const user of [ada, bo]) {
    await prisma.vote.create({ data: { postId: post.id, userId: user.id, projectId: project.id } });
  }
  const subscribe = async () =>
    propsOf(
      await PostPage({ params: Promise.resolve({ project: project.slug, board: "feature-requests", post: "dark-mode-1" }), searchParams: Promise.resolve({}) } as never),
      SubscribeButton,
    );
  const choose = (userId: string, ownPosts: boolean, followedPosts: boolean) =>
    prisma.emailPreference.upsert({
      where: { userId_projectId: { userId, projectId: project.id } },
      create: { userId, projectId: project.id, ownPosts, followedPosts },
      update: { ownPosts, followedPosts },
    });

  // Its author: "Posts I wrote" off, the shipped email won't come, so no line (though their vote is on it).
  await choose(ada.id, false, true);
  actAs(ada);
  expect(await subscribe()).toBeUndefined();
  // Only "Posts I voted on or follow" off: still told, as their own post.
  await choose(ada.id, true, false);
  expect(await subscribe()).toMatchObject({ following: true });

  // A voter: "Posts I voted on or follow" off, neither the line nor Subscribe; only "Posts I wrote" off changes nothing here.
  await choose(bo.id, true, false);
  actAs(bo);
  expect(await subscribe()).toBeUndefined();
  await choose(bo.id, false, true);
  expect(await subscribe()).toMatchObject({ following: true });

  // Not voting: Subscribe would follow it, which that switch turns off, so it isn't offered.
  await choose(cy.id, true, false);
  actAs(cy);
  expect(await subscribe()).toBeUndefined();
  await choose(cy.id, true, true);
  expect(await subscribe()).toMatchObject({ signedIn: true, following: false });
});
