import { prisma } from "@tuti/db";
import { z } from "zod";

import { defineOperation } from "./define";

/**
 * Who may read the portal (Phase 10): public (anyone), or private (only the team and the people
 * the project's SSO signs in; see server/portal-access.ts for where it's applied).
 */

const ACCESS = ["public", "private"] as const;
export type PortalAccess = (typeof ACCESS)[number];

export async function portalAccess(projectId: string): Promise<{ access: PortalAccess }> {
  const { portalAccess } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { portalAccess: true } });
  return { access: portalAccess === "PRIVATE" ? "private" : "public" };
}

export const getPortal = defineOperation({
  name: "portal.get",
  summary: "Get who may read the portal: public (anyone) or private (only the team and people your app signs in with SSO)",
  method: "GET",
  path: "/portal",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: ({ projectId }) => portalAccess(projectId),
});

export const updatePortal = defineOperation({
  name: "portal.update",
  summary:
    "Set who may read the portal: public (anyone), or private (only the team and people your app signs in with SSO; its pages, feeds, widget and AI answers ask everyone else to sign in)",
  method: "PATCH",
  path: "/portal",
  scope: "write",
  access: "admin",
  input: z.object({ access: z.enum(ACCESS, { error: "Pick public or private" }) }),
  example: { access: "private" },
  run: async ({ projectId }, input) => {
    await prisma.project.update({ where: { id: projectId }, data: { portalAccess: input.access === "private" ? "PRIVATE" : "PUBLIC" } });
    return portalAccess(projectId);
  },
});
