import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Prisma, prisma } from "@tuti/db";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { errors as joseErrors, jwtVerify } from "jose";
import { z } from "zod";

import { resolveHost } from "./hosts";
import { safeRedirectPath } from "./redirects";

/**
 * JWT single sign-on.
 *
 * A project's own app signs a short-lived HS256 token with the project's SSO
 * secret and sends the user to `<project portal>/sso?token=…&redirect=…`. We verify
 * it, find or create the user and sign them in. The project is taken from the
 * request's host, so the session cookie is only ever set on that project's portal.
 *
 * Users are matched by `sub` (the user's id in the project's app), never by email:
 * a project controls everything in its tokens, so trusting email would let it sign
 * in as any Tuti user. Each (project, sub) therefore gets its own User.
 */

/** Longest allowed gap between `iat` and `exp`. Tokens are meant to be used immediately. */
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60;
const CLOCK_TOLERANCE_SECONDS = 30;

export const SSO_ERROR_CODES = [
  "sso_not_enabled",
  "invalid_token",
  "expired_token",
  "token_lifetime_too_long",
  "token_already_used",
  "invalid_claims",
] as const;
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  jti: z.string().min(1).max(255),
  iat: z.number(),
  exp: z.number(),
  email: z.email().max(320).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  avatar: z.url({ protocol: /^https?$/ }).max(2048).optional(),
});

const querySchema = z.object({
  token: z.string().min(1).max(8192),
  redirect: z.string().max(2048).optional(),
});

export function generateSsoSecret(): string {
  return `tsso_${randomBytes(32).toString("base64url")}`;
}

/** User.email must be unique, so SSO users get a stable placeholder; the asserted email lives on SsoIdentity. */
function placeholderEmail(projectId: string, externalId: string): string {
  const hash = createHash("sha256").update(`${projectId}:${externalId}`).digest("hex").slice(0, 32);
  return `sso-${hash}@users.tuti.invalid`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * The User for someone from a project's app (matched by their id there, never by
 * email), created on first sight. Only the details given are updated. Used by
 * SSO sign-ins and by API calls made on someone's behalf.
 */
export async function upsertProjectUser(
  projectId: string,
  externalId: string,
  details: { name?: string; image?: string | null; email?: string | null },
): Promise<string> {
  const where = { projectId_externalId: { projectId, externalId } };
  const existing = await prisma.ssoIdentity.findUnique({ where, select: { userId: true } });
  if (existing) {
    const { email, ...profile } = details;
    if (Object.values(profile).some((value) => value !== undefined)) {
      await prisma.user.update({ where: { id: existing.userId }, data: profile });
    }
    if (email !== undefined) {
      await prisma.ssoIdentity.update({ where: { userId: existing.userId }, data: { email } });
    }
    return existing.userId;
  }
  try {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        name: details.name ?? details.email?.split("@")[0] ?? "Anonymous",
        image: details.image ?? null,
        email: placeholderEmail(projectId, externalId),
        ssoIdentity: { create: { projectId, externalId, email: details.email ?? null } },
      },
      select: { id: true },
    });
    return user.id;
  } catch (error) {
    // Lost a race with a concurrent first sight of the same person.
    if (!isUniqueViolation(error)) {
      throw error;
    }
    return (await prisma.ssoIdentity.findUniqueOrThrow({ where, select: { userId: true } })).userId;
  }
}

export const jwtSso = () =>
  ({
    id: "tuti-jwt-sso",
    endpoints: {
      ssoJwt: createAuthEndpoint(
        "/sso/jwt",
        { method: "GET", query: querySchema },
        async (ctx) => {
          const target = resolveHost(ctx.headers?.get("host") ?? null);
          if (target.kind !== "portal") {
            throw ctx.redirect("/");
          }
          const { slug } = target;
          const { token } = ctx.query;
          const fail = (code: SsoErrorCode) => ctx.redirect(`/sso/error?code=${code}`);

          const project = await prisma.project.findUnique({
            where: { slug },
            select: { id: true, ssoSecret: true },
          });
          if (!project?.ssoSecret) {
            throw fail("sso_not_enabled");
          }

          let payload: unknown;
          try {
            ({ payload } = await jwtVerify(token, new TextEncoder().encode(project.ssoSecret), {
              algorithms: ["HS256"],
              clockTolerance: CLOCK_TOLERANCE_SECONDS,
              requiredClaims: ["sub", "jti", "iat", "exp"],
            }));
          } catch (error) {
            throw fail(error instanceof joseErrors.JWTExpired ? "expired_token" : "invalid_token");
          }

          const claims = claimsSchema.safeParse(payload);
          if (!claims.success) {
            throw fail("invalid_claims");
          }
          const { sub, jti, iat, exp, email, name, avatar } = claims.data;
          if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS || iat > Date.now() / 1000 + CLOCK_TOLERANCE_SECONDS) {
            throw fail("token_lifetime_too_long");
          }

          // One-time use: the primary key on (projectId, jti) rejects replays.
          // Old rows only matter until their token would have expired anyway.
          await prisma.ssoTokenUse.deleteMany({ where: { expiresAt: { lt: new Date() } } });
          try {
            await prisma.ssoTokenUse.create({
              data: {
                projectId: project.id,
                jti,
                expiresAt: new Date((exp + CLOCK_TOLERANCE_SECONDS) * 1000),
              },
            });
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw fail("token_already_used");
            }
            throw error;
          }

          const userId = await upsertProjectUser(project.id, sub, {
            name: name ?? email?.split("@")[0] ?? "Anonymous",
            image: avatar ?? null,
            email: email ?? null,
          });

          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) {
            throw fail("invalid_claims");
          }
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });

          throw ctx.redirect(safeRedirectPath(ctx.query.redirect, "/"));
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
