import { log } from "@tuti/shared";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { ContextError, requestContext } from "@/server/trpc/context";
import { appRouter } from "@/server/trpc/router";

/**
 * Every call from the web app, the portal, the widget and the mobile app (docs/plan.md, "One way in"). Queries are GETs
 * and mutations POSTs only; a mutation with a cookie must come from the page's own site (server/trpc/init.ts: sameSite).
 */
function handler(request: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: async () => {
      try {
        return await requestContext(request.headers);
      } catch (error) {
        if (error instanceof ContextError) {
          throw new TRPCError({ code: error.status === 429 ? "TOO_MANY_REQUESTS" : "UNAUTHORIZED", message: error.message });
        }
        // Answered "Something went wrong" (server/trpc/init.ts): what it was is in the log only.
        log.error("Reading who's calling /api/trpc failed", { error });
        throw error;
      }
    },
    responseMeta: () => ({ headers: new Headers({ "cache-control": "private, no-store" }) }),
  });
}

export { handler as GET, handler as POST };
