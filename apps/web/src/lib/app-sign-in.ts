import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { log } from "@tuti/shared";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";

import { requestTarget } from "@/server/custom-domains";

/**
 * Signing in from Tuti's mobile app (docs/plan.md, Mobile app). The app has no web view of its own for it: Google,
 * GitHub and an emailed link finish in the device's browser, which then opens the app through its link scheme with the
 * session (Better Auth's Expo plugin, lib/auth.ts). Only this scheme is trusted, on the app's host only, on every
 * server: a self-hosted one needs no setting for it.
 */
export const APP_ORIGIN = "tuti://";

/** What the app made up when it asked for a link, which it gets back with the session: it takes no session it didn't ask for. */
const APP_SIGN_IN_STATE = /^[A-Za-z0-9_-]{16,128}$/;
export const isAppSignInState = (state: unknown): state is string => typeof state === "string" && APP_SIGN_IN_STATE.test(state);

/** Where an emailed link's "Open the app" sends the browser: the app, which checks `state`. */
export const appSignInReturn = (state: string) => `${APP_ORIGIN}sign-in?state=${state}`;

/**
 * POST /api/auth/app/sign-in-link `{ email, state }`: emails an account a link that signs the app in (the page it opens:
 * /app/auth/app-link). Under the limits of every emailed link (server/email-link-limits.ts), and it answers the same
 * whether or not the address has an account: one without gets nothing, as the app has no sign-up.
 */
export const appSignIn = () =>
  ({
    id: "tuti-app-sign-in",
    endpoints: {
      appSignInLink: createAuthEndpoint(
        "/app/sign-in-link",
        {
          method: "POST",
          body: z.object({ email: z.string().trim().toLowerCase().max(320).pipe(z.email()), state: z.string().regex(APP_SIGN_IN_STATE) }),
        },
        async (ctx) => {
          const headers = ctx.headers ?? new Headers();
          if (!emailConfigured() || (await requestTarget(headers.get("host"))).kind !== "app") {
            throw new APIError("BAD_REQUEST", { message: "Sign-in links aren't available here." });
          }
          const { email, state } = ctx.body;
          const account = await prisma.user.findUnique({ where: { email }, select: { id: true } });
          // Imported here: both import lib/auth.ts, which imports this file.
          const { countEmailedLink } = await import("@/server/email-link-limits");
          const limited = await countEmailedLink(null, email, headers, account ? "address" : "nobody");
          if ("error" in limited) {
            throw new APIError("TOO_MANY_REQUESTS", { message: limited.error });
          }
          if (limited.id && account) {
            try {
              const { auth } = await import("./auth");
              await auth.api.signInMagicLink({ body: { email, metadata: { linkId: limited.id, app: state } }, headers });
            } catch (error) {
              // Only an address with an account gets this far, so the answer stays the same.
              log.error("Sending the app's sign-in link failed", { error });
            }
          }
          return ctx.json({ status: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
