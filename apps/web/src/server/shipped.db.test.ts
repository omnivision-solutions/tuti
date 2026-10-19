import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { beforeEach, describe, expect, test } from "vitest";

import { POST as unsubscribe } from "@/app/portal/[project]/unsubscribe/confirm/route";
import { upsertProjectUser } from "@/lib/sso";
import { createComment, createPost } from "@/server/operations/create";
import { updatePost } from "@/server/operations/manage";
import { setVote } from "@/server/operations/more";
import { call } from "@/server/operations/run";
import { createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = (userId: string) => ({ actor: { kind: "user" as const, userId }, projectId: project.id });
const verified = async (name: string) => {
  const user = await signUp(name);
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  return user;
};
// Sign-up sends a verification email; these are the rest.
const emailsTo = (address: string) =>
  mailbox.emails.filter((e) => e.to.includes(address) && !e.subject.startsWith("Verify your email"));
const setStatus = (number: number, status: "completed" | "open") => call(updatePost, as(owner.id), { number, status });
const tokenOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { unsubscribeToken: true } })).unsubscribeToken;

describe("when a post ships", () => {
  test("its author, voters and commenters hear about it once, at addresses someone vouched for", async () => {
    await prisma.user.update({ where: { id: owner.id }, data: { emailVerified: true } });
    const [author, voter, commenter, unverified] = [
      await verified("Author"),
      await verified("Voter"),
      await verified("Commenter"),
      await signUp("Unverified"),
    ];
    const ssoEmail = `e2e-${randomUUID()}@example.com`;
    const ssoUser = await upsertProjectUser(project.id, `ext-${randomUUID()}`, { name: "From the app", email: ssoEmail });
    const post = await call(createPost, as(author.id), { board: "feature-requests", title: "Dark mode" });
    for (const userId of [voter.id, unverified.id, ssoUser, owner.id]) {
      await call(setVote, as(userId), { number: post.number, voted: true });
    }
    await call(createComment, as(commenter.id), { number: post.number, body: "Yes please" });

    await setStatus(post.number, "completed");

    for (const address of [author.email, voter.email, commenter.email, ssoEmail]) {
      const [email, ...more] = emailsTo(address);
      expect(more).toEqual([]);
      expect(email!.subject).toBe("Done: Dark mode");
      expect(email!.text).toContain(`http://${project.slug}.localhost:3100/p/dark-mode-${post.number}`);
      expect(email!.headers["list-unsubscribe"]).toMatch(
        new RegExp(`^<http://${project.slug}\\.localhost:3100/unsubscribe/confirm\\?token=[0-9a-f-]+>$`),
      );
      expect(email!.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    }
    // Not the team (they shipped it), nor an address nobody verified.
    expect(emailsTo(owner.email)).toEqual([]);
    expect(emailsTo(unverified.email)).toEqual([]);

    // Reopened and completed again: no second email.
    await setStatus(post.number, "open");
    await setStatus(post.number, "completed");
    expect(emailsTo(author.email)).toHaveLength(1);
  });

  test("a mail outage doesn't lose anyone: the retry emails those not reached, once", async () => {
    const [author, voter] = [await verified("Author"), await verified("Voter")];
    const post = await call(createPost, as(author.id), { board: "feature-requests", title: "Offline mode" });
    await call(setVote, as(voter.id), { number: post.number, voted: true });
    const { id: postId } = await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } });
    const log = { info: () => {}, warn: () => {} };

    const port = process.env.SMTP_PORT;
    process.env.SMTP_PORT = "1"; // nothing listens there
    try {
      await setStatus(post.number, "completed"); // the job fails; with inline jobs that's only logged
      await expect(handlers.postShipped({ postId }, log)).rejects.toThrow("2 shipped email(s)");
    } finally {
      process.env.SMTP_PORT = port;
    }
    expect(emailsTo(author.email)).toEqual([]);

    // Hatchet's retry.
    expect(await handlers.postShipped({ postId }, log)).toEqual({ emailed: 2 });
    expect(await handlers.postShipped({ postId }, log)).toEqual({ emailed: 0 });
    expect(emailsTo(author.email)).toHaveLength(1);
    expect(emailsTo(voter.email)).toHaveLength(1);
  });

  test("people who unsubscribed (one click from their mail app) don't hear about it", async () => {
    const [author, voter] = [await verified("Author"), await verified("Voter")];
    const url = (token: string) => `http://${project.slug}.localhost:3100/portal/${project.slug}/unsubscribe/confirm?token=${token}`;
    const params = Promise.resolve({ project: project.slug });
    const oneClick = (token: string) =>
      unsubscribe(new Request(url(token), { method: "POST", body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) }), {
        params,
      });

    expect((await oneClick("not-a-token")).status).toBe(404);
    const response = await oneClick(await tokenOf(voter.id));
    expect(response.status).toBe(200);
    // The unsubscribe page's button goes back to the page.
    const fromPage = await unsubscribe(new Request(url(await tokenOf(author.id)), { method: "POST" }), { params });
    expect(fromPage.status).toBe(303);
    expect(fromPage.headers.get("location")).toBe(`/unsubscribe?token=${await tokenOf(author.id)}`);

    const post = await call(createPost, as(author.id), { board: "feature-requests", title: "Export to CSV" });
    await call(setVote, as(voter.id), { number: post.number, voted: true });
    await setStatus(post.number, "completed");
    expect(emailsTo(voter.email)).toEqual([]);
    expect(emailsTo(author.email)).toEqual([]);

    // Only this project's emails stop.
    const other = await createProject(owner);
    const elsewhere = await call(createPost, { actor: { kind: "user", userId: voter.id }, projectId: other.id }, {
      board: "feature-requests",
      title: "Elsewhere",
    });
    await call(updatePost, { actor: { kind: "user", userId: owner.id }, projectId: other.id }, {
      number: elsewhere.number,
      status: "completed",
    });
    expect(emailsTo(voter.email).map((e) => e.subject)).toEqual(["Done: Elsewhere"]);
  });
});
