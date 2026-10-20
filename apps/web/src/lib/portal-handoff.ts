import { createHash, randomBytes } from "node:crypto";

import { prisma } from "@tuti/db";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

import { requestTarget } from "@/server/custom-domains";
import { safeRedirectPath } from "./redirects";

/**
 * "Continue as <name>": signing a Tuti account into a portal without sharing
 * cookies between hosts.
 *
 * 1. The portal's `/continue` sets a random state in a host-only cookie and sends
 *    the browser to the app host's `/continue` with that state.
 * 2. There, the signed-in account confirms; the app host stores a one-time code
 *    bound to the portal, the account and the state, and sends the browser back.
 * 3. The portal's callback (below) uses the code once, checks it was issued for
 *    this portal and this browser's state cookie, and starts its own session.
 *
 * The state cookie stops login CSRF: a code someone obtained for their own
 * account can't be used to sign another browser into the portal as them.
 */

export const HANDOFF_STATE_COOKIE = "tuti_continue";
export const HANDOFF_TTL_SECONDS = 60;
/** How long the portal waits for the person to confirm on the app host. */
export const HANDOFF_STATE_TTL_SECONDS = 10 * 60;

export const randomSecret = () => randomBytes(32).toString("base64url");
export const isSecret = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
/** Only hashes are stored, so a database leak doesn't reveal usable codes. */
export const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");

export const portalHandoff = () =>
  ({
    id: "tuti-portal-handoff",
    endpoints: {
      portalContinue: createAuthEndpoint(
        "/continue/callback",
        { method: "GET", query: z.object({ code: z.string().max(100), redirect: z.string().max(2048).optional() }) },
        async (ctx) => {
          const target = await requestTarget(ctx.headers?.get("host") ?? null);
          if (target.kind !== "portal") {
            throw ctx.redirect("/");
          }
          const state = ctx.getCookie(HANDOFF_STATE_COOKIE);
          ctx.setCookie(HANDOFF_STATE_COOKIE, "", { path: "/", maxAge: 0 });
          const failed = () => ctx.redirect("/sign-in?continue=failed");

          const { code } = ctx.query;
          if (!isSecret(code) || !isSecret(state)) {
            throw failed();
          }
          // Deleting it first makes the code single use, whatever happens next.
          const [handoff] = await prisma.$queryRaw<{ userId: string; projectId: string; stateHash: string; expiresAt: Date }[]>`
            DELETE FROM portal_handoff WHERE "codeHash" = ${hashSecret(code)}
            RETURNING "userId", "projectId", "stateHash", "expiresAt"`;
          await prisma.portalHandoff.deleteMany({ where: { expiresAt: { lt: new Date() } } });
          const project = await prisma.project.findUnique({ where: { slug: target.slug }, select: { id: true } });
          if (
            !handoff ||
            handoff.projectId !== project?.id ||
            handoff.stateHash !== hashSecret(state) ||
            handoff.expiresAt < new Date()
          ) {
            throw failed();
          }

          const user = await ctx.context.internalAdapter.findUserById(handoff.userId);
          if (!user) {
            throw failed();
          }
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          throw ctx.redirect(safeRedirectPath(ctx.query.redirect, "/"));
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
