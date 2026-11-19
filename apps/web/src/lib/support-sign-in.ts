import { prisma } from "@tuti/db";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

import { requestTarget } from "@/server/custom-domains";

import { hashSecret, isSecret } from "./portal-handoff";

/**
 * Support's sign-in as a customer: `scripts/sign-in-as.mjs` (maintainers, with the database) stores a one-time token's
 * hash in `verification` for 10 minutes and prints this endpoint's link. Opening it on the app's host uses the token
 * once and signs the browser in as that account until the browser closes (at most a day: Better Auth's "don't remember
 * me"). Minting one needs write access to the database, which can make any session already, so this adds no power.
 */

/** The `verification` row's identifier, before the token's hash. */
export const SUPPORT_SIGN_IN_PREFIX = "support-sign-in:";

export const supportSignIn = () =>
  ({
    id: "tuti-support-sign-in",
    endpoints: {
      supportSignIn: createAuthEndpoint("/support/sign-in", { method: "GET", query: z.object({ token: z.string().max(100) }) }, async (ctx) => {
        const failed = () => ctx.redirect("/app/auth/sign-in");
        if ((await requestTarget(ctx.headers?.get("host") ?? null)).kind !== "app" || !isSecret(ctx.query.token)) {
          throw failed();
        }
        // Deleting it first makes the token single use, whatever happens next.
        const [row] = await prisma.$queryRaw<{ value: string; expiresAt: Date }[]>`
          DELETE FROM verification WHERE identifier = ${SUPPORT_SIGN_IN_PREFIX + hashSecret(ctx.query.token)}
          RETURNING value, "expiresAt"`;
        const user = row && row.expiresAt > new Date() ? await ctx.context.internalAdapter.findUserById(row.value) : null;
        if (!user) {
          throw failed();
        }
        const session = await ctx.context.internalAdapter.createSession(user.id, true);
        await setSessionCookie(ctx, { session, user }, true);
        throw ctx.redirect("/app");
      }),
    },
  }) satisfies BetterAuthPlugin;
