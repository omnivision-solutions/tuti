import { randomUUID } from "node:crypto";

import { type Doc, toPlainText } from "@tuti/content";
import { type TeamRole, prisma } from "@tuti/db";
import { vi } from "vitest";
import { docOf, landEdit, lockProject } from "@tuti/jobs";

import { auth } from "@/lib/auth";

import { request } from "./next-headers";

/** Helpers for database tests (*.db.test.ts). Each test file has its own database. */

export type TestUser = { id: string; email: string; cookie: string };

/** Signs up a new user through Better Auth (with a random e2e-…@example.com address unless given one). */
export async function signUp(name = "Test user", email = `e2e-${randomUUID()}@example.com`): Promise<TestUser> {
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, name, password: "correct horse battery staple" },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { id: response.user.id, email, cookie };
}

/** Server actions called after this run as `user`; `null` means signed out. */
export function actAs(user: TestUser | null) {
  request.cookie = user?.cookie ?? "";
}

/** A project owned by `owner`, with one board ("feature-requests"). */
export async function createProject(owner: TestUser) {
  const slug = `p-${randomUUID().slice(0, 8)}`;
  return prisma.project.create({
    data: {
      slug,
      name: `Project ${slug}`,
      team: { create: { userId: owner.id, role: "OWNER" } },
      boards: { create: { slug: "feature-requests", name: "Feature requests" } },
    },
    include: { boards: true, team: true },
  });
}

/** A new user on the project's team with `role`. */
export async function addMember(projectId: string, role: TeamRole) {
  const user = await signUp(`${role.toLowerCase()} user`);
  const member = await prisma.teamMember.create({ data: { projectId, userId: user.id, role } });
  return { ...user, memberId: member.id };
}

/** Where a server action redirected to (it throws Next.js's redirect error). */
export async function redirectTarget(action: Promise<unknown>): Promise<string> {
  const error: unknown = await action.then(
    () => undefined,
    (e: unknown) => e,
  );
  const digest = (error as { digest?: string } | undefined)?.digest ?? "";
  if (!digest.startsWith("NEXT_REDIRECT;")) {
    throw new Error("Expected the action to redirect", { cause: error });
  }
  return digest.split(";")[2]!;
}

/** A reader group's conditions for the people whose `groups` property (an SSO token's `groups`) has `name`. */
export const inGroupNamed = (name: string) => [{ property: "groups", op: "is" as const, value: name }];

/**
 * A pull request's (number `number`) edit to an article, as the analysis saves it: `edit` maps the article's newest
 * text (its unpublished changes, or the published version) to the edit's, and it's saved into the unpublished changes
 * as a revision tagged with its update (landEdit). Returns the update.
 */
export async function landArticleEdit(
  projectId: string,
  articleId: string,
  number: number,
  edit: (doc: Doc) => Doc,
  { probability = 0.9, reason = `PR ${number}'s edit` } = {},
) {
  const change = await prisma.codeChange.upsert({
    where: { projectId_repoId_number: { projectId, repoId: 1, number } },
    create: { projectId, repoId: 1, repo: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, author: "octo", mergedAt: new Date(), state: "READY" },
    update: {},
  });
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId }, select: { body: true, content: true, changes: { select: { body: true, content: true } } } });
  const writtenOn = docOf(article.changes ?? article);
  const doc = edit(writtenOn);
  // The overview covers the edits already waiting, as the analysis writes it.
  const waiting = await prisma.codeChangeAction.findMany({ where: { articleId, kind: "ARTICLE_EDIT", status: { in: ["PENDING", "SCHEDULED"] } }, select: { id: true } });
  const action = await prisma.codeChangeAction.create({
    data: {
      codeChangeId: change.id,
      kind: "ARTICLE_EDIT",
      articleId,
      probability,
      reason,
      payload: { problem: "wrong", title: "", before: toPlainText(writtenOn), body: toPlainText(doc), overview: `${reason}, with ${waiting.length} before it`, overviewOf: waiting.map((one) => one.id) },
    },
  });
  const landed = await prisma.$transaction(async (tx) => {
    await lockProject(tx, projectId);
    return landEdit(tx, articleId, action.id, writtenOn, doc);
  });
  if (landed !== "landed") {
    throw new Error(`The edit didn't land: ${landed}`);
  }
  return action;
}

/** An article's text as sections: a heading and a paragraph each (`##`), or a paragraph alone. */
export function sectionsDoc(...parts: (string | [string, string])[]): Doc {
  return {
    type: "doc",
    content: parts.flatMap((part) =>
      typeof part === "string"
        ? [{ type: "paragraph", content: [{ type: "text", text: part }] }]
        : [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: part[0] }] },
            { type: "paragraph", content: [{ type: "text", text: part[1] }] },
          ],
    ),
  };
}

/**
 * Fails one of the next transactions with `error`, the ones before it (`skip`) going through: applying an Autopilot
 * update claims it in a transaction first, so `skip: 1` fails what comes after the claim (moving the post, its comment).
 */
export function failTransaction(error: Error, { skip = 0 } = {}) {
  const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
  let calls = 0;
  // Gone once it has failed one: later transactions (and another of these) see the real one.
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => {
    if (calls++ < skip) {
      return transaction(...args);
    }
    spy.mockRestore();
    return Promise.reject(error);
  }) as never);
  return spy;
}
