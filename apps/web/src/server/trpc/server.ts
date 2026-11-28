import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { getSession } from "../session";
import { sessionContext, type TrpcContext } from "./context";
import { createCallerFactory } from "./init";
import { appRouter } from "./router";

/** A caller for in-process use with a context already built (REST, MCP, tests). */
export const createCaller = (context: TrpcContext) => createCallerFactory(appRouter)(context);

/**
 * What a server-rendered page reads through: the router in process, as the request's cookie session (read once per
 * request, however many procedures the page calls). Not signed in: the sign-in page (`signIn`, the page's own); not
 * allowed or not found: a 404. No same-site check here: a page opened from a bookmark or an email's link loads.
 */
export const serverCaller = cache(async (signIn = "/app/auth/sign-in") => {
  const caller = createCaller(sessionContext(await getSession()));
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
