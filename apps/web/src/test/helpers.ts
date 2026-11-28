import { randomUUID } from "node:crypto";

import { type Doc, toPlainText } from "@tuti/content";
import { type Prisma, type TeamRole, prisma } from "@tuti/db";
import { onTestFinished, vi } from "vitest";
import { docOf, landEdit, lockProject } from "@tuti/jobs";

import { auth } from "@/server/auth/auth";
import { appUrl } from "@/lib/hosts";

import { request } from "./next-headers";

/** Helpers for database tests (*.db.test.ts). Each test file has its own database. */

export type TestUser = { id: string; email: string; cookie: string };

/** The test password's hash, made once per file: hashing is slow on purpose, and many tests make a dozen people. */
let passwordHash: Promise<string> | undefined;

/**
 * A new user (with a random e2e-…@example.com address unless given one), its address verified as its emailed link would,
 * signed in with its password through Better Auth (email-verification.db.test.ts signs up through it and opens the link).
 * `verified: false` leaves it unverified afterwards, as on a server without email.
 */
export async function signUp(name = "Test user", email = `e2e-${randomUUID()}@example.com`, { verified = true } = {}): Promise<TestUser> {
  const password = "correct horse battery staple";
  const context = await auth.$context;
  passwordHash ??= context.password.hash(password);
  const user = await context.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "email-password" });
  await context.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await passwordHash });
  // On the app, as a browser would say: a session from no host or an unknown one works nowhere.
  const { headers } = await auth.api.signInEmail({ body: { email, password }, headers: new Headers({ host: appUrl().host }), returnHeaders: true });
  if (!verified) {
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: false } });
  }
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { id: user.id, email, cookie };
}

/**
 * `user`'s sessions as if started on the project's portal ("Continue as"), and requests on its host for the rest of the
 * test. An unverified one's only on a server that sends no email, as the rest of the test then is.
 */
export async function onPortal(user: TestUser, project: { id: string; slug: string }) {
  await prisma.session.updateMany({ where: { userId: user.id }, data: { boundTo: project.id } });
  request.host = `${project.slug}.localhost:3100`;
  // An unverified password account is signed in only on a server that sends no email (server/session.ts).
  const { emailVerified } = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { emailVerified: true } });
  const smtp = process.env.SMTP_HOST;
  if (!emailVerified) {
    vi.stubEnv("SMTP_HOST", "");
  }
  onTestFinished(() => {
    request.host = "";
    vi.stubEnv("SMTP_HOST", smtp);
  });
}

/**
 * `run` on a server that sends no email (no SMTP_HOST), where an account is signed in without a verified address: on one
 * that sends email, the app has no session for it (server/session.ts).
 */
export async function withoutEmail<T>(run: () => Promise<T>): Promise<T> {
  const smtp = process.env.SMTP_HOST;
  vi.stubEnv("SMTP_HOST", "");
  try {
    return await run();
  } finally {
    vi.stubEnv("SMTP_HOST", smtp);
  }
}

/** Server actions called after this run as `user`; `null` means signed out. */
export function actAs(user: TestUser | null) {
  request.cookie = user?.cookie ?? "";
}

/** A tRPC caller as the request's own session (actAs, onPortal), as a page or the browser calls the router. */
export async function callerNow() {
  const [{ createCaller }, { sessionContext }, { getSession }] = await Promise.all([import("@/server/trpc/server"), import("@/server/trpc/context"), import("@/server/session")]);
  return createCaller(sessionContext(await getSession()));
}

/**
 * The uploads.* procedures (server/operations/uploads.ts) as the request's own session calls them (actAs, onPortal), with
 * a refusal as `{ error }`, its message: what the app shows. finish and status name `slug`'s project, as the app does.
 */
export async function uploadsAs(slug: () => string) {
  const [{ createCaller }, { sessionContext }, { getSession }, { TRPCError }] = await Promise.all([
    import("@/server/trpc/server"),
    import("@/server/trpc/context"),
    import("@/server/session"),
    import("@trpc/server"),
  ]);
  const caller = async () => createCaller(sessionContext(await getSession()));
  const said = async <T,>(call: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof TRPCError) {
        return { error: error.message };
      }
      throw error;
    }
  };
  return {
    createUpload: (project: string, file: { type: string; size: number; name?: string }) => said(async () => (await caller()).uploads.create({ project, ...file })),
    finishUpload: (mediaId: string) => said(async () => (await caller()).uploads.finish({ project: slug(), mediaId })),
    uploadStatus: (mediaId: string) => said(async () => (await caller()).uploads.status({ project: slug(), mediaId })),
  };
}

/**
 * A tRPC caller (server/trpc), in process as pages, REST and MCP call the router: as a user by their cookie (on the app,
 * or the portal's host onPortal set), as nobody (null), or as a project API key by its id (with its creator's current
 * role). Each call names its project, as the app's do: `caller.aiFirst.get({ project: slug })`.
 */
