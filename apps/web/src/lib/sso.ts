import { createHash, randomBytes } from "node:crypto";

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

          const profile = {
            name: name ?? email?.split("@")[0] ?? "Anonymous",
            image: avatar ?? null,
          };

          const identity = await prisma.ssoIdentity.findUnique({
            where: { projectId_externalId: { projectId: project.id, externalId: sub } },
            select: { userId: true },
          });

          let userId = identity?.userId;
          if (userId) {
            await ctx.context.internalAdapter.updateUser(userId, profile);
            await prisma.ssoIdentity.update({
              where: { userId },
              data: { email: email ?? null },
            });
          } else {
            const user = await ctx.context.internalAdapter.createUser(
              { ...profile, email: placeholderEmail(project.id, sub) },
              { method: "jwt-sso" },
            );
            try {
              await prisma.ssoIdentity.create({
                data: { projectId: project.id, externalId: sub, userId: user.id, email: email ?? null },
              });
              userId = user.id;
            } catch (error) {
              // Lost a race with a concurrent first sign-in for the same sub.
              await ctx.context.internalAdapter.deleteUser(user.id);
              if (!isUniqueViolation(error)) {
                throw error;
              }
              const existing = await prisma.ssoIdentity.findUniqueOrThrow({
                where: { projectId_externalId: { projectId: project.id, externalId: sub } },
                select: { userId: true },
              });
              userId = existing.userId;
            }
          }

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
