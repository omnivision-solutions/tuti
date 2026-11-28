import { prisma } from "@tuti/db";
import { z } from "zod";

import { generateSsoSecret } from "@/server/auth/sso";

import { defineOperation } from "./define";

/**
 * Settings → Single sign-on (internal: the secret never goes through the public API): whether the team's app signs its
 * users in to the portal, the secret it signs their tokens with (shown once, when made), and the app's own sign-in page.
 */

export const getSso = defineOperation({
  name: "sso.get",
  title: "Get single sign-on",
  summary: "Whether single sign-on is on, and the app's sign-in page for the portal's Continue with; never the secret.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: z.object({ enabled: z.boolean(), signInUrl: z.string().nullable() }),
  run: async ({ projectId }) => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { ssoSecret: true, ssoSignInUrl: true } });
    return { enabled: project.ssoSecret !== null, signInUrl: project.ssoSignInUrl };
  },
});

export const rotateSsoSecret = defineOperation({
  name: "sso.rotate",
  title: "Turn on or replace the key",
  summary: "Turn single sign-on on, or replace its secret key: the new key is returned here, once.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "admin",
  input: z.object({}),
  output: z.object({ secret: z.string() }),
  run: async ({ projectId }) => {
    const secret = generateSsoSecret();
    await prisma.project.update({ where: { id: projectId }, data: { ssoSecret: secret } });
    return { secret };
  },
});

export const disableSso = defineOperation({
  name: "sso.disable",
  title: "Turn off single sign-on",
  summary: "Turn single sign-on off: the secret key goes, and tokens signed with it stop working.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "admin",
  input: z.object({}),
  output: z.object({}),
  run: async ({ projectId }) => {
    await prisma.project.update({ where: { id: projectId }, data: { ssoSecret: null } });
    return {};
  },
});

export const updateSso = defineOperation({
  name: "sso.update",
  title: "Set the app's sign-in page",
  summary: "Set the app's own sign-in page, for the portal's Continue with: an https address, or empty to remove it.",
  method: "PATCH",
  internal: true,
  scope: "write",
  access: "admin",
  input: z.object({
    signInUrl: z
      .string()
      .trim()
      .refine((value) => value === "" || (value.length <= 2048 && URL.parse(value)?.protocol === "https:"), "Enter an https:// address"),
  }),
  output: z.object({ signInUrl: z.string().nullable() }),
  run: async ({ projectId }, { signInUrl }) => {
    await prisma.project.update({ where: { id: projectId }, data: { ssoSignInUrl: signInUrl || null } });
    return { signInUrl: signInUrl || null };
  },
});
