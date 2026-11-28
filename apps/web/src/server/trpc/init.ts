import { prisma, type TeamRole } from "@tuti/db";
import { log } from "@tuti/shared";
import { initTRPC, TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";
import superjson from "superjson";

import { type Actor, type Operation, OperationError } from "../operations/define";
import type { TrpcContext } from "./context";

/** tRPC's code for each status an OperationError (or the context) answers with, so the HTTP status stays the same. */
const CODES: Record<number, TRPC_ERROR_CODE_KEY> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  402: "PAYMENT_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "TOO_MANY_REQUESTS",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
};

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // The operation's own code ("not_found", "people_only"), as REST answers it, for clients that branch on it. An
  // unexpected failure's message (a database error, with its query and host) never leaves the server: logged (below).
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    message: error.code === "INTERNAL_SERVER_ERROR" ? "Something went wrong" : shape.message,
    data: { ...shape.data, code: error.cause instanceof OperationError ? error.cause.code : shape.data.code, stack: undefined },
  }),
});

/**
 * A successful call slower than this is logged, and so is every failure that isn't an expected one, with the names of
 * the fields it was given: never their values, which can be a password or a sign-in link.
 */
export const SLOW_MS = 1000;

const logged = t.middleware(async ({ path, type, next, getRawInput }) => {
  const started = performance.now();
  const result = await next();
  const ms = Math.round(performance.now() - started);
  if (result.ok ? ms >= SLOW_MS : result.error.code === "INTERNAL_SERVER_ERROR") {
    const raw = await getRawInput().catch(() => null);
    const fields = raw && typeof raw === "object" ? Object.keys(raw) : [];
    if (result.ok) {
      log.warn("Slow tRPC call", { path, type, ms, fields });
    } else {
      log.error("tRPC call failed", { path, type, ms, fields, error: result.error.cause ?? result.error });
    }
  }
  return result;
});

/** An expected failure (OperationError) as the tRPC error with its HTTP status and message. */
const operationErrors = t.middleware(async ({ next }) => {
  const result = await next();
  const cause = result.ok ? null : result.error.cause;
  if (cause instanceof OperationError) {
    throw new TRPCError({ code: CODES[cause.status] ?? "INTERNAL_SERVER_ERROR", message: cause.message, cause });
  }
  return result;
});

/**
 * A mutation with a cookie must come from the page's own site, as server actions' did (fromOwnSite). Queries change
 * nothing, so one from another site can't act, and can't read its answer.
 */
const sameSite = t.middleware(({ ctx, type, next }) => {
  if (type === "mutation" && ctx.who?.kind === "session" && ctx.who.via === "cookie" && !ctx.sameSite) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Refused: this change didn't come from this site's own page" });
  }
  return next();
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const baseProcedure = t.procedure.use(logged).use(operationErrors).use(sameSite);

/** Signed in, for the account's own procedures, which act in no project. */
export const signedInProcedure = baseProcedure.use(({ ctx, next }) => {
  if (!ctx.who) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to do this" });
  }
  return next({ ctx: { who: ctx.who } });
});

/** The project named by slug in each project procedure's input (a key's own project when it's a key). */
export type ProjectField = { project?: string };

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "No such project, or it isn't yours" });

/**
 * The project a procedure acts in, with who's acting there and their role (null: not on its team), or the refusal: a
 * key acts in its own project only; the app's session as the team (its membership, read once per request) or, for
 * `anyone` operations, as anyone; a portal's session (a reader's, even a teammate's) only on its own project and only
 * where anyone may act. The operation's own access, scope and owner rule are checked next (define.ts: authorize).
 */
export async function projectOf(ctx: TrpcContext & { who: NonNullable<TrpcContext["who"]> }, slug: string | undefined, access: Operation["access"]) {
  const { who } = ctx;
  if (who.kind === "apiKey") {
    if (slug !== undefined && !(await prisma.project.count({ where: { id: who.key.projectId, slug } }))) {
      throw notFound();
    }
    const { role, ...actor } = who.key;
    return { actor: actor as Actor, projectId: who.key.projectId, role: role as TeamRole | null };
  }
  if (!slug) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Say which project: its slug in `project`" });
  }
  const actor: Actor = who.via === "token" ? { kind: "user", userId: who.userId, sessionId: who.sessionId } : { kind: "user", userId: who.userId };
  if (who.boundTo === "app") {
    if (!ctx.memberships.has(slug)) {
      ctx.memberships.set(
        slug,
        prisma.teamMember
          .findFirst({ where: { userId: who.userId, project: { slug } }, select: { projectId: true, role: true } })
          .then((member) => member && { projectId: member.projectId, role: member.role }),
      );
    }
    const member = await ctx.memberships.get(slug)!;
    if (member) {
      return { actor, ...member };
    }
  }
  if (access !== "anyone") {
    throw notFound();
  }
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  if (!project || (who.boundTo !== "app" && who.boundTo !== project.id)) {
    throw notFound();
  }
  return { actor, projectId: project.id, role: null };
}
