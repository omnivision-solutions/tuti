import { prisma } from "@tuti/db";
import { z } from "zod";

import { previewOf } from "../customize";
import { defineOperation } from "./define";

/**
 * Customize's preview of one of the portal's pages (PortalSettingsPane's `preview`, server/customize.ts): its Tuti
 * address, where readers find it, and for a person a token that reads the portal as them, so a private one shows too.
 * Internal: a page-shaped read for the Portal settings screens.
 */
export const getPortalPreview = defineOperation({
  name: "customize.preview",
  title: "Get the portal preview",
  summary: "Where Customize's preview frames the portal's page `path`, and the token that shows it to the person looking.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "admin",
  input: z.object({ path: z.string().startsWith("/").max(2000) }),
  output: z.object({ origin: z.string(), path: z.string(), address: z.string(), token: z.string().optional() }),
  run: async ({ actor, projectId }, { path }) => {
    const { slug } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true } });
    return previewOf({ id: projectId, slug }, actor.kind === "user" ? actor.userId : null, path);
  },
});
