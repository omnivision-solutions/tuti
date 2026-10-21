import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Prisma, prisma } from "@tuti/db";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { errors as joseErrors, jwtVerify } from "jose";
import { z } from "zod";

import { requestTarget } from "@/server/custom-domains";
import { MAX_READER_GROUPS, readerGroup } from "./reader-groups";
import { safeRedirectPath } from "./redirects";
import { baseFrom, withBase } from "@/lib/portal-base";

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
  /** Which restricted help center collections they may read (see Collection.groups). Each sign-in says them all. */
  groups: z.array(readerGroup).max(MAX_READER_GROUPS).optional(),
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
  details: { name?: string; image?: string | null; email?: string | null; groups?: string[] },
): Promise<string> {
  const where = { projectId_externalId: { projectId, externalId } };
  const existing = await prisma.ssoIdentity.findUnique({ where, select: { userId: true } });
  if (existing) {
    const { email, groups, ...profile } = details;
    if (Object.values(profile).some((value) => value !== undefined)) {
      await prisma.user.update({ where: { id: existing.userId }, data: profile });
    }
    if (email !== undefined || groups !== undefined) {
      await prisma.ssoIdentity.update({ where: { userId: existing.userId }, data: { email, groups } });
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
        ssoIdentity: { create: { projectId, externalId, email: details.email ?? null, groups: details.groups ?? [] } },
      },
      select: { id: true },
    });
    return user.id;
  } catch (error) {
    // Lost a race with a concurrent first sight of the same person: they exist now, so this sign-in's
    // details (its groups above all) go on them like any later one's.
    if (!isUniqueViolation(error)) {
      throw error;
    }
    return upsertProjectUser(projectId, externalId, details);
  }
}

/**
 * Checks a sign-in token from a project's own app (HS256 with the project's SSO
 * secret, short-lived, used once) and finds or makes that person's user. Used by
 * the portal's SSO sign-in and by the widget.
 */
export async function verifySsoToken(
  project: { id: string; ssoSecret: string },
  token: string,
): Promise<{ userId: string } | { error: SsoErrorCode }> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(project.ssoSecret), {
      algorithms: ["HS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["sub", "jti", "iat", "exp"],
    }));
  } catch (error) {
    return { error: error instanceof joseErrors.JWTExpired ? "expired_token" : "invalid_token" };
  }

  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) {
    return { error: "invalid_claims" };
  }
  const { sub, jti, iat, exp, email, name, avatar, groups } = claims.data;
  if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS || iat > Date.now() / 1000 + CLOCK_TOLERANCE_SECONDS) {
    return { error: "token_lifetime_too_long" };
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
      return { error: "token_already_used" };
    }
    throw error;
  }

  const userId = await upsertProjectUser(project.id, sub, {
    name: name ?? email?.split("@")[0] ?? "Anonymous",
    image: avatar ?? null,
    email: email ?? null,
    // Without the claim, none: a token says everything they may read, so groups taken away go.
    groups: [...new Set(groups ?? [])],
  });
  return { userId };
}

export const jwtSso = () =>
  ({
    id: "tuti-jwt-sso",
    endpoints: {
      ssoJwt: createAuthEndpoint(
        "/sso/jwt",
        { method: "GET", query: querySchema },
        async (ctx) => {
          const target = await requestTarget(ctx.headers?.get("host") ?? null);
          if (target.kind !== "portal") {
            throw ctx.redirect("/");
          }
          const { slug } = target;
          const { token } = ctx.query;
          const fail = (code: SsoErrorCode) => ctx.redirect(withBase(baseFrom(ctx.headers), `/sso/error?code=${code}`));

          const project = await prisma.project.findUnique({
            where: { slug },
            select: { id: true, ssoSecret: true },
          });
          if (!project?.ssoSecret) {
            throw fail("sso_not_enabled");
          }

          const verified = await verifySsoToken({ id: project.id, ssoSecret: project.ssoSecret }, token);
          if ("error" in verified) {
            throw fail(verified.error);
          }
          const { userId } = verified;

          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) {
            throw fail("invalid_claims");
          }
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });

          // Back under the site's path, for a portal there (see lib/portal-base.ts).
          throw ctx.redirect(withBase(baseFrom(ctx.headers), safeRedirectPath(ctx.query.redirect, "/")));
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
