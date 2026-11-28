import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { type Operation, OperationError } from "../operations/define";
import { getSession } from "../session";
import { readerCookies, sessionContext, type TrpcContext } from "./context";
import { createCallerFactory } from "./init";
import { appRouter } from "./router";

/** A caller for in-process use with a context already built (REST, MCP, tests). */
export const createCaller = (context: TrpcContext) => createCallerFactory(appRouter)(context);

/** For a route that stays a route (an image, a poll): the router in process, as the request's cookie session. */
export const cookieCaller = async () => createCaller(sessionContext(await getSession()));

/**
 * A route's call through the router: its result, or null where the router refuses (not signed in, not allowed, not
 * found, an input it won't take). Anything else (the database unreachable) throws.
 */
export async function unlessRefused<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR") {
      return null;
    }
    throw error;
  }
}

/**
 * An operation through the router, for REST and MCP: its result, or the failure as they've always answered it (an
 * operation's own status, code and message; a bad input as `field: what's wrong`; anything unexpected "Something went
 * wrong", logged by the router).
 */
export async function callOperation(
  context: TrpcContext,
  operation: Operation,
  input: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; status: number; code: string; message: string }> {
  const [group, name] = operation.name.split(".") as [string, string];
  const procedures = createCaller(context) as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
  try {
    // Through `.call`: the caller reads a procedure called `apply` or `call` (codeChangeActions.apply) as the function's own.
    return { ok: true, result: await procedures[group]![name]!.call(undefined, input) };
  } catch (error) {
    const cause = error instanceof TRPCError ? error.cause : error;
    if (cause instanceof OperationError) {
      const rest = { ...input };
      delete rest.project;
      const issue = cause.code === "invalid_input" ? operation.input.safeParse(rest).error?.issues[0] : undefined;
      return { ok: false, status: cause.status, code: cause.code, message: issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : cause.message };
    }
    if (error instanceof TRPCError && error.code !== "INTERNAL_SERVER_ERROR") {
      return { ok: false, status: getHTTPStatusCodeFromError(error), code: error.code.toLowerCase(), message: error.message };
    }
    return { ok: false, status: 500, code: "internal_error", message: "Something went wrong" };
  }
}

/**
 * What a server-rendered page reads through: the router in process, as the request's cookie session (read once per
 * request, however many procedures the page calls), with the reader's cookies. Not signed in: the sign-in page (`signIn`,
 * the page's own); not allowed or not found: a 404. No same-site check here: a page opened from a bookmark or an email's link loads.
 */
export const serverCaller = cache(async (signIn = "/app/auth/sign-in") => {
  // With the reader's cookies (Customize's preview, the widget's reader cookie): what the page may read, as proxy.ts let it.
  const caller = createCaller(sessionContext(await getSession(), readerCookies(await headers())));
  // Not `then`: awaiting the caller asks for it, and the caller isn't a promise.
  return new Proxy(caller, { get: (target, group) => (group === "then" ? undefined : wrap(Reflect.get(target, group) as object, signIn)) }) as typeof caller;
});

/** Each procedure of a group, its errors turned into the page's answers. */
function wrap(group: object, signIn: string) {
  return new Proxy(group, {
    get: (target, name) => {
      const procedure = Reflect.get(target, name) as (input: unknown) => Promise<unknown>;
      return async (input: unknown) => {
        try {
          return await procedure(input);
        } catch (error) {
          if (error instanceof TRPCError && error.code === "UNAUTHORIZED") {
            redirect(signIn);
          }
          if (error instanceof TRPCError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")) {
            notFound();
          }
          throw error;
        }
      };
    },
  });
}