export async function callerAs(who: TestUser | null | { apiKeyId: string }) {
  // Imported here: the router imports every operation, which a test file that doesn't call it needn't load.
  const [{ createCaller }, { keyContext, sessionContext }, { sessionFrom }] = await Promise.all([import("@/server/trpc/server"), import("@/server/trpc/context"), import("@/server/session")]);
  if (who && "apiKeyId" in who) {
    const key = await prisma.apiKey.findUniqueOrThrow({ where: { id: who.apiKeyId }, select: { id: true, projectId: true, scope: true, createdById: true } });
    const member = await prisma.teamMember.findUnique({ where: { projectId_userId: { projectId: key.projectId, userId: key.createdById } }, select: { role: true } });
    if (!member) {
      throw new Error("This key's creator left the team: the key doesn't work (api-auth.ts: authenticate)");
    }
    const scope = key.scope === "WRITE" ? ("write" as const) : ("read" as const);
    return createCaller(keyContext({ kind: "apiKey", keyId: key.id, projectId: key.projectId, scope, createdById: key.createdById, role: member.role }));
  }
  const headers = new Headers({ host: request.host || appUrl().host, ...(who && { cookie: who.cookie }) });
  return createCaller(sessionContext(who && (await sessionFrom(headers, { refresh: false }))));
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

/** What the check saves on an edit it passed that is a small correction in place (E5, E6): it may go out by itself. */
export const PASSED_CHECK = { pass: true, reasons: [], hints: [], verdict: "accept", scope: "correction" };

/**
 * A pull request's (number `number`) edit to an article, as the analysis saves it: `edit` maps the article's newest
 * text (its unpublished changes, or the published version) to the edit's, and it's saved into the unpublished changes
 * as a revision tagged with its update (landEdit), with the check's result (`check`: by default passed, a small
 * correction, so it may go out by itself; null for none, as an edit saved before the check). Returns the update.
 */
export async function landArticleEdit(
  projectId: string,
  articleId: string,
  number: number,
  edit: (doc: Doc) => Doc,
  { probability = 0.9, reason = `PR ${number}'s edit`, check = PASSED_CHECK as Prisma.InputJsonObject | null } = {},
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
      payload: { problem: "wrong", title: "", before: toPlainText(writtenOn), body: toPlainText(doc), overview: `${reason}, with ${waiting.length} before it`, overviewOf: waiting.map((one) => one.id), ...(check && { check }) },
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

/**
 * Fails, with `error`, the first team lookup (server/session.ts onTeam) made once the post has a comment: something failing
 * right after a comment was saved. Returns whether it has failed yet.
 */
export function failTeamLookupAfterComment(postId: string, error = new Error("database blip")) {
  const findMember = prisma.teamMember.findUnique.bind(prisma.teamMember) as (...args: unknown[]) => Promise<unknown>;
  let failed = false;
  vi.spyOn(prisma.teamMember, "findUnique").mockImplementation((async (args: { where?: { projectId_userId?: unknown } }) => {
    if (!failed && args?.where?.projectId_userId !== undefined && (await prisma.comment.count({ where: { postId } })) > 0) {
      failed = true;
      throw error;
    }
    return findMember(args);
  }) as never);
  return () => failed;
}

/** Waits until `count` queries in this database (one by default) wait on a lock (another transaction holds what they need). */
export async function untilWaitingOnLock(count = 1) {
  for (let i = 0; i < 200; i++) {
    const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Nothing waited on a lock");
}

/** What a save through the router answers, as the app's forms show it: nothing, or the refusal's message. */
async function asForm(save: () => Promise<unknown>): Promise<{ error?: string }> {
  return save().then(
    () => ({}),
    (error: Error) => ({ error: error.message }),
  );
}

/** The request's cookie session's caller (actAs), as a page's client calls /api/trpc. */
async function cookieCallerNow() {
  const [{ createCaller }, { sessionContext }, { getSession }] = await Promise.all([import("@/server/trpc/server"), import("@/server/trpc/context"), import("@/server/session")]);
  return createCaller(sessionContext(await getSession()));
}

/**
 * A post's comment as the post page's form sends it (comments.create through the router, as whoever actAs() signed in):
 * its `postId`, `body`, `content`, `replyTo`, `internal` and `emailVoters` fields, as the form has them.
 */
export async function addComment(_prev: object, form: FormData): Promise<{ error?: string }> {
  const value = (name: string) => {
    const field = form.get(name);
    return typeof field === "string" ? field : undefined;
  };
  const post = await prisma.post.findUnique({ where: { id: value("postId") ?? "" }, select: { number: true, project: { select: { slug: true } } } });
  if (!post) {
    return { error: "Post not found" };
  }
  const caller = await cookieCallerNow();
  return asForm(() =>
    caller.comments.create({
      project: post.project.slug,
      number: post.number,
      content: value("content") || undefined,
      body: value("body"),
      ...(value("internal") === "on" && { internal: true }),
      ...(value("emailVoters") === "on" && { emailVoters: true }),
      replyTo: value("replyTo") || undefined,
    }),
  );
}

/** A comment's like as its button sends it (comments.like through the router, as whoever actAs() signed in). */
export async function setCommentLike(commentId: string, liked: boolean): Promise<{ error?: string }> {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, select: { post: { select: { number: true, project: { select: { slug: true } } } } } });
  if (!comment) {
    return { error: "Comment not found" };
  }
  const caller = await cookieCallerNow();
  return asForm(() => caller.comments.like({ project: comment.post.project.slug, number: comment.post.number, id: commentId, liked }));
}
